import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { TCPSocketListener } from "bun"
import { PROTOCOL_VERSION } from "../src/core/daemonProtocol"
import { OrdoError } from "../src/core/errors"
import { encode, LineDecoder } from "../src/core/protocol"
import { DaemonClient, killSessionPanes } from "../src/daemon/daemonClient"

let tmp: string
let prevDataDir: string | undefined

beforeEach(() => {
	prevDataDir = process.env.ORDO_DATA_DIR
	tmp = mkdtempSync(join(tmpdir(), "ordo-dc-"))
	process.env.ORDO_DATA_DIR = join(tmp, "ordo")
})

afterEach(() => {
	if (prevDataDir === undefined) delete process.env.ORDO_DATA_DIR
	else process.env.ORDO_DATA_DIR = prevDataDir
	rmSync(tmp, { recursive: true, force: true })
})

describe("tryAttach", () => {
	test("returns false with no daemon.json and spawns nothing", async () => {
		const dc = new DaemonClient()
		expect(await dc.tryAttach()).toBe(false)
		dc.stop()
		expect(existsSync(join(tmp, "ordo", "daemon.json"))).toBe(false)
	})
})

describe("request error mapping", () => {
	test("a request with no connection rejects as an OrdoError with a hint", async () => {
		const dc = new DaemonClient()
		const err = await dc.getState("s").then(
			() => null,
			(e) => e,
		)
		dc.stop()
		expect(err).toBeInstanceOf(OrdoError)
		expect((err as OrdoError).hint).toBeTruthy()
	})

	test("a daemon-reported failure surfaces as an OrdoError carrying its code", async () => {
		const listener: TCPSocketListener<{ dec: LineDecoder<{ id: number; op?: string }> }> =
			Bun.listen({
				hostname: "127.0.0.1",
				port: 0,
				socket: {
					open(sock) {
						sock.data = { dec: new LineDecoder() }
					},
					data(sock, chunk) {
						for (const msg of sock.data.dec.push(chunk)) {
							if (!("op" in msg) || msg.op === undefined) continue
							if (msg.op === "ping") {
								sock.write(
									encode({ id: msg.id, ok: true, result: { pid: 4242, v: PROTOCOL_VERSION } }),
								)
							} else {
								sock.write(
									encode({
										id: msg.id,
										ok: false,
										error: "the ordo command center for this session is not open",
										code: "no-owner",
									}),
								)
							}
							sock.flush()
						}
					},
				},
			})
		mkdirSync(join(tmp, "ordo"), { recursive: true })
		writeFileSync(
			join(tmp, "ordo", "daemon.json"),
			JSON.stringify({ port: listener.port, token: "t", pid: 4242 }),
		)

		const dc = new DaemonClient()
		try {
			expect(await dc.tryAttach()).toBe(true)
			const err = await dc.requestPane("s", {}).then(
				() => null,
				(e) => e,
			)
			expect(err).toBeInstanceOf(OrdoError)
			expect((err as OrdoError).code).toBe("no-owner")
		} finally {
			dc.stop()
			listener.stop(true)
		}
	})
})

describe("killSessionPanes", () => {
	test("resolves without side effects when no daemon is running", async () => {
		await killSessionPanes("ghost-session")
		expect(existsSync(join(tmp, "ordo", "daemon.json"))).toBe(false)
	})
})
