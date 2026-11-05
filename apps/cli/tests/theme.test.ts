import { describe, expect, test } from "bun:test"
import { BG, mixHex, PURPLE, PURPLE_BRIGHT, TRACK_BG } from "../src/cli/theme"

describe("mixHex", () => {
	test("endpoints return the pure colors", () => {
		expect(mixHex("#000000", "#ffffff", 0)).toBe("#000000")
		expect(mixHex("#000000", "#ffffff", 1)).toBe("#ffffff")
	})

	test("midpoint blends channels", () => {
		expect(mixHex("#000000", "#ffffff", 0.5)).toBe("#808080")
	})

	test("t is clamped to [0, 1]", () => {
		expect(mixHex("#102030", "#ffffff", -1)).toBe("#102030")
		expect(mixHex("#102030", "#ffffff", 2)).toBe("#ffffff")
	})

	test("malformed hex falls back to the first color", () => {
		expect(mixHex("nope", "#ffffff", 0.5)).toBe("nope")
	})
})

describe("derived shades", () => {
	test("all are valid six-digit hex colors", () => {
		for (const c of [PURPLE, BG, TRACK_BG, PURPLE_BRIGHT]) {
			expect(c).toMatch(/^#[0-9a-fA-F]{6}$/)
		}
	})

	test("background is darker than the accent, bright is lighter", () => {
		const lum = (hex: string) =>
			Number.parseInt(hex.slice(1, 3), 16) +
			Number.parseInt(hex.slice(3, 5), 16) +
			Number.parseInt(hex.slice(5, 7), 16)
		expect(lum(BG)).toBeLessThan(lum(PURPLE))
		expect(lum(TRACK_BG)).toBeLessThan(lum(PURPLE))
		expect(lum(PURPLE_BRIGHT)).toBeGreaterThan(lum(PURPLE))
	})
})
