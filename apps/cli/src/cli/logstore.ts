/**
 * Full in-memory history of everything the command center sees. The visible
 * log renders a slice of this store, so toggling verbose mode can replay
 * history instead of only affecting lines appended after the toggle. The
 * default view shows "user" entries (the user's own inputs and their direct
 * feedback) plus every warning and error; verbose shows everything, timestamped.
 */

export type LogKind = "user" | "action" | "message" | "status" | "event"
export type LogLevel = "info" | "warn" | "error"

export interface LogEntry {
	ts: number
	kind: LogKind
	level: LogLevel
	text: string
	/** message entries */
	from?: string
	to?: string
	/** status entries */
	pane?: string
	task?: string
	/** pane accent for message/status entries */
	color?: string
}

/** Newest entries kept in the store (history for verbose replay). */
export const LOG_CAP = 2000

export class LogStore {
	private items: LogEntry[] = []

	push(entry: LogEntry): void {
		this.items.push(entry)
		if (this.items.length > LOG_CAP) this.items.splice(0, this.items.length - LOG_CAP)
	}

	/**
	 * The slice the log widget renders: the last `limit` entries. The default
	 * view is the user's own activity plus warnings and errors; `verbose` shows
	 * every kind.
	 */
	visible(verbose: boolean, limit: number): LogEntry[] {
		const src = verbose ? this.items : this.items.filter((e) => this.shows(e, false))
		return src.slice(-limit)
	}

	/** Whether `entry` would appear in the current view mode. */
	shows(entry: LogEntry, verbose: boolean): boolean {
		return verbose || entry.kind === "user" || entry.level !== "info"
	}
}

/** "HH:MM:SS" for the dim timestamp prefix in verbose mode. */
export function timeLabel(ts: number): string {
	const d = new Date(ts)
	const p = (n: number) => String(n).padStart(2, "0")
	return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}
