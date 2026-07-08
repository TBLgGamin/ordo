import type { Direction } from "../platform"

/** Window title each satellite gets — its (unique) pane name, used to find its HWND. */
export function satelliteTitle(id: string): string {
	return id
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** Run tasks with bounded concurrency, preserving input order in the results. */
export async function runPool<T>(
	limit: number,
	tasks: Array<() => Promise<T>>,
): Promise<Array<PromiseSettledResult<T>>> {
	const results = new Array<PromiseSettledResult<T>>(tasks.length)
	let next = 0
	const worker = async (): Promise<void> => {
		while (true) {
			const i = next++
			if (i >= tasks.length) return
			const task = tasks[i]
			if (!task) return
			try {
				results[i] = { status: "fulfilled", value: await task() }
			} catch (reason) {
				results[i] = { status: "rejected", reason }
			}
		}
	}
	await Promise.all(Array.from({ length: Math.min(limit, tasks.length) }, worker))
	return results
}

export type PaneStatus = "spawning" | "connected" | "exited"

export interface ManagedPane {
	id: string
	kind: "tab" | "window"
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
	| { type: "message"; from: string; to: string; text: string; color?: string }
	| { type: "status"; pane: string; status: string; task?: string; color?: string }
