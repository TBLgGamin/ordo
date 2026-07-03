import type { SessionState } from "../core/session"

/** "3m ago"-style relative time from an ISO timestamp. */
export function relativeTime(iso: string): string {
	const t = Date.parse(iso)
	if (!t) return "?"
	const s = Math.max(0, (Date.now() - t) / 1000)
	if (s < 60) return `${Math.round(s)}s ago`
	if (s < 3600) return `${Math.round(s / 60)}m ago`
	if (s < 86400) return `${Math.round(s / 3600)}h ago`
	return `${Math.round(s / 86400)}d ago`
}

/** Truncate `s` to `n` chars with a trailing ellipsis. */
export function truncate(s: string, n: number): string {
	return s.length > n ? `${s.slice(0, n - 1)}…` : s
}

/** A session's display heading: its generated title, or its id if untitled. */
export function sessionHeading(s: SessionState): string {
	return s.title ?? s.id
}

/** Pluralized pane-count label, e.g. "1 pane" / "3 panes". */
export function paneCountLabel(s: SessionState): string {
	return `${s.satellites.length} pane${s.satellites.length === 1 ? "" : "s"}`
}
