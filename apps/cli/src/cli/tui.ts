import { statSync } from "node:fs"
import { join } from "node:path"
import {
	BoxRenderable,
	bold,
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
import { listSessionNames, loadSession, type SessionState, sessionsDir } from "../core/session"
import { animateOnce, attachAnimations, spin, sweepLoop } from "./anim"
import { relativeTime } from "./format"
import {
	handleKey,
	handlePaste,
	type InputAction,
	type InputResult,
	type InputState,
} from "./input"
import type { LaunchIntent, PaneSeed } from "./launch"
import { type LogEntry, LogStore } from "./logstore"
import { LOGO_MARK, logEntryChunks, logoMarkChunks, PURPLE, sessionChunks } from "./styled"
import { mixHex, PURPLE_BRIGHT, TRACK_BG } from "./theme"

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

/** Newest-first cap on the log lines actually rendered (full history in the store). */
const MAX_LOG_LINES = 200
/** Below this width the sidebar stacks on top of the main area instead of beside it. */
const NARROW_COLS = 64
/** Below this width the statusline switches to its short labels. */
const COMPACT_BAR_COLS = 90
/** Below this height the brand strip inside the activity frame is hidden. */
const LOGO_MIN_ROWS = 18
/** Sidebar width by terminal width (wide / medium). */
const SIDEBAR_WIDE = 32
const SIDEBAR_MEDIUM = 26

// ---------------------------------------------------------------------------
// Command center — a session launcher/browser; `n` new, `a` add pane, `s` open
// ---------------------------------------------------------------------------
export async function runOrchestrator(renderer: CliRenderer, launch: LaunchIntent) {
	const orchestrator = new Orchestrator()
	attachAnimations(renderer)

	// Input state: "open"/"delete"/"rename" modes await text typed into the input
	// area; "confirmDelete" waits for a y/n; "none" is the resting state where the
	// single-key commands act.
	let buffer = ""
	let mode: "none" | "open" | "delete" | "rename" | "confirmDelete" = "none"
	let pendingDelete = ""

	// The main area is the running activity log, backed by this full-history
	// store; `v` toggles the verbose view (everything, timestamped).
	const logStore = new LogStore()
	let verbose = false

	// Latest agent-reported status per pane (from `status` events), keyed by pane
	// id; pruned when panes change.
	const agentStatus = new Map<string, { status: string; task?: string }>()

	// Layout: the body (sessions sidebar beside the main activity area — stacked
	// on narrow terminals), then a one-line statusline of commands. The brand
	// mark lives inside the activity frame's top-left, not in its own header.
	const root = new BoxRenderable(renderer, {
		id: "root",
		flexDirection: "column",
		padding: 1,
		flexGrow: 1,
	})
	renderer.root.add(root)

	const body = new BoxRenderable(renderer, { id: "body", flexDirection: "row", flexGrow: 1 })
	root.add(body)

	const sidebar = new BoxRenderable(renderer, {
		id: "sidebar",
		border: true,
		borderStyle: "rounded",
		borderColor: PURPLE,
		title: " sessions ",
		titleAlignment: "left",
		flexDirection: "column",
		paddingLeft: 1,
		paddingRight: 1,
		paddingTop: 1,
		width: SIDEBAR_WIDE,
		flexShrink: 0,
	})
	body.add(sidebar)

	// Scrolls (↑/↓) when there are more sessions than fit. Thumb is purple too.
	const scroll = new ScrollBoxRenderable(renderer, {
		id: "sessionsScroll",
		flexGrow: 1,
		scrollY: true,
		scrollX: false,
		verticalScrollbarOptions: {
			showArrows: false,
			trackOptions: { foregroundColor: PURPLE, backgroundColor: TRACK_BG },
		},
	})
	sidebar.add(scroll)

	// A container we refill with one clickable row per saved session.
	const listBox = new BoxRenderable(renderer, { id: "listBox", flexDirection: "column" })
	scroll.add(listBox)

	// --- main area: the running activity log + the input line -----------------
	const main = new BoxRenderable(renderer, {
		id: "main",
		border: true,
		borderStyle: "rounded",
		borderColor: PURPLE,
		title: " activity ",
		titleAlignment: "left",
		flexDirection: "column",
		flexGrow: 1,
		marginLeft: 1,
		paddingLeft: 1,
		paddingRight: 1,
		paddingTop: 1,
	})
	body.add(main)

	// The brand strip pinned inside the activity frame's top-left: the compact
	// ordo mark, with the dim session summary on the right.
	const brandStrip = new BoxRenderable(renderer, {
		id: "brandStrip",
		flexDirection: "row",
		flexShrink: 0,
		justifyContent: "space-between",
		alignItems: "flex-end",
		marginBottom: 1,
	})
	main.add(brandStrip)

	const logoMark = new TextRenderable(renderer, {
		id: "logoMark",
		content: new StyledText(logoMarkChunks()),
		flexShrink: 0,
	})
	brandStrip.add(logoMark)

	const headerInfo = new TextRenderable(renderer, {
		id: "headerInfo",
		content: "",
		flexShrink: 0,
		marginLeft: 2,
	})
	brandStrip.add(headerInfo)

	// One light pass at a time: the intro build-in on launch, a shorter sweep on
	// big session actions. Both settle back to the resting purple mark.
	const logoCols = LOGO_MARK[0]?.length ?? 12
	let logoBusy = false
	function paintLogo(opts: { reveal?: number; sweep?: number | null }): void {
		try {
			logoMark.content = new StyledText(logoMarkChunks(opts))
		} catch {}
	}
	/** Launch animation: the mark builds up from the bottom, then a light sweeps across. */
	function logoIntro(): void {
		if (logoBusy || !brandStrip.visible) return
		logoBusy = true
		animateOnce(
			(t) => {
				if (t < 0.4) paintLogo({ reveal: t / 0.4, sweep: null })
				else paintLogo({ sweep: -3 + ((t - 0.4) / 0.6) * (logoCols + 6) })
			},
			{
				duration: 1200,
				ease: "inOutSine",
				onDone: () => {
					logoBusy = false
					paintLogo({})
				},
			},
		)
	}
	/** Shorter light pass across the mark, played when a session opens or is created. */
	function logoSweep(): void {
		if (logoBusy || !brandStrip.visible) return
		logoBusy = true
		animateOnce((t) => paintLogo({ sweep: -3 + t * (logoCols + 6) }), {
			duration: 700,
			ease: "inOutSine",
			onDone: () => {
				logoBusy = false
				paintLogo({})
			},
		})
	}

	// The activity log: scroll back (mouse wheel) through what has happened.
	// Curated by default; `v` switches to everything, with timestamps.
	const logScroll = new ScrollBoxRenderable(renderer, {
		id: "logScroll",
		flexGrow: 1,
		scrollY: true,
		scrollX: false,
		verticalScrollbarOptions: {
			showArrows: false,
			trackOptions: { foregroundColor: PURPLE, backgroundColor: TRACK_BG },
		},
	})
	main.add(logScroll)

	const logBox = new BoxRenderable(renderer, { id: "logBox", flexDirection: "column" })
	logScroll.add(logBox)

	// The input line — empty at rest (the actions live in the statusline), a busy
	// spinner while an action runs, a prompt while typing an id/title or confirming
	// a delete.
	const inputLine = new TextRenderable(renderer, {
		id: "inputLine",
		content: "",
		fg: PURPLE,
		flexShrink: 0,
		marginTop: 1,
	})
	main.add(inputLine)

	// --- log rendering ---------------------------------------------------------
	let logSeq = 0

	function trimLog(): void {
		const children = [...logBox.getChildren()]
		const excess = children.length - MAX_LOG_LINES
		for (let i = 0; i < excess; i++) children[i]?.destroy()
	}

	/** Pin the log to its newest line — after layout, so scrollHeight is current. */
	function scrollLogToEnd(): void {
		setTimeout(() => {
			logScroll.scrollTop = logScroll.scrollHeight
		}, 0)
	}

	/** Append one entry: store it, and if the current view shows it, render it
	 * with a short fade-in from the background to its resting ink. */
	function appendEntry(entry: LogEntry): void {
		logStore.push(entry)
		if (logStore.shows(entry, verbose)) {
			const paint = (alpha: number) => logEntryChunks(entry, { timestamps: verbose, alpha })
			const text = new TextRenderable(renderer, {
				id: `log-${logSeq++}`,
				content: new StyledText(paint(0)),
			})
			logBox.add(text)
			trimLog()
			scrollLogToEnd()
			animateOnce(
				(t) => {
					try {
						text.content = new StyledText(paint(t))
					} catch {}
				},
				{ duration: 260 },
			)
		}
		// Errors also flash the main frame so they register at the edge of vision.
		if (entry.level === "error") {
			animateOnce(
				(t) => {
					main.borderColor = mixHex(PURPLE_BRIGHT, PURPLE, t)
				},
				{ duration: 500 },
			)
		}
	}

	/** Rebuild the whole visible log from the store (used when toggling verbose). */
	function renderLog(): void {
		for (const child of [...logBox.getChildren()]) child.destroy()
		for (const entry of logStore.visible(verbose, MAX_LOG_LINES)) {
			logBox.add(
				new TextRenderable(renderer, {
					id: `log-${logSeq++}`,
					content: new StyledText(logEntryChunks(entry, { timestamps: verbose })),
				}),
			)
		}
		scrollLogToEnd()
	}

	function appendLog(message: string, level: "info" | "warn" | "error" = "info"): void {
		appendEntry({ ts: Date.now(), kind: "action", level, text: message })
	}

	/** The user's own inputs and their direct feedback — the default view. */
	function appendUser(message: string, level: "info" | "warn" | "error" = "info"): void {
		appendEntry({ ts: Date.now(), kind: "user", level, text: message })
	}

	/** Low-level chatter: only visible in the verbose view. */
	function appendEvent(message: string): void {
		appendEntry({ ts: Date.now(), kind: "event", level: "info", text: message })
	}

	function toggleVerbose(): void {
		verbose = !verbose
		main.title = verbose ? " activity · everything " : " activity "
		appendUser(verbose ? "verbose on" : "verbose off")
		renderLog()
	}

	// --- busy spinner ------------------------------------------------------------
	// While any orchestrator action is in flight, the resting input line shows a
	// spinner with the action's verb.
	let busyCount = 0
	let busyLabel = ""
	let spinFrame = "⠋"
	let stopSpin: (() => void) | undefined

	function busy<T>(label: string, work: Promise<T>): Promise<T> {
		busyCount++
		busyLabel = label
		if (!stopSpin) {
			stopSpin = spin((frame) => {
				spinFrame = frame
				if (mode === "none") redrawInput()
			})
		}
		return work.finally(() => {
			busyCount--
			if (busyCount <= 0) {
				busyCount = 0
				stopSpin?.()
				stopSpin = undefined
				redrawInput()
			}
		})
	}

	// --- statusline: one borderless strip of clickable commands -------------------
	const statusBar = new BoxRenderable(renderer, {
		id: "statusBar",
		flexDirection: "row",
		flexShrink: 0,
		marginTop: 1,
		paddingLeft: 1,
		paddingRight: 1,
		backgroundColor: TRACK_BG,
	})
	root.add(statusBar)

	const commands = new Map<string, { text: TextRenderable; full: string; short: string }>()
	function makeCommand(id: string, full: string, short: string, onClick: () => void): void {
		const text = new TextRenderable(renderer, {
			id: `cmd-${id}`,
			content: full,
			fg: PURPLE,
			marginRight: 3,
			onMouseDown: () => onClick(),
		})
		statusBar.add(text)
		commands.set(id, { text, full, short })
	}

	/** Micro-flash the statusline label of the command that just fired. */
	function flashCommand(id: string): void {
		const cmd = commands.get(id)
		if (!cmd) return
		animateOnce(
			(t) => {
				try {
					cmd.text.fg = mixHex(PURPLE_BRIGHT, PURPLE, t)
				} catch {}
			},
			{ duration: 350 },
		)
	}

	function redrawInput(): void {
		const purple = fg(PURPLE)
		const hint = (t: string) => dim(purple(t))
		if (mode === "open" || mode === "delete") {
			const verb = mode === "open" ? "open" : "delete"
			inputLine.content = new StyledText([
				purple(`${verb} session › ${buffer}▏`),
				hint("   (type an id or click a session · Esc cancels)"),
			])
			return
		}
		if (mode === "rename") {
			inputLine.content = new StyledText([
				purple(`rename › ${buffer}▏`),
				hint("   (Enter saves · Esc cancels)"),
			])
			return
		}
		if (mode === "confirmDelete") {
			inputLine.content = new StyledText([
				purple(`delete "${pendingDelete}"? › `),
				bold(purple("y / n")),
				hint("   (Esc cancels)"),
			])
			return
		}
		if (busyCount > 0) {
			inputLine.content = new StyledText([dim(purple(`${spinFrame} ${busyLabel}…`))])
			return
		}
		inputLine.content = ""
	}

	const loadSessions = makeSessionLoader()
	const rowRegistry = new Map<
		string,
		{ text: TextRenderable; state: SessionState; mtimeMs: number; rel: string }
	>()
	let lastSignature = ""

	// The live session is marked by a light band sweeping across its heading,
	// looping for as long as a session is open — the same pass the logo plays.
	let liveSweep: number | null = null
	let stopLiveSweep: (() => void) | undefined
	const LIVE_SWEEP_SPAN = 24

	function repaintLiveRow(): void {
		const id = orchestrator.sessionId
		if (!id) return
		const entry = rowRegistry.get(id)
		if (!entry) return
		try {
			entry.text.content = new StyledText(sessionChunks(entry.state, true, liveSweep, agentStatus))
		} catch {}
	}

	/** Start/stop the looping heading sweep to match whether a session is open.
	 * Each 5s loop plays one ~1.2s pass, then the heading rests. */
	function syncLiveSweep(): void {
		if (orchestrator.hasSession && !stopLiveSweep) {
			const PASS = 0.24
			stopLiveSweep = sweepLoop((t) => {
				const next = t < PASS ? -3 + (t / PASS) * (LIVE_SWEEP_SPAN + 6) : null
				if (next === null && liveSweep === null) return
				liveSweep = next
				repaintLiveRow()
			}, 5000)
		} else if (!orchestrator.hasSession && stopLiveSweep) {
			stopLiveSweep()
			stopLiveSweep = undefined
			liveSweep = null
		}
	}

	function renderHeaderInfo(sessionCount: number): void {
		const parts: string[] = [`${sessionCount} session${sessionCount === 1 ? "" : "s"}`]
		if (orchestrator.hasSession) {
			const n = orchestrator.paneList.length
			parts.push(`${n} pane${n === 1 ? "" : "s"}`)
		}
		headerInfo.content = new StyledText([dim(fg(PURPLE)(parts.join(" · ")))])
	}

	function renderSessions(): void {
		try {
			const sessions = loadSessions()
			renderHeaderInfo(sessions.length)
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
					entry.state = s.state
					if (entry.mtimeMs === s.mtimeMs && entry.rel === rel) continue
					const live = s.state.id === orchestrator.sessionId
					entry.text.content = new StyledText(
						sessionChunks(s.state, live, live ? liveSweep : null, agentStatus),
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
					// Left-click opens a session; right-click (or a click in delete mode)
					// arms the delete confirmation for it.
					onMouseDown: (event) => {
						if (event.button === 2 || mode === "delete") armDelete(s.state.id)
						else void doOpen(s.state.id)
					},
				})
				const text = new TextRenderable(renderer, {
					id: `rowtxt-${s.state.id}`,
					content: new StyledText(
						sessionChunks(s.state, live, live ? liveSweep : null, agentStatus),
					),
				})
				row.add(text)
				listBox.add(row)
				rowRegistry.set(s.state.id, {
					text,
					state: s.state,
					mtimeMs: s.mtimeMs,
					rel: relativeTime(s.state.updatedAt),
				})
			}
			scroll.scrollTop = savedScroll
		} catch {
			appendLog("session list error", "error")
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

	// --- responsive layout ---------------------------------------------------
	// People resize the command window; keep the layout legible at any size.
	// Wide: sidebar beside the main area, ASCII logo up top. Narrow: stacked,
	// one-line logo. Tight heights drop padding, then the statusline (its keys
	// keep working), then the header.
	let compactBar: boolean | undefined
	function applyLayout(width: number, height: number): void {
		const narrow = width < NARROW_COLS
		const tight = height < 14 || width < 40
		root.padding = tight ? 0 : 1
		body.flexDirection = narrow ? "column" : "row"
		if (narrow) {
			sidebar.width = "100%"
			sidebar.height = Math.max(7, Math.floor(height * 0.35))
			main.marginLeft = 0
			main.marginTop = 1
		} else {
			sidebar.width = width < 92 ? SIDEBAR_MEDIUM : SIDEBAR_WIDE
			sidebar.height = "auto"
			main.marginLeft = 1
			main.marginTop = 0
		}
		brandStrip.visible = height >= LOGO_MIN_ROWS
		headerInfo.visible = width >= 44
		statusBar.visible = height >= 12
		const compact = width < COMPACT_BAR_COLS
		if (compact !== compactBar) {
			compactBar = compact
			for (const cmd of commands.values()) {
				cmd.text.content = compact ? cmd.short : cmd.full
				cmd.text.marginRight = compact ? 2 : 3
			}
		}
	}

	let resizeLogTimer: ReturnType<typeof setTimeout> | undefined
	renderer.on("resize", (width: number, height: number) => {
		applyLayout(width, height)
		if (resizeLogTimer) clearTimeout(resizeLogTimer)
		resizeLogTimer = setTimeout(() => {
			resizeLogTimer = undefined
			appendEvent(`resized to ${renderer.terminalWidth}×${renderer.terminalHeight}`)
		}, 400)
	})

	// --- actions (shared by the keys and the clickable statusline commands) ----
	function resetMode(): void {
		mode = "none"
		buffer = ""
		redrawInput()
	}

	async function doNew(seed?: PaneSeed): Promise<void> {
		appendUser("new session")
		// newSession() closes any current session first (single atomic action).
		await busy("new session", orchestrator.newSession(seed))
			.then(() => logoSweep())
			.catch(() => {})
	}

	async function doAdd(): Promise<void> {
		appendUser("add pane")
		await busy("adding pane", orchestrator.addPane()).catch(() => {})
	}

	async function doOpen(id: string): Promise<void> {
		const trimmed = id.trim()
		resetMode()
		if (!trimmed) return
		appendUser(`open ${trimmed}`)
		// openSession() is the single shared restore action: it closes whatever's
		// open and restores the requested session in one step.
		await busy("opening session", orchestrator.openSession(trimmed))
			.then(() => logoSweep())
			.catch(() => {})
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
		redrawInput()
	}

	async function doDelete(id: string): Promise<void> {
		const trimmed = id.trim()
		resetMode()
		if (!trimmed) return
		appendUser(`delete ${trimmed}`)
		await busy("deleting", orchestrator.deleteSavedSession(trimmed)).catch(() => {})
	}

	function doRename(title: string): void {
		const trimmed = title.trim()
		resetMode()
		if (!trimmed) return
		appendUser(`rename → "${trimmed}"`)
		orchestrator.renameSession(trimmed)
	}

	function doClose(): void {
		if (!orchestrator.hasSession) {
			appendUser("no session open", "warn")
			return
		}
		appendUser("close session")
		void busy("closing session", orchestrator.closeSessionAction()).catch(() => {})
	}

	function enterMode(next: "open" | "delete" | "rename"): void {
		if (next === "rename" && !orchestrator.hasSession) {
			appendUser("no session to rename", "warn")
			return
		}
		flashCommand(next === "open" ? "s" : next === "delete" ? "d" : "r")
		mode = next
		buffer = ""
		redrawInput()
	}

	makeCommand("n", "n new", "n new", () => void doNew())
	makeCommand("a", "a add pane", "a add", () => void doAdd())
	makeCommand("s", "s open", "s open", () => enterMode("open"))
	makeCommand("c", "c close", "c close", () => doClose())
	makeCommand("r", "r rename", "r ren", () => enterMode("rename"))
	makeCommand("d", "d delete", "d del", () => enterMode("delete"))
	makeCommand("v", "v verbose", "v all", () => {
		flashCommand("v")
		toggleVerbose()
	})
	makeCommand("q", "q quit", "q quit", () => void shutdown())

	orchestrator.on((e) => {
		if (e.type === "panes-changed") {
			appendEvent("panes changed")
			for (const id of [...agentStatus.keys()]) {
				if (!orchestrator.paneList.some((p) => p.id === id)) agentStatus.delete(id)
			}
			scheduleRender()
			redrawInput()
			syncLiveSweep()
		} else if (e.type === "log") {
			// Every orchestrator event lands in the log store.
			appendLog(e.message, e.level)
		} else if (e.type === "message") {
			appendEntry({
				ts: Date.now(),
				kind: "message",
				level: "info",
				text: e.text,
				from: e.from,
				to: e.to,
				color: e.color,
			})
		} else if (e.type === "status") {
			agentStatus.set(e.pane, { status: e.status, task: e.task })
			appendEntry({
				ts: Date.now(),
				kind: "status",
				level: "info",
				text: e.status,
				pane: e.pane,
				task: e.task,
				color: e.color,
			})
			// The sidebar shows each live pane's latest status after its name. Status
			// events don't touch the session file, so repaint the live row directly.
			repaintLiveRow()
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
		if (resizeLogTimer) clearTimeout(resizeLogTimer)
		stopSpin?.()
		stopLiveSweep?.()
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
				appendUser("focus → next pane")
				orchestrator.focusNext()
				break
			case "focusPrev":
				appendUser("focus → previous pane")
				orchestrator.focusPrev()
				break
			case "new":
				flashCommand("n")
				void doNew()
				break
			case "add":
				flashCommand("a")
				void doAdd()
				break
			case "close":
				flashCommand("c")
				doClose()
				break
			case "toggleLog":
				flashCommand("v")
				toggleVerbose()
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
				appendUser(action.message, "warn")
				break
			case "redraw":
				redrawInput()
				break
			case "none":
				break
		}
	}

	function applyInput(result: InputResult): void {
		const entering = result.state.mode !== "none" && mode === "none"
		mode = result.state.mode
		buffer = result.state.buffer
		pendingDelete = result.state.pendingDelete
		if (entering && (mode === "open" || mode === "delete" || mode === "rename"))
			flashCommand(mode === "open" ? "s" : mode === "delete" ? "d" : "r")
		dispatch(result.action)
	}

	renderer.keyInput.on("keypress", (key: KeyEvent) => applyInput(handleKey(snapshot(), key)))
	renderer.keyInput.on("paste", (e: PasteEvent) =>
		applyInput(handlePaste(snapshot(), decodePasteBytes(e.bytes))),
	)

	applyLayout(renderer.terminalWidth, renderer.terminalHeight)
	renderSessions()
	redrawInput()
	renderer.start()
	logoIntro()

	// Keep relative times current and pick up the live session's continuous saves.
	refresh = setInterval(renderSessions, 2000)

	// restore opens that session at its saved geometry, new starts a fresh one.
	// Otherwise this window stays a launcher — size its (session-less) command
	// window to the default so it looks right.
	if (launch.kind === "restore") void orchestrator.openSession(launch.name).catch(() => {})
	else if (launch.kind === "new") void doNew(launch.seed)
	else orchestrator.sizeCenter()
}
