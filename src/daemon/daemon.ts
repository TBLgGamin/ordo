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

import { existsSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import type { Socket, TCPSocketListener } from "bun"
import type {
	AttachClientMsg,
	ControlEvent,
	ControlRequest,
	ControlResponse,
	Hello,
	PaneState,
} from "../core/daemonProtocol"
import { encode, LineDecoder } from "../core/protocol"
import { ordoDir, scrollbackPath } from "../core/session"
import { Pane, type SockState } from "./pane"

function daemonInfoPath(): string {
	return join(ordoDir(), "daemon.json")
}

const key = (session: string, pane: string) => `${session} ${pane}`

class Daemon {
	private readonly panes = new Map<string, Pane>()
	private readonly controls = new Set<Socket<SockState>>()
	private server?: TCPSocketListener<SockState>
	private readonly token = crypto.randomUUID()

	start(): void {
		this.server = Bun.listen<SockState>({
			hostname: "127.0.0.1",
			port: 0,
			socket: {
				open: (sock) => {
					sock.data = { decoder: new LineDecoder<Hello | ControlRequest | AttachClientMsg>() }
				},
				data: (sock, chunk) => this.onData(sock, chunk),
				close: (sock) => this.onClose(sock),
				error: (sock) => this.onClose(sock),
			},
		})
		writeFileSync(
			daemonInfoPath(),
			JSON.stringify({ port: this.server.port, token: this.token, pid: process.pid }),
		)
		// Keep the event loop alive.
		setInterval(() => {}, 1 << 30)
	}

	private onData(sock: Socket<SockState>, chunk: Uint8Array): void {
		// An attached client's bytes after its hello are newline-JSON frames too,
		// so everything flows through the line decoder.
		for (const msg of sock.data.decoder.push(chunk)) {
			if (!sock.data.kind) {
				this.onHello(sock, msg as Hello)
			} else if (sock.data.kind === "control") {
				this.onControl(sock, msg as ControlRequest)
			} else {
				this.onAttachMsg(sock, msg as AttachClientMsg)
			}
		}
	}

	private onHello(sock: Socket<SockState>, hello: Hello): void {
		if (!hello || hello.token !== this.token) {
			sock.end()
			return
		}
		if (hello.kind === "control") {
			sock.data.kind = "control"
			sock.data.ownedSession = hello.session
			this.controls.add(sock)
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
			sock.write(encode(res))
			sock.flush()
		}
		try {
			switch (req.op) {
				case "ping": {
					reply({ id: req.id, ok: true, result: { pid: process.pid } })
					break
				}
				case "createPane": {
					const k = key(req.session, req.pane)
					const existing = this.panes.get(k)
					if (existing?.state.live) {
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
							shell: req.shell,
							replay: cold,
							relaunch: cold ? req.relaunch : undefined,
						},
						(e) => this.emit(e),
						(purged) => {
							this.panes.delete(k)
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
					reply({ id: req.id, ok: true, result: { warm: false, cold, state: pane.state } })
					break
				}
				case "hasPane": {
					const pane = this.panes.get(key(req.session, req.pane))
					reply({ id: req.id, ok: true, result: { live: Boolean(pane?.state.live) } })
					break
				}
				case "getState": {
					const states: PaneState[] = []
					for (const [k, pane] of this.panes) {
						if (k.startsWith(`${req.session} `)) states.push({ ...pane.state })
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
					for (const pane of this.panes.values()) pane.kill()
					this.server?.stop(true)
					process.exit(0)
				}
			}
		} catch (err) {
			reply({ id: req.id, ok: false, error: (err as Error).message })
		}
	}

	private onAttachMsg(sock: Socket<SockState>, msg: AttachClientMsg): void {
		const pane = sock.data.paneKey ? this.panes.get(sock.data.paneKey) : undefined
		if (!pane) return
		if (msg.t === "i") pane.input(Buffer.from(msg.d, "base64"))
		else if (msg.t === "r") pane.resize(msg.c, msg.r)
	}

	private onClose(sock: Socket<SockState>): void {
		if (this.controls.delete(sock) && sock.data?.ownedSession) {
			// The orchestrator (main window) went away — close its panes' client
			// windows but keep the shells alive for a later restore.
			this.detachSessionClients(sock.data.ownedSession)
		}
		if (sock.data?.paneKey) this.panes.get(sock.data.paneKey)?.detach(sock)
	}

	/** Close every client window of a session's panes; the shells stay alive. */
	private detachSessionClients(session: string): void {
		for (const [k, pane] of this.panes) {
			if (k.startsWith(`${session} `)) pane.detachAll()
		}
	}

	private emit(event: ControlEvent): void {
		const bytes = encode(event)
		for (const c of this.controls) {
			try {
				c.write(bytes)
				c.flush()
			} catch {}
		}
	}
}

new Daemon().start()
