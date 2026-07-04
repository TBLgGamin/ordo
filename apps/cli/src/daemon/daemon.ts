/**
 * The persistent session daemon.
 *
 * It owns every pane's shell + ConPTY and stays alive after the app and its
 * windows close (launched windowless via `Start-Process -WindowStyle Hidden`).
 * Pane clients (one per Windows Terminal pane) attach over loopback TCP to pipe
 * I/O; closing a window just detaches — the shell keeps running. Reopening the
 * session re-attaches to the *same live shell* (warm restore, no reconstruction).
 *
 * Across a reboot (when the daemon is gone) it cold-restores from the per-pane
 * capture file + saved cwd (best-effort, the only option once the process died).
 *
 * Discovery: writes %APPDATA%\ordo\daemon.json = { port, token, pid }.
 *
 * Invoked as: bun daemon/daemon.ts   (no args; reads/writes daemon.json)
 */

import { existsSync, renameSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import type { Socket, TCPSocketListener } from "bun"
import { CLIENT_OVERFLOW_BYTES, powershellExe, RESTORE_PROGRAMS } from "../core/config"
import { daemonInfoPath, readDaemonInfo } from "../core/daemonInfo"
import type {
	AttachClientMsg,
	BroadcastResult,
	ControlEvent,
	ControlHello,
	ControlRequest,
	ControlResponse,
	EventWaitResult,
	Hello,
	PaneState,
	RunResult,
	StatusEntry,
	WaitableEvent,
	WaitResult,
} from "../core/daemonProtocol"
import { PROTOCOL_VERSION } from "../core/daemonProtocol"
import { errMessage } from "../core/errors"
import { encode, LineDecoder } from "../core/protocol"
import { ordoDir, scrollbackPath } from "../core/session"
import { acquireSingletonLock, type SingletonLock, singletonLockSupported } from "../platform/lock"
import { buildProcessIndex, deepestWhitelisted, snapshotProcesses } from "../platform/proctree"
import { ALL_WAITABLE_EVENTS, clampInt, matchEventWaiter, matchWaiter } from "./messages"
import { Pane, type SockState } from "./pane"
import { SocketWriter } from "./socketWriter"

interface PendingWait {
	from?: string
	sock: Socket<SockState>
	reqId: number
	timer: ReturnType<typeof setTimeout>
}

interface EventWaiter {
	sock: Socket<SockState>
	reqId: number
	session: string
	kinds: Set<WaitableEvent>
	filterPane?: string
	from?: string
	timer: ReturnType<typeof setTimeout>
}

interface PendingSpawn {
	sock: Socket<SockState>
	reqId: number
	session: string
	timer: ReturnType<typeof setTimeout>
}

const WAIT_DEFAULT_MS = 60000
const WAIT_MIN_MS = 1000
const WAIT_MAX_MS = 300000
const READ_DEFAULT_LINES = 120
const READ_MAX_LINES = 2000
const SPAWN_TIMEOUT_MS = 20000
const RUN_DEFAULT_MS = 30000
const RUN_MIN_MS = 1000
const RUN_MAX_MS = 300000
const RUN_OUTPUT_CAP = 256 * 1024

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/**
 * Returns true if a compatible daemon named in daemon.json is already listening
 * and answers a ping. A daemon running an incompatible protocol version is asked
 * to shut down (so this process can cleanly take over) and reported as absent.
 */
async function probeExistingDaemon(): Promise<boolean> {
	const info = readDaemonInfo()
	if (!info) return false
	return new Promise<boolean>((resolve) => {
		let settled = false
		let sock: Socket<undefined> | undefined
		const done = (v: boolean) => {
			if (settled) return
			settled = true
			clearTimeout(timer)
			try {
				sock?.end()
			} catch {}
			resolve(v)
		}
		const timer = setTimeout(() => done(false), 300)
		const decoder = new LineDecoder<ControlResponse>()
		Bun.connect<undefined>({
			hostname: "127.0.0.1",
			port: info.port,
			socket: {
				open: (s) => {
					sock = s
					const hello: ControlHello = { kind: "control", token: info.token }
					s.write(encode(hello))
					s.write(encode({ id: 1, op: "ping" }))
					s.flush()
				},
				data: (s, chunk) => {
					try {
						for (const msg of decoder.push(chunk)) {
							if ("id" in msg && msg.ok) {
								const v = (msg.result as { v?: number } | undefined)?.v
								if (v !== undefined && v !== PROTOCOL_VERSION) {
									try {
										s.write(encode({ id: 2, op: "shutdown" }))
										s.flush()
									} catch {}
									return done(false)
								}
								return done(true)
							}
						}
					} catch {
						done(false)
					}
				},
				error: () => done(false),
				connectError: () => done(false),
			},
		}).catch(() => done(false))
	})
}

const KEY_SEP = "\0"
const key = (session: string, pane: string) => `${session}${KEY_SEP}${pane}`
const keyPrefix = (session: string) => `${session}${KEY_SEP}`

async function readCapped(
	stream: ReadableStream<Uint8Array> | null | undefined,
	cap: number,
): Promise<{ text: string; truncated: boolean }> {
	if (!stream) return { text: "", truncated: false }
	const reader = stream.getReader()
	const chunks: Uint8Array[] = []
	let total = 0
	let truncated = false
	try {
		while (true) {
			const { done, value } = await reader.read()
			if (done) break
			if (!value) continue
			if (total < cap) {
				chunks.push(value)
				total += value.byteLength
			} else {
				truncated = true
			}
		}
	} catch {
	} finally {
		try {
			reader.releaseLock()
		} catch {}
	}
	let text = Buffer.concat(chunks.map((c) => Buffer.from(c))).toString("utf8")
	if (text.length > cap) {
		text = text.slice(0, cap)
		truncated = true
	}
	return { text, truncated }
}

class Daemon {
	private readonly panes = new Map<string, Pane>()
	private readonly controls = new Set<Socket<SockState>>()
	private readonly waiters = new Map<string, PendingWait>()
	private readonly statuses = new Map<string, StatusEntry>()
	private readonly eventWaiters = new Map<number, EventWaiter>()
	private readonly pendingSpawns = new Map<number, PendingSpawn>()
	private nextEventWaiterId = 1
	private nextSpawnId = 1
	private server?: TCPSocketListener<SockState>
	private readonly token = crypto.randomUUID()
	private shuttingDown = false
	private fgTimer?: ReturnType<typeof setInterval>
	private lock: SingletonLock | null = null

	/** One process-table scan per tick resolves every pane's foreground program. */
	private startForegroundScan(): void {
		if (this.fgTimer || RESTORE_PROGRAMS.size === 0) return
		if (this.controls.size === 0 || this.panes.size === 0) return
		this.fgTimer = setInterval(() => {
			if (this.controls.size === 0) return
			const index = buildProcessIndex(snapshotProcesses())
			for (const pane of this.panes.values()) {
				if (pane.alive && pane.state.pid !== undefined) {
					pane.updateForeground(deepestWhitelisted(index, pane.state.pid, RESTORE_PROGRAMS))
				}
			}
		}, 2000)
	}

	private stopForegroundScanIfIdle(): void {
		if ((this.panes.size === 0 || this.controls.size === 0) && this.fgTimer) {
			clearInterval(this.fgTimer)
			this.fgTimer = undefined
		}
	}

	async start(): Promise<void> {
		const lockPath = join(ordoDir(), "daemon.singleton")
		this.lock = acquireSingletonLock(lockPath)
		if (!this.lock) {
			if (await probeExistingDaemon()) process.exit(0)
			if (singletonLockSupported) {
				for (let i = 0; i < 30; i++) {
					await sleep(100)
					this.lock = acquireSingletonLock(lockPath)
					if (this.lock) break
					if (await probeExistingDaemon()) process.exit(0)
				}
				if (!this.lock) process.exit(1)
			}
		}
		this.server = Bun.listen<SockState>({
			hostname: "127.0.0.1",
			port: 0,
			socket: {
				open: (sock) => {
					sock.data = {
						decoder: new LineDecoder<Hello | ControlRequest | AttachClientMsg>(undefined, (line) =>
							console.error(`[ordo daemon] dropped malformed line (${line.length} chars)`),
						),
						writer: new SocketWriter(sock, CLIENT_OVERFLOW_BYTES, () => {
							try {
								sock.end()
							} catch {}
						}),
					}
				},
				data: (sock, chunk) => this.onData(sock, chunk),
				drain: (sock) => sock.data.writer?.drain(),
				close: (sock) => this.onClose(sock),
				error: (sock) => this.onClose(sock),
			},
		})
		const infoPath = daemonInfoPath()
		const tmp = `${infoPath}.tmp`
		writeFileSync(
			tmp,
			JSON.stringify({ port: this.server.port, token: this.token, pid: process.pid }),
		)
		renameSync(tmp, infoPath)
		this.installExitHandlers()
	}

	private installExitHandlers(): void {
		const graceful = () => this.shutdownAll(0)
		process.on("SIGINT", graceful)
		process.on("SIGTERM", graceful)
		process.on("SIGBREAK", graceful)
		process.on("uncaughtException", (err) => {
			console.error("[ordo daemon] uncaught:", err)
		})
		process.on("unhandledRejection", (err) => {
			console.error("[ordo daemon] unhandled rejection:", err)
		})
		process.on("exit", () => {
			for (const pane of this.panes.values()) {
				try {
					pane.kill()
				} catch {}
			}
		})
	}

	private shutdownAll(code: number): void {
		if (this.shuttingDown) return
		this.shuttingDown = true
		const flushes: Promise<void>[] = []
		for (const pane of this.panes.values()) {
			try {
				pane.kill()
				flushes.push(pane.flushed)
			} catch {}
		}
		try {
			this.server?.stop(true)
		} catch {}
		try {
			if (readDaemonInfo()?.pid === process.pid) rmSync(daemonInfoPath(), { force: true })
		} catch {}
		try {
			this.lock?.release()
		} catch {}
		const done = () => process.exit(code)
		Promise.race([Promise.allSettled(flushes), sleep(500)]).then(done, done)
	}

	private onData(sock: Socket<SockState>, chunk: Uint8Array): void {
		let msgs: Array<Hello | ControlRequest | AttachClientMsg>
		try {
			msgs = sock.data.decoder.push(chunk)
		} catch {
			try {
				sock.end()
			} catch {}
			return
		}
		for (const msg of msgs) {
			try {
				if (!sock.data.kind) {
					this.onHello(sock, msg as Hello)
				} else if (sock.data.kind === "control") {
					this.onControl(sock, msg as ControlRequest)
				} else {
					this.onAttachMsg(sock, msg as AttachClientMsg)
				}
			} catch (err) {
				console.error("[ordo daemon] message error:", err)
			}
		}
	}

	private onHello(sock: Socket<SockState>, hello: Hello): void {
		if (!hello || hello.token !== this.token) {
			sock.end()
			return
		}
		if (hello.v !== undefined && hello.v !== PROTOCOL_VERSION) {
			sock.end()
			return
		}
		if (hello.kind === "control") {
			sock.data.kind = "control"
			sock.data.ownedSession = hello.session
			this.controls.add(sock)
			this.startForegroundScan()
		} else if (hello.kind === "attach") {
			sock.data.kind = "attach"
			const pane = this.panes.get(key(hello.session, hello.pane))
			if (!pane) {
				sock.end() // orchestrator must createPane first
				return
			}
			sock.data.paneKey = key(hello.session, hello.pane)
			pane.attach(sock, hello.cols, hello.rows)
		} else {
			sock.end()
		}
	}

	private onControl(sock: Socket<SockState>, req: ControlRequest): void {
		const reply = (res: ControlResponse) => {
			sock.data.writer?.write(encode(res))
		}
		try {
			switch (req.op) {
				case "ping": {
					reply({ id: req.id, ok: true, result: { pid: process.pid, v: PROTOCOL_VERSION } })
					break
				}
				case "createPane": {
					const k = key(req.session, req.pane)
					const existing = this.panes.get(k)
					if (existing?.alive) {
						if (req.color !== undefined) existing.state.color = req.color
						reply({ id: req.id, ok: true, result: { warm: true, state: existing.state } })
						break
					}
					const capture = scrollbackPath(req.session, req.pane)
					const cold = existsSync(capture)
					const pane = new Pane(
						req.session,
						req.pane,
						{
							cwd: req.cwd,
							color: req.color,
							replay: cold,
							relaunch: cold ? req.relaunch : undefined,
							launch: req.launch,
						},
						(e) => this.emit(e),
						(purged) => {
							this.panes.delete(k)
							this.statuses.delete(k)
							this.stopForegroundScanIfIdle()
							// A purged pane (user closed its window) reports paneClosed so the
							// orchestrator de-registers it; a plain shell exit reports paneExited.
							this.emit({
								event: purged ? "paneClosed" : "paneExited",
								session: req.session,
								pane: req.pane,
							})
						},
					)
					this.panes.set(k, pane)
					this.startForegroundScan()
					reply({ id: req.id, ok: true, result: { warm: false, cold, state: pane.state } })
					this.emit({ event: "paneCreated", session: req.session, state: pane.state })
					break
				}
				case "getState": {
					const states: PaneState[] = []
					const prefix = keyPrefix(req.session)
					for (const [k, pane] of this.panes) {
						if (k.startsWith(prefix)) states.push({ ...pane.state, live: pane.alive })
					}
					reply({ id: req.id, ok: true, result: { panes: states } })
					break
				}
				case "killPane": {
					this.panes.get(key(req.session, req.pane))?.kill()
					reply({ id: req.id, ok: true })
					break
				}
				case "detachSession": {
					this.detachSessionClients(req.session)
					reply({ id: req.id, ok: true })
					break
				}
				case "requestPane": {
					this.handleRequestPane(sock, req)
					break
				}
				case "resolveSpawn": {
					this.handleResolveSpawn(sock, req)
					break
				}
				case "broadcast": {
					this.handleBroadcast(sock, req)
					break
				}
				case "setStatus": {
					const k = key(req.session, req.pane)
					const status = req.status.trim()
					const ts = Date.now()
					if (status === "") this.statuses.delete(k)
					else this.statuses.set(k, { pane: req.pane, status, task: req.task, ts })
					reply({ id: req.id, ok: true })
					this.emit({
						event: "status",
						session: req.session,
						pane: req.pane,
						status,
						task: req.task,
						ts,
					})
					break
				}
				case "getStatus": {
					const prefix = keyPrefix(req.session)
					const entries: StatusEntry[] = []
					for (const [k, entry] of this.statuses) if (k.startsWith(prefix)) entries.push(entry)
					reply({ id: req.id, ok: true, result: { entries } })
					break
				}
				case "waitForEvent": {
					this.handleWaitForEvent(sock, req)
					break
				}
				case "runCommand": {
					this.handleRunCommand(sock, req)
					break
				}
				case "sendMessage": {
					this.handleSendMessage(sock, req)
					break
				}
				case "readPane": {
					this.handleReadPane(sock, req)
					break
				}
				case "waitForMessage": {
					this.handleWaitForMessage(sock, req)
					break
				}
				case "interrupt": {
					const pane = this.panes.get(key(req.session, req.pane))
					if (!pane?.alive) reply({ id: req.id, ok: false, error: "no such pane" })
					else {
						pane.interrupt()
						reply({ id: req.id, ok: true })
					}
					break
				}
				case "shutdown": {
					reply({ id: req.id, ok: true })
					const finish = () => this.shutdownAll(0)
					sock.data.writer?.onEmpty(finish)
					setTimeout(finish, 250)
					break
				}
			}
		} catch (err) {
			reply({ id: req.id, ok: false, error: errMessage(err) })
		}
	}

	private onAttachMsg(sock: Socket<SockState>, msg: AttachClientMsg): void {
		const pane = sock.data.paneKey ? this.panes.get(sock.data.paneKey) : undefined
		if (!pane) return
		if (msg.t === "i") pane.input(Buffer.from(msg.d, "base64"))
		else if (msg.t === "r") pane.resize(msg.c, msg.r)
	}

	private async deliverTo(
		session: string,
		pane: string,
		from: string,
		text: string,
		enter: boolean,
		raw?: boolean,
	): Promise<{ delivered: "typed" | "waiter" } | { error: string }> {
		const targetKey = key(session, pane)
		const target = this.panes.get(targetKey)
		if (!target?.alive) return { error: "no such pane" }
		const ts = Date.now()
		const waiter = this.waiters.get(targetKey)
		if (waiter && matchWaiter(waiter, from)) {
			this.resolveWaiter(targetKey, { from, text, ts })
			this.emit({ event: "message", session, from, to: pane, text, ts, delivered: "waiter" })
			return { delivered: "waiter" }
		}
		try {
			await target.sendTyped(text, enter, raw)
			this.emit({ event: "message", session, from, to: pane, text, ts, delivered: "typed" })
			return { delivered: "typed" }
		} catch (err) {
			return { error: errMessage(err) }
		}
	}

	private handleSendMessage(
		sock: Socket<SockState>,
		req: Extract<ControlRequest, { op: "sendMessage" }>,
	): void {
		const reply = (res: ControlResponse) => sock.data.writer?.write(encode(res))
		const from = req.from ?? "?"
		if (req.from !== undefined && req.from === req.pane) {
			reply({ id: req.id, ok: false, error: "cannot message yourself" })
			return
		}
		this.deliverTo(req.session, req.pane, from, req.text, req.enter !== false, req.raw)
			.then((res) => {
				if ("error" in res) reply({ id: req.id, ok: false, error: res.error })
				else reply({ id: req.id, ok: true, result: { delivered: res.delivered } })
			})
			.catch((err) => reply({ id: req.id, ok: false, error: errMessage(err) }))
	}

	private handleBroadcast(
		sock: Socket<SockState>,
		req: Extract<ControlRequest, { op: "broadcast" }>,
	): void {
		const reply = (res: ControlResponse) => sock.data.writer?.write(encode(res))
		const from = req.from ?? "?"
		const prefix = keyPrefix(req.session)
		const targets: string[] = []
		for (const [k, pane] of this.panes) {
			if (!k.startsWith(prefix) || !pane.alive || pane.pane === from) continue
			targets.push(pane.pane)
		}
		Promise.all(
			targets.map(async (t) => {
				const res = await this.deliverTo(req.session, t, from, req.text, true, false)
				return "error" in res
					? { pane: t, error: res.error }
					: { pane: t, delivered: res.delivered }
			}),
		)
			.then((results) => {
				const payload: BroadcastResult = { results }
				reply({ id: req.id, ok: true, result: payload })
			})
			.catch((err) => reply({ id: req.id, ok: false, error: errMessage(err) }))
	}

	private handleWaitForEvent(
		sock: Socket<SockState>,
		req: Extract<ControlRequest, { op: "waitForEvent" }>,
	): void {
		const kinds = new Set<WaitableEvent>(
			req.events && req.events.length > 0 ? req.events : ALL_WAITABLE_EVENTS,
		)
		const ms = clampInt(req.timeoutMs, WAIT_DEFAULT_MS, WAIT_MIN_MS, WAIT_MAX_MS)
		const id = this.nextEventWaiterId++
		const timer = setTimeout(() => this.resolveEventWaiter(id, { timeout: true }), ms)
		this.eventWaiters.set(id, {
			sock,
			reqId: req.id,
			session: req.session,
			kinds,
			filterPane: req.filterPane,
			from: req.from,
			timer,
		})
	}

	private resolveEventWaiter(id: number, result: EventWaitResult): void {
		const w = this.eventWaiters.get(id)
		if (!w) return
		this.eventWaiters.delete(id)
		clearTimeout(w.timer)
		try {
			w.sock.data.writer?.write(encode({ id: w.reqId, ok: true, result }))
		} catch {}
	}

	private findOwner(session: string): Socket<SockState> | undefined {
		for (const c of this.controls) if (c.data.ownedSession === session) return c
		return undefined
	}

	private handleRequestPane(
		sock: Socket<SockState>,
		req: Extract<ControlRequest, { op: "requestPane" }>,
	): void {
		const reply = (res: ControlResponse) => sock.data.writer?.write(encode(res))
		const owner = this.findOwner(req.session)
		if (!owner) {
			reply({
				id: req.id,
				ok: false,
				error: "the ordo command center for this session is not open",
			})
			return
		}
		const requestId = this.nextSpawnId++
		const timer = setTimeout(() => {
			const pending = this.pendingSpawns.get(requestId)
			if (!pending) return
			this.pendingSpawns.delete(requestId)
			try {
				pending.sock.data.writer?.write(
					encode({ id: pending.reqId, ok: false, error: "spawn request timed out" }),
				)
			} catch {}
		}, SPAWN_TIMEOUT_MS)
		this.pendingSpawns.set(requestId, { sock, reqId: req.id, session: req.session, timer })
		try {
			owner.data.writer?.write(
				encode({
					event: "spawnRequest",
					session: req.session,
					requestId,
					requestedBy: req.requestedBy,
					name: req.name,
					cwd: req.cwd,
					agent: req.agent,
				}),
			)
		} catch {}
	}

	private handleResolveSpawn(
		sock: Socket<SockState>,
		req: Extract<ControlRequest, { op: "resolveSpawn" }>,
	): void {
		const reply = (res: ControlResponse) => sock.data.writer?.write(encode(res))
		const pending = this.pendingSpawns.get(req.requestId)
		if (!pending) {
			reply({ id: req.id, ok: false, error: "unknown spawn request" })
			return
		}
		this.pendingSpawns.delete(req.requestId)
		clearTimeout(pending.timer)
		try {
			pending.sock.data.writer?.write(
				encode(
					req.pane
						? { id: pending.reqId, ok: true, result: { pane: req.pane } }
						: { id: pending.reqId, ok: false, error: req.error ?? "spawn failed" },
				),
			)
		} catch {}
		reply({ id: req.id, ok: true })
	}

	private handleRunCommand(
		sock: Socket<SockState>,
		req: Extract<ControlRequest, { op: "runCommand" }>,
	): void {
		const reply = (res: ControlResponse) => sock.data.writer?.write(encode(res))
		const ms = clampInt(req.timeoutMs, RUN_DEFAULT_MS, RUN_MIN_MS, RUN_MAX_MS)
		let proc: import("bun").Subprocess<"ignore", "pipe", "pipe">
		try {
			proc = Bun.spawn(
				[powershellExe(), "-NoProfile", "-NonInteractive", "-Command", req.command],
				{
					cwd: req.cwd && existsSync(req.cwd) ? req.cwd : undefined,
					stdin: "ignore",
					stdout: "pipe",
					stderr: "pipe",
					env: process.env,
				},
			)
		} catch (err) {
			reply({ id: req.id, ok: false, error: errMessage(err) })
			return
		}
		let timedOut = false
		const timer = setTimeout(() => {
			timedOut = true
			try {
				proc.kill()
			} catch {}
		}, ms)
		Promise.all([
			readCapped(proc.stdout, RUN_OUTPUT_CAP),
			readCapped(proc.stderr, RUN_OUTPUT_CAP),
			proc.exited,
		])
			.then(([out, err, code]) => {
				clearTimeout(timer)
				const result: RunResult = {
					exitCode: timedOut ? null : code,
					stdout: out.text,
					stderr: err.text,
					timedOut,
					truncated: out.truncated || err.truncated,
				}
				reply({ id: req.id, ok: true, result })
			})
			.catch((e) => {
				clearTimeout(timer)
				reply({ id: req.id, ok: false, error: errMessage(e) })
			})
	}

	private handleReadPane(
		sock: Socket<SockState>,
		req: Extract<ControlRequest, { op: "readPane" }>,
	): void {
		const reply = (res: ControlResponse) => sock.data.writer?.write(encode(res))
		const pane = this.panes.get(key(req.session, req.pane))
		if (!pane) {
			reply({ id: req.id, ok: false, error: "no such pane" })
			return
		}
		pane
			.readText(clampInt(req.lines, READ_DEFAULT_LINES, 1, READ_MAX_LINES))
			.then((text) => reply({ id: req.id, ok: true, result: { text } }))
			.catch((err) => reply({ id: req.id, ok: false, error: errMessage(err) }))
	}

	private handleWaitForMessage(
		sock: Socket<SockState>,
		req: Extract<ControlRequest, { op: "waitForMessage" }>,
	): void {
		const reply = (res: ControlResponse) => sock.data.writer?.write(encode(res))
		const targetKey = key(req.session, req.pane)
		if (!this.panes.has(targetKey)) {
			reply({ id: req.id, ok: false, error: "no such pane" })
			return
		}
		if (this.waiters.has(targetKey)) this.resolveWaiter(targetKey, { timeout: true })
		const ms = clampInt(req.timeoutMs, WAIT_DEFAULT_MS, WAIT_MIN_MS, WAIT_MAX_MS)
		const timer = setTimeout(() => this.resolveWaiter(targetKey, { timeout: true }), ms)
		this.waiters.set(targetKey, { from: req.from, sock, reqId: req.id, timer })
	}

	private resolveWaiter(targetKey: string, result: WaitResult): void {
		const waiter = this.waiters.get(targetKey)
		if (!waiter) return
		this.waiters.delete(targetKey)
		clearTimeout(waiter.timer)
		try {
			waiter.sock.data.writer?.write(encode({ id: waiter.reqId, ok: true, result }))
		} catch {}
	}

	private onClose(sock: Socket<SockState>): void {
		if (this.controls.delete(sock)) {
			this.stopForegroundScanIfIdle()
			if (sock.data?.ownedSession) {
				// The orchestrator (main window) went away — close its panes' client
				// windows but keep the shells alive for a later restore.
				this.detachSessionClients(sock.data.ownedSession)
			}
		}
		for (const [k, w] of this.waiters) {
			if (w.sock === sock) {
				clearTimeout(w.timer)
				this.waiters.delete(k)
			}
		}
		for (const [id, w] of this.eventWaiters) {
			if (w.sock === sock) {
				clearTimeout(w.timer)
				this.eventWaiters.delete(id)
			}
		}
		for (const [rid, p] of this.pendingSpawns) {
			const requesterGone = p.sock === sock
			const ownerGone = sock.data?.ownedSession === p.session
			if (!requesterGone && !ownerGone) continue
			clearTimeout(p.timer)
			this.pendingSpawns.delete(rid)
			if (!requesterGone) {
				try {
					p.sock.data.writer?.write(
						encode({ id: p.reqId, ok: false, error: "the ordo command center closed" }),
					)
				} catch {}
			}
		}
		if (sock.data?.paneKey) this.panes.get(sock.data.paneKey)?.detach(sock)
	}

	/** Close every client window of a session's panes; the shells stay alive. */
	private detachSessionClients(session: string): void {
		const prefix = keyPrefix(session)
		for (const [k, pane] of this.panes) {
			if (k.startsWith(prefix)) pane.detachAll()
		}
	}

	private emit(event: ControlEvent): void {
		const bytes = encode(event)
		for (const c of this.controls) {
			try {
				c.data.writer?.write(bytes)
			} catch {}
		}
		if (this.eventWaiters.size === 0) return
		for (const [id, w] of [...this.eventWaiters]) {
			const res = matchEventWaiter(w, event)
			if (res) this.resolveEventWaiter(id, res)
		}
	}
}

void new Daemon().start()
