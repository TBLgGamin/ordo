import { bold, dim, fg, type TextChunk } from "@opentui/core"
import { SELECT_BORDER_COLOR } from "../core/config"
import type { SessionState } from "../core/session"

/** The one UI accent — the user's light purple. The only ink that isn't a pane color. */
export const PURPLE = SELECT_BORDER_COLOR

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

// ---------------------------------------------------------------------------
// Sessions sidebar — the styled content of the in-app session browser
// ---------------------------------------------------------------------------
/**
 * Styled chunks for ONE session row in the sidebar. Everything is the accent
 * purple except each pane's name, which keeps its own pane color (the only place
 * a non-purple ink is allowed). The model-generated title is the heading, with
 * the id dimmed beneath it; `live` flags the running session with a dot.
 */
export function sessionChunks(s: SessionState, live: boolean): TextChunk[] {
	const purple = fg(PURPLE)
	const chunks: TextChunk[] = []
	const newline = () => chunks.push(purple("\n"))

	// Heading: the generated title (bold purple), or the id if not titled yet.
	const heading = s.title ?? s.id
	chunks.push(bold(purple(live ? `● ${heading}` : heading)))
	newline()
	// When a title exists, show the id beneath it as the dim sub-label.
	if (s.title) {
		chunks.push(dim(purple(`  ${s.id}`)))
		newline()
	}
	const count = `${s.satellites.length} pane${s.satellites.length === 1 ? "" : "s"}`
	chunks.push(dim(purple(`  ${count} · ${relativeTime(s.updatedAt)}`)))
	s.satellites.forEach((p) => {
		newline()
		chunks.push(dim(purple("  └─ ")))
		// Just the pane's name, in its own color — the only non-purple ink.
		chunks.push(fg(p.color ?? PURPLE)(truncate(p.id, 20)))
	})
	return chunks
}
