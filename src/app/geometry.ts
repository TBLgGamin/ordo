import type { Rect } from "../platform/win32"
import type { Direction } from "../platform/wt"

/** The outer bounds of a zone (before subdividing among its satellites). */
export function zoneRect(dir: Direction, center: Rect, work: Rect): Rect {
	const c = center
	const w = work
	const right = w.x + w.w
	const bottom = w.y + w.h
	switch (dir) {
		// Side columns run the FULL height so vertical stacking stays tall.
		case "right":
			return { x: c.x + c.w, y: w.y, w: right - (c.x + c.w), h: w.h }
		case "left":
			return { x: w.x, y: w.y, w: c.x - w.x, h: w.h }
		// Top/bottom strips span the center's width, in the gap above/below it.
		case "up":
			return { x: c.x, y: w.y, w: c.w, h: c.y - w.y }
		case "down":
			return { x: c.x, y: c.y + c.h, w: c.w, h: bottom - (c.y + c.h) }
	}
}

/**
 * Subdivide a zone into `n` evenly-sized slots, applying the gap.
 *
 * Slots divide the zone's HEIGHT (never its width), because WT won't let a
 * window go below ~476px wide but height is unconstrained. So every tile keeps
 * the zone's full width — they never overlap — and adding one only shortens
 * heights. With full-height side columns, tiles stay ≥¾ of the center height
 * up to ~3 per side.
 */
export function slotRects(
	dir: Direction,
	n: number,
	center: Rect,
	work: Rect,
	gap: number,
): Rect[] {
	const z = zoneRect(dir, center, work)
	const g = gap
	const out: Rect[] = []
	for (let i = 0; i < n; i++) {
		const cell = { x: z.x, y: z.y + (i * z.h) / n, w: z.w, h: z.h / n }
		out.push(
			clampToWork(
				{
					x: cell.x + g,
					y: cell.y + g,
					w: Math.max(0, cell.w - 2 * g),
					h: Math.max(0, cell.h - 2 * g),
				},
				work,
			),
		)
	}
	return out
}

/** Keep a rect fully inside the current monitor's work area (on-screen). */
export function clampToWork(r: Rect, work: Rect): Rect {
	const a = work
	const w = Math.min(r.w, a.w)
	const h = Math.min(r.h, a.h)
	return {
		x: Math.max(a.x, Math.min(r.x, a.x + a.w - w)),
		y: Math.max(a.y, Math.min(r.y, a.y + a.h - h)),
		w,
		h,
	}
}
