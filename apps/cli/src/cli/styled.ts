import { bold, dim, fg, type TextChunk } from "@opentui/core"
import { SELECT_BORDER_COLOR } from "../core/config"
import type { SessionState } from "../core/session"
import { paneCountLabel, relativeTime, sessionHeading, truncate } from "./format"

/** The one UI accent — the user's light purple. The only ink that isn't a pane color. */
export const PURPLE = SELECT_BORDER_COLOR

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
	const heading = sessionHeading(s)
	chunks.push(bold(purple(live ? `● ${heading}` : heading)))
	newline()
	// When a title exists, show the id beneath it as the dim sub-label.
	if (s.title) {
		chunks.push(dim(purple(`  ${s.id}`)))
		newline()
	}
	chunks.push(dim(purple(`  ${paneCountLabel(s)} · ${relativeTime(s.updatedAt)}`)))
	s.satellites.forEach((p) => {
		newline()
		chunks.push(dim(purple("  └─ ")))
		// Just the pane's name, in its own color — the only non-purple ink.
		chunks.push(fg(p.color ?? PURPLE)(truncate(p.id, 20)))
	})
	return chunks
}
