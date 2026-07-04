import type { ControlEvent, EventWaitResult, WaitableEvent } from "../core/daemonProtocol"

export interface PendingWaitMatch {
	from?: string
}

export function matchWaiter(waiter: PendingWaitMatch, from: string): boolean {
	return waiter.from === undefined || waiter.from === from
}

export interface EventWaiterMatch {
	session: string
	kinds: Set<WaitableEvent>
	filterPane?: string
	from?: string
}

export const ALL_WAITABLE_EVENTS: readonly WaitableEvent[] = [
	"message",
	"pane-exited",
	"pane-created",
	"status-changed",
]

export function matchEventWaiter(w: EventWaiterMatch, e: ControlEvent): EventWaitResult | null {
	if (e.session !== w.session) return null
	let kind: WaitableEvent
	let pane: string | undefined
	let from: string | undefined
	let text: string | undefined
	let status: string | undefined
	let task: string | undefined
	let ts = 0
	switch (e.event) {
		case "message":
			kind = "message"
			pane = e.to
			from = e.from
			text = e.text
			ts = e.ts
			break
		case "paneExited":
		case "paneClosed":
			kind = "pane-exited"
			pane = e.pane
			break
		case "paneCreated":
			kind = "pane-created"
			pane = e.state.pane
			break
		case "status":
			kind = "status-changed"
			pane = e.pane
			status = e.status
			task = e.task
			ts = e.ts
			break
		default:
			return null
	}
	if (!w.kinds.has(kind)) return null
	if (w.filterPane !== undefined && w.filterPane !== pane) return null
	if (w.from !== undefined && w.from !== from) return null
	return { kind, pane, from, text, status, task, ts }
}

export function clampInt(value: number | undefined, def: number, min: number, max: number): number {
	if (value === undefined || !Number.isFinite(value)) return def
	return Math.min(max, Math.max(min, Math.trunc(value)))
}
