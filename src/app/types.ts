import type { Direction } from "../platform/wt"

/** Window title each satellite gets — its (unique) pane name, used to find its HWND. */
export function satelliteTitle(id: string): string {
	return id
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

export type PaneStatus = "spawning" | "connected" | "exited"

export interface ManagedPane {
	id: string
	kind: "pane" | "tab" | "window"
	direction?: Direction
	status: PaneStatus
	pid?: number
	color?: string
	cwd?: string
	lastCommand?: string
	/** Whitelisted foreground program (e.g. "vim"), reported by the agent. */
	foreground?: string
	createdAt: number
}

export type OrchestratorEvent =
	| { type: "log"; level: "info" | "warn" | "error"; message: string }
	| { type: "panes-changed" }
