import { ansiFg } from "../core/colors"
import { listSessionNames, loadSession, type SessionState } from "../core/session"
import { paneCountLabel, relativeTime, sessionHeading, truncate } from "./format"

// ---------------------------------------------------------------------------
// Session list — `--sessions` (printed inline, no TUI)
// ---------------------------------------------------------------------------
export function printSessions(): void {
	const C = {
		reset: "\x1b[0m",
		bold: "\x1b[1m",
		dim: "\x1b[2m",
		cyan: "\x1b[36m",
		green: "\x1b[32m",
	}
	const sessions = listSessionNames()
		.map(loadSession)
		.filter((s): s is SessionState => s !== null)
		.sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""))

	if (sessions.length === 0) {
		console.log(`\n${C.dim}No saved sessions yet. Start one with:${C.reset} ordo\n`)
		return
	}

	console.log(`\n${C.bold}ordo sessions (${sessions.length})${C.reset}\n`)
	for (const s of sessions) {
		const count = paneCountLabel(s)
		// Heading is the generated title (id shown beneath it); falls back to the id.
		const heading = sessionHeading(s)
		console.log(
			`${C.cyan}${C.bold}${heading}${C.reset}  ${C.dim}${count} · ${relativeTime(s.updatedAt)}${C.reset}`,
		)
		if (s.title) console.log(`${C.dim}${s.id}${C.reset}`)
		s.satellites.forEach((p, j) => {
			const branch = j === s.satellites.length - 1 ? "└─" : "├─"
			const cmd = p.lastCommand
				? `${C.dim}› ${truncate(p.lastCommand, 50)}${C.reset}`
				: `${C.dim}(no commands)${C.reset}`
			// Color the pane name with its own pastel color (same as its tab).
			const name = p.color ? `${ansiFg(p.color)}${p.id.padEnd(14)}${C.reset}` : p.id.padEnd(14)
			console.log(
				`  ${C.dim}${branch}${C.reset} ${name} ${C.dim}${p.direction.padEnd(5)}${C.reset} ${cmd}`,
			)
		})
		console.log(`  ${C.dim}resume →${C.reset} ${C.green}ordo --restore ${s.id}${C.reset}\n`)
	}
}
