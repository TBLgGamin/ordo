/**
 * "Session as a snap unit" — treat the whole session like one window for the
 * OS's native tiling.
 *
 * ordo normally owns the entire monitor work area. When the user snaps the
 * command-center window with the OS (Windows Snap / Snap Layouts, macOS tiling,
 * GNOME/KDE half-tiling), we want the ENTIRE session (center + satellites) to
 * fold into the snapped region instead of fighting it, so the rest of the
 * screen stays free for other apps.
 *
 * No OS emits a clean "window was snapped" event for this, so we classify the
 * center's settled rect against the work area (pure geometry, below) and, when
 * it looks snapped, re-plan where the center + zones live inside that region.
 *
 * Everything here is pure and platform-agnostic — the layout manager owns the
 * actual window moves and the state machine.
 */

import type { Direction, Rect } from "../platform"

export type SnapKind =
	| "full" // maximized / fills work area → not a fold (exit any fold)
	| "band-left" // full-height vertical band flush to the left
	| "band-right" // full-height vertical band flush to the right
	| "band-top" // full-width horizontal band flush to the top
	| "band-bottom" // full-width horizontal band flush to the bottom
	| "quad-tl"
	| "quad-tr"
	| "quad-bl"
	| "quad-br"

export interface SnapRegion {
	kind: SnapKind
	/** The region the session should fold into, normalized flush to the work edges it touches. */
	bounds: Rect
}

const ALL_KINDS: readonly SnapKind[] = [
	"full",
	"band-left",
	"band-right",
	"band-top",
	"band-bottom",
	"quad-tl",
	"quad-tr",
	"quad-bl",
	"quad-br",
]

/** Narrow an arbitrary persisted string to a SnapKind. */
export function isSnapKind(value: string): value is SnapKind {
	return (ALL_KINDS as readonly string[]).includes(value)
}

/** Corners that stack in top/bottom strips. */
const QUAD_KINDS: readonly SnapKind[] = ["quad-tl", "quad-tr", "quad-bl", "quad-br"]

/** A quadrant snap must cover at least this fraction of the work area in each axis. */
const QUAD_MIN_FRAC = 0.35

type DirRemap = Record<Direction, Direction>
const IDENTITY: DirRemap = { left: "left", right: "right", up: "up", down: "down" }

/**
 * Classify a settled center rect against the monitor work area.
 *
 * An edge is "flush" when it lands within `tolPx` of the corresponding work
 * edge. The tolerance absorbs the Win32 invisible DWM resize frame (~7–8px per
 * edge on a snapped/maximized window) and macOS tiling margins. Returns null
 * when the rect isn't touching enough edges to read as snapped (freeform).
 *
 * Bands intentionally use the rect's ACTUAL free edge, so a drag-resized snap
 * (e.g. 40/60 instead of 50/50) folds into the region the user actually made.
 */
export function classifySnap(rect: Rect, work: Rect, tolPx: number): SnapRegion | null {
	if (work.w <= 0 || work.h <= 0 || rect.w <= 0 || rect.h <= 0) return null
	const wl = work.x
	const wt = work.y
	const wr = work.x + work.w
	const wb = work.y + work.h
	const rl = rect.x
	const rt = rect.y
	const rr = rect.x + rect.w
	const rb = rect.y + rect.h

	const left = Math.abs(rl - wl) <= tolPx
	const right = Math.abs(rr - wr) <= tolPx
	const top = Math.abs(rt - wt) <= tolPx
	const bottom = Math.abs(rb - wb) <= tolPx

	if (left && right && top && bottom) return { kind: "full", bounds: { ...work } }

	// Full-height vertical bands (flush to one side, spanning top→bottom).
	if (top && bottom && left && !right) {
		return { kind: "band-left", bounds: { x: wl, y: wt, w: rr - wl, h: work.h } }
	}
	if (top && bottom && right && !left) {
		return { kind: "band-right", bounds: { x: rl, y: wt, w: wr - rl, h: work.h } }
	}
	// Full-width horizontal bands (flush to top/bottom, spanning left→right).
	if (left && right && top && !bottom) {
		return { kind: "band-top", bounds: { x: wl, y: wt, w: work.w, h: rb - wt } }
	}
	if (left && right && bottom && !top) {
		return { kind: "band-bottom", bounds: { x: wl, y: rt, w: work.w, h: wb - rt } }
	}

	// Quadrants: one vertical + one horizontal edge flush, and large enough that
	// it can't be a small window merely nudged into a corner.
	const bigEnough = rect.w >= QUAD_MIN_FRAC * work.w && rect.h >= QUAD_MIN_FRAC * work.h
	if (bigEnough) {
		const vLeft = left && !right
		const vRight = right && !left
		const hTop = top && !bottom
		const hBottom = bottom && !top
		if (vLeft && hTop) return { kind: "quad-tl", bounds: { x: wl, y: wt, w: rr - wl, h: rb - wt } }
		if (vRight && hTop) return { kind: "quad-tr", bounds: { x: rl, y: wt, w: wr - rl, h: rb - wt } }
		if (vLeft && hBottom)
			return { kind: "quad-bl", bounds: { x: wl, y: rt, w: rr - wl, h: wb - rt } }
		if (vRight && hBottom)
			return { kind: "quad-br", bounds: { x: rl, y: rt, w: wr - rl, h: wb - rt } }
	}
	return null
}

export interface FoldPlan {
	/** Where the center window should sit inside the bounds. */
	center: Rect
	/** Maps each satellite's logical direction to the zone it tiles into while folded. */
	dirRemap: DirRemap
	/**
	 * "tiled" lays satellites out in the (possibly remapped) zones as usual.
	 * "overlap" means the bounds are too small for any zone, so satellites
	 * cascade over the center (still reachable via focus cycling / Alt-Tab group).
	 */
	mode: "tiled" | "overlap"
}

export interface FoldOpts {
	centerWFrac: number
	centerHFrac: number
	minWinW: number
	gap: number
	minSlotH: number
}

function clampNum(v: number, lo: number, hi: number): number {
	return Math.max(lo, Math.min(hi, v))
}

function hugsRightEdge(kind: SnapKind): boolean {
	return kind === "band-right" || kind === "quad-tr" || kind === "quad-br"
}

/**
 * Plan how the center + zones lay out inside a snapped region.
 *
 * Degrade ladder (driven by Windows Terminal's ~480px minimum window width):
 *  1. Two side columns  — if the center + two min-width columns fit.
 *  2. One side column   — if only one fits; placed toward the screen interior.
 *  3. Top/bottom strips — if no column fits (typical half-width snap).
 *  4. Overlap cascade   — if even one strip doesn't fit.
 */
export function planFold(region: SnapRegion, opts: FoldOpts): FoldPlan {
	const { bounds, kind } = region
	const { centerWFrac, centerHFrac, minWinW, gap, minSlotH } = opts

	const centerW = Math.round(
		clampNum(bounds.w * centerWFrac, Math.min(minWinW, bounds.w), bounds.w),
	)
	const centerH = Math.round(
		clampNum(bounds.h * centerHFrac, Math.min(minSlotH, bounds.h), bounds.h),
	)
	const midY = Math.round(bounds.y + (bounds.h - centerH) / 2)

	// 1. Two columns — center sits in the middle, left/right zones flank it.
	if (bounds.w >= centerW + 2 * minWinW) {
		const x = Math.round(bounds.x + (bounds.w - centerW) / 2)
		return { center: { x, y: midY, w: centerW, h: centerH }, dirRemap: IDENTITY, mode: "tiled" }
	}

	// 2. One column — placed on the side facing the screen interior so the free
	// column visually points inward. Both side zones fold into that one column.
	if (bounds.w >= centerW + minWinW) {
		if (hugsRightEdge(kind)) {
			// Bounds hug the right edge → column on the left, center flush-right.
			const x = bounds.x + bounds.w - centerW
			return {
				center: { x, y: midY, w: centerW, h: centerH },
				dirRemap: { ...IDENTITY, left: "left", right: "left" },
				mode: "tiled",
			}
		}
		// Bounds hug the left edge (or full-width) → column on the right, center flush-left.
		return {
			center: { x: bounds.x, y: midY, w: centerW, h: centerH },
			dirRemap: { ...IDENTITY, left: "right", right: "right" },
			mode: "tiled",
		}
	}

	// 3. Strips only — center spans the bounds width; satellites stack above/below.
	const spare = bounds.h - centerH
	const oneStrip = minSlotH + 2 * gap
	if (spare >= 2 * oneStrip) {
		// Balance the load: left+up in the top strip, right+down in the bottom strip.
		return {
			center: { x: bounds.x, y: midY, w: bounds.w, h: centerH },
			dirRemap: { left: "up", right: "down", up: "up", down: "down" },
			mode: "tiled",
		}
	}
	if (spare >= oneStrip) {
		// Only one strip fits: pin the center to the top, everything goes below.
		return {
			center: { x: bounds.x, y: bounds.y, w: bounds.w, h: centerH },
			dirRemap: { left: "down", right: "down", up: "down", down: "down" },
			mode: "tiled",
		}
	}

	// 4. Overlap — bounds too small for any zone; satellites cascade over the center.
	return { center: { ...bounds }, dirRemap: IDENTITY, mode: "overlap" }
}

/** Whether a kind represents an actual fold (vs. "full" / not snapped). */
export function isFoldKind(kind: SnapKind): boolean {
	return kind !== "full"
}

export function isQuadKind(kind: SnapKind): boolean {
	return QUAD_KINDS.includes(kind)
}

/**
 * Rescale a saved snap region onto the current work area, so a session restored
 * on a different-sized monitor folds into the proportionally-equivalent region.
 * Falls back to the saved bounds when the saved work area is unusable.
 */
export function snapBoundsForWork(saved: { bounds: Rect; work: Rect }, currentWork: Rect): Rect {
	const sw = saved.work
	if (sw.w <= 0 || sw.h <= 0) return { ...saved.bounds }
	const fx = (saved.bounds.x - sw.x) / sw.w
	const fy = (saved.bounds.y - sw.y) / sw.h
	const fw = saved.bounds.w / sw.w
	const fh = saved.bounds.h / sw.h
	return {
		x: Math.round(currentWork.x + fx * currentWork.w),
		y: Math.round(currentWork.y + fy * currentWork.h),
		w: Math.round(fw * currentWork.w),
		h: Math.round(fh * currentWork.h),
	}
}
