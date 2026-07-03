import { describe, expect, test } from "bun:test"
import { ZoneAnimator } from "../src/app/animator"
import { runPool, sleep } from "../src/app/types"
import type { Hwnd, Rect } from "../src/platform/win32"

const H = 0 as unknown as Hwnd
const to = (x: number): Rect => ({ x, y: 0, w: 0, h: 0 })

describe("ZoneAnimator", () => {
	test("applies targets immediately when animMs is 0", () => {
		const a = new ZoneAnimator()
		const xs: number[] = []
		a.animate("right", [{ hwnd: H, to: to(7) }], 0, (_h, r) => xs.push(r.x))
		expect(xs).toEqual([7])
		expect(a.has("right")).toBe(false)
	})

	test("runs a trailing correction, then clears the zone entry", async () => {
		const a = new ZoneAnimator()
		const xs: number[] = []
		a.animate("right", [{ hwnd: H, to: to(99) }], 16, (_h, r) => xs.push(r.x))
		await sleep(240)
		expect(xs.at(-1)).toBe(99)
		expect(a.has("right")).toBe(false)
	})

	test("cancel() before the correction stops it and leaves no entry", async () => {
		const a = new ZoneAnimator()
		const xs: number[] = []
		a.animate("right", [{ hwnd: H, to: to(5) }], 16, (_h, r) => xs.push(r.x))
		await sleep(50)
		a.cancel("right")
		const n = xs.length
		await sleep(220)
		expect(xs.length).toBe(n)
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
