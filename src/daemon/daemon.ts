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
import { CLIENT_OVERFLOW_BYTES, RESTORE_PROGRAMS } from "../core/config"
import { daemonInfoPath, readDaemonInfo } from "../core/daemonInfo"
import type {
	AttachClientMsg,
	ControlEvent,
	ControlHello,
	ControlRequest,
	ControlResponse,
	Hello,
	PaneState,
} from "../core/daemonProtocol"
import { PROTOCOL_VERSION } from "../core/daemonProtocol"
import { errMessage } from "../core/errors"
import { encode, LineDecoder } from "../core/protocol"
import { ordoDir, scrollbackPath } from "../core/session"
import { acquireSingletonLock, type SingletonLock, singletonLockSupported } from "../platform/lock"
import { buildProcessIndex, deepestWhitelisted, snapshotProcesses } from "../platform/proctree"
import { Pane, type SockState } from "./pane"
import { SocketWriter } from "./socketWriter"

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

class Daemon {
	private readonly panes = new Map<string, Pane>()
	private readonly controls = new Set<Socket<SockState>>()
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
							replay: cold,
							relaunch: cold ? req.relaunch : undefined,
						},
						(e) => this.emit(e),
						(purged) => {
							this.panes.delete(k)
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

	private onClose(sock: Socket<SockState>): void {
		if (this.controls.delete(sock)) {
			this.stopForegroundScanIfIdle()
			if (sock.data?.ownedSession) {
				// The orchestrator (main window) went away — close its panes' client
				// windows but keep the shells alive for a later restore.
				this.detachSessionClients(sock.data.ownedSession)
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
	}
}

void new Daemon().start()
