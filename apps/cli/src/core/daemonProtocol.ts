/**
 * Wire protocol for the persistent session daemon.
 *
 * Every TCP connection opens with a single newline-JSON "hello" line declaring
 * its kind. Two kinds:
 *
 *  - "control" (orchestrator ↔ daemon): newline-JSON request/response, plus the
 *    daemon pushes newline-JSON events (pane state changes).
 *  - "attach"  (pane client ↔ daemon): bound to one pane.
 *       • client → daemon: newline-JSON frames (input as base64, or resize).
 *       • daemon → client: RAW terminal bytes (ring-buffer replay, then live).
 *         Low-volume control goes as JSON one way; the high-volume output stream
 *         stays raw the other way. The daemon closes the socket when the shell
 *         exits.
 *
 * Reuses `encode` / `LineDecoder` from protocol.ts for all newline-JSON framing.
 */

export const PROTOCOL_VERSION = 5

export interface ControlHello {
	kind: "control"
	token: string
	v?: number
	/**
	 * The session this orchestrator owns. When this control connection drops (the
	 * main window closed by any route), the daemon closes that session's client
	 * windows — but keeps the shells alive for a later restore.
	 */
	session?: string
}

export interface AttachHello {
	kind: "attach"
	token: string
	v?: number
	session: string
	pane: string
	cols: number
	rows: number
}

export type Hello = ControlHello | AttachHello

/** Orchestrator → daemon requests (each carries a correlation `id`). */
export type ControlRequest =
	| { id: number; op: "ping" }
	| {
			id: number
			op: "createPane"
			session: string
			pane: string
			cwd?: string
			color?: string
			/** Cold-restore only: re-launch this whitelisted foreground program. */
			relaunch?: string
			launch?: string
	  }
	| { id: number; op: "getState"; session: string }
	| { id: number; op: "killPane"; session: string; pane: string }
	/** Close all client windows for a session WITHOUT killing the shells. */
	| { id: number; op: "detachSession"; session: string }
	| {
			id: number
			op: "requestPane"
			session: string
			requestedBy?: string
			name?: string
			cwd?: string
			agent?: string
	  }
	| { id: number; op: "resolveSpawn"; requestId: number; pane?: string; error?: string }
	| { id: number; op: "broadcast"; session: string; from?: string; text: string }
	| { id: number; op: "setStatus"; session: string; pane: string; status: string; task?: string }
	| { id: number; op: "getStatus"; session: string }
	| {
			id: number
			op: "waitForEvent"
			session: string
			pane: string
			events?: WaitableEvent[]
			filterPane?: string
			from?: string
			timeoutMs?: number
	  }
	| {
			id: number
			op: "runCommand"
			session: string
			command: string
			cwd?: string
			timeoutMs?: number
	  }
	| {
			id: number
			op: "sendMessage"
			session: string
			pane: string
			from?: string
			text: string
			enter?: boolean
			raw?: boolean
	  }
	| { id: number; op: "readPane"; session: string; pane: string; lines?: number }
	| {
			id: number
			op: "waitForMessage"
			session: string
			pane: string
			from?: string
			timeoutMs?: number
	  }
	| { id: number; op: "interrupt"; session: string; pane: string }
	| { id: number; op: "shutdown" }

/** Daemon → orchestrator responses. */
export type ControlResponse =
	| { id: number; ok: true; result?: unknown }
	| { id: number; ok: false; error: string; code?: string }

/** Per-pane state the daemon tracks and reports. */
export interface PaneState {
	pane: string
	pid?: number
	cwd?: string
	color?: string
	lastCommand?: string
	foreground?: string
	/** Whether the pane's shell is alive (warm) — false once it exits. */
	live: boolean
}

export interface MessageDelivery {
	delivered: "typed" | "waiter"
}

export type WaitResult = { from: string; text: string; ts: number } | { timeout: true }

export type WaitableEvent = "message" | "pane-exited" | "pane-created" | "status-changed"

export interface StatusEntry {
	pane: string
	status: string
	task?: string
	ts: number
}

export interface BroadcastResult {
	results: Array<{ pane: string; delivered?: "typed" | "waiter"; error?: string }>
}

export type EventWaitResult =
	| { timeout: true }
	| {
			kind: WaitableEvent
			pane?: string
			from?: string
			text?: string
			status?: string
			task?: string
			ts: number
	  }

export interface RunResult {
	exitCode: number | null
	stdout: string
	stderr: string
	timedOut: boolean
	truncated: boolean
}

/** Daemon → orchestrator async event pushes (on the control channel). */
export type ControlEvent =
	| { event: "pane"; session: string; state: PaneState }
	| { event: "paneExited"; session: string; pane: string }
	/**
	 * The user closed a pane's window (its last client detached while the
	 * orchestrator was still connected). The daemon has killed the shell and
	 * deleted the pane's scrollback; the orchestrator de-registers it from the
	 * session. Distinct from `paneExited` (shell quit) and from a session detach
	 * (window/app closed — shells kept for restore).
	 */
	| { event: "paneClosed"; session: string; pane: string }
	| {
			event: "message"
			session: string
			from: string
			to: string
			text: string
			ts: number
			delivered: "typed" | "waiter"
	  }
	| {
			event: "spawnRequest"
			session: string
			requestId: number
			requestedBy?: string
			name?: string
			cwd?: string
			agent?: string
	  }
	| { event: "paneCreated"; session: string; state: PaneState }
	| { event: "status"; session: string; pane: string; status: string; task?: string; ts: number }

/** Pane client → daemon frames (after the attach hello). */
export type AttachClientMsg =
	| { t: "i"; d: string } // input bytes, base64
	| { t: "r"; c: number; r: number } // resize to c cols × r rows
