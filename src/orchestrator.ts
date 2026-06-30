/**
 * The orchestrator: the one object the TUI (and later, the real app) talks to.
 *
 * It owns the hub, knows how to launch agents into new panes/tabs/windows via
 * the wt.exe wrapper, and tracks the lifecycle of every pane it created.
 */

import { lightTint, PANE_FG, paletteColor } from "./colors"
import {
	AGENT_PATH,
	AGENT_SHELL,
	ANIM_MS,
	BUN_EXE,
	CENTER_H_FRAC,
	CENTER_W_FRAC,
	COLOR_MODE,
	RESTORE_NAME,
	TILE_GAP,
} from "./config"
import { Hub, type HubEvent } from "./hub"
import { LayoutManager } from "./layout"
import { pickUniqueName } from "./names"
import {
	generateSessionName,
	loadSession,
	type SessionState,
	saveSession,
	scrollbackPath,
} from "./session"
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
	createdAt: number
}

export type OrchestratorEvent =
	| { type: "log"; level: "info" | "warn" | "error"; message: string }
	| { type: "panes-changed" }

export class Orchestrator {
	private readonly hub = new Hub()
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

	/** Start the hub, capture the fixed center window, and wire hub events. */
	start(): number {
		this.hub.on((e) => this.onHubEvent(e))
		const port = this.hub.start()
		this.log(`hub listening on 127.0.0.1:${port}`)
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
		return port
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
					replay: true, // replay this pane's saved scrollback
				})
				const pane = this.panes.get(s.id) // carry the saved last-command forward
				if (pane) pane.lastCommand = s.lastCommand
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

	private onHubEvent(e: HubEvent): void {
		switch (e.type) {
			case "connected": {
				const pane = this.panes.get(e.paneId)
				if (pane) {
					pane.status = "connected"
					pane.pid = e.pid
				}
				this.log(`pane "${e.paneId}" connected (pid ${e.pid})`)
				this.emit({ type: "panes-changed" })
				break
			}
			case "disconnected": {
				const pane = this.panes.get(e.paneId)
				if (pane) pane.status = "exited"
				// Drop it from the tiling and let its zone reclaim the space.
				if (this.layout.has(e.paneId)) this.layout.remove(e.paneId)
				this.log(`pane "${e.paneId}" disconnected`, "warn")
				this.emit({ type: "panes-changed" })
				this.persist()
				break
			}
			case "message": {
				if (e.message.type === "output") {
					this.log(`[${e.paneId}] ${e.message.data}`)
				} else if (e.message.type === "exit") {
					this.log(`pane "${e.paneId}" shell exited (${e.message.code})`)
				}
				break
			}
		}
	}

	/** A unique soldier name for a new pane (avoids existing panes + the session). */
	private nextId(): string {
		const taken = new Set<string>(this.panes.keys())
		taken.add(this.sessionName)
		return pickUniqueName(taken)
	}

	/** argv that launches an agent bound to the given pane id + the hub port. */
	private agentCommandline(
		paneId: string,
		opts: { bg?: string; fg?: string; capture?: string; replay?: boolean } = {},
	): string[] {
		const args = [
			BUN_EXE,
			AGENT_PATH,
			"--id",
			paneId,
			"--port",
			String(this.hub.port),
			"--shell",
			AGENT_SHELL,
		]
		if (opts.bg) args.push("--bg", opts.bg)
		if (opts.fg) args.push("--fg", opts.fg)
		if (opts.capture) args.push("--capture", opts.capture)
		if (opts.replay) args.push("--replay")
		return args
	}

	/**
	 * Spawn a satellite window in `direction` and tile it around the fixed
	 * center. The window runs a managed agent and is positioned/resized via
	 * Win32 so the center never moves.
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
		/** Replay this pane's saved scrollback before its fresh shell. */
		replay?: boolean
	}): Promise<void> {
		const { id, direction } = spec
		const useTab = COLOR_MODE !== "off" && (COLOR_MODE === "tab" || COLOR_MODE === "both")
		const useBg = COLOR_MODE !== "off" && (COLOR_MODE === "bg" || COLOR_MODE === "both")
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
			// Spawn near the final spot: the saved rect when restoring, else the zone.
			const origin = spec.rect
				? { x: spec.rect.x, y: spec.rect.y }
				: this.layout.zoneOrigin(direction)
			await spawnWindow({
				commandline: this.agentCommandline(id, {
					bg: useBg && spec.color ? lightTint(spec.color) : undefined,
					fg: useBg && spec.color ? PANE_FG : undefined,
					capture: scrollbackPath(this.sessionName, id),
					replay: spec.replay,
				}),
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

	/** Open a new tab with a managed agent. */
	async openTab(opts: { cwd?: string } = {}): Promise<string> {
		const id = this.nextId()
		this.panes.set(id, { id, kind: "tab", status: "spawning", createdAt: performance.now() })
		this.emit({ type: "panes-changed" })
		await spawnTab({ commandline: this.agentCommandline(id), cwd: opts.cwd, title: id })
		this.log(`spawned tab "${id}"`)
		return id
	}

	/** Open a new window with a managed agent, optionally positioned/sized. */
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
		await spawnWindow({
			commandline: this.agentCommandline(id),
			cwd: opts.cwd,
			pos: opts.pos,
			size: opts.size,
			title: id,
		})
		this.log(`spawned window "${id}"`)
		return id
	}

	/** Ask a pane to shut down and forget it. */
	kill(paneId: string): boolean {
		const ok = this.hub.shutdown(paneId)
		if (ok) this.log(`killing pane "${paneId}"`)
		else this.log(`no connected pane "${paneId}"`, "warn")
		return ok
	}

	list(): ManagedPane[] {
		return [...this.panes.values()]
	}

	stop(): void {
		if (this.persistTimer) clearInterval(this.persistTimer)
		this.persist()
		this.layout.unwatch()
		this.hub.stop()
	}
}
