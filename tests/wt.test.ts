import { describe, expect, test } from "bun:test"
import { isDirection } from "../src/platform/wt"

describe("isDirection", () => {
	test("accepts the four tiling directions", () => {
		for (const d of ["left", "right", "up", "down"]) expect(isDirection(d)).toBe(true)
	})

	test("rejects anything else", () => {
		for (const s of ["", "Left", "north", "tab", "win", "up-down"]) {
			expect(isDirection(s)).toBe(false)
		}
	})
})
