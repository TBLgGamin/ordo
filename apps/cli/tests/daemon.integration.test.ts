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
import { existsSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Subprocess } from "bun"
import { BUN_EXE, DAEMON_PATH } from "../src/core/config"
import type { AttachClientMsg, AttachHello } from "../src/core/daemonProtocol"
import { encode } from "../src/core/protocol"
import { DaemonClient } from "../src/daemon/daemonClient"

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
let dataDir: string
let prevDataDir: string | undefined
let daemonProc: Subprocess
let dc: DaemonClient
let port = 0
let token = ""

// This end-to-end test spawns a real daemon and drives interactive PTY shells,
// which depends on OS-specific process/PTY behavior. It runs on Windows CI (where
// it is verified) and locally on any OS, but is skipped on macOS/Linux CI runners
// until the POSIX daemon path is validated on real hardware.
const RUN_DAEMON_IT = process.platform === "win32" || !process.env.CI

beforeAll(async () => {
	if (!RUN_DAEMON_IT) return
	prevDataDir = process.env.ORDO_DATA_DIR
	tmp = mkdtempSync(join(tmpdir(), "ordo-daemon-"))
	dataDir = join(tmp, "ordo")
	process.env.ORDO_DATA_DIR = dataDir
	// Spawn the daemon directly (test-controlled lifecycle, not Start-Process).
	daemonProc = Bun.spawn([BUN_EXE, DAEMON_PATH], {
		env: {
			...process.env,
			ORDO_DATA_DIR: dataDir,
			ORDO_RESTORE_PROGRAMS: "whoami cmd node python claude codex kilo kilocode gemini opencode",
		},
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
	if (!RUN_DAEMON_IT) return
	try {
		dc.stop()
	} catch {}
	try {
		daemonProc.kill()
	} catch {}
	try {
		await daemonProc.exited
	} catch {}
	if (prevDataDir === undefined) delete process.env.ORDO_DATA_DIR
	else process.env.ORDO_DATA_DIR = prevDataDir
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

describe.skipIf(!RUN_DAEMON_IT)("daemon", () => {
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
		const second = Bun.spawn([BUN_EXE, DAEMON_PATH], {
			env: { ...process.env, ORDO_DATA_DIR: dataDir },
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

	test("sendMessage types into the target pane and presses Enter", async () => {
		await dc.createPane("m1", "typed", { cwd: process.cwd() })
		const a = attach("m1", "typed")
		await a.ready
		expect(await waitLive(a)).toBe(true)
		const del = await dc.sendMessage("m1", "typed", {
			from: "sender",
			text: "echo EXECUTED_7",
			raw: true,
		})
		expect(del.delivered).toBe("typed")
		expect(await waitText(a, "EXECUTED_7")).toBe(true)
		await dc.killPane("m1", "typed")
	}, 15000)

	test("waitForMessage receives a message instead of typing it", async () => {
		await dc.createPane("m2", "waiter", { cwd: process.cwd() })
		const a = attach("m2", "waiter")
		await a.ready
		expect(await waitLive(a)).toBe(true)
		const waitP = dc.waitForMessage("m2", "waiter", { timeoutMs: 8000 })
		await delay(150)
		const del = await dc.sendMessage("m2", "waiter", { from: "alice", text: "PING_123" })
		expect(del.delivered).toBe("waiter")
		const res = await waitP
		expect(res).toMatchObject({ from: "alice", text: "PING_123" })
		await delay(300)
		expect(a.output()).not.toContain("PING_123")
		await dc.killPane("m2", "waiter")
	}, 15000)

	test("waitForMessage times out when nothing arrives", async () => {
		await dc.createPane("m3", "lonely", { cwd: process.cwd() })
		const res = await dc.waitForMessage("m3", "lonely", { timeoutMs: 1000 })
		expect(res).toEqual({ timeout: true })
		await dc.killPane("m3", "lonely")
	}, 15000)

	test("readPane returns recent plain-text output", async () => {
		await dc.createPane("m4", "reader", { cwd: process.cwd() })
		const a = attach("m4", "reader")
		await a.ready
		expect(await waitLive(a)).toBe(true)
		a.type("echo READABLE_99\r")
		expect(await waitText(a, "READABLE_99")).toBe(true)
		await delay(200)
		const { text } = await dc.readPane("m4", "reader", 200)
		expect(text).toContain("READABLE_99")
		expect(text).not.toContain("\x1b")
		await dc.killPane("m4", "reader")
	}, 15000)

	test("sendMessage rejects an unknown pane and self-messaging", async () => {
		await dc.createPane("m5", "self", { cwd: process.cwd() })
		const a = attach("m5", "self")
		await a.ready
		expect(await waitLive(a)).toBe(true)
		await expect(dc.sendMessage("m5", "ghost", { from: "x", text: "hi" })).rejects.toThrow(
			/no such pane/,
		)
		await expect(dc.sendMessage("m5", "self", { from: "self", text: "hi" })).rejects.toThrow(
			/yourself/,
		)
		await dc.killPane("m5", "self")
	}, 15000)

	test("interrupt sends Ctrl-C to a pane", async () => {
		await dc.createPane("m6", "runner", { cwd: process.cwd() })
		const a = attach("m6", "runner")
		await a.ready
		expect(await waitLive(a)).toBe(true)
		await dc.interrupt("m6", "runner")
		const st = await dc.getState("m6")
		expect(st.panes[0]?.live).toBe(true)
		await dc.killPane("m6", "runner")
	}, 15000)

	test("broadcast types into every peer except the sender", async () => {
		await dc.createPane("bc", "one", { cwd: process.cwd() })
		await dc.createPane("bc", "two", { cwd: process.cwd() })
		await dc.createPane("bc", "src", { cwd: process.cwd() })
		const a1 = attach("bc", "one")
		const a2 = attach("bc", "two")
		await Promise.all([a1.ready, a2.ready])
		expect(await waitLive(a1)).toBe(true)
		expect(await waitLive(a2)).toBe(true)
		const { results } = await dc.broadcast("bc", { from: "src", text: "echo BCAST_42" })
		const panes = results.map((r) => r.pane).sort()
		expect(panes).toEqual(["one", "two"])
		expect(await waitText(a1, "BCAST_42")).toBe(true)
		expect(await waitText(a2, "BCAST_42")).toBe(true)
		await dc.killPane("bc", "one")
		await dc.killPane("bc", "two")
		await dc.killPane("bc", "src")
	}, 20000)

	test("setStatus/getStatus round-trip, observed by another control, cleared on exit", async () => {
		const owner = new DaemonClient()
		await owner.ensure("stt")
		await owner.createPane("stt", "statuspane", { cwd: process.cwd() })
		let observedStatus: string | undefined
		const off = dc.on((e) => {
			if (e.event === "status" && e.session === "stt") observedStatus = e.status
		})
		await owner.setStatus("stt", "statuspane", "reviewing", "pr 42")
		const got = await owner.getStatus("stt")
		expect(got.entries.find((x) => x.pane === "statuspane")?.status).toBe("reviewing")
		expect(got.entries.find((x) => x.pane === "statuspane")?.task).toBe("pr 42")
		expect(await waitFor(() => observedStatus === "reviewing")).toBe(true)
		await owner.killPane("stt", "statuspane")
		const cleared = await waitFor(async () => (await owner.getStatus("stt")).entries.length === 0)
		expect(cleared).toBe(true)
		off()
		owner.stop()
	}, 15000)

	test("waitForEvent resolves on a pane-exited event", async () => {
		await dc.createPane("we1", "watcher", { cwd: process.cwd() })
		await dc.createPane("we1", "victim", { cwd: process.cwd() })
		const p = dc.waitForEvent("we1", "watcher", { events: ["pane-exited"], timeoutMs: 8000 })
		await delay(150)
		await dc.killPane("we1", "victim")
		expect(await p).toMatchObject({ kind: "pane-exited", pane: "victim" })
		await dc.killPane("we1", "watcher")
	}, 15000)

	test("waitForEvent observes a message without consuming it", async () => {
		await dc.createPane("we2", "obs", { cwd: process.cwd() })
		await dc.createPane("we2", "recip", { cwd: process.cwd() })
		const a = attach("we2", "recip")
		await a.ready
		expect(await waitLive(a)).toBe(true)
		const p = dc.waitForEvent("we2", "obs", { events: ["message"], timeoutMs: 8000 })
		await delay(150)
		await dc.sendMessage("we2", "recip", { from: "obs", text: "echo OBSERVED_9", raw: true })
		expect(await p).toMatchObject({ kind: "message", pane: "recip" })
		expect(await waitText(a, "OBSERVED_9")).toBe(true)
		await dc.killPane("we2", "obs")
		await dc.killPane("we2", "recip")
	}, 15000)

	test("waitForEvent times out cleanly", async () => {
		await dc.createPane("we3", "idle", { cwd: process.cwd() })
		const res = await dc.waitForEvent("we3", "idle", {
			events: ["status-changed"],
			timeoutMs: 1000,
		})
		expect(res).toEqual({ timeout: true })
		await dc.killPane("we3", "idle")
	}, 15000)

	test("runCommand returns stdout and an exit code", async () => {
		const res = await dc.runCommand("rc1", { command: "Write-Output RUNCMD_OK; exit 0" })
		expect(res.stdout).toContain("RUNCMD_OK")
		expect(res.exitCode).toBe(0)
		expect(res.timedOut).toBe(false)
	}, 15000)

	test("runCommand times out a long-running command", async () => {
		const res = await dc.runCommand("rc2", {
			command: "Start-Sleep -Seconds 10",
			timeoutMs: 1000,
		})
		expect(res.timedOut).toBe(true)
	}, 15000)

	test("spawn broker: the owner answers a requestPane with a new pane", async () => {
		const owner = new DaemonClient()
		await owner.ensure("sp1")
		const off = owner.on((e) => {
			if (e.event === "spawnRequest" && e.session === "sp1") {
				void (async () => {
					const name = e.name ?? "auto"
					await owner.createPane("sp1", name, { cwd: process.cwd() })
					await owner.resolveSpawn(e.requestId, { pane: name })
				})()
			}
		})
		const res = await dc.requestPane("sp1", { requestedBy: "agent", name: "brokered" })
		expect(res.pane).toBe("brokered")
		const st = await owner.getState("sp1")
		expect(st.panes.some((p) => p.pane === "brokered")).toBe(true)
		off()
		await owner.killPane("sp1", "brokered")
		owner.stop()
	}, 15000)

	test("requestPane is rejected when no command center owns the session", async () => {
		await expect(dc.requestPane("no-owner-here", { requestedBy: "x" })).rejects.toThrow(
			/command center/,
		)
	}, 15000)

	test("requestPane is rejected if the owner disconnects before answering", async () => {
		const owner = new DaemonClient()
		await owner.ensure("sp2")
		const p = dc.requestPane("sp2", { requestedBy: "x" })
		await delay(150)
		owner.stop()
		await expect(p).rejects.toThrow(/command center closed/)
	}, 15000)

	test("createPane launch types a whitelisted program into the shell", async () => {
		await dc.createPane("lp1", "launcher", { cwd: process.cwd(), launch: "whoami" })
		const a = attach("lp1", "launcher")
		await a.ready
		expect(await waitText(a, "whoami")).toBe(true)
		await dc.killPane("lp1", "launcher")
	}, 15000)
})
