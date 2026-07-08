import { describe, expect, test } from "bun:test"
import type { AnimatorOps } from "../src/app/animator"
import { ZoneAnimator } from "../src/app/animator"
import { runPool, sleep } from "../src/app/types"
import type { Rect, WindowHandle } from "../src/platform/types"

const H = 0 as unknown as WindowHandle
const to = (x: number): Rect => ({ x, y: 0, w: 0, h: 0 })

type Op =
	| { kind: "set"; rect: Rect }
	| { kind: "move"; x: number; y: number }
	| { kind: "batch"; xs: number[] }

function recorder(getRect: () => Rect | null) {
	const log: Op[] = []
	const ops: AnimatorOps = {
		getRect: () => {
			const r = getRect()
			return r ? { ...r } : null
		},
		setRect: (_h, rect) => log.push({ kind: "set", rect: { ...rect } }),
		move: (_h, x, y) => log.push({ kind: "move", x, y }),
		moveBatch: (items) => log.push({ kind: "batch", xs: items.map((i) => i.x) }),
		now: () => performance.now(),
	}
	return { ops, log }
}

const lastSet = (log: Op[]): Rect | undefined => log.filter((o) => o.kind === "set").at(-1)?.rect

describe("ZoneAnimator", () => {
	test("applies targets immediately when animMs is 0", () => {
		const a = new ZoneAnimator()
		const { ops, log } = recorder(() => ({ x: 0, y: 0, w: 0, h: 0 }))
		a.animate("right", [{ handle: H, to: to(7) }], 0, ops)
		expect(log).toEqual([{ kind: "set", rect: to(7) }])
		expect(a.has("right")).toBe(false)
	})

	test("resizes once up front, slides position, then lands exactly on target", async () => {
		const a = new ZoneAnimator()
		const from: Rect = { x: 0, y: 0, w: 100, h: 100 }
		const target: Rect = { x: 200, y: 0, w: 300, h: 100 }
		const { ops, log } = recorder(() => from)
		a.animate("right", [{ handle: H, to: target }], 60, ops)
		await sleep(260)
		expect(log[0]).toEqual({ kind: "set", rect: { x: 0, y: 0, w: 300, h: 100 } })
		expect(log.some((o) => o.kind === "move")).toBe(true)
		expect(lastSet(log)).toEqual(target)
		expect(a.has("right")).toBe(false)
	})

	test("a move-only tween never resizes before sliding", async () => {
		const a = new ZoneAnimator()
		const from: Rect = { x: 0, y: 0, w: 100, h: 100 }
		const target: Rect = { x: 200, y: 0, w: 100, h: 100 }
		const { ops, log } = recorder(() => from)
		a.animate("right", [{ handle: H, to: target }], 60, ops)
		await sleep(260)
		expect(log[0]?.kind).toBe("move")
		expect(lastSet(log)).toEqual(target)
	})

	test("snaps immediately and skips the tween when the source rect is gone", () => {
		const a = new ZoneAnimator()
		const { ops, log } = recorder(() => null)
		a.animate("right", [{ handle: H, to: to(42) }], 60, ops)
		expect(log).toEqual([{ kind: "set", rect: to(42) }])
		expect(a.has("right")).toBe(false)
	})

	test("hasAny() is true while animating and false once settled", async () => {
		const a = new ZoneAnimator()
		const { ops } = recorder(() => ({ x: 0, y: 0, w: 0, h: 0 }))
		a.animate("right", [{ handle: H, to: to(9) }], 40, ops)
		expect(a.hasAny()).toBe(true)
		await sleep(260)
		expect(a.hasAny()).toBe(false)
	})

	test("batches frames when a zone has more than one window", async () => {
		const a = new ZoneAnimator()
		const from: Rect = { x: 0, y: 0, w: 100, h: 100 }
		const h2 = 1 as unknown as WindowHandle
		const { ops, log } = recorder(() => from)
		a.animate(
			"right",
			[
				{ handle: H, to: { x: 200, y: 0, w: 100, h: 100 } },
				{ handle: h2, to: { x: 400, y: 0, w: 100, h: 100 } },
			],
			60,
			ops,
		)
		await sleep(260)
		expect(log.some((o) => o.kind === "batch")).toBe(true)
		expect(log.some((o) => o.kind === "move")).toBe(false)
	})

	test("cancel() before the correction stops it and leaves no entry", async () => {
		const a = new ZoneAnimator()
		const { ops, log } = recorder(() => ({ x: 0, y: 0, w: 0, h: 0 }))
		a.animate("right", [{ handle: H, to: to(5) }], 16, ops)
		await sleep(50)
		a.cancel("right")
		const n = log.length
		await sleep(220)
		expect(log.length).toBe(n)
		expect(a.has("right")).toBe(false)
	})
})

describe("runPool", () => {
	test("preserves input order in the results", async () => {
		const tasks = [1, 2, 3].map((n) => async () => {
			await sleep(12 - n * 3)
			return n
		})
		const res = await runPool(2, tasks)
		expect(res.map((r) => (r.status === "fulfilled" ? r.value : null))).toEqual([1, 2, 3])
	})

	test("bounds concurrency to the limit", async () => {
		let active = 0
		let max = 0
		const tasks = Array.from({ length: 6 }, () => async () => {
			active++
			max = Math.max(max, active)
			await sleep(20)
			active--
		})
		await runPool(2, tasks)
		expect(max).toBeLessThanOrEqual(2)
	})

	test("captures a rejection without failing the whole pool", async () => {
		const tasks = [
			async () => {
				throw new Error("boom")
			},
			async () => 5,
		]
		const res = await runPool(2, tasks)
		expect(res[0]?.status).toBe("rejected")
		expect(res[1]).toEqual({ status: "fulfilled", value: 5 })
	})
})
