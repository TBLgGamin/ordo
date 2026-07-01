/**
 * Wire protocol between the hub (central app) and the agents (one per pane).
 *
 * Framing: newline-delimited JSON. Each message is a single JSON object on its
 * own line. This is trivial to produce/parse in Bun and survives partial reads.
 */

/** Messages an agent sends UP to the hub. */
export type AgentMessage =
	/** Sent once on connect so the hub can map this socket to a pane id. */
	| { type: "hello"; paneId: string; pid: number }
	/** Acknowledges a command was handed to the pane's shell. */
	| { type: "ack"; paneId: string; ofType: HubMessage["type"] }
	/** A line of output the agent chose to forward (optional, best-effort). */
	| { type: "output"; paneId: string; data: string }
	/** A command line the user typed directly into the pane (for the session browser). */
	| { type: "command"; paneId: string; text: string }
	/** The pane's current working directory, reported by the shell via OSC 9;9. */
	| { type: "cwd"; paneId: string; path: string }
	/**
	 * The foreground program currently running in the pane (best-effort), so the
	 * orchestrator can persist it and relaunch it on restore. `name` is null when
	 * the pane is sitting at a bare shell prompt.
	 */
	| { type: "foreground"; paneId: string; name: string | null; cwd?: string }
	/** The agent's shell (or the agent) is exiting. */
	| { type: "exit"; paneId: string; code: number }

/** Messages the hub sends DOWN to an agent. */
export type HubMessage =
	/** Run a command line in the pane's shell (a newline is appended). */
	| { type: "run"; command: string }
	/** Write raw input to the shell's stdin verbatim (no newline added). */
	| { type: "input"; data: string }
	/** Ask the agent to shut its shell and exit cleanly. */
	| { type: "shutdown" }

/** Frame any JSON-serializable message as a single newline-terminated line. */
export function encode(msg: object): Uint8Array {
	return new TextEncoder().encode(`${JSON.stringify(msg)}\n`)
}

/**
 * Stateful newline framer. Feed it raw socket chunks; it yields complete
 * messages and buffers any trailing partial line until the next chunk.
 */
export class LineDecoder<T> {
	private buffer = ""
	private readonly decoder = new TextDecoder()

	push(chunk: Uint8Array): T[] {
		this.buffer += this.decoder.decode(chunk, { stream: true })
		const out: T[] = []
		let newline = this.buffer.indexOf("\n")
		while (newline !== -1) {
			const line = this.buffer.slice(0, newline).trim()
			this.buffer = this.buffer.slice(newline + 1)
			if (line) out.push(JSON.parse(line) as T)
			newline = this.buffer.indexOf("\n")
		}
		return out
	}
}
