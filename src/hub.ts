/**
 * The hub: a loopback TCP server that the central app runs. Every spawned pane
 * runs an agent that dials back in here, so the hub can push commands/input to
 * any pane on demand — the capability wt.exe itself does not provide.
 */

import type { Socket, TCPSocketListener } from "bun"
import { HUB_HOST, HUB_PORT } from "./config"
import { type AgentMessage, encode, type HubMessage, LineDecoder } from "./protocol"

/** One connected pane. */
export interface Pane {
	id: string
	pid: number
	socket: Socket<PaneState>
	connectedAt: number
}

/** Per-socket state Bun hands back to every socket callback. */
interface PaneState {
	decoder: LineDecoder<AgentMessage>
	paneId: string | null
}

export type HubEvent =
	| { type: "listening"; port: number }
	| { type: "connected"; paneId: string; pid: number }
	| { type: "disconnected"; paneId: string }
	| { type: "message"; paneId: string; message: AgentMessage }

export class Hub {
	private server?: TCPSocketListener<PaneState>
	private readonly panes = new Map<string, Pane>()
	private readonly listeners = new Set<(e: HubEvent) => void>()

	/** The actual port the hub is listening on (valid after start()). */
	port = 0

	on(listener: (e: HubEvent) => void): () => void {
		this.listeners.add(listener)
		return () => this.listeners.delete(listener)
	}

	private emit(event: HubEvent): void {
		for (const l of this.listeners) l(event)
	}

	start(): number {
		this.server = Bun.listen<PaneState>({
			hostname: HUB_HOST,
			port: HUB_PORT,
			socket: {
				open: (socket) => {
					socket.data = { decoder: new LineDecoder<AgentMessage>(), paneId: null }
				},
				data: (socket, chunk) => this.onData(socket, chunk),
				close: (socket) => this.onClose(socket),
				error: (socket) => this.onClose(socket),
			},
		})
		this.port = this.server.port
		this.emit({ type: "listening", port: this.port })
		return this.port
	}

	private onData(socket: Socket<PaneState>, chunk: Uint8Array): void {
		for (const msg of socket.data.decoder.push(chunk)) {
			if (msg.type === "hello") {
				socket.data.paneId = msg.paneId
				this.panes.set(msg.paneId, {
					id: msg.paneId,
					pid: msg.pid,
					socket,
					connectedAt: performance.now(),
				})
				this.emit({ type: "connected", paneId: msg.paneId, pid: msg.pid })
				continue
			}
			const paneId = socket.data.paneId
			if (paneId) this.emit({ type: "message", paneId, message: msg })
		}
	}

	private onClose(socket: Socket<PaneState>): void {
		const paneId = socket.data?.paneId
		if (paneId && this.panes.delete(paneId)) {
			this.emit({ type: "disconnected", paneId })
		}
	}

	private write(paneId: string, msg: HubMessage): boolean {
		const pane = this.panes.get(paneId)
		if (!pane) return false
		pane.socket.write(encode(msg))
		pane.socket.flush()
		return true
	}

	/** Run a command line in one pane's shell. Returns false if the pane is unknown. */
	run(paneId: string, command: string): boolean {
		return this.write(paneId, { type: "run", command })
	}

	/** Write raw input (no trailing newline) to one pane's shell. */
	input(paneId: string, data: string): boolean {
		return this.write(paneId, { type: "input", data })
	}

	/** Run a command in every connected pane. Returns how many received it. */
	broadcast(command: string): number {
		let n = 0
		for (const id of this.panes.keys()) if (this.run(id, command)) n++
		return n
	}

	/** Ask a pane to shut down cleanly. */
	shutdown(paneId: string): boolean {
		return this.write(paneId, { type: "shutdown" })
	}

	list(): Pane[] {
		return [...this.panes.values()]
	}

	has(paneId: string): boolean {
		return this.panes.has(paneId)
	}

	stop(): void {
		for (const id of this.panes.keys()) this.shutdown(id)
		this.server?.stop(true)
	}
}
