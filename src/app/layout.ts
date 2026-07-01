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

import { BORDER_THICKNESS, MIN_WIN_W, SELECT_BORDER_COLOR } from "../core/config"
import { OverlayFrame } from "../platform/overlay"
import {
	getForegroundWindow,
	getWindowRect,
	getWorkArea,
	type Hwnd,
	listTerminalWindows,
	type Rect,
	setWindowHighlight,
	setWindowRect,
} from "../platform/win32"
import type { Direction } from "../platform/wt"
import { ZoneAnimator } from "./animator"
import { slotRects, zoneRect } from "./geometry"

interface Satellite {
	id: string
	hwnd: Hwnd
	dir: Direction
	/** Highlight color last applied to this window (so we only repaint on change). */
	appliedHighlight?: string | null
}

export class LayoutManager {
	private centerHwnd: Hwnd = 0 as unknown as Hwnd
	private center: Rect = { x: 0, y: 0, w: 0, h: 0 }
	private work: Rect = { x: 0, y: 0, w: 0, h: 0 }
	private readonly sats = new Map<string, Satellite>()

	/** Pixel gap left between tiled windows (and around the center). */
	gap = 2

	/** Animation duration (ms) for slide/resize. 0 = instant. */
	animMs = 180

	/** Per-zone window slide/resize tweening. */
	private readonly animator = new ZoneAnimator()

	/** Interval handle for the follow-the-center watcher. */
	private watchTimer?: ReturnType<typeof setInterval>

	/** Highlight color last applied to the center (command) window. */
	private centerHighlight?: string | null

	/** Thick colored frame drawn around the focused window. */
	private readonly overlay = new OverlayFrame(SELECT_BORDER_COLOR, BORDER_THICKNESS)

	/**
	 * Capture the center window (the app's own WT window) and its monitor work
	 * area. Uses the foreground window if it's a Windows Terminal window — true in
	 * the normal launch flow — and otherwise falls back to the first WT window.
	 */
	captureCenter(explicit?: Hwnd): { hwnd: Hwnd; rect: Rect } {
		if (explicit !== undefined) {
			this.centerHwnd = explicit
		} else {
			const wtWins = listTerminalWindows()
			const fg = getForegroundWindow()
			const fgIsWt = wtWins.some((w) => w.hwnd === fg)
			this.centerHwnd = fgIsWt ? fg : (wtWins[0]?.hwnd ?? fg)
		}
		this.center = getWindowRect(this.centerHwnd)
		this.work = getWorkArea(this.centerHwnd)
		return { hwnd: this.centerHwnd, rect: this.center }
	}

	get centerRect(): Rect {
		return this.center
	}

	/**
	 * Resize + center the captured center window to `wFrac`×`hFrac` of the work
	 * area, and adopt that as the fixed center. Call after captureCenter().
	 */
	centerWindow(wFrac: number, hFrac: number): Rect {
		const a = this.work
		// Clamp the center width so each side column stays ≥ the WT minimum,
		// otherwise side tiles couldn't shrink to fit and would overlap.
		const maxW = a.w - 2 * MIN_WIN_W
		const w = Math.round(Math.min(Math.max(a.w * wFrac, MIN_WIN_W), Math.max(MIN_WIN_W, maxW)))
		const h = Math.round(a.h * hFrac)
		const rect: Rect = {
			x: Math.round(a.x + (a.w - w) / 2),
			y: Math.round(a.y + (a.h - h) / 2),
			w,
			h,
		}
		setWindowRect(this.centerHwnd, rect)
		this.center = rect
		return rect
	}

	/** Adopt an explicit center rect (used when restoring a saved session). */
	setCenterRect(rect: Rect): Rect {
		setWindowRect(this.centerHwnd, rect)
		this.center = { ...rect }
		this.work = getWorkArea(this.centerHwnd)
		return this.center
	}

	/** Snapshot the current center + each satellite's on-screen rect. */
	snapshot(): { center: Rect; sats: Array<{ id: string; dir: Direction; rect: Rect }> } {
		return {
			center: { ...this.center },
			sats: [...this.sats.values()].map((s) => ({
				id: s.id,
				dir: s.dir,
				rect: getWindowRect(s.hwnd),
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
	private retile(dir: Direction, instant = false): void {
		const zone = this.inZone(dir)
		const rects = slotRects(dir, zone.length, this.center, this.work, this.gap)
		const targets = zone
			.map((s, i) => ({ hwnd: s.hwnd, to: rects[i] }))
			.filter((t) => t.to) as Array<{
			hwnd: Hwnd
			to: Rect
		}>
		if (instant) {
			this.animator.cancel(dir)
			for (const it of targets) setWindowRect(it.hwnd, it.to)
		} else {
			this.animator.animate(dir, targets, this.animMs)
		}
	}

	/** Force every populated zone to re-tile cleanly against the current center. */
	relayout(): void {
		this.retileAll(true)
	}

	/** Re-tile every zone — used when the center moves so satellites follow it. */
	private retileAll(instant: boolean): void {
		for (const dir of ["left", "right", "up", "down"] as Direction[]) {
			if (this.inZone(dir).length > 0) this.retile(dir, instant)
		}
	}

	/** Register a satellite window and tile its zone. */
	add(id: string, hwnd: Hwnd, dir: Direction): void {
		this.sats.set(id, { id, hwnd, dir })
		this.retile(dir)
		this.updateFocusHighlight() // a just-spawned pane is usually focused
	}

	/**
	 * Register a satellite at an EXACT rect without re-tiling — used when
	 * restoring a session so windows return to precisely where they were.
	 */
	addRestored(id: string, hwnd: Hwnd, dir: Direction, rect: Rect): void {
		this.sats.set(id, { id, hwnd, dir })
		setWindowRect(hwnd, rect)
		this.updateFocusHighlight()
	}

	/** Forget a satellite (e.g. its window closed) and re-tile its zone. */
	remove(id: string): void {
		const s = this.sats.get(id)
		if (!s) return
		this.sats.delete(id)
		this.retile(s.dir)
	}

	/**
	 * Forget every satellite without re-tiling — used when closing a session so the
	 * follow-the-center watcher stops touching windows that are going away.
	 */
	clearSatellites(): void {
		this.animator.cancelAll()
		this.sats.clear()
	}

	has(id: string): boolean {
		return this.sats.has(id)
	}

	/**
	 * Start watching the center window. If the user drags or resizes it — even to
	 * another monitor — adopt the new rect + work area and re-tile all satellites
	 * so they follow it and stay on the same screen.
	 */
	watch(intervalMs = 120): void {
		this.unwatch()
		this.watchTimer = setInterval(() => {
			this.followCenter()
			this.updateFocusHighlight()
		}, intervalMs)
	}

	unwatch(): void {
		if (this.watchTimer) clearInterval(this.watchTimer)
		this.watchTimer = undefined
		this.overlay.destroy()
	}

	private followCenter(): void {
		const cur = getWindowRect(this.centerHwnd)
		if (cur.w <= 0 || cur.h <= 0) return // window minimized/gone
		const c = this.center
		if (cur.x === c.x && cur.y === c.y && cur.w === c.w && cur.h === c.h) return
		this.center = cur
		this.work = getWorkArea(this.centerHwnd) // may be a different monitor now
		// Animate so satellites glide along smoothly instead of snapping/flickering.
		// Each poll supersedes the previous tween, producing a smooth trail.
		this.retileAll(false)
	}

	/**
	 * Highlight the focused window (border + title bar) and reset the others —
	 * including the center (command) window. Tracks the applied color per window
	 * (not a single "last focused") so a window focused at the moment it's added
	 * still gets highlighted.
	 */
	private updateFocusHighlight(): void {
		const fg = getForegroundWindow()

		const centerDesired = this.centerHwnd === fg ? SELECT_BORDER_COLOR : null
		if (this.centerHighlight !== centerDesired) {
			setWindowHighlight(this.centerHwnd, centerDesired)
			this.centerHighlight = centerDesired
		}

		let focusedRect: Rect | null = null
		if (this.centerHwnd === fg) focusedRect = this.center
		for (const s of this.sats.values()) {
			const desired = s.hwnd === fg ? SELECT_BORDER_COLOR : null
			if (s.appliedHighlight !== desired) {
				setWindowHighlight(s.hwnd, desired)
				s.appliedHighlight = desired
			}
			if (s.hwnd === fg) focusedRect = getWindowRect(s.hwnd)
		}

		// Thick overlay frame around whichever window is focused (else hidden).
		if (focusedRect) this.overlay.show(focusedRect)
		else this.overlay.hide()
	}
}
