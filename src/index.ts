#!/usr/bin/env bun
import {
	BoxRenderable,
	bold,
	type CliRenderer,
	createCliRenderer,
	dim,
	fg,
	type KeyEvent,
	ScrollBoxRenderable,
	StyledText,
	type TextChunk,
	TextRenderable,
} from "@opentui/core"
import { ansiFg } from "./colors"
import {
	BUN_EXE,
	DELETE_NAME,
	ENTRY_PATH,
	IN_WINDOW,
	NEW_SESSION,
	PROJECT_DIR,
	RESTORE_NAME,
	SELECT_BORDER_COLOR,
	SESSIONS_MODE,
} from "./config"
import { Orchestrator } from "./orchestrator"
import { deleteSession, listSessionNames, loadSession, type SessionState } from "./session"
import { openSelfWindow } from "./wt"

/** The one UI accent — the user's light purple. The only ink that isn't a pane color. */
const PURPLE = SELECT_BORDER_COLOR

/** Input-row hints for the two states: a launcher (no session) vs. a live session. */
const HINT_LAUNCHER = "n new · s open · d delete · ↑↓ scroll"
const HINT_ACTIVE = "a add pane · s switch · c close · n new · d delete"

/** "3m ago"-style relative time from an ISO timestamp. */
function relativeTime(iso: string): string {
	const t = Date.parse(iso)
	if (!t) return "?"
	const s = Math.max(0, (Date.now() - t) / 1000)
	if (s < 60) return `${Math.round(s)}s ago`
	if (s < 3600) return `${Math.round(s / 60)}m ago`
	if (s < 86400) return `${Math.round(s / 3600)}h ago`
	return `${Math.round(s / 86400)}d ago`
}

/** Truncate `s` to `n` chars with a trailing ellipsis. */
function truncate(s: string, n: number): string {
	return s.length > n ? `${s.slice(0, n - 1)}…` : s
}

async function main() {
	// `--delete <name>` removes a session (and its scrollback), then exits.
	if (DELETE_NAME) {
		const ok = deleteSession(DELETE_NAME)
		console.log(ok ? `Deleted session "${DELETE_NAME}".` : `No session named "${DELETE_NAME}".`)
		return
	}
	// `--sessions` just prints the tree to the current terminal and exits — no TUI.
	if (SESSIONS_MODE) {
		printSessions()
		return
	}
	// Launch / restore: re-spawn into a fresh dedicated Windows Terminal window
	// (the job the old launch.ps1 did) so the app captures a clean window as its
	// fixed center instead of hijacking whatever terminal `ordo` was typed in. The
	// spawned child carries `--in-window`, so it skips this branch and runs the TUI.
	if (!IN_WINDOW) {
		const commandline = [BUN_EXE, "run", ENTRY_PATH, "--in-window"]
		if (RESTORE_NAME) commandline.push("--restore", RESTORE_NAME)
		else if (NEW_SESSION) commandline.push("--new")
		await openSelfWindow(commandline, PROJECT_DIR, RESTORE_NAME)
		return
	}
	const renderer = await createCliRenderer({ exitOnCtrlC: false, targetFps: 30, useMouse: true })
	renderer.setBackgroundColor("#0b0e14")
	await runOrchestrator(renderer)
}

// ---------------------------------------------------------------------------
// Command center — a session launcher/browser; `n` new, `a` add pane, `s` open
// ---------------------------------------------------------------------------
async function runOrchestrator(renderer: CliRenderer) {
	const orchestrator = new Orchestrator()

	// Input state: "open"/"delete" modes await a session id typed into the input
	// area; "none" is the resting state where n/a/s/c/d act on a single key.
	let buffer = ""
	let mode: "none" | "open" | "delete" = "none"

	// Layout: a top row (sessions sidebar on the left, input area filling the empty
	// space to its right), then one continuous command bar linking them along the
	// bottom.
	const root = new BoxRenderable(renderer, {
		id: "root",
		flexDirection: "column",
		padding: 1,
		flexGrow: 1,
	})
	renderer.root.add(root)

	const topRow = new BoxRenderable(renderer, { id: "topRow", flexDirection: "row", flexGrow: 1 })
	root.add(topRow)

	const sidebar = new BoxRenderable(renderer, {
		id: "sidebar",
		border: true,
		borderStyle: "rounded",
		borderColor: PURPLE,
		title: " ordo · sessions ",
		titleAlignment: "left",
		flexDirection: "column",
		paddingLeft: 1,
		paddingRight: 1,
		paddingTop: 1,
		width: 32,
		flexShrink: 0,
	})
	topRow.add(sidebar)

	// Scrolls (↑/↓) when there are more sessions than fit. Thumb is purple too.
	const scroll = new ScrollBoxRenderable(renderer, {
		id: "sessionsScroll",
		flexGrow: 1,
		scrollY: true,
		scrollX: false,
		verticalScrollbarOptions: {
			showArrows: false,
			trackOptions: { foregroundColor: PURPLE, backgroundColor: "#171520" },
		},
	})
	sidebar.add(scroll)

	// A container we refill with one clickable row per saved session.
	const listBox = new BoxRenderable(renderer, { id: "listBox", flexDirection: "column" })
	scroll.add(listBox)

	// The input area — the rectangle of empty space to the right of the sidebar.
	const inputArea = new BoxRenderable(renderer, {
		id: "inputArea",
		border: true,
		borderStyle: "rounded",
		borderColor: PURPLE,
		title: " input ",
		titleAlignment: "left",
		flexGrow: 1,
		marginLeft: 1,
		paddingLeft: 1,
		paddingRight: 1,
		paddingTop: 1,
	})
	topRow.add(inputArea)

	const promptText = new TextRenderable(renderer, { id: "promptText", content: "", fg: PURPLE })
	inputArea.add(promptText)

	// One continuous command bar (not separate boxes) linking the two columns.
	const bottomBar = new BoxRenderable(renderer, {
		id: "bottomBar",
		border: true,
		borderStyle: "rounded",
		borderColor: PURPLE,
		flexDirection: "row",
		flexShrink: 0,
		marginTop: 1,
		paddingLeft: 1,
		paddingRight: 1,
	})
	root.add(bottomBar)

	function makeCommand(id: string, label: string, onClick: () => void): void {
		bottomBar.add(
			new TextRenderable(renderer, {
				id: `cmd-${id}`,
				content: label,
				fg: PURPLE,
				marginRight: 3,
				onMouseDown: () => onClick(),
			}),
		)
	}

	function redrawPrompt(status?: string): void {
		if (status !== undefined) {
			promptText.content = status
			return
		}
		if (mode === "open" || mode === "delete") {
			const verb = mode === "open" ? "open" : "delete"
			promptText.content = `${verb} session › ${buffer}▏\n\n(type an id or click one in the sidebar · Esc cancels)`
			return
		}
		promptText.content = `› ${orchestrator.hasSession ? HINT_ACTIVE : HINT_LAUNCHER}`
	}

	function renderSessions(): void {
		// Rebuild the clickable rows. Cheap for the handful of sessions in play.
		// Preserve the scroll position so the 2s refresh doesn't jump to the top.
		const savedScroll = scroll.scrollTop
		for (const child of [...listBox.getChildren()]) child.destroy()
		const sessions = listSessionNames()
			.map(loadSession)
			.filter((s): s is SessionState => s !== null)
			.sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""))

		if (sessions.length === 0) {
			const hint = orchestrator.hasSession ? "starting…" : "no saved sessions — press n"
			listBox.add(
				new TextRenderable(renderer, {
					id: "empty",
					content: new StyledText([dim(fg(PURPLE)(hint))]),
				}),
			)
			return
		}
		for (const s of sessions) {
			const live = s.id === orchestrator.sessionId
			const row = new BoxRenderable(renderer, {
				id: `row-${s.id}`,
				flexDirection: "column",
				flexShrink: 0,
				marginBottom: 1,
				// Clicking a session opens it — or deletes it while in delete mode.
				onMouseDown: () => void (mode === "delete" ? doDelete(s.id) : doOpen(s.id)),
			})
			row.add(
				new TextRenderable(renderer, {
					id: `rowtxt-${s.id}`,
					content: new StyledText(sessionChunks(s, live)),
				}),
			)
			listBox.add(row)
		}
		scroll.scrollTop = savedScroll
	}

	// --- actions (shared by the keys and the clickable bottom-bar commands) ----
	function resetMode(): void {
		mode = "none"
		buffer = ""
		redrawPrompt()
	}

	async function doNew(): Promise<void> {
		// newSession() closes any current session first (single atomic action).
		await orchestrator.newSession().catch(() => {})
	}

	async function doAdd(): Promise<void> {
		await orchestrator.addPane().catch(() => {})
	}

	async function doOpen(id: string): Promise<void> {
		const trimmed = id.trim()
		resetMode()
		if (!trimmed) return
		// openSession() is the single shared restore action: it closes whatever's
		// open and restores the requested session in one step.
		await orchestrator.openSession(trimmed).catch(() => {})
	}

	async function doDelete(id: string): Promise<void> {
		const trimmed = id.trim()
		resetMode()
		if (!trimmed) return
		orchestrator.deleteSavedSession(trimmed)
	}

	function doClose(): void {
		if (!orchestrator.hasSession) {
			redrawPrompt("· no session open")
			return
		}
		orchestrator.closeSession()
	}

	function enterMode(next: "open" | "delete"): void {
		mode = next
		buffer = ""
		redrawPrompt()
	}

	makeCommand("n", "n new", () => void doNew())
	makeCommand("a", "a add pane", () => void doAdd())
	makeCommand("s", "s open", () => enterMode("open"))
	makeCommand("c", "c close", () => doClose())
	makeCommand("d", "d delete", () => enterMode("delete"))

	orchestrator.on((e) => {
		if (e.type === "panes-changed") {
			renderSessions()
			redrawPrompt()
		} else if (e.type === "log") {
			// Transient command feedback shares the input row (no separate log panel).
			redrawPrompt(`· ${e.message}`)
		}
	})

	await orchestrator.start()
	// Name the command window's WT tab (OSC 0), before the renderer owns stdout.
	process.stdout.write("\x1b]0;ordo\x07")

	function shutdown(): never {
		clearInterval(refresh)
		orchestrator.stop()
		renderer.destroy()
		process.exit(0)
	}

	// Close everything when this (command) window goes away by any route — Ctrl+C,
	// a kill signal, or the window's X (which Windows surfaces as a console-close
	// signal). orchestrator.stop() detaches panes; the shells stay alive in the daemon.
	for (const sig of ["SIGINT", "SIGTERM", "SIGHUP", "SIGBREAK"] as const) {
		try {
			process.on(sig, () => shutdown())
		} catch {
			// not all signals exist on every platform; ignore
		}
	}
	process.on("exit", () => orchestrator.stop())

	renderer.keyInput.on("keypress", (key: KeyEvent) => {
		if (key.ctrl && key.name === "c") return shutdown()
		// Scrolling the session list works in any mode.
		if (key.name === "up") return scroll.scrollBy(-2)
		if (key.name === "down") return scroll.scrollBy(2)
		if (key.name === "pageup") return scroll.scrollBy(-10)
		if (key.name === "pagedown") return scroll.scrollBy(10)

		if (mode === "open" || mode === "delete") {
			if (key.name === "escape") return resetMode()
			if (key.name === "return" || key.name === "enter") {
				return void (mode === "delete" ? doDelete(buffer) : doOpen(buffer))
			}
			if (key.name === "backspace") {
				buffer = buffer.slice(0, -1)
				return redrawPrompt()
			}
			if (key.sequence && key.sequence.length === 1 && key.sequence >= " ") {
				buffer += key.sequence
				redrawPrompt()
			}
			return
		}

		// Command mode: single-key actions.
		if (key.sequence === "q") return shutdown()
		if (key.sequence === "n") return void doNew()
		if (key.sequence === "a") return void doAdd()
		if (key.sequence === "s") return enterMode("open")
		if (key.sequence === "c") return doClose()
		if (key.sequence === "d") return enterMode("delete")
	})

	renderSessions()
	redrawPrompt()
	renderer.start()

	// Keep relative times current and pick up the live session's continuous saves.
	const refresh = setInterval(renderSessions, 2000)

	// Auto-action from launch flags: --restore opens that session at its saved
	// geometry, --new starts a fresh one. Otherwise this window stays a launcher —
	// size its (session-less) command window to the default so it looks right.
	if (RESTORE_NAME) void orchestrator.openSession(RESTORE_NAME)
	else if (NEW_SESSION) void doNew()
	else orchestrator.sizeCenter()
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
function sessionChunks(s: SessionState, live: boolean): TextChunk[] {
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

// ---------------------------------------------------------------------------
// Session list — `--sessions` (printed inline, no TUI)
// ---------------------------------------------------------------------------
function printSessions(): void {
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
		const count = `${s.satellites.length} pane${s.satellites.length === 1 ? "" : "s"}`
		// Heading is the generated title (id shown beneath it); falls back to the id.
		const heading = s.title ?? s.id
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

main().catch((err) => {
	console.error(err)
	process.exit(1)
})
