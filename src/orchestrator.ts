/**
 * The orchestrator: the one object the TUI (and later, the real app) talks to.
 *
 * It talks to the persistent session daemon (which owns the shells), launches a
 * thin pane client into each new pane/tab/window via the wt.exe wrapper, and
 * tracks the lifecycle + tiling of every pane it created. The shells outlive this
 * process, so closing/reopening reattaches to the same live shell.
 */

import { paletteColor } from "./colors"
import {
	ANIM_MS,
	BUN_EXE,
	CENTER_H_FRAC,
	CENTER_W_FRAC,
	CLIENT_PATH,
	COLOR_MODE,
	RESTORE_NAME,
	TILE_GAP,
} from "./config"
import { DaemonClient } from "./daemonClient"
import type { ControlEvent } from "./daemonProtocol"
import { LayoutManager } from "./layout"
import { pickUniqueName } from "./names"
import { generateSessionName, loadSession, type SessionState, saveSession } from "./session"
import { findTerminalWindowByExactTitle, type Hwnd, type Rect } from "./win32"
import { type Direction, spawnTab, spawnWindow } from "./wt"

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

	/** The current session's unique name (shown as the center window's title). */
	sessionName = ""
	private pendingRestore?: SessionState
	private persistTimer?: ReturnType<typeof setInterval>

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

	/** Capture the center window, then connect to (or start) the daemon. */
	async start(): Promise<void> {
		this.daemon.on((e) => this.onDaemonEvent(e))
		// Capture the center FIRST (while our WT window is foreground), before the
		// daemon spawn can momentarily affect window focus.
		try {
			this.layout.captureCenter()
			this.layout.gap = TILE_GAP
			this.layout.animMs = ANIM_MS

			const restored = RESTORE_NAME ? loadSession(RESTORE_NAME) : null
			if (RESTORE_NAME && !restored) {
				this.log(`no saved session "${RESTORE_NAME}"; starting fresh`, "warn")
			}
			if (restored) {
				this.sessionName = restored.name
				this.pendingRestore = restored
				const rect = this.layout.setCenterRect(restored.center)
				this.log(
					`restoring "${restored.name}": ${restored.satellites.length} panes, center ${rect.w}×${rect.h}`,
				)
			} else {
				const rect = this.layout.centerWindow(CENTER_W_FRAC, CENTER_H_FRAC)
				this.sessionName = generateSessionName()
				this.log(`center ${rect.w}×${rect.h} @ (${rect.x},${rect.y})`)
			}

			this.log(`session: ${this.sessionName}`)
			this.layout.watch() // follow the center if the user drags/moves it
			this.persistTimer = setInterval(() => this.persist(), 2000)
			this.persist()
		} catch (err) {
			this.log(`could not set up center window: ${(err as Error).message}`, "error")
		}
		try {
			await this.daemon.ensure(this.sessionName)
			this.log("session daemon ready")
		} catch (err) {
			this.log(`daemon failed to start: ${(err as Error).message}`, "error")
		}
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
					rect: s.rect, // restore to the exact saved size/position
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
		// Re-assert the exact center rect (in case WT nudged it during launch).
		this.layout.setCenterRect(state.center)
		// Continue the color palette past the restored panes so new ones differ.
		this.colorIndex = Math.max(this.colorIndex, state.satellites.length)
		this.persist()
		this.log(`restored session "${this.sessionName}"`)
	}

	/** Write the current layout to the session file. */
	private persist(): void {
		if (!this.sessionName) return
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
				name: this.sessionName,
				updatedAt: new Date().toISOString(),
				center: snap.center,
				satellites,
			})
		} catch {
			// best-effort; never let persistence crash the app
		}
	}

	/** Per-pane state pushed by the daemon (cwd/lastCommand/foreground/pid) and exits. */
	private onDaemonEvent(e: ControlEvent): void {
		if (e.session !== this.sessionName) return
		if (e.event === "paneExited") {
			const pane = this.panes.get(e.pane)
			if (pane) pane.status = "exited"
			if (this.layout.has(e.pane)) this.layout.remove(e.pane)
			this.log(`pane "${e.pane}" shell exited`, "warn")
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
		if (s.lastCommand !== undefined && pane.lastCommand !== s.lastCommand) {
			pane.lastCommand = s.lastCommand
			changed = true
		}
		if (pane.foreground !== s.foreground) {
			pane.foreground = s.foreground
			changed = true
		}
		if (changed) {
			this.persist()
			this.emit({ type: "panes-changed" })
		}
	}

	/** A unique soldier name for a new pane (avoids existing panes + the session). */
	private nextId(): string {
		const taken = new Set<string>(this.panes.keys())
		taken.add(this.sessionName)
		return pickUniqueName(taken)
	}

	/** argv that launches a thin pane client attached to the daemon for `paneId`. */
	private clientCommandline(paneId: string): string[] {
		return [BUN_EXE, CLIENT_PATH, "--session", this.sessionName, "--pane", paneId]
	}

	/**
	 * Spawn a satellite window in `direction` and tile it around the fixed center.
	 * The daemon creates (or warm-reuses) the pane's shell; the window runs a thin
	 * client attached to it, positioned/resized via Win32 so the center never moves.
	 */
	async openPane(direction: Direction, opts: { cwd?: string } = {}): Promise<string> {
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
			const res = await this.daemon.createPane(this.sessionName, id, {
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
		await this.daemon.createPane(this.sessionName, id, { cwd: opts.cwd })
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
		await this.daemon.createPane(this.sessionName, id, { cwd: opts.cwd })
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
		void this.daemon.killPane(this.sessionName, paneId).catch(() => {})
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
		this.persist()
		this.layout.unwatch()
		void this.daemon.detachSession(this.sessionName).catch(() => {})
		this.daemon.stop()
	}
}
