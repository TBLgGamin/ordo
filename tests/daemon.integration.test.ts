/**
 * End-to-end tests for the persistent session daemon: it hosts the shell, and a
 * client can attach, detach, and re-attach to the SAME live shell (warm restore)
 * with the prior output replayed from the ring buffer. Runs an isolated daemon
 * under a temp APPDATA so it never touches the real one.
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
	for (let i = 0; i < 50 && !existsSync(info); i++) await delay(100)
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
	if (prevAppData === undefined) delete process.env.APPDATA
	else process.env.APPDATA = prevAppData
	rmSync(tmp, { recursive: true, force: true })
})

/** A raw attach connection: daemon→us is raw bytes; us→daemon is newline-JSON. */
function attach(session: string, pane: string) {
	let out = ""
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
				},
			},
		})
	})
	return {
		ready,
		output: () => out,
		type: (text: string) => {
			const msg: AttachClientMsg = { t: "i", d: Buffer.from(text).toString("base64") }
			sock?.write(enc(msg))
			sock?.flush()
		},
		close: () => sock?.end(),
	}
}

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
		await delay(2500) // let pwsh come up
		a1.type("echo RING_MARK_77\r")
		await delay(1200)
		expect(a1.output()).toContain("RING_MARK_77")
		// Detach the whole session like the app/command window closing: the daemon
		// closes the client window but KEEPS the shell alive for a later restore.
		// (Closing a single pane window instead would purge it — see the next test.)
		await dc.detachSession("s2")

		await delay(600)
		const a2 = attach("s2", "decanus")
		await a2.ready
		await delay(800)
		// Ring buffer replayed the prior output to the new attachment...
		expect(a2.output()).toContain("RING_MARK_77")
		// ...and the SAME live shell still runs new input.
		a2.type("echo SECOND_88\r")
		await delay(1200)
		expect(a2.output()).toContain("SECOND_88")
		await dc.detachSession("s2") // keep the shell alive for the state check below

		const st = await dc.getState("s2")
		expect(st.panes[0]?.live).toBe(true)
		expect(st.panes[0]?.lastCommand).toBe("echo SECOND_88")
		await dc.killPane("s2", "decanus")
	}, 20000)

	test("closing a pane's window purges it: pane de-registered + scrollback deleted", async () => {
		const owner = new DaemonClient()
		await owner.ensure("s5")
		await owner.createPane("s5", "miles", { cwd: process.cwd() })
		const cap = join(tmp, "ordo", "sessions", "s5.scrollback", "miles.log")

		const a = attach("s5", "miles")
		await a.ready
		await delay(2000) // shell comes up; its capture file exists
		expect(existsSync(cap)).toBe(true)

		// Close ONLY this pane's window (single client drop, owner still connected) →
		// the daemon permanently purges the pane: kills the shell, deletes scrollback.
		a.close()
		await delay(1200)

		const st = await owner.getState("s5")
		expect(st.panes.length).toBe(0) // pane de-registered
		expect(existsSync(cap)).toBe(false) // its scrollback was deleted
		owner.stop()
	}, 15000)

	test("killPane removes the pane", async () => {
		await dc.createPane("s3", "velite", { cwd: process.cwd() })
		await dc.killPane("s3", "velite")
		await delay(400)
		const st = await dc.getState("s3")
		expect(st.panes.length).toBe(0)
	}, 15000)

	test("main disconnect closes client windows but keeps the shell alive", async () => {
		// A second control connection that OWNS the session (like the orchestrator).
		const owner = new DaemonClient()
		await owner.ensure("s4")
		await owner.createPane("s4", "eques", { cwd: process.cwd() })

		// A satellite client window attaches; track when it gets closed.
		let clientGone = false
		const sock = await Bun.connect<undefined>({
			hostname: "127.0.0.1",
			port,
			socket: {
				open: (s) => {
					const hello: AttachHello = { kind: "attach", token, session: "s4", pane: "eques", cols: 80, rows: 24 }
					s.write(enc(hello))
					s.flush()
				},
				data: () => {},
				close: () => {
					clientGone = true
				},
				error: () => {
					clientGone = true
				},
			},
		})
		void sock
		await delay(1500)

		// Main "window" closes: drop the owning control connection.
		owner.stop()
		await delay(800)
		expect(clientGone).toBe(true) // its window was force-closed

		// ...but the shell is still alive for a later restore.
		const st = await dc.getState("s4")
		expect(st.panes[0]?.live).toBe(true)
		await dc.killPane("s4", "eques")
	}, 15000)
})
