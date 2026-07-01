/**
 * The orchestrator: the one object the TUI (and later, the real app) talks to.
 *
 * It talks to the persistent session daemon (which owns the shells), launches a
 * thin pane client into each new pane/tab/window via the wt.exe wrapper, and
 * tracks the lifecycle + tiling of every pane it created. The shells outlive this
 * process, so closing/reopening reattaches to the same live shell.
 */

import { paletteColor } from "../core/colors"
import {
	ANIM_MS,
	BUN_EXE,
	CENTER_H_FRAC,
	CENTER_W_FRAC,
	CLIENT_PATH,
	COLOR_MODE,
	TILE_GAP,
	TITLE_DEBOUNCE_MS,
	TITLE_ENABLED,
} from "../core/config"
import type { ControlEvent } from "../core/daemonProtocol"
import { pickUniqueName } from "../core/names"
import {
	deleteSession,
	generateSessionId,
	loadSession,
	type SessionState,
	saveSession,
} from "../core/session"
import { DaemonClient } from "../daemon/daemonClient"
import { findTerminalWindowByExactTitle, type Hwnd, type Rect } from "../platform/win32"
import { type Direction, spawnTab, spawnWindow } from "../platform/wt"
import { LayoutManager } from "./layout"
import { disposeTitleModel, gatherActivity, generateTitle } from "./title"

/** Window title each satellite gets — its (unique) pane name, used to find its HWND. */
function satelliteTitle(id: string): string {
	return id
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

export type PaneStatus = "spawning" | "connected" | "exited"

export interface ManagedPane {
	id: string
	kind: "pane" | "tab" | "window"
	direction?: Direction
	status: PaneStatus
	pid?: number
	color?: string
	cwd?: string
	lastCommand?: string
	/** Whitelisted foreground program (e.g. "vim"), reported by the agent. */
	foreground?: string
	createdAt: number
}

export type OrchestratorEvent =
	| { type: "log"; level: "info" | "warn" | "error"; message: string }
	| { type: "panes-changed" }

export class Orchestrator {
	private readonly daemon = new DaemonClient()
	private readonly layout = new LayoutManager()
	private readonly panes = new Map<string, ManagedPane>()
	private readonly listeners = new Set<(e: OrchestratorEvent) => void>()
	/** Monotonic index into the color palette (separate from pane names). */
	private colorIndex = 0

	/** The current session's unique id (a soldier name; the center window's title). */
	sessionId = ""
	/** Model-generated human title for this session (undefined until generated). */
	sessionTitle?: string
	private pendingRestore?: SessionState
	private persistTimer?: ReturnType<typeof setInterval>
	/** Debounce timer + in-flight guard for auto title (re)generation. */
	private titleTimer?: ReturnType<typeof setTimeout>
	private titleBusy = false
	/** Last activity text we titled, so we skip regenerating identical activity. */
	private lastTitledActivity?: string

	on(listener: (e: OrchestratorEvent) => void): () => void {
		this.listeners.add(listener)
		return () => this.listeners.delete(listener)
	}

	private emit(event: OrchestratorEvent): void {
		for (const l of this.listeners) l(event)
	}

	private log(message: string, level: "info" | "warn" | "error" = "info"): void {
		this.emit({ type: "log", level, message })
	}

	/**
	 * Launch the command center: capture + size this WT window as the fixed center
	 * and start following it. NO session is started — the window opens as a launcher
	 * (a session browser). Call newSession() or openSession() to begin one.
	 */
	async start(): Promise<void> {
		this.daemon.on((e) => this.onDaemonEvent(e))
		// Capture the center FIRST (while our WT window is foreground), before any
		// daemon spawn can momentarily affect window focus. Sizing is deliberately
		// left to the session path: a NEW session/launcher centers to the default
		// fraction (sizeCenter), while a RESTORE goes straight to its saved rect
		// (openSession → setCenterRect). Default-sizing here first would desync the
		// geometry the restored panes are tiled against.
		try {
			this.layout.captureCenter()
			this.layout.gap = TILE_GAP
			this.layout.animMs = ANIM_MS
			this.layout.watch() // follow the center if the user drags/moves it
		} catch (err) {
			this.log(`could not set up center window: ${(err as Error).message}`, "error")
		}
	}

	/** Size + center the command window to the default fraction (launcher / new session). */
	sizeCenter(): void {
		try {
			const rect = this.layout.centerWindow(CENTER_W_FRAC, CENTER_H_FRAC)
			this.log(`command center ${rect.w}×${rect.h} @ (${rect.x},${rect.y})`)
		} catch (err) {
			this.log(`could not size center window: ${(err as Error).message}`, "error")
		}
	}

	/** Whether a session has been started in this window yet. */
	get hasSession(): boolean {
		return this.sessionId !== ""
	}

	/** Connect to (or start) the daemon for the current session, and begin persisting. */
	private async beginSession(): Promise<void> {
		this.persistTimer = setInterval(() => this.persist(), 2000)
		this.persist()
		this.emit({ type: "panes-changed" })
		try {
			await this.daemon.ensure(this.sessionId)
			this.log("session daemon ready")
		} catch (err) {
			this.log(`daemon failed to start: ${(err as Error).message}`, "error")
		}
	}

	/**
	 * Tear down the current session (if any) and WAIT for its pane windows to fully
	 * close before returning. Pane names are drawn from a shared pool, so a new
	 * session can reuse an id that an old, still-closing window still holds — and
	 * we locate pane windows by title. Waiting them out prevents the new pane from
	 * binding to the old window (which then closes, leaving the new one untiled).
	 */
	private async teardownCurrentSession(): Promise<void> {
		if (!this.hasSession) return
		const oldIds = [...this.panes.keys()]
		this.closeSession()
		for (let i = 0; i < 30; i++) {
			if (!oldIds.some((id) => findTerminalWindowByExactTitle(id) !== null)) return
			await sleep(100)
		}
	}

	/** Start a brand-new session in this window and spawn its first pane. */
	async newSession(): Promise<void> {
		await this.teardownCurrentSession()
		this.sizeCenter() // a fresh session gets the default centered command window
		this.sessionId = generateSessionId()
		this.sessionTitle = undefined
		this.log(`new session: ${this.sessionId}`)
		await this.beginSession()
		await this.addPane()
	}

	/**
	 * Open a session in this window — the single shared "restore" action. Closing
	 * the current session (if any) and restoring the requested one is one atomic
	 * step, so opening from the launcher and switching mid-session behave identically.
	 */
	async openSession(id: string): Promise<void> {
		const state = loadSession(id)
		if (!state) {
			this.log(`no saved session "${id}"`, "warn")
			return
		}
		await this.teardownCurrentSession()
		this.sessionId = state.id
		this.sessionTitle = state.title
		this.pendingRestore = state
		this.layout.setCenterRect(state.center)
		this.log(`opening "${state.id}": ${state.satellites.length} panes`)
		await this.beginSession()
		await this.applyRestore()
	}

	/**
	 * Close the current session and return this window to the launcher state: its
	 * pane windows close but the shells stay ALIVE in the daemon (so it can be
	 * reopened later). Does nothing if no session is active.
	 */
	closeSession(): void {
		if (!this.hasSession) return
		const id = this.sessionId
		if (this.persistTimer) {
			clearInterval(this.persistTimer)
			this.persistTimer = undefined
		}
		if (this.titleTimer) {
			clearTimeout(this.titleTimer)
			this.titleTimer = undefined
		}
		this.persist() // final save before detaching
		void this.daemon.detachSession(id).catch(() => {})
		// Reset back to a clean launcher.
		this.layout.clearSatellites()
		this.panes.clear()
		this.sessionId = ""
		this.sessionTitle = undefined
		this.colorIndex = 0
		this.dirCycleIndex = 0
		this.pendingRestore = undefined
		this.lastTitledActivity = undefined
		this.titleBusy = false
		this.log(`closed session "${id}"`)
		this.emit({ type: "panes-changed" })
	}

	/**
	 * Delete a saved session (its file + scrollback). If it's the one currently
	 * open, close it first. Returns true if the session existed.
	 */
	deleteSavedSession(id: string): boolean {
		if (id === this.sessionId) {
			// Kill the panes first: that closes their windows AND ends the shells,
			// releasing the daemon's capture-file handles so the scrollback can go.
			for (const paneId of [...this.panes.keys()]) this.kill(paneId)
			this.closeSession()
		}
		const ok = deleteSession(id)
		this.log(ok ? `deleted session "${id}"` : `no session "${id}" to delete`, ok ? "info" : "warn")
		this.emit({ type: "panes-changed" })
		return ok
	}

	/** Re-spawn the satellites from a session being restored (call after start). */
	async applyRestore(): Promise<void> {
		const state = this.pendingRestore
		if (!state) return
		this.pendingRestore = undefined
		for (const s of state.satellites) {
			try {
				await this.spawnSatellite({
					id: s.id,
					direction: s.direction,
					color: s.color,
					cwd: s.cwd,
					// Re-tile fresh by direction rather than replaying the saved pixel
					// rect: panes are always auto-placed now, and the saved rects can be
					// stale/overlapping. Tiling around the restored center is always clean.
					relaunch: s.foreground, // cold restore: re-open the program that was running
				})
				const pane = this.panes.get(s.id) // carry saved metadata forward (daemon will refresh)
				if (pane) {
					pane.lastCommand = s.lastCommand
					pane.foreground = s.foreground
				}
			} catch (err) {
				this.log(`restore failed for "${s.id}": ${(err as Error).message}`, "error")
			}
		}
		// Re-assert the exact center rect (in case WT nudged it during launch), then
		// re-tile every zone cleanly against it so nothing overlaps even if the center
		// drifted while the panes were spawning.
		this.layout.setCenterRect(state.center)
		this.layout.relayout()
		// Continue the color palette + direction cycle past the restored panes so
		// new ones (via `addPane`) get fresh colors and the next zone in turn.
		this.colorIndex = Math.max(this.colorIndex, state.satellites.length)
		this.dirCycleIndex = Math.max(this.dirCycleIndex, state.satellites.length)
		this.persist()
		this.log(`restored session "${this.sessionId}"`)
		// Refresh the title from the restored panes' (now live) scrollback.
		this.scheduleTitle()
	}

	/** Write the current layout to the session file. */
	private persist(): void {
		if (!this.sessionId) return
		try {
			const snap = this.layout.snapshot()
			const satellites = snap.sats.map((s) => {
				const p = this.panes.get(s.id)
				return {
					id: s.id,
					direction: s.dir,
					color: p?.color,
					cwd: p?.cwd,
					lastCommand: p?.lastCommand,
					foreground: p?.foreground,
					rect: s.rect,
				}
			})
			saveSession({
				id: this.sessionId,
				title: this.sessionTitle,
				updatedAt: new Date().toISOString(),
				center: snap.center,
				satellites,
			})
		} catch {
			// best-effort; never let persistence crash the app
		}
	}

	/**
	 * Debounced, auto-only session titling. Each new command resets the timer; when
	 * activity settles we read the panes' recent scrollback and ask the local title
	 * model for a name. Best-effort: failures leave the existing title (or id) in
	 * place. Skips work when the activity is unchanged since the last title.
	 */
	private scheduleTitle(): void {
		if (!TITLE_ENABLED) return
		if (this.titleTimer) clearTimeout(this.titleTimer)
		this.titleTimer = setTimeout(() => void this.regenerateTitle(), TITLE_DEBOUNCE_MS)
	}

	private async regenerateTitle(): Promise<void> {
		if (this.titleBusy || !this.sessionId) return
		const activity = gatherActivity(this.sessionId, [...this.panes.keys()])
		if (!activity || activity === this.lastTitledActivity) return
		this.titleBusy = true
		try {
			const title = await generateTitle(activity)
			this.lastTitledActivity = activity
			if (title && title !== this.sessionTitle) {
				this.sessionTitle = title
				this.persist()
				this.emit({ type: "panes-changed" })
				this.log(`titled session → "${title}"`)
			}
		} finally {
			this.titleBusy = false
		}
	}

	/** Per-pane state pushed by the daemon (cwd/lastCommand/foreground/pid) and exits. */
	private onDaemonEvent(e: ControlEvent): void {
		if (e.session !== this.sessionId) return
		if (e.event === "paneExited") {
			const pane = this.panes.get(e.pane)
			if (pane) pane.status = "exited"
			if (this.layout.has(e.pane)) this.layout.remove(e.pane)
			this.log(`pane "${e.pane}" shell exited`, "warn")
			this.emit({ type: "panes-changed" })
			this.persist()
			return
		}
		if (e.event === "paneClosed") {
			// The user closed this pane's window. The daemon already killed the shell
			// and deleted its scrollback; de-register it so it's gone from the session
			// for good (and the remaining panes re-tile to fill its zone).
			if (this.layout.has(e.pane)) this.layout.remove(e.pane)
			this.panes.delete(e.pane)
			this.log(`pane "${e.pane}" closed — removed from session`)
			this.emit({ type: "panes-changed" })
			this.persist()
			return
		}
		// e.event === "pane": merge the daemon's view into our ManagedPane.
		const s = e.state
		const pane = this.panes.get(s.pane)
		if (!pane) return
		let changed = false
		if (s.pid !== undefined && pane.pid !== s.pid) {
			pane.pid = s.pid
			pane.status = "connected"
			changed = true
		}
		if (s.cwd !== undefined && pane.cwd !== s.cwd) {
			pane.cwd = s.cwd
			changed = true
		}
		let newCommand = false
		if (s.lastCommand !== undefined && pane.lastCommand !== s.lastCommand) {
			pane.lastCommand = s.lastCommand
			changed = true
			newCommand = true
		}
		if (pane.foreground !== s.foreground) {
			pane.foreground = s.foreground
			changed = true
		}
		if (changed) {
			this.persist()
			this.emit({ type: "panes-changed" })
		}
		// A fresh command ran in some pane → (re)title once activity settles.
		if (newCommand) this.scheduleTitle()
	}

	/** A unique soldier name for a new pane (avoids existing panes + the session). */
	private nextId(): string {
		const taken = new Set<string>(this.panes.keys())
		taken.add(this.sessionId)
		return pickUniqueName(taken)
	}

	/** argv that launches a thin pane client attached to the daemon for `paneId`. */
	private clientCommandline(paneId: string): string[] {
		return [BUN_EXE, CLIENT_PATH, "--session", this.sessionId, "--pane", paneId]
	}

	/** Zones a new pane cycles through, in order, each time you add one. */
	private static readonly DIR_CYCLE: Direction[] = ["right", "left", "up", "down"]
	private dirCycleIndex = 0

	/** Next auto-placement zone: right → left → up → down → right → … */
	private nextDirection(): Direction {
		const d = Orchestrator.DIR_CYCLE[this.dirCycleIndex % Orchestrator.DIR_CYCLE.length] ?? "right"
		this.dirCycleIndex++
		return d
	}

	/**
	 * Spawn one more pane, auto-placed in the next zone of the cycle (no direction
	 * to choose). The daemon creates (or warm-reuses) the shell; the window runs a
	 * thin client attached to it, tiled via Win32 so the center never moves.
	 */
	async addPane(opts: { cwd?: string } = {}): Promise<string | null> {
		if (!this.hasSession) {
			this.log("no active session — press n to start one", "warn")
			return null
		}
		const direction = this.nextDirection()
		const id = this.nextId()
		const hue = COLOR_MODE === "off" ? undefined : paletteColor(this.colorIndex++)
		await this.spawnSatellite({ id, direction, color: hue, cwd: opts.cwd })
		return id
	}

	/** Spawn one satellite window (shared by new spawns and session restore). */
	private async spawnSatellite(spec: {
		id: string
		direction: Direction
		color?: string
		cwd?: string
		/** Exact rect to restore to (skips auto-tiling). */
		rect?: Rect
		/** Whitelisted program to re-launch on a cold restore (daemon-side). */
		relaunch?: string
	}): Promise<void> {
		const { id, direction } = spec
		const useTab = COLOR_MODE !== "off" && (COLOR_MODE === "tab" || COLOR_MODE === "both")
		const cwd = spec.cwd ?? process.cwd()
		this.panes.set(id, {
			id,
			kind: "window",
			direction,
			status: "spawning",
			color: COLOR_MODE === "off" ? undefined : spec.color,
			cwd,
			createdAt: performance.now(),
		})
		this.emit({ type: "panes-changed" })
		try {
			// Daemon hosts the shell: warm-reuse if it's still alive, else (re)create
			// it — cold-restoring from the capture + cwd when the daemon was restarted.
			const res = await this.daemon.createPane(this.sessionId, id, {
				cwd,
				relaunch: spec.relaunch,
			})
			this.log(
				`pane "${id}" ${res.warm ? "reattached (warm)" : res.cold ? "cold-restored" : "created"}`,
			)

			// Spawn near the final spot: the saved rect when restoring, else the zone.
			const origin = spec.rect
				? { x: spec.rect.x, y: spec.rect.y }
				: this.layout.zoneOrigin(direction)
			await spawnWindow({
				commandline: this.clientCommandline(id),
				cwd,
				title: satelliteTitle(id),
				tabColor: useTab ? spec.color : undefined,
				pos: origin,
				size: { cols: 80, rows: 24 },
			})

			// The window appears asynchronously; poll for its HWND by title.
			let hwnd: Hwnd | null = null
			for (let i = 0; i < 50; i++) {
				hwnd = findTerminalWindowByExactTitle(satelliteTitle(id))
				if (hwnd) break
				await sleep(100)
			}
			if (!hwnd) throw new Error("window did not appear (title not found)")

			if (spec.rect) {
				this.layout.addRestored(id, hwnd, direction, spec.rect)
				this.log(`restored ${direction} window "${id}"`)
			} else {
				this.layout.add(id, hwnd, direction)
				this.log(`spawned ${direction} window "${id}" → tiled`)
			}
			this.persist()
		} catch (err) {
			this.panes.delete(id)
			this.emit({ type: "panes-changed" })
			this.log(`failed to spawn window: ${(err as Error).message}`, "error")
			throw err
		}
	}

	/** Open a new (untiled) tab running a daemon-backed pane. Not restored. */
	async openTab(opts: { cwd?: string } = {}): Promise<string> {
		const id = this.nextId()
		this.panes.set(id, { id, kind: "tab", status: "spawning", createdAt: performance.now() })
		this.emit({ type: "panes-changed" })
		await this.daemon.createPane(this.sessionId, id, { cwd: opts.cwd })
		await spawnTab({ commandline: this.clientCommandline(id), cwd: opts.cwd, title: id })
		this.log(`spawned tab "${id}"`)
		return id
	}

	/** Open a new (untiled) free window running a daemon-backed pane. Not restored. */
	async openWindow(
		opts: {
			cwd?: string
			pos?: { x: number; y: number }
			size?: { cols: number; rows: number }
		} = {},
	): Promise<string> {
		const id = this.nextId()
		this.panes.set(id, { id, kind: "window", status: "spawning", createdAt: performance.now() })
		this.emit({ type: "panes-changed" })
		await this.daemon.createPane(this.sessionId, id, { cwd: opts.cwd })
		await spawnWindow({
			commandline: this.clientCommandline(id),
			cwd: opts.cwd,
			pos: opts.pos,
			size: opts.size,
			title: id,
		})
		this.log(`spawned window "${id}"`)
		return id
	}

	/** Kill a pane's shell in the daemon (truly gone) and forget it. */
	kill(paneId: string): boolean {
		if (!this.panes.has(paneId)) {
			this.log(`no pane "${paneId}"`, "warn")
			return false
		}
		void this.daemon.killPane(this.sessionId, paneId).catch(() => {})
		this.log(`killing pane "${paneId}"`)
		return true
	}

	list(): ManagedPane[] {
		return [...this.panes.values()]
	}

	private stopped = false

	/**
	 * Tear down the UI: persist once, stop watching, and close the satellite client
	 * windows — but DO NOT kill the shells. They stay alive in the daemon so a later
	 * restore re-attaches to them. Idempotent.
	 */
	stop(): void {
		if (this.stopped) return
		this.stopped = true
		if (this.persistTimer) clearInterval(this.persistTimer)
		if (this.titleTimer) clearTimeout(this.titleTimer)
		void disposeTitleModel()
		this.persist()
		this.layout.unwatch()
		void this.daemon.detachSession(this.sessionId).catch(() => {})
		this.daemon.stop()
	}
}
