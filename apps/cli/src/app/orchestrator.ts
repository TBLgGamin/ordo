/**
 * The orchestrator: the one object the TUI (and later, the real app) talks to.
 *
 * It talks to the persistent session daemon (which owns the shells), launches a
 * thin pane client into each new pane/tab/window via the wt.exe wrapper, and
 * tracks the lifecycle + tiling of every pane it created. The shells outlive this
 * process, so closing/reopening reattaches to the same live shell.
 */

import type { PaneSeed } from "../cli/launch"
import { ensureAgentIntegrations } from "../core/agentSetup"
import { paletteColor } from "../core/colors"
import {
	ANIM_MS,
	BUN_EXE,
	CENTER_H_FRAC,
	CENTER_W_FRAC,
	CLIENT_PATH,
	COLOR_MODE,
	TILE_GAP,
} from "../core/config"
import type { ControlEvent } from "../core/daemonProtocol"
import { errMessage } from "../core/errors"
import { pickUniqueName } from "../core/names"
import {
	deleteSession,
	listSessionNames,
	loadSession,
	type SessionState,
	saveSession,
} from "../core/session"
import { DaemonClient } from "../daemon/daemonClient"
import {
	type Direction,
	listTerminalWindows,
	type Rect,
	spawnWindow,
	type WindowHandle,
	type WindowInfo,
	wmCaps,
} from "../platform"
import { LayoutManager } from "./layout"
import { reconnectDecision } from "./reconnect"
import { gatherActivity } from "./title"
import { SessionTitler } from "./titler"
import { type ManagedPane, type OrchestratorEvent, runPool, satelliteTitle, sleep } from "./types"

const TEARDOWN_POLL_INTERVAL_MS = 100
const TEARDOWN_POLL_ATTEMPTS = 5
const WINDOW_FIND_TIMEOUT_MS = 5000
const WINDOW_POLL_STEP_MS = 50
const WINDOW_POLL_MAX_MS = 250
const WINDOW_ENUM_TTL_MS = 40
const RESTORE_CONCURRENCY = 3
const SPAWN_COLS = 80
const SPAWN_ROWS = 24

export class Orchestrator {
	private readonly daemon = new DaemonClient()
	private readonly layout = new LayoutManager()
	private readonly panes = new Map<string, ManagedPane>()
	private readonly listeners = new Set<(e: OrchestratorEvent) => void>()
	/** Monotonic index into the color palette (separate from pane names). */
	private colorIndex = 0
	/** Serializes session-mutating actions so rapid keypresses can't interleave. */
	private busy: Promise<unknown> = Promise.resolve()

	/** The current session's unique id (a soldier name; the center window's title). */
	sessionId = ""
	/** Model-generated human title for this session (undefined until generated). */
	sessionTitle?: string
	/** True once the user renamed the session by hand — suppresses the auto-titler. */
	private manualTitle = false
	/** While restoring, the saved session file is left intact so the sidebar keeps
	 * showing every stored pane instead of them vanishing and reappearing one by one. */
	private restoring = false
	private pendingRestore?: SessionState
	private persistTimer?: ReturnType<typeof setInterval>
	private winEnumAt = 0
	private winEnumCache: WindowInfo[] = []
	/** Debounced auto title (re)generation driven by pane activity. */
	private readonly titler = new SessionTitler(
		() => (this.sessionId ? gatherActivity(this.sessionId, [...this.panes.keys()]) : null),
		(title) => {
			if (this.manualTitle || title === this.sessionTitle) return
			this.sessionTitle = title
			this.persist()
			this.emit({ type: "panes-changed" })
			this.log(`titled session → "${title}"`)
		},
	)

	/** Rename the current session by hand; the auto-titler stops overriding it. */
	renameSession(title: string): void {
		if (!this.hasSession) {
			this.log("no active session to rename", "warn")
			return
		}
		const trimmed = title.trim()
		if (!trimmed) return
		this.sessionTitle = trimmed
		this.manualTitle = true
		this.persistNow()
		this.emit({ type: "panes-changed" })
		this.log(`renamed session → "${trimmed}"`)
	}

	/** Cycle keyboard focus to the next/previous window (center + satellites). */
	focusNext(): void {
		this.layout.focusCycle(1)
	}

	focusPrev(): void {
		this.layout.focusCycle(-1)
	}

	on(listener: (e: OrchestratorEvent) => void): () => void {
		this.listeners.add(listener)
		return () => this.listeners.delete(listener)
	}

	private emit(event: OrchestratorEvent): void {
		for (const l of this.listeners) {
			try {
				l(event)
			} catch (e) {
				console.error(`ordo: orchestrator listener failed: ${e instanceof Error ? e.message : e}`)
			}
		}
	}

	/** Run `fn` after any in-flight action settles, so transitions never overlap. */
	private serialize<T>(fn: () => Promise<T>): Promise<T> {
		const run = this.busy.then(fn, fn)
		this.busy = run.then(
			() => undefined,
			() => undefined,
		)
		return run
	}

	private log(message: string, level: "info" | "warn" | "error" = "info"): void {
		this.emit({ type: "log", level, message })
	}

	private terminalWindows(maxAgeMs: number): WindowInfo[] {
		const now = performance.now()
		if (now - this.winEnumAt > maxAgeMs) {
			this.winEnumCache = listTerminalWindows()
			this.winEnumAt = now
		}
		return this.winEnumCache
	}

	/**
	 * Launch the command center: capture + size this WT window as the fixed center
	 * and start following it. NO session is started — the window opens as a launcher
	 * (a session browser). Call newSession() or openSession() to begin one.
	 */
	async start(): Promise<void> {
		this.daemon.on((e) => this.onDaemonEvent(e))
		this.daemon.onConnection((up) => void this.onDaemonConnection(up))
		// Capture the center FIRST (while our WT window is foreground), before any
		// daemon spawn can momentarily affect window focus. Sizing is deliberately
		// left to the session path: a NEW session/launcher centers to the default
		// fraction (sizeCenter), while a RESTORE goes straight to its saved rect
		// (openSession → setCenterRect). Default-sizing here first would desync the
		// geometry the restored panes are tiled against.
		try {
			if (wmCaps().manage) {
				this.layout.captureCenter()
			} else {
				this.log("window manager unavailable — panes will open untiled", "warn")
			}
			this.layout.gap = TILE_GAP
			this.layout.animMs = ANIM_MS
		} catch (err) {
			this.log(`could not set up center window: ${errMessage(err)}`, "error")
		}
		try {
			for (const r of ensureAgentIntegrations()) {
				if (r.action !== "unchanged") {
					this.log(`agent integration (${r.tool}): ${r.action}${r.detail ? ` — ${r.detail}` : ""}`)
				}
			}
		} catch {}
	}

	/** Size + center the command window to the default fraction (launcher / new session). */
	sizeCenter(): void {
		try {
			const rect = this.layout.centerWindow(CENTER_W_FRAC, CENTER_H_FRAC)
			this.log(`command center ${rect.w}×${rect.h} @ (${rect.x},${rect.y})`)
		} catch (err) {
			this.log(`could not size center window: ${errMessage(err)}`, "error")
		}
	}

	/** Whether a session has been started in this window yet. */
	get hasSession(): boolean {
		return this.sessionId !== ""
	}

	/** Connect to (or start) the daemon for the current session, and begin persisting. */
	private async beginSession(): Promise<void> {
		this.layout.watch() // follow the center if the user drags/moves it
		this.persistTimer = setInterval(() => {
			if (this.layout.consumeDirty()) this.persistNow()
		}, 2000)
		this.persist()
		this.emit({ type: "panes-changed" })
		try {
			await this.daemon.ensure(this.sessionId)
			this.log("session daemon ready")
		} catch (err) {
			this.log(`daemon failed to start: ${errMessage(err)}`, "error")
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
		for (let i = 0; i < TEARDOWN_POLL_ATTEMPTS; i++) {
			const titles = new Set(this.terminalWindows(WINDOW_ENUM_TTL_MS).map((w) => w.title))
			if (!oldIds.some((id) => titles.has(id))) return
			await sleep(TEARDOWN_POLL_INTERVAL_MS)
		}
	}

	/** Start a brand-new session in this window and spawn its first pane. */
	async newSession(seed?: PaneSeed): Promise<void> {
		return this.serialize(() => this.newSessionCore(seed))
	}

	private async newSessionCore(seed?: PaneSeed): Promise<void> {
		await this.teardownCurrentSession()
		this.sizeCenter() // a fresh session gets the default centered command window
		this.sessionId = this.freshSessionId()
		this.sessionTitle = undefined
		this.manualTitle = false
		this.log(`new session: ${this.sessionId}`)
		await this.beginSession()
		await this.addPaneCore({ cwd: seed?.cwd, name: seed?.name, launch: seed?.agent })
	}

	/**
	 * Open a session in this window — the single shared "restore" action. Closing
	 * the current session (if any) and restoring the requested one is one atomic
	 * step, so opening from the launcher and switching mid-session behave identically.
	 */
	async openSession(id: string): Promise<void> {
		return this.serialize(() => this.openSessionCore(id))
	}

	private async openSessionCore(id: string): Promise<void> {
		const state = loadSession(id)
		if (!state) {
			this.log(`no saved session "${id}"`, "warn")
			return
		}
		await this.teardownCurrentSession()
		this.sessionId = state.id
		this.sessionTitle = state.title
		this.manualTitle = state.manualTitle ?? false
		this.pendingRestore = state
		this.restoring = true
		this.layout.setCenterRect(state.center)
		this.log(`opening "${state.id}": ${state.satellites.length} panes`)
		try {
			await this.beginSession()
			await this.applyRestore()
		} finally {
			this.restoring = false
		}
	}

	/**
	 * Close the current session and return this window to the launcher state: its
	 * pane windows close but the shells stay ALIVE in the daemon (so it can be
	 * reopened later). Does nothing if no session is active.
	 */
	/** UI close action: serialized so it can't interleave with a session transition. */
	closeSessionAction(): Promise<void> {
		return this.serialize(async () => {
			this.closeSession()
		})
	}

	closeSession(): void {
		if (!this.hasSession) return
		const id = this.sessionId
		if (this.persistTimer) {
			clearInterval(this.persistTimer)
			this.persistTimer = undefined
		}
		this.titler.reset()
		this.persistNow() // final save before detaching
		void this.daemon.detachSession(id).catch(() => {})
		// Reset back to a clean launcher.
		this.layout.unwatch()
		this.layout.clearSatellites()
		this.panes.clear()
		this.sessionId = ""
		this.sessionTitle = undefined
		this.manualTitle = false
		this.colorIndex = 0
		this.dirCycleIndex = 0
		this.pendingRestore = undefined
		this.log(`closed session "${id}"`)
		this.emit({ type: "panes-changed" })
	}

	/**
	 * Delete a saved session (its file + scrollback). If it's the one currently
	 * open, close it first. Returns true if the session existed.
	 */
	async deleteSavedSession(id: string): Promise<boolean> {
		return this.serialize(() => this.deleteSavedSessionCore(id))
	}

	private async deleteSavedSessionCore(id: string): Promise<boolean> {
		if (id === this.sessionId) {
			// Kill the panes first and WAIT: that ends the shells and releases the
			// daemon's capture-file handles so the scrollback can actually be deleted.
			await Promise.allSettled(
				[...this.panes.keys()].map((paneId) => this.daemon.killPane(this.sessionId, paneId)),
			)
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
		const tasks = state.satellites.map((s) => async () => {
			await this.spawnSatellite({
				id: s.id,
				direction: s.direction,
				color: s.color,
				cwd: s.cwd,
				// Re-tile fresh by direction rather than replaying the saved pixel rect:
				// panes are auto-placed now and saved rects can be stale/overlapping.
				relaunch: s.foreground, // cold restore: re-open the program that was running
			})
			const pane = this.panes.get(s.id) // carry saved metadata forward (daemon will refresh)
			if (pane) {
				pane.lastCommand = s.lastCommand
				pane.foreground = s.foreground
			}
		})
		const results = await runPool(RESTORE_CONCURRENCY, tasks)
		results.forEach((r, i) => {
			if (r.status === "rejected") {
				this.log(
					`restore failed for "${state.satellites[i]?.id}": ${errMessage(r.reason)}`,
					"error",
				)
			}
		})
		// Re-assert the exact center rect (in case WT nudged it during launch), then
		// re-tile every zone cleanly against it so nothing overlaps even if the center
		// drifted while the panes were spawning.
		this.layout.setCenterRect(state.center)
		this.layout.relayout()
		// Continue the color palette + direction cycle past the restored panes so
		// new ones (via `addPane`) get fresh colors and the next zone in turn.
		this.colorIndex = Math.max(this.colorIndex, state.satellites.length)
		this.dirCycleIndex = Math.max(this.dirCycleIndex, state.satellites.length)
		this.persistNow(true)
		this.log(`restored session "${this.sessionId}"`)
		// Refresh the title from the restored panes' (now live) scrollback.
		this.titler.schedule()
	}

	private persistDebounce?: ReturnType<typeof setTimeout>
	private lastPersistJson?: string

	/** Schedule a coalesced, trailing save (many rapid events → one write). */
	private persist(): void {
		if (this.restoring) return
		if (this.persistDebounce) return
		this.persistDebounce = setTimeout(() => {
			this.persistDebounce = undefined
			this.persistNow()
		}, 300)
	}

	/** Write the current layout to the session file now, skipping an unchanged save.
	 * Guarded during restore (except the final `force`d write) so the saved pane list
	 * isn't overwritten with a half-spawned set while panes are still coming up. */
	private persistNow(force = false): void {
		if (this.restoring && !force) return
		if (this.persistDebounce) {
			clearTimeout(this.persistDebounce)
			this.persistDebounce = undefined
		}
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
			const comparable = JSON.stringify({
				id: this.sessionId,
				title: this.sessionTitle,
				manualTitle: this.manualTitle,
				center: snap.center,
				satellites,
			})
			if (comparable === this.lastPersistJson) return
			this.lastPersistJson = comparable
			saveSession({
				id: this.sessionId,
				title: this.sessionTitle,
				manualTitle: this.manualTitle || undefined,
				updatedAt: new Date().toISOString(),
				center: snap.center,
				satellites,
			})
		} catch {
			// best-effort; never let persistence crash the app
		}
	}

	private reopening = false
	private prevDaemonPid?: number
	private lastReopenAt = 0

	/** React to the daemon link dropping/restoring: reattach the session on recovery. */
	private async onDaemonConnection(up: boolean): Promise<void> {
		if (!up) {
			this.prevDaemonPid = this.daemon.connectedPid
			this.log("session daemon disconnected — reconnecting…", "warn")
			return
		}
		if (!this.hasSession || this.reopening) return
		const action = reconnectDecision(
			this.prevDaemonPid,
			this.daemon.connectedPid,
			this.lastReopenAt,
			performance.now(),
		)
		if (action === "skip") return
		if (action === "resync") {
			this.log("session daemon reconnected — resyncing", "warn")
			await this.resyncSession()
			return
		}
		this.reopening = true
		this.lastReopenAt = performance.now()
		this.log("session daemon reconnected — reattaching", "warn")
		try {
			await this.openSession(this.sessionId)
		} catch (err) {
			this.log(`reconnect reattach failed: ${errMessage(err)}`, "error")
		} finally {
			this.reopening = false
		}
	}

	private async resyncSession(): Promise<void> {
		try {
			const { panes } = await this.daemon.getState(this.sessionId)
			for (const s of panes) {
				const pane = this.panes.get(s.pane)
				if (!pane) continue
				if (s.pid !== undefined) {
					pane.pid = s.pid
					pane.status = "connected"
				}
				if (s.cwd !== undefined) pane.cwd = s.cwd
				if (s.lastCommand !== undefined) pane.lastCommand = s.lastCommand
				pane.foreground = s.foreground
			}
			this.emit({ type: "panes-changed" })
		} catch (err) {
			this.log(`resync failed: ${errMessage(err)}`, "error")
		}
	}

	/** Per-pane state pushed by the daemon (cwd/lastCommand/foreground/pid) and exits. */
	private onDaemonEvent(e: ControlEvent): void {
		if (e.session !== this.sessionId) return
		if (e.event === "message") {
			this.emit({
				type: "message",
				from: e.from,
				to: e.to,
				text: e.text,
				color: this.panes.get(e.from)?.color,
			})
			return
		}
		if (e.event === "paneExited") {
			if (this.layout.has(e.pane)) this.layout.remove(e.pane)
			this.panes.delete(e.pane)
			this.log(`pane "${e.pane}" shell exited — removed from session`, "warn")
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
		if (e.event === "spawnRequest") {
			void this.handleSpawnRequest(e)
			return
		}
		if (e.event === "status") {
			this.emit({
				type: "status",
				pane: e.pane,
				status: e.status,
				task: e.task,
				color: this.panes.get(e.pane)?.color,
			})
			return
		}
		if (e.event === "paneCreated") return
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
		if (newCommand) this.titler.schedule()
	}

	private async handleSpawnRequest(
		e: Extract<ControlEvent, { event: "spawnRequest" }>,
	): Promise<void> {
		try {
			const id = await this.serialize(() =>
				this.addPaneCore({ cwd: e.cwd, name: e.name, launch: e.agent }),
			)
			if (id) {
				await this.daemon.resolveSpawn(e.requestId, { pane: id })
				this.log(`pane "${id}" spawned by ${e.requestedBy ?? "an agent"}`)
			} else {
				await this.daemon.resolveSpawn(e.requestId, {
					error: "ordo could not open a pane (no active session)",
				})
			}
		} catch (err) {
			try {
				await this.daemon.resolveSpawn(e.requestId, { error: errMessage(err) })
			} catch {}
			this.log(`spawn request from ${e.requestedBy ?? "agent"} failed: ${errMessage(err)}`, "error")
		}
	}

	private isNameFree(name: string): boolean {
		if (!/^[a-z][a-z0-9-]*$/i.test(name)) return false
		const taken = new Set<string>(this.panes.keys())
		taken.add(this.sessionId)
		for (const w of this.terminalWindows(WINDOW_ENUM_TTL_MS)) taken.add(w.title)
		return !taken.has(name)
	}

	/** A unique soldier name for a new pane (avoids existing panes, the session, and open windows). */
	private nextId(): string {
		const taken = new Set<string>(this.panes.keys())
		taken.add(this.sessionId)
		for (const w of this.terminalWindows(WINDOW_ENUM_TTL_MS)) taken.add(w.title)
		return pickUniqueName(taken)
	}

	private freshSessionId(): string {
		const taken = new Set<string>(listSessionNames())
		for (const w of this.terminalWindows(WINDOW_ENUM_TTL_MS)) taken.add(w.title)
		return pickUniqueName(taken)
	}

	/** argv that launches a thin pane client attached to the daemon for `paneId`. */
	private clientCommandline(paneId: string): string[] {
		return [BUN_EXE, CLIENT_PATH, this.sessionId, paneId]
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
		return this.serialize(() => this.addPaneCore(opts))
	}

	private async addPaneCore(
		opts: { cwd?: string; name?: string; launch?: string } = {},
	): Promise<string | null> {
		if (!this.hasSession) {
			this.log("no active session — press n to start one", "warn")
			return null
		}
		const direction = this.nextDirection()
		const id = opts.name && this.isNameFree(opts.name) ? opts.name : this.nextId()
		const hue = COLOR_MODE === "off" ? undefined : paletteColor(this.colorIndex++)
		await this.spawnSatellite({ id, direction, color: hue, cwd: opts.cwd, launch: opts.launch })
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
		launch?: string
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
				color: spec.color,
				relaunch: spec.relaunch,
				launch: spec.launch,
			})
			this.log(
				`pane "${id}" ${res.warm ? "reattached (warm)" : res.cold ? "cold-restored" : "created"}`,
			)

			// Spawn near the final spot: the saved rect when restoring, else the zone.
			const canManage = wmCaps().manage
			const origin = spec.rect
				? { x: spec.rect.x, y: spec.rect.y }
				: this.layout.zoneOrigin(direction)
			const wantTitle = satelliteTitle(id)
			const spawnRes = await spawnWindow({
				commandline: this.clientCommandline(id),
				cwd,
				title: wantTitle,
				tabColor: useTab ? spec.color : undefined,
				pos: origin,
				size: { cols: SPAWN_COLS, rows: SPAWN_ROWS },
			})

			// The daemon owns the shell regardless of tiling. When the window manager
			// can't move other windows (Wayland, missing libX11), the pane still works
			// as a standalone window — we just skip the find + tile step.
			if (!canManage) {
				this.log(`spawned window "${id}" (untiled)`)
				this.persist()
				return
			}

			// Prefer a handle the backend returned synchronously (macOS); otherwise the
			// window appears asynchronously, so poll for it by title with a short backoff
			// up to a ~5s deadline (so concurrent restores don't serialize).
			let handle: WindowHandle | null = spawnRes.handle ?? null
			const deadline = performance.now() + WINDOW_FIND_TIMEOUT_MS
			for (let i = 0; !handle && performance.now() < deadline; i++) {
				handle =
					this.terminalWindows(WINDOW_ENUM_TTL_MS).find((w) => w.title === wantTitle)?.handle ?? null
				if (handle) break
				await sleep(Math.min(WINDOW_POLL_STEP_MS * (i + 1), WINDOW_POLL_MAX_MS))
			}
			if (!handle) throw new Error("window did not appear (title not found)")

			if (spec.rect) {
				this.layout.addRestored(id, handle, direction, spec.rect)
				this.log(`restored ${direction} window "${id}"`)
			} else {
				this.layout.add(id, handle, direction)
				this.log(`spawned ${direction} window "${id}" → tiled`)
			}
			this.persist()
		} catch (err) {
			this.panes.delete(id)
			this.emit({ type: "panes-changed" })
			this.log(`failed to spawn window: ${errMessage(err)}`, "error")
			throw err
		}
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
		this.titler.stopTimer()
		this.persistNow()
		this.layout.unwatch()
		void this.daemon.detachSession(this.sessionId).catch(() => {})
		this.daemon.stop()
	}

	/**
	 * Async teardown for the normal exit path: persist, detach the session, and
	 * release the native title model — awaiting each so the daemon is actually told
	 * to detach and the model is freed before the process exits. Idempotent; `stop()`
	 * remains the sync last-resort used by the process "exit" hook.
	 */
	async shutdown(): Promise<void> {
		if (this.stopped) return
		this.stopped = true
		if (this.persistTimer) clearInterval(this.persistTimer)
		this.persistNow()
		this.layout.unwatch()
		try {
			await this.daemon.detachSession(this.sessionId)
		} catch {}
		this.daemon.stop()
		await this.titler.dispose()
	}
}
