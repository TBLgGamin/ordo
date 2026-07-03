/**
 * End-to-end tests for the persistent session daemon: it hosts the shell, and a
 * client can attach, detach, and re-attach to the SAME live shell (warm restore)
 * with the prior output replayed from the ring buffer. Runs an isolated daemon
 * under a temp APPDATA so it never touches the real one.
 *
 * Timing is condition-driven (poll until true, with a generous ceiling) rather
 * than fixed sleeps, so the tests pass as fast as the machine allows and only
 * wait the ceiling when something is genuinely wrong.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import type { Subprocess } from "bun"
import { existsSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DaemonClient } from "../src/daemon/daemonClient"
import type { AttachClientMsg, AttachHello } from "../src/core/daemonProtocol"
import { encode } from "../src/core/protocol"

const enc = (o: object) => encode(o)
const delay = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** Poll `pred` until it's truthy or the ceiling elapses. Returns whether it held. */
async function waitFor(
	pred: () => boolean | Promise<boolean>,
	timeout = 10000,
	interval = 50,
): Promise<boolean> {
	const deadline = Date.now() + timeout
	while (Date.now() < deadline) {
		if (await pred()) return true
		await delay(interval)
	}
	return false
}

let tmp: string
let prevAppData: string | undefined
let daemonProc: Subprocess
let dc: DaemonClient
let port = 0
let token = ""

beforeAll(async () => {
	prevAppData = process.env.APPDATA
	tmp = mkdtempSync(join(tmpdir(), "ordo-daemon-"))
	process.env.APPDATA = tmp
	// Spawn the daemon directly (test-controlled lifecycle, not Start-Process).
	daemonProc = Bun.spawn(["bun", "src/daemon/daemon.ts"], {
		env: { ...process.env, APPDATA: tmp },
		stdin: "ignore",
		stdout: "ignore",
		stderr: "ignore",
	})
	const info = join(tmp, "ordo", "daemon.json")
	await waitFor(() => existsSync(info))
	const parsed = JSON.parse(await Bun.file(info).text())
	port = parsed.port
	token = parsed.token
	dc = new DaemonClient()
	await dc.ensure() // pings the daemon we just spawned (no second spawn)
}, 20000)

afterAll(async () => {
	try {
		dc.stop()
	} catch {}
	try {
		daemonProc.kill()
	} catch {}
	try {
		await daemonProc.exited
	} catch {}
	if (prevAppData === undefined) delete process.env.APPDATA
	else process.env.APPDATA = prevAppData
	for (let i = 0; i < 10; i++) {
		try {
			rmSync(tmp, { recursive: true, force: true })
			break
		} catch {
			await delay(50)
		}
	}
})

/** A raw attach connection: daemon→us is raw bytes; us→daemon is newline-JSON. */
function attach(session: string, pane: string) {
	let out = ""
	let bytes = 0
	let sock: import("bun").Socket<undefined> | undefined
	const ready = new Promise<void>((resolve) => {
		Bun.connect<undefined>({
			hostname: "127.0.0.1",
			port,
			socket: {
				open: (s) => {
					sock = s
					const hello: AttachHello = { kind: "attach", token, session, pane, cols: 80, rows: 24 }
					s.write(enc(hello))
					s.flush()
					resolve()
				},
				data: (_s, c) => {
					out += new TextDecoder().decode(c)
					bytes += c.byteLength
				},
			},
		})
	})
	return {
		ready,
		output: () => out,
		/** Bytes received from the daemon so far (proves the attach is live). */
		received: () => bytes,
		type: (text: string) => {
			const msg: AttachClientMsg = { t: "i", d: Buffer.from(text).toString("base64") }
			sock?.write(enc(msg))
			sock?.flush()
		},
		close: () => sock?.end(),
	}
}

type Attachment = ReturnType<typeof attach>

/** Wait until the daemon has streamed some output to this attachment (shell up). */
const waitLive = (a: Attachment) => waitFor(() => a.received() > 0)
/** Wait until the attachment's accumulated output contains `text`. */
const waitText = (a: Attachment, text: string) => waitFor(() => a.output().includes(text))

describe("daemon", () => {
	test("createPane hosts a live shell and getState reports it", async () => {
		const created = await dc.createPane("s1", "optio", { cwd: process.cwd() })
		expect(created.warm).toBe(false)
		expect(created.state.live).toBe(true)
		expect(created.state.pid).toBeGreaterThan(0)
		const st = await dc.getState("s1")
		expect(st.panes.some((p) => p.pane === "optio")).toBe(true)
		await dc.killPane("s1", "optio")
	}, 15000)

	test("warm restore: detachSession then re-attach to the SAME shell with replayed output", async () => {
		await dc.createPane("s2", "decanus", { cwd: process.cwd() })

		const a1 = attach("s2", "decanus")
		await a1.ready
		expect(await waitLive(a1)).toBe(true) // pwsh prompt printed → shell is up
		a1.type("echo RING_MARK_77\r")
		expect(await waitText(a1, "RING_MARK_77")).toBe(true)
		// Detach the whole session like the app/command window closing: the daemon
		// closes the client window but KEEPS the shell alive for a later restore.
		// (Closing a single pane window instead would purge it — see the next test.)
		await dc.detachSession("s2")

		const a2 = attach("s2", "decanus")
		await a2.ready
		// Ring buffer replayed the prior output to the new attachment...
		expect(await waitText(a2, "RING_MARK_77")).toBe(true)
		// ...and the SAME live shell still runs new input.
		a2.type("echo SECOND_88\r")
		expect(await waitText(a2, "SECOND_88")).toBe(true)
		await dc.detachSession("s2") // keep the shell alive for the state check below

		const settled = await waitFor(async () => {
			const st = await dc.getState("s2")
			return st.panes[0]?.lastCommand === "echo SECOND_88"
		})
		expect(settled).toBe(true)
		const st = await dc.getState("s2")
		expect(st.panes[0]?.live).toBe(true)
		await dc.killPane("s2", "decanus")
	}, 20000)

	test("closing a pane's window purges it: pane de-registered + scrollback deleted", async () => {
		const owner = new DaemonClient()
		await owner.ensure("s5")
		await owner.createPane("s5", "miles", { cwd: process.cwd() })
		const cap = join(tmp, "ordo", "sessions", "s5.scrollback", "miles.log")

		const a = attach("s5", "miles")
		await a.ready
		expect(await waitFor(() => existsSync(cap))).toBe(true) // shell up; capture created

		// Close ONLY this pane's window (single client drop, owner still connected) →
		// the daemon permanently purges the pane: kills the shell, deletes scrollback.
		a.close()
		const purged = await waitFor(async () => {
			const st = await owner.getState("s5")
			return st.panes.length === 0 && !existsSync(cap)
		})
		expect(purged).toBe(true)
		owner.stop()
	}, 15000)

	test("survives a malformed line on a raw connection", async () => {
		await new Promise<void>((resolve) => {
			Bun.connect<undefined>({
				hostname: "127.0.0.1",
				port,
				socket: {
					open: (s) => {
						s.write(new TextEncoder().encode("this is not json\n"))
						s.write(new TextEncoder().encode("{ broken json \n"))
						s.flush()
						setTimeout(() => {
							try {
								s.end()
							} catch {}
							resolve()
						}, 200)
					},
					data: () => {},
				},
			})
		})
		const st = await dc.getState("still-alive")
		expect(Array.isArray(st.panes)).toBe(true)
	}, 15000)

	test("killPane removes the pane", async () => {
		await dc.createPane("s3", "velite", { cwd: process.cwd() })
		await dc.killPane("s3", "velite")
		const gone = await waitFor(async () => (await dc.getState("s3")).panes.length === 0)
		expect(gone).toBe(true)
	}, 15000)

	test("a second daemon defers to the running one (singleton)", async () => {
		const infoPath = join(tmp, "ordo", "daemon.json")
		const before = JSON.parse(await Bun.file(infoPath).text())
		const second = Bun.spawn(["bun", "src/daemon/daemon.ts"], {
			env: { ...process.env, APPDATA: tmp },
			stdin: "ignore",
			stdout: "ignore",
			stderr: "ignore",
		})
		const code = await second.exited
		expect(code).toBe(0)
		const after = JSON.parse(await Bun.file(infoPath).text())
		expect(after.pid).toBe(before.pid)
	}, 20000)

	test("main disconnect closes client windows but keeps the shell alive", async () => {
		// A second control connection that OWNS the session (like the orchestrator).
		const owner = new DaemonClient()
		await owner.ensure("s4")
		await owner.createPane("s4", "eques", { cwd: process.cwd() })

		// A satellite client window attaches; track when it gets closed.
		let clientGone = false
		let clientBytes = 0
		const sock = await Bun.connect<undefined>({
			hostname: "127.0.0.1",
			port,
			socket: {
				open: (s) => {
					const hello: AttachHello = {
						kind: "attach",
						token,
						session: "s4",
						pane: "eques",
						cols: 80,
						rows: 24,
					}
					s.write(enc(hello))
					s.flush()
				},
				data: (_s, c) => {
					clientBytes += c.byteLength
				},
				close: () => {
					clientGone = true
				},
				error: () => {
					clientGone = true
				},
			},
		})
		void sock
		// Ensure the attach is registered (daemon streamed the prompt) before the
		// owner disconnects, otherwise the close wouldn't reach this client.
		expect(await waitFor(() => clientBytes > 0)).toBe(true)

		// Main "window" closes: drop the owning control connection.
		owner.stop()
		expect(await waitFor(() => clientGone)).toBe(true) // its window was force-closed

		// ...but the shell is still alive for a later restore.
		const st = await dc.getState("s4")
		expect(st.panes[0]?.live).toBe(true)
		await dc.killPane("s4", "eques")
	}, 15000)
})
