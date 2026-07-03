/**
 * The pane client: runs INSIDE each Windows Terminal pane and is a *dumb pipe* to
 * the persistent daemon, which owns the actual shell + ConPTY.
 *
 *   real stdin  ──▶ {t:"i", base64} ──▶ daemon ──▶ shell
 *   shell ──▶ daemon ──(raw bytes)──▶ real stdout (the WT pane)
 *
 * Closing the window kills this client but NOT the shell — the daemon keeps it
 * running, so reopening the session re-attaches to the same live shell.
 *
 * Invoked as: bun attachClient.ts --session <name> --pane <id>
 */

import { CLIENT_OVERFLOW_BYTES, RESIZE_DEBOUNCE_MS } from "../core/config"
import { readDaemonInfo } from "../core/daemonInfo"
import type { AttachClientMsg, AttachHello } from "../core/daemonProtocol"
import { PROTOCOL_VERSION } from "../core/daemonProtocol"
import { errMessage } from "../core/errors"
import { encode } from "../core/protocol"
import { SocketWriter } from "./socketWriter"

const stdinEncoder = new TextEncoder()
const INPUT_FRAME_BYTES = 64 * 1024

function arg(flag: string): string | undefined {
	const i = Bun.argv.indexOf(flag)
	return i >= 0 ? Bun.argv[i + 1] : undefined
}

function paneSize(): { cols: number; rows: number } {
	return { cols: process.stdout.columns ?? 80, rows: process.stdout.rows ?? 24 }
}

function restoreRawMode(): void {
	try {
		;(process.stdin as NodeJS.ReadStream).setRawMode?.(false)
	} catch {}
}

const CONNECT_TIMEOUT_MS = 3000
const ACK_TIMEOUT_MS = 5000

async function main() {
	const session = arg("--session")
	const pane = arg("--pane")
	if (!session || !pane) throw new Error("client requires --session and --pane")

	const info = readDaemonInfo()
	if (!info) throw new Error("session daemon is not running — start ordo first")

	process.stdout.on("error", () => process.exit(0))
	process.on("exit", restoreRawMode)

	const { cols, rows } = paneSize()
	let writer: SocketWriter | undefined
	let acked = false
	let ackTimer: ReturnType<typeof setTimeout> | undefined

	const connect = Bun.connect({
		hostname: "127.0.0.1",
		port: info.port,
		socket: {
			open: (sock) => {
				writer = new SocketWriter(sock, CLIENT_OVERFLOW_BYTES, () => process.exit(0))
				const hello: AttachHello = {
					kind: "attach",
					token: info.token,
					v: PROTOCOL_VERSION,
					session,
					pane,
					cols,
					rows,
				}
				writer.write(encode(hello))

				ackTimer = setTimeout(() => {
					if (!acked) {
						restoreRawMode()
						console.error("ordo: no response from session daemon")
						process.exit(1)
					}
				}, ACK_TIMEOUT_MS)

				// Forward raw stdin to the daemon (base64-framed). The daemon does the
				// echo/line-editing inside its ConPTY, so we must run raw.
				try {
					;(process.stdin as NodeJS.ReadStream).setRawMode?.(true)
				} catch {}
				process.stdin.resume()
				process.stdin.on("data", (b) => {
					const bytes = typeof b === "string" ? stdinEncoder.encode(b) : new Uint8Array(b)
					for (let off = 0; off < bytes.byteLength; off += INPUT_FRAME_BYTES) {
						const frame = bytes.subarray(off, off + INPUT_FRAME_BYTES)
						const msg: AttachClientMsg = { t: "i", d: Buffer.from(frame).toString("base64") }
						writer?.write(encode(msg))
					}
					if (writer && writer.pending > 0) {
						process.stdin.pause()
						writer.onEmpty(() => process.stdin.resume())
					}
				})

				const sendResize = () => {
					const s = paneSize()
					const msg: AttachClientMsg = { t: "r", c: s.cols, r: s.rows }
					writer?.write(encode(msg))
				}
				let resizeTimer: ReturnType<typeof setTimeout> | undefined
				process.stdout.on("resize", () => {
					if (RESIZE_DEBOUNCE_MS <= 0) {
						sendResize()
						return
					}
					if (resizeTimer !== undefined) clearTimeout(resizeTimer)
					resizeTimer = setTimeout(sendResize, RESIZE_DEBOUNCE_MS)
				})
			},
			drain: () => writer?.drain(),
			data: (sock, chunk) => {
				let payload = chunk
				if (!acked) {
					const nl = chunk.indexOf(0x0a)
					if (nl === -1) return
					acked = true
					if (ackTimer) clearTimeout(ackTimer)
					payload = chunk.subarray(nl + 1)
					if (payload.byteLength === 0) return
				}
				const flushed = process.stdout.write(payload)
				if (!flushed && typeof sock.pause === "function") {
					sock.pause()
					process.stdout.once("drain", () => {
						try {
							sock.resume()
						} catch {}
					})
				}
			},
			// Shell exited or daemon gone → close this pane.
			close: () => process.exit(0),
			error: () => process.exit(0),
		},
	})

	const socket = await Promise.race([
		connect,
		new Promise((_, reject) =>
			setTimeout(
				() => reject(new Error("timed out connecting to session daemon")),
				CONNECT_TIMEOUT_MS,
			),
		),
	])
	void socket
}

main().catch((err) => {
	console.error(`ordo: ${errMessage(err)}`)
	process.exit(1)
})
