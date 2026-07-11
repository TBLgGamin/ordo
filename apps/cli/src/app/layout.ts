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
	CENTER_H_FRAC,
	CENTER_IDLE_POLL_MS,
	CENTER_SETTLE_MS,
	CENTER_W_FRAC,
	MIN_WIN_W,
	SELECT_BORDER_COLOR,
	SNAP_FOLLOW,
	SNAP_TOL_PX,
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
import { clampToWork, MIN_SLOT_H, slotRects, zoneRect } from "./geometry"
import {
	classifySnap,
	type FoldPlan,
	isFoldKind,
	isSnapKind,
	planFold,
	type SnapRegion,
	snapBoundsForWork,
} from "./snap"

interface Satellite {
	id: string
	handle: WindowHandle
	dir: Direction
	anchored: boolean
	observedRect?: Rect
	suppressGeometryUntil: number
	/** Last user/programmatic movement; overflow is clamped once it settles. */
	geometryChangedAt?: number
	/** Highlight color last applied to this window (so we only repaint on change). */
	appliedHighlight?: string | null
	/** Consecutive failed attempts to group this window with the center. */
	groupFailures?: number
}

/** Stop re-trying to group a window after this many consecutive failures. */
const MAX_GROUP_ATTEMPTS = 5

function sameRect(a: Rect, b: Rect | undefined): boolean {
	return !!b && a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h
}

/** Rects equal within a pixel tolerance (absorbs OS frame overhang / rounding). */
function sameRectTol(a: Rect, b: Rect | undefined, tol: number): boolean {
	return (
		!!b &&
		Math.abs(a.x - b.x) <= tol &&
		Math.abs(a.y - b.y) <= tol &&
		Math.abs(a.w - b.w) <= tol &&
		Math.abs(a.h - b.h) <= tol
	)
}

/** Whether ≥60% of `a`'s area falls inside `b` (used to tell a resize-within-fold from a drag-out). */
function rectMostlyInside(a: Rect, b: Rect): boolean {
	const ix = Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x))
	const iy = Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y))
	const area = a.w * a.h
	return area > 0 && ix * iy >= 0.6 * area
}

export class LayoutManager {
	private centerHwnd: WindowHandle | null = null
	private center: Rect = { x: 0, y: 0, w: 0, h: 0 }
	private work: Rect = { x: 0, y: 0, w: 0, h: 0 }
	/** The region the session tiles inside — the full work area, or a snapped sub-rect when folded. */
	private bounds: Rect = { x: 0, y: 0, w: 0, h: 0 }
	/** Active OS-snap the session is folded into, or null when it owns the full work area. */
	private snap: SnapRegion | null = null
	/** How the center + zones are arranged inside `bounds` while folded. */
	private foldPlan: FoldPlan | null = null
	/** Last center rect ordo set itself — so the watcher doesn't mistake it for a user move. */
	private expectedCenter?: Rect
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
	/** Whether the current center interaction changed its size, not just its position. */
	private centerResizing = false
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
		this.bounds = this.work
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
		this.expectedCenter = { ...rect }
		// A freshly centered command window owns the full work area again.
		this.snap = null
		this.foldPlan = null
		this.bounds = this.work
		this.dirty = true
		return rect
	}

	/**
	 * Adopt an explicit center rect (used when restoring a saved session).
	 * Deliberately does NOT touch fold state, so a snapped session can set its
	 * (already-folded) center rect and then adopt the snap via `adoptSnap`.
	 */
	setCenterRect(rect: Rect): Rect {
		if (!this.centerHwnd) return this.center
		setWindowRect(this.centerHwnd, rect)
		this.center = { ...rect }
		this.expectedCenter = { ...rect }
		this.work = getWorkArea(this.centerHwnd) ?? this.work
		if (!this.snap) this.bounds = this.work
		this.dirty = true
		return this.center
	}

	/**
	 * Re-adopt a saved snap on restore WITHOUT moving the center (the center is
	 * placed separately from its saved, already-folded rect). The saved bounds are
	 * rescaled onto the current work area so a different-sized monitor still folds
	 * proportionally. A subsequent `relayout()` tiles satellites into the bounds.
	 */
	restoreSnap(saved: { kind: string; bounds: Rect; work: Rect }): void {
		if (!SNAP_FOLLOW) return
		if (!isSnapKind(saved.kind) || !isFoldKind(saved.kind)) return
		const bounds = snapBoundsForWork(saved, this.work)
		this.adoptSnap({ kind: saved.kind, bounds })
	}

	/** Adopt a snap region without moving the center. */
	private adoptSnap(region: SnapRegion): void {
		this.snap = region
		this.bounds = region.bounds
		this.foldPlan = this.makeFoldPlan(region)
		this.dirty = true
	}

	private makeFoldPlan(region: SnapRegion): FoldPlan {
		return planFold(region, {
			centerWFrac: CENTER_W_FRAC,
			centerHFrac: CENTER_H_FRAC,
			minWinW: MIN_WIN_W,
			gap: this.gap,
			minSlotH: MIN_SLOT_H,
		})
	}

	/** Map a satellite's logical direction to the zone it tiles into while folded. */
	private effectiveDir(dir: Direction): Direction {
		return this.foldPlan?.dirRemap[dir] ?? dir
	}

	/**
	 * Fold the whole session into a freshly-detected snap region: shrink the
	 * center to fit inside `bounds` and re-tile every zone around it.
	 */
	private enterFold(region: SnapRegion): void {
		this.snap = region
		this.bounds = region.bounds
		this.foldPlan = this.makeFoldPlan(region)
		const c = this.foldPlan.center
		if (this.centerHwnd) setWindowRect(this.centerHwnd, c)
		this.center = { ...c }
		this.expectedCenter = { ...c }
		this.dirty = true
		this.retileAll(false)
	}

	/** Un-fold: return to full-work-area tiling, leaving the center where the user left it. */
	private exitFold(): void {
		this.snap = null
		this.foldPlan = null
		this.bounds = this.work
		this.expectedCenter = { ...this.center }
		this.dirty = true
		this.retileAll(false)
	}

	/** Snapshot the current center + each satellite's on-screen rect. */
	snapshot(): {
		center: Rect
		sats: Array<{ id: string; dir: Direction; rect: Rect; anchored: boolean }>
		snap?: { kind: string; bounds: Rect; work: Rect }
	} {
		return {
			center: { ...this.center },
			sats: [...this.sats.values()].map((s) => ({
				id: s.id,
				dir: s.dir,
				anchored: s.anchored,
				rect: getWindowRect(s.handle) ?? { x: 0, y: 0, w: 0, h: 0 },
			})),
			snap: this.snap
				? { kind: this.snap.kind, bounds: { ...this.snap.bounds }, work: { ...this.work } }
				: undefined,
		}
	}

	/** Top-left corner of a zone — used as the rough spawn position. */
	zoneOrigin(dir: Direction): { x: number; y: number } {
		const z = zoneRect(this.effectiveDir(dir), this.center, this.bounds)
		return { x: z.x + this.gap, y: z.y + this.gap }
	}

	/** Satellites whose EFFECTIVE (fold-remapped) zone is `dir`. */
	private inZone(dir: Direction): Satellite[] {
		return [...this.sats.values()].filter((s) => this.effectiveDir(s.dir) === dir && !s.anchored)
	}

	private suppressGeometry(s: Satellite, duration = this.animMs): void {
		s.observedRect = undefined
		s.suppressGeometryUntil = performance.now() + Math.max(50, duration + CENTER_SETTLE_MS)
	}

	/** Re-tile every satellite in `dir`'s zone to fill it evenly. */
	private retile(
		dir: Direction,
		instant = false,
		zone: Satellite[] = this.inZone(dir),
		live = false,
	): void {
		const rects = slotRects(dir, zone.length, this.center, this.bounds, this.gap, this.work)
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
		for (const s of zone) this.suppressGeometry(s, instant ? 0 : this.animMs)
	}

	/** Force every populated zone to re-tile cleanly against the current center. */
	relayout(): void {
		this.retileAll(true)
	}

	/** Re-tile every zone — used when the center moves so satellites follow it. */
	private retileAll(instant: boolean, live = false): void {
		if (this.foldPlan?.mode === "overlap") {
			this.cascadeOverlap(live)
			return
		}
		for (const dir of ["left", "right", "up", "down"] as Direction[]) {
			const zone = this.inZone(dir)
			if (zone.length > 0) this.retile(dir, instant, zone, live)
		}
	}

	/** Re-tile the zone a satellite belongs to (mapping through the fold remap). */
	private retileZoneFor(logicalDir: Direction): void {
		if (this.foldPlan?.mode === "overlap") {
			this.cascadeOverlap(false)
			return
		}
		this.retile(this.effectiveDir(logicalDir))
	}

	/**
	 * Degenerate fold: the snapped region is too small for any zone, so stack the
	 * non-anchored satellites over the center in a slight cascade. They stay
	 * reachable via focus cycling and the shared Alt-Tab group.
	 */
	private cascadeOverlap(live: boolean): void {
		const place = live ? setWindowRectAsync : setWindowRect
		const step = 24
		let i = 0
		for (const s of this.sats.values()) {
			if (s.anchored) continue
			const rect = clampToWork(
				{
					x: this.bounds.x + this.gap + i * step,
					y: this.bounds.y + this.gap + i * step,
					w: Math.max(0, this.bounds.w - 2 * this.gap),
					h: Math.max(0, this.bounds.h - 2 * this.gap),
				},
				this.work,
			)
			place(s.handle, rect)
			this.suppressGeometry(s, 0)
			i++
		}
	}

	/** Register a satellite window and tile its zone. */
	add(id: string, handle: WindowHandle, dir: Direction): void {
		const sat: Satellite = { id, handle, dir, anchored: false, suppressGeometryUntil: 0 }
		this.sats.set(id, sat)
		this.groupWithCenter(sat)
		this.dirty = true
		this.retileZoneFor(dir)
		this.updateFocusHighlight() // a just-spawned pane is usually focused
	}

	/**
	 * Register a satellite at an EXACT rect without re-tiling — used when
	 * restoring a session so windows return to precisely where they were.
	 */
	addRestored(id: string, handle: WindowHandle, dir: Direction, rect: Rect): void {
		const sat: Satellite = { id, handle, dir, anchored: true, suppressGeometryUntil: 0 }
		this.sats.set(id, sat)
		this.groupWithCenter(sat)
		this.dirty = true
		setWindowRect(handle, rect)
		this.suppressGeometry(sat, 0)
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
		this.retileZoneFor(s.dir)
	}

	/**
	 * Forget every satellite without re-tiling — used when closing a session so the
	 * follow-the-center watcher stops touching windows that are going away.
	 */
	clearSatellites(): void {
		this.animator.cancelAll()
		this.sats.clear()
		// Switching sessions unfolds: the next session decides its own snap state.
		this.snap = null
		this.foldPlan = null
		this.bounds = this.work
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
	 * Watch the center window. A drag only updates its persisted position; satellite
	 * windows remain exactly where they are, including across monitors. A resize
	 * still updates automatic zones while anchored panes remain untouched.
	 */
	watch(intervalMs = CENTER_IDLE_POLL_MS): void {
		if (!this.centerHwnd) return
		this.unwatch()
		this.idlePollMs = intervalMs
		const tick = () => {
			if (!this.centerHwnd) return
			// Observe manual satellite changes first. Otherwise a center move in the
			// same tick could re-tile a pane before its new anchor was adopted.
			this.followSatellites()
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

	/** Release a moved/resized satellite from auto-tiling and adopt its live rect. */
	private followSatellites(): void {
		const now = performance.now()
		for (const s of this.sats.values()) {
			const cur = getWindowRect(s.handle)
			if (!cur || cur.w <= 0 || cur.h <= 0) continue
			if (s.anchored) {
				if (!sameRect(cur, s.observedRect)) {
					s.observedRect = cur
					s.geometryChangedAt = now
					this.dirty = true
				} else if (
					s.geometryChangedAt !== undefined &&
					now - s.geometryChangedAt >= CENTER_SETTLE_MS
				) {
					const work = getWorkArea(s.handle)
					const bounded = work ? clampToWork(cur, work) : cur
					if (!sameRect(bounded, cur)) {
						setWindowRectAsync(s.handle, bounded)
						s.observedRect = bounded
						this.dirty = true
					}
					s.geometryChangedAt = undefined
				}
				continue
			}
			if (now < s.suppressGeometryUntil) continue
			if (!s.observedRect) {
				s.observedRect = cur
				continue
			}
			if (!sameRect(cur, s.observedRect)) {
				s.anchored = true
				s.observedRect = cur
				s.geometryChangedAt = now
				this.animator.cancel(this.effectiveDir(s.dir))
				this.dirty = true
				this.retileZoneFor(s.dir)
			}
		}
	}

	unwatch(): void {
		this.animator.cancelAll()
		if (this.watchTimer) clearTimeout(this.watchTimer)
		this.watchTimer = undefined
		this.centerMoving = false
		this.centerResizing = false
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
			const resized = cur.w !== c.w || cur.h !== c.h
			this.center = cur
			const newWork = getWorkArea(handle) ?? this.work // may be a different monitor now
			const monitorChanged = !sameRect(newWork, this.work)
			this.work = newWork
			if (!this.snap) this.bounds = this.work
			this.dirty = true
			this.centerMoving = true
			this.centerResizing = this.centerResizing || resized
			this.lastCenterMove = performance.now()
			// Dragging the folded session onto another monitor unfolds it: the snapped
			// bounds belonged to the old monitor's work area.
			if (this.snap && monitorChanged) {
				this.exitFold()
				return
			}
			// Moving the command center is independent: every satellite stays at its
			// exact screen coordinates, even when the center crosses monitors. Only an
			// actual center resize changes the automatic zones.
			if (resized) this.retileAll(true, true)
			return
		}
		if (this.centerMoving && performance.now() - this.lastCenterMove >= CENTER_SETTLE_MS) {
			this.centerMoving = false
			const wasResizing = this.centerResizing
			this.centerResizing = false
			// Detect OS-native snapping / un-snapping of the command center and fold
			// the session accordingly. If that changed the layout, it already re-tiled.
			if (this.onCenterSettled(cur)) return
			if (wasResizing) this.retileAll(false)
		}
	}

	/**
	 * Called once the center has settled after a user move/resize. Classifies its
	 * rect against the work area to decide whether the session should fold into an
	 * OS-snapped region (or un-fold). Returns true when it changed the layout.
	 */
	private onCenterSettled(cur: Rect): boolean {
		if (!SNAP_FOLLOW) return false
		// Ignore settles that just land on a rect ordo set itself.
		if (sameRectTol(cur, this.expectedCenter, SNAP_TOL_PX)) return false
		const region = classifySnap(cur, this.work, SNAP_TOL_PX)
		if (region && isFoldKind(region.kind)) {
			this.enterFold(region) // also handles re-snapping to a different zone
			return true
		}
		if (!this.snap) return false
		// Folded, but the center no longer reads as a fold zone:
		if (region?.kind === "full") {
			this.exitFold() // maximized → back to full work area
			return true
		}
		if (rectMostlyInside(cur, this.bounds)) {
			// User is just resizing/moving the center within the folded region.
			this.retileAll(false)
			return true
		}
		this.exitFold() // dragged out of the snapped region
		return true
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
