/**
 * Orchestrator-side handle to the persistent daemon: discovers/spawns it and
 * exposes a small RPC (createPane/getState/…) plus a subscription to pane events.
 *
 * The daemon is launched windowless and detached via `Start-Process -WindowStyle
 * Hidden` (Bun's own spawn can't outlive its parent on Windows), so it survives
 * the app closing. Discovery is via %APPDATA%\ordo\daemon.json.
 */

import type { Socket } from "bun"
import { BUN_EXE, DAEMON_PATH, powershellExe } from "../core/config"
import { type DaemonInfo, readDaemonInfo } from "../core/daemonInfo"
import type {
	BroadcastResult,
	ControlEvent,
	ControlHello,
	ControlRequest,
	ControlResponse,
	EventWaitResult,
	MessageDelivery,
	PaneState,
	RunResult,
	StatusEntry,
	WaitableEvent,
	WaitResult,
} from "../core/daemonProtocol"
import { PROTOCOL_VERSION } from "../core/daemonProtocol"
import { errMessage, OrdoError } from "../core/errors"
import { encode, LineDecoder } from "../core/protocol"
import { ordoDir } from "../core/session"
import { acquireSpawnLock, releaseSpawnLock } from "./spawnLock"

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

export const SPAWN_CLIENT_TIMEOUT_MS = 25000

const DAEMON_UNREACHABLE_HINT = "open an ordo window (run `ordo`) to start it, then retry."

/** Omit that distributes over a union (so each variant keeps its own shape). */
type DistributiveOmit<T, K extends keyof T> = T extends unknown ? Omit<T, K> : never
type RequestBody = DistributiveOmit<ControlRequest, "id">

export class DaemonClient {
	private sock?: Socket<undefined>
	private ownedSession?: string
	private readonly decoder = new LineDecoder<ControlResponse | ControlEvent>()
	private nextId = 1
	private readonly pending = new Map<
		number,
		{ resolve: (v: unknown) => void; reject: (e: Error) => void }
	>()
	private readonly listeners = new Set<(e: ControlEvent) => void>()
	private readonly connListeners = new Set<(up: boolean) => void>()
	private connected = false
	private closedByUser = false
	private reconnecting = false
	private daemonPid?: number

	get connectedPid(): number | undefined {
		return this.daemonPid
	}

	get isConnected(): boolean {
		return this.connected
	}

	/** Subscribe to daemon pane events. Returns an unsubscribe fn. */
	on(listener: (e: ControlEvent) => void): () => void {
		this.listeners.add(listener)
		return () => this.listeners.delete(listener)
	}

	/** Subscribe to connection up/down transitions after an established link drops. */
	onConnection(cb: (up: boolean) => void): () => void {
		this.connListeners.add(cb)
		return () => this.connListeners.delete(cb)
	}

	private notifyConnection(up: boolean): void {
		for (const cb of this.connListeners) {
			try {
				cb(up)
			} catch {}
		}
	}

	/** Attempt to attach to a running daemon without ever spawning one. */
	tryAttach(opts: { connectTimeoutMs?: number } = {}): Promise<boolean> {
		return this.tryConnect(opts.connectTimeoutMs)
	}

	/**
	 * Ensure a daemon is running and we're connected to it. `session` is the one
	 * this orchestrator owns; the daemon closes its client windows if we disconnect.
	 */
	async ensure(session?: string): Promise<void> {
		this.ownedSession = session
		if (await this.tryConnect()) return
		if (!this.acquireSpawnLock()) {
			for (let i = 0; i < 40; i++) {
				await sleep(200)
				if (await this.tryConnect()) return
			}
			throw new Error("session daemon did not start")
		}
		try {
			if (await this.tryConnect()) return
			await this.spawnDaemon()
			for (let i = 0; i < 40; i++) {
				await sleep(200)
				if (await this.tryConnect()) return
			}
			throw new Error("session daemon did not start")
		} finally {
			this.releaseSpawnLock()
		}
	}

	private lockPath?: string

	private acquireSpawnLock(): boolean {
		this.lockPath = acquireSpawnLock(ordoDir()) ?? undefined
		return this.lockPath !== undefined
	}

	private releaseSpawnLock(): void {
		releaseSpawnLock(this.lockPath)
		this.lockPath = undefined
	}

	private async tryConnect(connectTimeoutMs?: number): Promise<boolean> {
		const info = readDaemonInfo()
		if (!info) return false
		try {
			await this.connectControl(info, connectTimeoutMs)
			const res = await this.request<{ pid: number; v?: number }>({ op: "ping" }, 1500)
			this.daemonPid = res.pid
			if (res.v !== undefined && res.v !== PROTOCOL_VERSION) {
				try {
					await this.request({ op: "shutdown" }, 1000)
				} catch {}
				this.connected = false
				try {
					this.sock?.end()
				} catch {}
				this.sock = undefined
				return false
			}
			this.connected = true
			return true
		} catch {
			try {
				this.sock?.end()
			} catch {}
			this.sock = undefined
			return false
		}
	}

	private connectControl(info: DaemonInfo, connectTimeoutMs = 2000): Promise<void> {
		return new Promise<void>((resolve, reject) => {
			let settled = false
			const timer = setTimeout(() => {
				if (settled) return
				settled = true
				try {
					this.sock?.end()
				} catch {}
				reject(new Error("connect to daemon timed out"))
			}, connectTimeoutMs)
			const succeed = () => {
				if (settled) return
				settled = true
				clearTimeout(timer)
				resolve()
			}
			const fail = (e: Error) => {
				if (settled) return
				settled = true
				clearTimeout(timer)
				reject(e)
			}
			Bun.connect<undefined>({
				hostname: "127.0.0.1",
				port: info.port,
				socket: {
					open: (sock) => {
						this.sock = sock
						const hello: ControlHello = {
							kind: "control",
							token: info.token,
							session: this.ownedSession,
						}
						sock.write(encode(hello))
						sock.flush()
						succeed()
					},
					data: (_sock, chunk) => this.onData(chunk),
					close: () => this.onDisconnect(),
					error: () => this.onDisconnect(),
					connectError: (_s, e) => fail(e),
				},
			}).catch(fail)
		})
	}

	private onData(chunk: Uint8Array): void {
		let messages: (ControlResponse | ControlEvent)[]
		try {
			messages = this.decoder.push(chunk)
		} catch {
			try {
				this.sock?.end()
			} catch {}
			return
		}
		for (const msg of messages) {
			if ("id" in msg) {
				const p = this.pending.get(msg.id)
				if (p) {
					this.pending.delete(msg.id)
					if (msg.ok) p.resolve(msg.result)
					else p.reject(new OrdoError(msg.error, { code: msg.code }))
				}
			} else if ("event" in msg) {
				for (const l of this.listeners) {
					try {
						l(msg)
					} catch (e) {
						console.error(`ordo: daemon event listener failed: ${errMessage(e)}`)
					}
				}
			}
		}
	}

	private onDisconnect(): void {
		const wasConnected = this.connected
		this.connected = false
		this.sock = undefined
		for (const { reject } of this.pending.values())
			reject(new OrdoError("the ordo daemon disconnected", { hint: DAEMON_UNREACHABLE_HINT }))
		this.pending.clear()
		if (this.closedByUser || !wasConnected) return
		this.notifyConnection(false)
		void this.reconnect()
	}

	private async reconnect(): Promise<void> {
		if (this.reconnecting) return
		this.reconnecting = true
		try {
			for (let i = 0; i < 5; i++) {
				if (this.closedByUser) return
				await sleep(Math.min(500 * 2 ** i, 4000))
				if (this.closedByUser) return
				// Reconnect must never spawn a fresh (empty) daemon: if the daemon that
				// held our shells is gone, a new one cannot bring them back. Only re-attach
				// to the same still-running daemon; otherwise report the link as lost.
				try {
					if (await this.tryConnect()) {
						this.notifyConnection(true)
						return
					}
				} catch {}
			}
			this.notifyConnection(false)
		} finally {
			this.reconnecting = false
		}
	}

	private request<T>(req: RequestBody, timeoutMs = 5000): Promise<T> {
		const sock = this.sock
		if (!sock)
			return Promise.reject(
				new OrdoError("not connected to the ordo daemon", { hint: DAEMON_UNREACHABLE_HINT }),
			)
		const id = this.nextId++
		const full = { ...req, id } as ControlRequest
		return new Promise<T>((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pending.delete(id)
				reject(
					new OrdoError(`the ordo daemon did not respond to '${req.op}'`, {
						hint: DAEMON_UNREACHABLE_HINT,
					}),
				)
			}, timeoutMs)
			this.pending.set(id, {
				resolve: (v) => {
					clearTimeout(timer)
					resolve(v as T)
				},
				reject: (e) => {
					clearTimeout(timer)
					reject(e)
				},
			})
			sock.write(encode(full))
			sock.flush()
		})
	}

	private async spawnDaemon(): Promise<void> {
		// Start-Process makes the daemon independent of (and outliving) this app,
		// and -WindowStyle Hidden keeps it windowless. Single-quote the paths.
		const ps = `Start-Process -FilePath '${BUN_EXE}' -ArgumentList @('run','${DAEMON_PATH}') -WindowStyle Hidden`
		const proc = Bun.spawn([powershellExe(), "-NoProfile", "-Command", ps], {
			stdin: "ignore",
			stdout: "ignore",
			stderr: "ignore",
		})
		await proc.exited
	}

	createPane(
		session: string,
		pane: string,
		opts: { cwd?: string; color?: string; relaunch?: string; launch?: string } = {},
	): Promise<{ warm: boolean; cold?: boolean; state: PaneState }> {
		return this.request({
			op: "createPane",
			session,
			pane,
			cwd: opts.cwd,
			color: opts.color,
			relaunch: opts.relaunch,
			launch: opts.launch,
		})
	}

	requestPane(
		session: string,
		opts: { requestedBy?: string; name?: string; cwd?: string; agent?: string } = {},
	): Promise<{ pane: string }> {
		return this.request(
			{
				op: "requestPane",
				session,
				requestedBy: opts.requestedBy,
				name: opts.name,
				cwd: opts.cwd,
				agent: opts.agent,
			},
			SPAWN_CLIENT_TIMEOUT_MS,
		)
	}

	resolveSpawn(requestId: number, res: { pane?: string; error?: string }): Promise<void> {
		return this.request({ op: "resolveSpawn", requestId, pane: res.pane, error: res.error })
	}

	broadcast(session: string, opts: { from?: string; text: string }): Promise<BroadcastResult> {
		return this.request({ op: "broadcast", session, from: opts.from, text: opts.text })
	}

	setStatus(session: string, pane: string, status: string, task?: string): Promise<void> {
		return this.request({ op: "setStatus", session, pane, status, task })
	}

	getStatus(session: string): Promise<{ entries: StatusEntry[] }> {
		return this.request({ op: "getStatus", session })
	}

	waitForEvent(
		session: string,
		pane: string,
		opts: {
			events?: WaitableEvent[]
			filterPane?: string
			from?: string
			timeoutMs?: number
		} = {},
	): Promise<EventWaitResult> {
		const timeoutMs = opts.timeoutMs ?? 60000
		return this.request(
			{
				op: "waitForEvent",
				session,
				pane,
				events: opts.events,
				filterPane: opts.filterPane,
				from: opts.from,
				timeoutMs,
			},
			timeoutMs + 5000,
		)
	}

	runCommand(
		session: string,
		opts: { command: string; cwd?: string; timeoutMs?: number },
	): Promise<RunResult> {
		const timeoutMs = opts.timeoutMs ?? 30000
		return this.request(
			{ op: "runCommand", session, command: opts.command, cwd: opts.cwd, timeoutMs },
			timeoutMs + 5000,
		)
	}

	getState(session: string): Promise<{ panes: PaneState[] }> {
		return this.request({ op: "getState", session })
	}

	sendMessage(
		session: string,
		pane: string,
		opts: { from?: string; text: string; enter?: boolean; raw?: boolean },
	): Promise<MessageDelivery> {
		return this.request({
			op: "sendMessage",
			session,
			pane,
			from: opts.from,
			text: opts.text,
			enter: opts.enter,
			raw: opts.raw,
		})
	}

	readPane(session: string, pane: string, lines?: number): Promise<{ text: string }> {
		return this.request({ op: "readPane", session, pane, lines })
	}

	waitForMessage(
		session: string,
		pane: string,
		opts: { from?: string; timeoutMs?: number } = {},
	): Promise<WaitResult> {
		const timeoutMs = opts.timeoutMs ?? 60000
		return this.request(
			{ op: "waitForMessage", session, pane, from: opts.from, timeoutMs },
			timeoutMs + 5000,
		)
	}

	interrupt(session: string, pane: string): Promise<void> {
		return this.request({ op: "interrupt", session, pane })
	}

	killPane(session: string, pane: string): Promise<void> {
		return this.request({ op: "killPane", session, pane })
	}

	/** Close all client windows for a session but keep the shells alive in the daemon. */
	detachSession(session: string): Promise<void> {
		return this.request({ op: "detachSession", session })
	}

	stop(): void {
		this.closedByUser = true
		this.connected = false
		try {
			this.sock?.end()
		} catch {}
		this.sock = undefined
	}
}

/**
 * Kill every pane of a session in a running daemon, without ever spawning one.
 * Used by CLI `delete` so the daemon releases its capture-file handles before
 * the session's scrollback is removed. No-op if no daemon is running.
 */
export async function killSessionPanes(session: string): Promise<void> {
	const dc = new DaemonClient()
	try {
		if (!(await dc.tryAttach())) return
		const { panes } = await dc.getState(session)
		await Promise.allSettled(panes.map((p) => dc.killPane(session, p.pane)))
	} catch {
	} finally {
		dc.stop()
	}
}
