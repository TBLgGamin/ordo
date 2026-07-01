/**
 * Orchestrator-side handle to the persistent daemon: discovers/spawns it and
 * exposes a small RPC (createPane/getState/…) plus a subscription to pane events.
 *
 * The daemon is launched windowless and detached via `Start-Process -WindowStyle
 * Hidden` (Bun's own spawn can't outlive its parent on Windows), so it survives
 * the app closing. Discovery is via %APPDATA%\ordo\daemon.json.
 */

import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import type { Socket } from "bun"
import { BUN_EXE, DAEMON_PATH, POWERSHELL_EXE } from "../core/config"
import type {
	ControlEvent,
	ControlHello,
	ControlRequest,
	ControlResponse,
	PaneState,
} from "../core/daemonProtocol"
import { encode, LineDecoder } from "../core/protocol"
import { ordoDir } from "../core/session"

interface DaemonInfo {
	port: number
	token: string
	pid: number
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** Omit that distributes over a union (so each variant keeps its own shape). */
type DistributiveOmit<T, K extends keyof T> = T extends unknown ? Omit<T, K> : never
type RequestBody = DistributiveOmit<ControlRequest, "id">

export class DaemonClient {
	private sock?: Socket<undefined>
	private token = ""
	private ownedSession?: string
	private readonly decoder = new LineDecoder<ControlResponse | ControlEvent>()
	private nextId = 1
	private readonly pending = new Map<
		number,
		{ resolve: (v: unknown) => void; reject: (e: Error) => void }
	>()
	private readonly listeners = new Set<(e: ControlEvent) => void>()

	/** Subscribe to daemon pane events. Returns an unsubscribe fn. */
	on(listener: (e: ControlEvent) => void): () => void {
		this.listeners.add(listener)
		return () => this.listeners.delete(listener)
	}

	/**
	 * Ensure a daemon is running and we're connected to it. `session` is the one
	 * this orchestrator owns; the daemon closes its client windows if we disconnect.
	 */
	async ensure(session?: string): Promise<void> {
		this.ownedSession = session
		if (await this.tryConnect()) return
		await this.spawnDaemon()
		for (let i = 0; i < 40; i++) {
			await sleep(200)
			if (await this.tryConnect()) return
		}
		throw new Error("session daemon did not start")
	}

	private readInfo(): DaemonInfo | null {
		const path = join(ordoDir(), "daemon.json")
		if (!existsSync(path)) return null
		try {
			return JSON.parse(readFileSync(path, "utf8")) as DaemonInfo
		} catch {
			return null
		}
	}

	private async tryConnect(): Promise<boolean> {
		const info = this.readInfo()
		if (!info) return false
		try {
			await this.connectControl(info)
			await this.request<{ pid: number }>({ op: "ping" }, 1500)
			return true
		} catch {
			try {
				this.sock?.end()
			} catch {}
			this.sock = undefined
			return false
		}
	}

	private connectControl(info: DaemonInfo): Promise<void> {
		this.token = info.token
		return new Promise<void>((resolve, reject) => {
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
						resolve()
					},
					data: (_sock, chunk) => this.onData(chunk),
					close: () => this.onDisconnect(),
					error: () => this.onDisconnect(),
					connectError: (_s, e) => reject(e),
				},
			}).catch(reject)
		})
	}

	private onData(chunk: Uint8Array): void {
		for (const msg of this.decoder.push(chunk)) {
			if ("id" in msg) {
				const p = this.pending.get(msg.id)
				if (p) {
					this.pending.delete(msg.id)
					if (msg.ok) p.resolve(msg.result)
					else p.reject(new Error(msg.error))
				}
			} else if ("event" in msg) {
				for (const l of this.listeners) l(msg)
			}
		}
	}

	private onDisconnect(): void {
		this.sock = undefined
		for (const { reject } of this.pending.values()) reject(new Error("daemon disconnected"))
		this.pending.clear()
	}

	private request<T>(req: RequestBody, timeoutMs = 5000): Promise<T> {
		const sock = this.sock
		if (!sock) return Promise.reject(new Error("not connected to daemon"))
		const id = this.nextId++
		const full = { ...req, id } as ControlRequest
		return new Promise<T>((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pending.delete(id)
				reject(new Error(`daemon request '${req.op}' timed out`))
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
		const proc = Bun.spawn([POWERSHELL_EXE, "-NoProfile", "-Command", ps], {
			stdin: "ignore",
			stdout: "ignore",
			stderr: "ignore",
		})
		await proc.exited
	}

	createPane(
		session: string,
		pane: string,
		opts: { cwd?: string; relaunch?: string } = {},
	): Promise<{ warm: boolean; cold?: boolean; state: PaneState }> {
		return this.request({ op: "createPane", session, pane, cwd: opts.cwd, relaunch: opts.relaunch })
	}

	getState(session: string): Promise<{ panes: PaneState[] }> {
		return this.request({ op: "getState", session })
	}

	killPane(session: string, pane: string): Promise<void> {
		return this.request({ op: "killPane", session, pane })
	}

	/** Close all client windows for a session but keep the shells alive in the daemon. */
	detachSession(session: string): Promise<void> {
		return this.request({ op: "detachSession", session })
	}

	stop(): void {
		try {
			this.sock?.end()
		} catch {}
		this.sock = undefined
	}
}
