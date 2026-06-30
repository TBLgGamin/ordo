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
 * Invoked as: bun client.ts --session <name> --pane <id>
 */

import { readFileSync } from "node:fs"
import { join } from "node:path"
import type { AttachClientMsg, AttachHello } from "./daemonProtocol"
import { encode } from "./protocol"
import { ordoDir } from "./session"

function arg(flag: string): string | undefined {
	const i = Bun.argv.indexOf(flag)
	return i >= 0 ? Bun.argv[i + 1] : undefined
}

function paneSize(): { cols: number; rows: number } {
	return { cols: process.stdout.columns ?? 80, rows: process.stdout.rows ?? 24 }
}

async function main() {
	const session = arg("--session")
	const pane = arg("--pane")
	if (!session || !pane) throw new Error("client requires --session and --pane")

	const info = JSON.parse(readFileSync(join(ordoDir(), "daemon.json"), "utf8")) as {
		port: number
		token: string
	}

	const { cols, rows } = paneSize()
	const socket = await Bun.connect({
		hostname: "127.0.0.1",
		port: info.port,
		socket: {
			open: (sock) => {
				const hello: AttachHello = { kind: "attach", token: info.token, session, pane, cols, rows }
				sock.write(encode(hello))
				sock.flush()

				// Forward raw stdin to the daemon (base64-framed). The daemon does the
				// echo/line-editing inside its ConPTY, so we must run raw.
				try {
					;(process.stdin as NodeJS.ReadStream).setRawMode?.(true)
				} catch {}
				process.stdin.resume()
				process.stdin.on("data", (b) => {
					const bytes = typeof b === "string" ? new TextEncoder().encode(b) : new Uint8Array(b)
					const msg: AttachClientMsg = { t: "i", d: Buffer.from(bytes).toString("base64") }
					sock.write(encode(msg))
					sock.flush()
				})

				process.stdout.on("resize", () => {
					const s = paneSize()
					const msg: AttachClientMsg = { t: "r", c: s.cols, r: s.rows }
					sock.write(encode(msg))
					sock.flush()
				})
			},
			// Daemon → client is the raw terminal stream; paint it straight to stdout.
			data: (_sock, chunk) => {
				process.stdout.write(new Uint8Array(chunk))
			},
			// Shell exited or daemon gone → close this pane.
			close: () => process.exit(0),
			error: () => process.exit(0),
		},
	})
	void socket
}

main().catch((err) => {
	console.error("[ordo client] fatal:", err)
	process.exit(1)
})
