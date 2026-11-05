import { bold, dim, fg, type TextChunk } from "@opentui/core"
import type { SessionState } from "../core/session"
import { paneCountLabel, relativeTime, sessionHeading, truncate } from "./format"
import { type LogEntry, timeLabel } from "./logstore"
import { BG, mixHex, PURPLE, PURPLE_BRIGHT } from "./theme"

export { PURPLE }

// ---------------------------------------------------------------------------
// The ordo mark — the "Orbit o" symbol (apps/web/public/brand/ordo-symbol-duo.svg),
// rasterised from the brand kit's small-size cut onto a 12×12 half-block grid:
// a ring with its top-right notched out and the pane stepped into the gap.
// ---------------------------------------------------------------------------
export const LOGO_MARK = [
	"  ▄████ ▄▄▄ ",
	"▄███▀▀▀ ███ ",
	"███      ▄▄▄",
	"███      ███",
	"▀███▄▄▄▄███▀",
	"  ▀██████▀  ",
]

/**
 * Styled chunks for the logo mark. `reveal` (0–1) shows that fraction of rows
 * from the bottom up (hidden rows keep their footprint so the header doesn't
 * jump); `sweep` paints a soft highlight band centered on that column, for the
 * light pass that plays on launch and on big session actions.
 */
export function logoMarkChunks(opts: { reveal?: number; sweep?: number | null } = {}): TextChunk[] {
	const reveal = opts.reveal ?? 1
	const sweep = opts.sweep ?? null
	const rows = LOGO_MARK.length
	const shown = Math.round(Math.max(0, Math.min(1, reveal)) * rows)
	const chunks: TextChunk[] = []
	LOGO_MARK.forEach((line, r) => {
		if (r > 0) chunks.push(fg(PURPLE)("\n"))
		if (r < rows - shown) {
			chunks.push(fg(PURPLE)(" ".repeat(line.length)))
			return
		}
		if (sweep === null) {
			chunks.push(fg(PURPLE)(line))
			return
		}
		for (let c = 0; c < line.length; c++) {
			const d = Math.abs(c - sweep)
			const glow = Math.max(0, 1 - (d / 4) ** 2)
			chunks.push(fg(mixHex(PURPLE, PURPLE_BRIGHT, glow))(line[c] ?? " "))
		}
	})
	return chunks
}

// ---------------------------------------------------------------------------
// Sessions sidebar — the styled content of the in-app session browser
// ---------------------------------------------------------------------------
/**
 * Styled chunks for ONE session row in the sidebar. Everything is the accent
 * purple except each pane's name, which keeps its own pane color (the only place
 * a non-purple ink is allowed). The model-generated title is the heading, with
 * the id dimmed beneath it. The running session is marked by a light band
 * sweeping across its heading — the caller drives the band's position via
 * `sweep` (a fractional character column; null paints the heading at rest).
 * For the live session, each pane's agent-reported status (from `statuses`)
 * trails its name, dim.
 */
export function sessionChunks(
	s: SessionState,
	live: boolean,
	sweep?: number | null,
	statuses?: Map<string, { status: string; task?: string }>,
): TextChunk[] {
	const purple = fg(PURPLE)
	const chunks: TextChunk[] = []
	const newline = () => chunks.push(purple("\n"))

	// Heading: the generated title (bold purple), or the id if not titled yet.
	// The live session gets a left bar (echoing the block-glyph mark) and a
	// light band that periodically travels across its heading.
	const heading = sessionHeading(s)
	if (live) chunks.push(bold(purple("▍ ")))
	if (live && sweep !== null && sweep !== undefined) {
		// Code points, not UTF-16 units: emoji in a renamed title must not split.
		const chars = [...heading]
		for (let c = 0; c < chars.length; c++) {
			const d = Math.abs(c - sweep)
			const glow = Math.max(0, 1 - (d / 3) ** 2)
			chunks.push(bold(fg(mixHex(PURPLE, PURPLE_BRIGHT, glow))(chars[c] ?? " ")))
		}
	} else {
		chunks.push(bold(purple(heading)))
	}
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
		const status = live ? statuses?.get(p.id)?.status?.trim() : undefined
		if (status) chunks.push(dim(purple(` · ${truncate(status.replace(/\s+/g, " "), 18)}`)))
	})
	return chunks
}

// ---------------------------------------------------------------------------
// Log lines — one entry from the log store, painted at a given intensity
// ---------------------------------------------------------------------------
/**
 * Styled chunks for one log entry. `alpha` fades every ink from the background
 * up to its resting color (1 = fully settled) so freshly appended lines can
 * ease in. Only pane *names* keep their pane color; all other ink is purple.
 * `timestamps` prefixes the dim HH:MM:SS used in verbose mode.
 */
export function logEntryChunks(
	entry: LogEntry,
	opts: { timestamps?: boolean; alpha?: number } = {},
): TextChunk[] {
	const alpha = opts.alpha ?? 1
	const ink = (hex: string) => (alpha >= 1 ? hex : mixHex(BG, hex, alpha))
	const purple = fg(ink(PURPLE))
	const chunks: TextChunk[] = []
	if (opts.timestamps) chunks.push(dim(purple(`${timeLabel(entry.ts)} `)))

	if (entry.kind === "message") {
		const from = entry.from ?? "?"
		const to = entry.to ?? "?"
		const oneLine = entry.text.replace(/\s+/g, " ").trim()
		const shown = oneLine.length > 80 ? `${oneLine.slice(0, 79)}…` : oneLine
		chunks.push(bold(fg(ink(entry.color ?? PURPLE))(from)))
		chunks.push(dim(purple(" → ")))
		chunks.push(bold(purple(to)))
		chunks.push(dim(purple(`  ${shown}`)))
		return chunks
	}

	if (entry.kind === "status") {
		const clause =
			entry.text.trim() === "" ? "cleared status" : entry.text.replace(/\s+/g, " ").trim()
		chunks.push(bold(fg(ink(entry.color ?? PURPLE))(entry.pane ?? "?")))
		chunks.push(dim(purple(` · ${clause}`)))
		if (entry.task && entry.task.trim() !== "")
			chunks.push(dim(purple(`  (task: ${entry.task.replace(/\s+/g, " ").trim()})`)))
		return chunks
	}

	// user / action / event lines: one purple ink, weight by level. The user's
	// own inputs get the prompt marker; everything else the quiet dot.
	const text = entry.text.replace(/^·\s*/, "")
	const marker = entry.kind === "user" ? "› " : "· "
	const paint =
		entry.level === "error"
			? (t: string) => bold(purple(t))
			: entry.level === "warn"
				? (t: string) => purple(t)
				: (t: string) => dim(purple(t))
	chunks.push(paint(`${marker}${text}`))
	return chunks
}
