/**
 * Geometry manager for the "fixed center, tiled satellites" layout.
 *
 * The center is the app's own Windows Terminal window, captured at startup and
 * resized/centered once, then never touched again. Satellites are separate WT
 * windows placed in four zones around it.
 *
 * The dominant constraint is that Windows Terminal won't make a window narrower
 * than ~476px. So tiles are divided along HEIGHT (which has no minimum), never
 * width — the side columns run the FULL screen height and stack vertically, so
 * adding a tile shrinks heights (still ≥¾ center up to ~3) while every tile
 * stays full-column-wide and never overlaps.
 *
 *   ┌──────┬───────┬──────┐   left/right: full-height columns, vertical stack
 *   │      │  up   │      │   up/down:    center-width strips, vertical stack
 *   │ left ├───────┤right │   center:     fixed, in the middle
 *   │      │CENTER │      │
 *   │      ├───────┤      │
 *   │      │ down  │      │
 *   └──────┴───────┴──────┘
 */

import {
	CENTER_FOLLOW_MS,
	CENTER_IDLE_POLL_MS,
	CENTER_SETTLE_MS,
	MIN_WIN_W,
	SELECT_BORDER_COLOR,
} from "../core/config"
import {
	type Direction,
	getForegroundWindow,
	getWindowOwner,
	getWindowRect,
	getWorkArea,
	listTerminalWindows,
	type Rect,
	setForegroundWindow,
	setWindowHighlight,
	setWindowOwner,
	setWindowRect,
	setWindowRectAsync,
	type WindowHandle,
	wmCaps,
} from "../platform"
import { ZoneAnimator } from "./animator"
import { slotRects, zoneRect } from "./geometry"

interface Satellite {
	id: string
	handle: WindowHandle
	dir: Direction
	/** Highlight color last applied to this window (so we only repaint on change). */
	appliedHighlight?: string | null
	/** Consecutive failed attempts to group this window with the center. */
	groupFailures?: number
}

/** Stop re-trying to group a window after this many consecutive failures. */
const MAX_GROUP_ATTEMPTS = 5

export class LayoutManager {
	private centerHwnd: WindowHandle | null = null
	private center: Rect = { x: 0, y: 0, w: 0, h: 0 }
	private work: Rect = { x: 0, y: 0, w: 0, h: 0 }
	private readonly sats = new Map<string, Satellite>()
	/** Set whenever window geometry changes, so an idle persist tick can skip snapshotting. */
	private dirty = true

	/** Pixel gap left between tiled windows (and around the center). */
	gap = 2

	/** Animation duration (ms) for slide/resize. 0 = instant. */
	animMs = 180

	/** Per-zone window slide/resize tweening. */
	private readonly animator = new ZoneAnimator()

	/** Timer handle for the follow-the-center watcher. */
	private watchTimer?: ReturnType<typeof setTimeout>
	private centerMoving = false
	private lastCenterMove = 0
	private idlePollMs = CENTER_IDLE_POLL_MS

	/** Highlight color last applied to the center (command) window. */
	private centerHighlight?: string | null

	/**
	 * Capture the center window (the app's own WT window) and its monitor work
	 * area. Uses the foreground window if it's a Windows Terminal window — true in
	 * the normal launch flow — and otherwise falls back to the first WT window.
	 */
	captureCenter(explicit?: WindowHandle): { handle: WindowHandle; rect: Rect } {
		if (explicit !== undefined) {
			this.centerHwnd = explicit
		} else {
			const wtWins = listTerminalWindows()
			const fg = getForegroundWindow()
			const fgIsWt = wtWins.some((w) => w.handle === fg)
			this.centerHwnd = fgIsWt ? fg : (wtWins[0]?.handle ?? fg)
		}
		if (!this.centerHwnd) throw new Error("no Windows Terminal window found to use as center")
		this.center = getWindowRect(this.centerHwnd) ?? this.center
		this.work = getWorkArea(this.centerHwnd) ?? this.work
		return { handle: this.centerHwnd, rect: this.center }
	}

	get centerRect(): Rect {
		return this.center
	}

	/**
	 * Resize + center the captured center window to `wFrac`×`hFrac` of the work
	 * area, and adopt that as the fixed center. Call after captureCenter().
	 */
	centerWindow(wFrac: number, hFrac: number): Rect {
		if (!this.centerHwnd) return this.center
		this.work = getWorkArea(this.centerHwnd) ?? this.work
		const a = this.work
		// Clamp the center width so each side column stays ≥ the WT minimum,
		// otherwise side tiles couldn't shrink to fit and would overlap.
		const maxW = a.w - 2 * MIN_WIN_W
		const w = Math.min(
			a.w,
			Math.round(Math.min(Math.max(a.w * wFrac, MIN_WIN_W), Math.max(MIN_WIN_W, maxW))),
		)
		const h = Math.min(a.h, Math.round(a.h * hFrac))
		const rect: Rect = {
			x: Math.round(a.x + (a.w - w) / 2),
			y: Math.round(a.y + (a.h - h) / 2),
			w,
			h,
		}
		setWindowRect(this.centerHwnd, rect)
		this.center = rect
		this.dirty = true
		return rect
	}

	/** Adopt an explicit center rect (used when restoring a saved session). */
	setCenterRect(rect: Rect): Rect {
		if (!this.centerHwnd) return this.center
		setWindowRect(this.centerHwnd, rect)
		this.center = { ...rect }
		this.work = getWorkArea(this.centerHwnd) ?? this.work
		this.dirty = true
		return this.center
	}

	/** Snapshot the current center + each satellite's on-screen rect. */
	snapshot(): { center: Rect; sats: Array<{ id: string; dir: Direction; rect: Rect }> } {
		return {
			center: { ...this.center },
			sats: [...this.sats.values()].map((s) => ({
				id: s.id,
				dir: s.dir,
				rect: getWindowRect(s.handle) ?? { x: 0, y: 0, w: 0, h: 0 },
			})),
		}
	}

	/** Top-left corner of a zone — used as the rough spawn position. */
	zoneOrigin(dir: Direction): { x: number; y: number } {
		const z = zoneRect(dir, this.center, this.work)
		return { x: z.x + this.gap, y: z.y + this.gap }
	}

	private inZone(dir: Direction): Satellite[] {
		return [...this.sats.values()].filter((s) => s.dir === dir)
	}

	/** Re-tile every satellite in `dir`'s zone to fill it evenly. */
	private retile(
		dir: Direction,
		instant = false,
		zone: Satellite[] = this.inZone(dir),
		live = false,
	): void {
		const rects = slotRects(dir, zone.length, this.center, this.work, this.gap)
		const targets = zone
			.map((s, i) => ({ handle: s.handle, to: rects[i] }))
			.filter((t) => t.to) as Array<{
			handle: WindowHandle
			to: Rect
		}>
		if (instant) {
			this.animator.cancel(dir)
			const place = live ? setWindowRectAsync : setWindowRect
			for (const it of targets) place(it.handle, it.to)
		} else {
			this.animator.animate(dir, targets, this.animMs)
		}
	}

	/** Force every populated zone to re-tile cleanly against the current center. */
	relayout(): void {
		this.retileAll(true)
	}

	/** Re-tile every zone — used when the center moves so satellites follow it. */
	private retileAll(instant: boolean, live = false): void {
		for (const dir of ["left", "right", "up", "down"] as Direction[]) {
			const zone = this.inZone(dir)
			if (zone.length > 0) this.retile(dir, instant, zone, live)
		}
	}

	/** Register a satellite window and tile its zone. */
	add(id: string, handle: WindowHandle, dir: Direction): void {
		const sat: Satellite = { id, handle, dir }
		this.sats.set(id, sat)
		this.groupWithCenter(sat)
		this.dirty = true
		this.retile(dir)
		this.updateFocusHighlight() // a just-spawned pane is usually focused
	}

	/**
	 * Register a satellite at an EXACT rect without re-tiling — used when
	 * restoring a session so windows return to precisely where they were.
	 */
	addRestored(id: string, handle: WindowHandle, dir: Direction, rect: Rect): void {
		const sat: Satellite = { id, handle, dir }
		this.sats.set(id, sat)
		this.groupWithCenter(sat)
		this.dirty = true
		setWindowRect(handle, rect)
		this.updateFocusHighlight()
	}

	private groupWithCenter(sat: Satellite): void {
		if (!wmCaps().group || !this.centerHwnd) return
		if (setWindowOwner(sat.handle, this.centerHwnd)) {
			sat.groupFailures = 0
		} else {
			sat.groupFailures = (sat.groupFailures ?? 0) + 1
		}
	}

	/**
	 * Verify each satellite is still grouped with the center and re-assert when
	 * it isn't. Grouping is applied once at add(), but re-owning a window after
	 * creation is not an officially supported operation — it can silently fail
	 * while the window is still initializing, or be undone later — so the watch
	 * tick self-heals it. Windows that keep refusing are left alone after
	 * MAX_GROUP_ATTEMPTS so an uncooperative WM can't cause a hide/show loop.
	 */
	private ensureGrouped(): void {
		if (!wmCaps().group || !this.centerHwnd) return
		for (const s of this.sats.values()) {
			if ((s.groupFailures ?? 0) >= MAX_GROUP_ATTEMPTS) continue
			if (getWindowOwner(s.handle) !== this.centerHwnd) this.groupWithCenter(s)
		}
	}

	/** Forget a satellite (e.g. its window closed) and re-tile its zone. */
	remove(id: string): void {
		const s = this.sats.get(id)
		if (!s) return
		this.sats.delete(id)
		this.dirty = true
		this.retile(s.dir)
	}

	/**
	 * Forget every satellite without re-tiling — used when closing a session so the
	 * follow-the-center watcher stops touching windows that are going away.
	 */
	clearSatellites(): void {
		this.animator.cancelAll()
		this.sats.clear()
		this.dirty = true
	}

	has(id: string): boolean {
		return this.sats.has(id)
	}

	/** Return whether geometry changed since the last call, clearing the flag. */
	consumeDirty(): boolean {
		const was = this.dirty
		this.dirty = false
		return was
	}

	/** Cycle keyboard focus across the center + satellites by `delta` (+1 next, -1 prev). */
	focusCycle(delta: number): void {
		const order: WindowHandle[] = [
			...(this.centerHwnd ? [this.centerHwnd] : []),
			...[...this.sats.values()].map((s) => s.handle),
		]
		if (order.length === 0) return
		const fg = getForegroundWindow()
		let idx = fg === null ? -1 : order.indexOf(fg)
		if (idx < 0) idx = 0
		const next = order[(((idx + delta) % order.length) + order.length) % order.length]
		if (next) setForegroundWindow(next)
	}

	/**
	 * Start watching the center window. If the user drags or resizes it — even to
	 * another monitor — adopt the new rect + work area and re-tile all satellites
	 * so they follow it and stay on the same screen.
	 */
	watch(intervalMs = CENTER_IDLE_POLL_MS): void {
		if (!this.centerHwnd) return
		this.unwatch()
		this.idlePollMs = intervalMs
		const tick = () => {
			if (!this.centerHwnd) return
			this.followCenter()
			this.updateFocusHighlight()
			// Skip while the center is being dragged: grouping repair can hide/show
			// a window, which would fight the user's drag; idle ticks catch up.
			if (!this.centerMoving) this.ensureGrouped()
			const delay = this.centerMoving ? CENTER_FOLLOW_MS : this.idlePollMs
			this.watchTimer = setTimeout(tick, delay)
		}
		this.watchTimer = setTimeout(tick, intervalMs)
	}

	unwatch(): void {
		this.animator.cancelAll()
		if (this.watchTimer) clearTimeout(this.watchTimer)
		this.watchTimer = undefined
		this.centerMoving = false
		this.clearHighlights()
	}

	clearHighlights(): void {
		if (this.centerHwnd && this.centerHighlight) setWindowHighlight(this.centerHwnd, null)
		this.centerHighlight = null
		for (const s of this.sats.values()) {
			if (s.appliedHighlight) setWindowHighlight(s.handle, null)
			s.appliedHighlight = null
		}
	}

	private followCenter(): void {
		const handle = this.centerHwnd
		if (!handle) return
		const cur = getWindowRect(handle)
		if (!cur || cur.w <= 0 || cur.h <= 0) return // window minimized/gone
		const c = this.center
		const moved = cur.x !== c.x || cur.y !== c.y || cur.w !== c.w || cur.h !== c.h
		if (moved) {
			this.center = cur
			this.work = getWorkArea(handle) ?? this.work // may be a different monitor now
			this.dirty = true
			this.centerMoving = true
			this.lastCenterMove = performance.now()
			this.retileAll(true, true)
			return
		}
		if (this.centerMoving && performance.now() - this.lastCenterMove >= CENTER_SETTLE_MS) {
			this.centerMoving = false
			this.retileAll(false)
		}
	}

	/**
	 * Highlight the focused window (border + title bar) and reset the others —
	 * including the center (command) window. Tracks the applied color per window
	 * (not a single "last focused") so a window focused at the moment it's added
	 * still gets highlighted.
	 */
	private updateFocusHighlight(): void {
		if (!wmCaps().highlight) return
		const fg = getForegroundWindow()

		const center = this.centerHwnd
		const centerDesired = center === fg ? SELECT_BORDER_COLOR : null
		if (center && this.centerHighlight !== centerDesired) {
			setWindowHighlight(center, centerDesired)
			this.centerHighlight = centerDesired
		}

		for (const s of this.sats.values()) {
			const desired = s.handle === fg ? SELECT_BORDER_COLOR : null
			if (s.appliedHighlight !== desired) {
				setWindowHighlight(s.handle, desired)
				s.appliedHighlight = desired
			}
		}
	}
}
