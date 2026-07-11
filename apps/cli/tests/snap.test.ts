import { describe, expect, test } from "bun:test"
import { classifySnap, type FoldOpts, planFold, snapBoundsForWork } from "../src/app/snap"
import type { Rect } from "../src/platform/types"

// 1080p-ish work area (taskbar removed).
const work: Rect = { x: 0, y: 0, w: 1920, h: 1032 }
const TOL = 16

describe("classifySnap", () => {
	test("maximized / full work area → full", () => {
		expect(classifySnap({ ...work }, work, TOL)?.kind).toBe("full")
	})

	test("centered freeform window → null", () => {
		expect(classifySnap({ x: 500, y: 250, w: 900, h: 500 }, work, TOL)).toBeNull()
	})

	test("exact left half → band-left with left bounds", () => {
		const r = classifySnap({ x: 0, y: 0, w: 960, h: 1032 }, work, TOL)
		expect(r?.kind).toBe("band-left")
		expect(r?.bounds).toEqual({ x: 0, y: 0, w: 960, h: 1032 })
	})

	test("exact right half → band-right", () => {
		const r = classifySnap({ x: 960, y: 0, w: 960, h: 1032 }, work, TOL)
		expect(r?.kind).toBe("band-right")
		expect(r?.bounds).toEqual({ x: 960, y: 0, w: 960, h: 1032 })
	})

	test("drag-resized 40/60 left band keeps the user's free edge", () => {
		const r = classifySnap({ x: 0, y: 0, w: 768, h: 1032 }, work, TOL)
		expect(r?.kind).toBe("band-left")
		expect(r?.bounds.w).toBe(768)
	})

	test("top half → band-top full width", () => {
		const r = classifySnap({ x: 0, y: 0, w: 1920, h: 516 }, work, TOL)
		expect(r?.kind).toBe("band-top")
		expect(r?.bounds).toEqual({ x: 0, y: 0, w: 1920, h: 516 })
	})

	test("bottom half → band-bottom", () => {
		const r = classifySnap({ x: 0, y: 516, w: 1920, h: 516 }, work, TOL)
		expect(r?.kind).toBe("band-bottom")
		expect(r?.bounds).toEqual({ x: 0, y: 516, w: 1920, h: 516 })
	})

	test("top-left quadrant", () => {
		const r = classifySnap({ x: 0, y: 0, w: 960, h: 516 }, work, TOL)
		expect(r?.kind).toBe("quad-tl")
		expect(r?.bounds).toEqual({ x: 0, y: 0, w: 960, h: 516 })
	})

	test("bottom-right quadrant", () => {
		const r = classifySnap({ x: 960, y: 516, w: 960, h: 516 }, work, TOL)
		expect(r?.kind).toBe("quad-br")
		expect(r?.bounds).toEqual({ x: 960, y: 516, w: 960, h: 516 })
	})

	test("win32 invisible-frame overhang still classifies as a band", () => {
		// Left snap where the window rect overhangs each frame edge by 8px.
		const r = classifySnap({ x: -8, y: 0, w: 976, h: 1040 }, work, TOL)
		expect(r?.kind).toBe("band-left")
		// Bounds normalize flush to the work edges (x/y/h), tolerating the overhang.
		expect(r?.bounds.x).toBe(0)
		expect(r?.bounds.y).toBe(0)
		expect(r?.bounds.h).toBe(1032)
	})

	test("small window nudged into a corner is not a quadrant", () => {
		// Flush to top-left but tiny — below the 35% area floor.
		expect(classifySnap({ x: 0, y: 0, w: 400, h: 300 }, work, TOL)).toBeNull()
	})

	test("tolerance boundary: 16px off is flush, 40px off is not", () => {
		expect(classifySnap({ x: 16, y: 0, w: 944, h: 1032 }, work, TOL)?.kind).toBe("band-left")
		expect(classifySnap({ x: 40, y: 0, w: 920, h: 1032 }, work, TOL)).toBeNull()
	})
})

const opts: FoldOpts = { centerWFrac: 0.48, centerHFrac: 0.5, minWinW: 480, gap: 2, minSlotH: 60 }

describe("planFold", () => {
	test("wide band → two columns, identity remap, centered", () => {
		// Ultrawide-ish top band: 2560 wide.
		const bounds: Rect = { x: 0, y: 0, w: 2560, h: 700 }
		const plan = planFold({ kind: "band-top", bounds }, opts)
		expect(plan.mode).toBe("tiled")
		expect(plan.dirRemap).toEqual({ left: "left", right: "right", up: "up", down: "down" })
		// Center is horizontally centered within bounds.
		const centerMid = plan.center.x + plan.center.w / 2
		expect(Math.abs(centerMid - (bounds.x + bounds.w / 2))).toBeLessThanOrEqual(1)
	})

	test("mid-width left band → one column on the right (interior-facing)", () => {
		// ~1500px band hugging the left edge: fits center + one column, not two.
		const bounds: Rect = { x: 0, y: 0, w: 1500, h: 1032 }
		const plan = planFold({ kind: "band-left", bounds }, opts)
		expect(plan.mode).toBe("tiled")
		expect(plan.dirRemap.left).toBe("right")
		expect(plan.dirRemap.right).toBe("right")
		// Center flush-left inside the bounds so the free column points inward.
		expect(plan.center.x).toBe(bounds.x)
	})

	test("mid-width right band → one column on the left, center flush-right", () => {
		const bounds: Rect = { x: 1060, y: 0, w: 1500, h: 1032 }
		const plan = planFold({ kind: "band-right", bounds }, opts)
		expect(plan.dirRemap.left).toBe("left")
		expect(plan.dirRemap.right).toBe("left")
		expect(plan.center.x + plan.center.w).toBe(bounds.x + bounds.w)
	})

	test("half-width band on 1080p → column or strips, never overlap", () => {
		const bounds: Rect = { x: 0, y: 0, w: 960, h: 1032 }
		const plan = planFold({ kind: "band-left", bounds }, opts)
		expect(plan.mode).toBe("tiled")
	})

	test("narrow tall bounds with no column → strips, load balanced", () => {
		// Too narrow for even one 480 column beside a 480 center, but tall.
		const bounds: Rect = { x: 0, y: 0, w: 700, h: 1032 }
		const plan = planFold({ kind: "band-left", bounds }, opts)
		expect(plan.mode).toBe("tiled")
		expect(plan.dirRemap).toEqual({ left: "up", right: "down", up: "up", down: "down" })
		// Center spans the full bounds width in strip mode.
		expect(plan.center.w).toBe(bounds.w)
	})

	test("short narrow bounds → overlap cascade", () => {
		// Too short to fit the center plus even one min-height strip.
		const bounds: Rect = { x: 0, y: 0, w: 700, h: 110 }
		const plan = planFold({ kind: "quad-tl", bounds }, opts)
		expect(plan.mode).toBe("overlap")
		expect(plan.center).toEqual(bounds)
	})

	test("center never exceeds the bounds", () => {
		for (const bounds of [
			{ x: 0, y: 0, w: 960, h: 1032 },
			{ x: 100, y: 50, w: 1500, h: 800 },
			{ x: 0, y: 0, w: 700, h: 1032 },
		] as Rect[]) {
			const plan = planFold({ kind: "band-left", bounds }, opts)
			expect(plan.center.x).toBeGreaterThanOrEqual(bounds.x)
			expect(plan.center.y).toBeGreaterThanOrEqual(bounds.y)
			expect(plan.center.x + plan.center.w).toBeLessThanOrEqual(bounds.x + bounds.w + 1)
			expect(plan.center.y + plan.center.h).toBeLessThanOrEqual(bounds.y + bounds.h + 1)
		}
	})
})

describe("snapBoundsForWork", () => {
	test("identical work area reproduces the saved bounds", () => {
		const saved = { bounds: { x: 0, y: 0, w: 960, h: 1032 }, work }
		expect(snapBoundsForWork(saved, work)).toEqual(saved.bounds)
	})

	test("rescales proportionally onto a larger monitor", () => {
		const saved = { bounds: { x: 0, y: 0, w: 960, h: 1032 }, work }
		const bigger: Rect = { x: 0, y: 0, w: 3840, h: 2064 }
		expect(snapBoundsForWork(saved, bigger)).toEqual({ x: 0, y: 0, w: 1920, h: 2064 })
	})

	test("preserves the right-half offset across sizes", () => {
		const saved = { bounds: { x: 960, y: 0, w: 960, h: 1032 }, work }
		const bigger: Rect = { x: 0, y: 0, w: 3840, h: 2064 }
		const out = snapBoundsForWork(saved, bigger)
		expect(out).toEqual({ x: 1920, y: 0, w: 1920, h: 2064 })
	})

	test("degenerate saved work falls back to saved bounds", () => {
		const saved = { bounds: { x: 10, y: 20, w: 30, h: 40 }, work: { x: 0, y: 0, w: 0, h: 0 } }
		expect(snapBoundsForWork(saved, work)).toEqual(saved.bounds)
	})
})
