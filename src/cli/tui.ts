import { statSync } from "node:fs"
import { join } from "node:path"
import {
	BoxRenderable,
	type CliRenderer,
	decodePasteBytes,
	dim,
	fg,
	type KeyEvent,
	type PasteEvent,
	ScrollBoxRenderable,
	StyledText,
	TextRenderable,
} from "@opentui/core"
import { Orchestrator } from "../app/orchestrator"
import { NEW_SESSION, RESTORE_NAME } from "../core/config"
import { listSessionNames, loadSession, type SessionState, sessionsDir } from "../core/session"
import { relativeTime } from "./format"
import {
	handleKey,
	handlePaste,
	type InputAction,
	type InputResult,
	type InputState,
} from "./input"
import { PURPLE, sessionChunks } from "./styled"

interface LoadedSession {
	state: SessionState
	mtimeMs: number
}

/** Parse saved sessions, re-reading only files whose mtime changed since last call. */
function makeSessionLoader() {
	const cache = new Map<string, { mtimeMs: number; state: SessionState }>()
	return (): LoadedSession[] => {
		const dir = sessionsDir()
		const names = listSessionNames()
		const present = new Set(names)
		for (const key of [...cache.keys()]) if (!present.has(key)) cache.delete(key)
		const out: LoadedSession[] = []
		for (const name of names) {
			let mtimeMs: number
			try {
				mtimeMs = statSync(join(dir, `${name}.json`)).mtimeMs
			} catch {
				continue
			}
			const hit = cache.get(name)
			if (hit && hit.mtimeMs === mtimeMs) {
				out.push({ state: hit.state, mtimeMs })
				continue
			}
			const state = loadSession(name)
			if (!state) continue
			cache.set(name, { mtimeMs, state })
			out.push({ state, mtimeMs })
		}
		return out.sort((a, b) => (b.state.updatedAt ?? "").localeCompare(a.state.updatedAt ?? ""))
	}
}

/** Input-row hints for the two states: a launcher (no session) vs. a live session. */
const HINT_LAUNCHER = "n new · s open · d delete · ↑↓ scroll"
const HINT_ACTIVE = "a add · s switch · c close · r rename · ⇥ focus · n new · d delete"

// ---------------------------------------------------------------------------
// Command center — a session launcher/browser; `n` new, `a` add pane, `s` open
// ---------------------------------------------------------------------------
export async function runOrchestrator(renderer: CliRenderer) {
	const orchestrator = new Orchestrator()

	// Input state: "open"/"delete"/"rename" modes await text typed into the input
	// area; "confirmDelete" waits for a y/n; "none" is the resting state where the
	// single-key commands act.
	let buffer = ""
	let mode: "none" | "open" | "delete" | "rename" | "confirmDelete" = "none"
	let pendingDelete = ""

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
		if (mode === "rename") {
			promptText.content = `rename session › ${buffer}▏\n\n(type a new title · Enter saves · Esc cancels)`
			return
		}
		if (mode === "confirmDelete") {
			promptText.content = `delete "${pendingDelete}"? › y / n\n\n(this removes the saved layout and scrollback · Esc cancels)`
			return
		}
		promptText.content = `› ${orchestrator.hasSession ? HINT_ACTIVE : HINT_LAUNCHER}`
	}

	const loadSessions = makeSessionLoader()
	const rowRegistry = new Map<string, { text: TextRenderable; mtimeMs: number; rel: string }>()
	let lastSignature = ""

	function renderSessions(): void {
		try {
			const sessions = loadSessions()
			const signature = sessions
				.map((s) => `${s.state.id}:${s.state.id === orchestrator.sessionId ? 1 : 0}`)
				.join("|")

			// Same set of rows → refresh only rows whose file changed or whose relative
			// time rolled over, without destroying and rebuilding every renderable.
			if (signature === lastSignature && rowRegistry.size > 0) {
				for (const s of sessions) {
					const entry = rowRegistry.get(s.state.id)
					if (!entry) continue
					const rel = relativeTime(s.state.updatedAt)
					if (entry.mtimeMs === s.mtimeMs && entry.rel === rel) continue
					entry.text.content = new StyledText(
						sessionChunks(s.state, s.state.id === orchestrator.sessionId),
					)
					entry.mtimeMs = s.mtimeMs
					entry.rel = rel
				}
				return
			}
			lastSignature = signature

			const savedScroll = scroll.scrollTop
			for (const child of [...listBox.getChildren()]) child.destroy()
			rowRegistry.clear()

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
				const live = s.state.id === orchestrator.sessionId
				const row = new BoxRenderable(renderer, {
					id: `row-${s.state.id}`,
					flexDirection: "column",
					flexShrink: 0,
					marginBottom: 1,
					// Clicking a session opens it — or arms a delete confirm in delete mode.
					onMouseDown: () => {
						if (mode === "delete") armDelete(s.state.id)
						else void doOpen(s.state.id)
					},
				})
				const text = new TextRenderable(renderer, {
					id: `rowtxt-${s.state.id}`,
					content: new StyledText(sessionChunks(s.state, live)),
				})
				row.add(text)
				listBox.add(row)
				rowRegistry.set(s.state.id, {
					text,
					mtimeMs: s.mtimeMs,
					rel: relativeTime(s.state.updatedAt),
				})
			}
			scroll.scrollTop = savedScroll
		} catch {
			redrawPrompt("· session list error")
		}
	}

	let renderTimer: ReturnType<typeof setTimeout> | undefined
	function scheduleRender(): void {
		if (renderTimer) return
		renderTimer = setTimeout(() => {
			renderTimer = undefined
			renderSessions()
		}, 50)
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

	/** Stage a delete: hold the id and switch to a y/n confirmation prompt. */
	function armDelete(id: string): void {
		const trimmed = id.trim()
		if (!trimmed) {
			resetMode()
			return
		}
		pendingDelete = trimmed
		mode = "confirmDelete"
		buffer = ""
		redrawPrompt()
	}

	async function doDelete(id: string): Promise<void> {
		const trimmed = id.trim()
		resetMode()
		if (!trimmed) return
		await orchestrator.deleteSavedSession(trimmed).catch(() => {})
	}

	function doRename(title: string): void {
		const trimmed = title.trim()
		resetMode()
		if (!trimmed) return
		orchestrator.renameSession(trimmed)
	}

	function doClose(): void {
		if (!orchestrator.hasSession) {
			redrawPrompt("· no session open")
			return
		}
		void orchestrator.closeSessionAction().catch(() => {})
	}

	function enterMode(next: "open" | "delete" | "rename"): void {
		if (next === "rename" && !orchestrator.hasSession) {
			redrawPrompt("· no session to rename")
			return
		}
		mode = next
		buffer = ""
		redrawPrompt()
	}

	makeCommand("n", "n new", () => void doNew())
	makeCommand("a", "a add pane", () => void doAdd())
	makeCommand("s", "s open", () => enterMode("open"))
	makeCommand("c", "c close", () => doClose())
	makeCommand("r", "r rename", () => enterMode("rename"))
	makeCommand("d", "d delete", () => enterMode("delete"))

	orchestrator.on((e) => {
		if (e.type === "panes-changed") {
			scheduleRender()
			redrawPrompt()
		} else if (e.type === "log") {
			// Transient command feedback shares the input row (no separate log panel).
			redrawPrompt(`· ${e.message}`)
		}
	})

	await orchestrator.start()
	// Name the command window's WT tab (OSC 0), before the renderer owns stdout.
	try {
		process.stdout.write("\x1b]0;ordo\x07")
	} catch {}

	let shuttingDown = false
	let refresh: ReturnType<typeof setInterval> | undefined
	async function shutdown(): Promise<void> {
		if (shuttingDown) return
		shuttingDown = true
		if (refresh) clearInterval(refresh)
		if (renderTimer) clearTimeout(renderTimer)
		try {
			await orchestrator.shutdown()
		} catch {}
		try {
			renderer.destroy()
		} catch {}
		process.exit(0)
	}

	// Close everything when this (command) window goes away by any route — Ctrl+C,
	// a kill signal, or the window's X (which Windows surfaces as a console-close
	// signal). orchestrator.shutdown() detaches panes and releases the title model;
	// the shells stay alive in the daemon. The "exit" hook is a sync last resort.
	for (const sig of ["SIGINT", "SIGTERM", "SIGHUP", "SIGBREAK"] as const) {
		try {
			process.on(sig, () => void shutdown())
		} catch {
			// not all signals exist on every platform; ignore
		}
	}
	process.on("uncaughtException", (err) => {
		console.error(err)
		void shutdown()
	})
	process.on("unhandledRejection", (err) => {
		console.error(err)
		void shutdown()
	})
	process.on("exit", () => {
		try {
			orchestrator.stop()
		} catch {}
		try {
			process.stdout.write("\x1b[?1049l\x1b[?25h\x1b[?1002l\x1b[?1003l\x1b[0m")
		} catch {}
		try {
			;(process.stdin as NodeJS.ReadStream).setRawMode?.(false)
		} catch {}
	})

	const snapshot = (): InputState => ({
		mode,
		buffer,
		pendingDelete,
		hasSession: orchestrator.hasSession,
	})

	function dispatch(action: InputAction): void {
		switch (action.type) {
			case "shutdown":
				void shutdown()
				break
			case "scroll":
				scroll.scrollBy(action.by)
				break
			case "focusNext":
				orchestrator.focusNext()
				break
			case "focusPrev":
				orchestrator.focusPrev()
				break
			case "new":
				void doNew()
				break
			case "add":
				void doAdd()
				break
			case "close":
				doClose()
				break
			case "open":
				void doOpen(action.id)
				break
			case "delete":
				void doDelete(action.id)
				break
			case "rename":
				doRename(action.title)
				break
			case "status":
				redrawPrompt(action.message)
				break
			case "redraw":
				redrawPrompt()
				break
			case "none":
				break
		}
	}

	function applyInput(result: InputResult): void {
		mode = result.state.mode
		buffer = result.state.buffer
		pendingDelete = result.state.pendingDelete
		dispatch(result.action)
	}

	renderer.keyInput.on("keypress", (key: KeyEvent) => applyInput(handleKey(snapshot(), key)))
	renderer.keyInput.on("paste", (e: PasteEvent) =>
		applyInput(handlePaste(snapshot(), decodePasteBytes(e.bytes))),
	)

	renderSessions()
	redrawPrompt()
	renderer.start()

	// Keep relative times current and pick up the live session's continuous saves.
	refresh = setInterval(renderSessions, 2000)

	// Auto-action from launch flags: --restore opens that session at its saved
	// geometry, --new starts a fresh one. Otherwise this window stays a launcher —
	// size its (session-less) command window to the default so it looks right.
	if (RESTORE_NAME) void orchestrator.openSession(RESTORE_NAME).catch(() => {})
	else if (NEW_SESSION) void doNew()
	else orchestrator.sizeCenter()
}
