import { describe, expect, test } from "bun:test"
import { clampToWork, slotRects, zoneRect } from "../src/app/geometry"
import type { Rect } from "../src/platform/win32"

const work: Rect = { x: 0, y: 0, w: 1600, h: 1200 }
const center: Rect = { x: 400, y: 300, w: 800, h: 600 }

describe("zoneRect", () => {
	test("right column runs full height beside the center", () => {
		expect(zoneRect("right", center, work)).toEqual({ x: 1200, y: 0, w: 400, h: 1200 })
	})

	test("left column runs full height to the center's left", () => {
		expect(zoneRect("left", center, work)).toEqual({ x: 0, y: 0, w: 400, h: 1200 })
	})

	test("up strip spans the center width in the gap above it", () => {
		expect(zoneRect("up", center, work)).toEqual({ x: 400, y: 0, w: 800, h: 300 })
	})

	test("down strip spans the center width in the gap below it", () => {
		expect(zoneRect("down", center, work)).toEqual({ x: 400, y: 900, w: 800, h: 300 })
	})

	test("zones don't overlap the center on any side", () => {
		for (const dir of ["left", "right", "up", "down"] as const) {
			const z = zoneRect(dir, center, work)
			const overlapsX = z.x < center.x + center.w && z.x + z.w > center.x
			const overlapsY = z.y < center.y + center.h && z.y + z.h > center.y
			expect(overlapsX && overlapsY).toBe(false)
		}
	})
})

describe("slotRects", () => {
	test("no slots for n = 0", () => {
		expect(slotRects("right", 0, center, work, 10)).toEqual([])
	})

	test("a single slot fills its zone minus the gap on every side", () => {
		expect(slotRects("right", 1, center, work, 10)).toEqual([
			{ x: 1210, y: 10, w: 380, h: 1180 },
		])
	})

	test("splits the zone height evenly, stacking vertically", () => {
		const rects = slotRects("right", 2, center, work, 10)
		expect(rects).toHaveLength(2)
		expect(rects[0]).toEqual({ x: 1210, y: 10, w: 380, h: 580 })
		expect(rects[1]).toEqual({ x: 1210, y: 610, w: 380, h: 580 })
		// Same width, stacked (second starts below the first, no overlap).
		expect(rects[0]?.w).toBe(rects[1]?.w ?? -1)
		expect((rects[0]?.y ?? 0) + (rects[0]?.h ?? 0)).toBeLessThanOrEqual(rects[1]?.y ?? 0)
	})

	test("many slots stay non-negative and on-screen (overflow clamps)", () => {
		const rects = slotRects("right", 20, center, work, 10)
		expect(rects).toHaveLength(20)
		for (const r of rects) {
			expect(r.w).toBeGreaterThanOrEqual(0)
			expect(r.h).toBeGreaterThanOrEqual(0)
			expect(r.x).toBeGreaterThanOrEqual(work.x)
			expect(r.y).toBeGreaterThanOrEqual(work.y)
			expect(r.x + r.w).toBeLessThanOrEqual(work.x + work.w)
			expect(r.y + r.h).toBeLessThanOrEqual(work.y + work.h)
		}
	})

	const oddWork: Rect = { x: 0, y: 0, w: 1600, h: 1001 }
	const oddCenter: Rect = { x: 400, y: 200, w: 800, h: 600 }
	const gap = 10

	test("every slot field is an integer even on an odd-height zone", () => {
		for (const n of [2, 3, 7]) {
			for (const r of slotRects("right", n, oddCenter, oddWork, gap)) {
				expect(Number.isInteger(r.x)).toBe(true)
				expect(Number.isInteger(r.y)).toBe(true)
				expect(Number.isInteger(r.w)).toBe(true)
				expect(Number.isInteger(r.h)).toBe(true)
			}
		}
	})

	test("adjacent stacked slots share an exact 2*gap seam (no shimmer)", () => {
		for (const n of [2, 3, 7]) {
			const rects = slotRects("right", n, oddCenter, oddWork, gap)
			for (let i = 0; i + 1 < rects.length; i++) {
				const seam = (rects[i + 1]?.y ?? 0) - ((rects[i]?.y ?? 0) + (rects[i]?.h ?? 0))
				expect(seam).toBe(2 * gap)
			}
		}
	})

	test("slot heights differ by at most 1px", () => {
		for (const n of [3, 7]) {
			const heights = slotRects("right", n, oddCenter, oddWork, gap).map((r) => r.h)
			expect(Math.max(...heights) - Math.min(...heights)).toBeLessThanOrEqual(1)
		}
	})
})

describe("clampToWork", () => {
	test("pulls an off-top-left rect back on-screen", () => {
		expect(clampToWork({ x: -50, y: -50, w: 200, h: 100 }, work)).toEqual({
			x: 0,
			y: 0,
			w: 200,
			h: 100,
		})
	})

	test("pulls an off-right rect back inside the work area", () => {
		expect(clampToWork({ x: 1500, y: 0, w: 200, h: 100 }, work)).toEqual({
			x: 1400,
			y: 0,
			w: 200,
			h: 100,
		})
	})

	test("shrinks a rect larger than the work area to fit", () => {
		expect(clampToWork({ x: 0, y: 0, w: 2000, h: 100 }, work)).toEqual({
			x: 0,
			y: 0,
			w: 1600,
			h: 100,
		})
	})

	test("leaves an already-contained rect unchanged", () => {
		const r: Rect = { x: 100, y: 200, w: 300, h: 400 }
		expect(clampToWork(r, work)).toEqual(r)
	})
})
