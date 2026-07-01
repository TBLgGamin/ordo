import { describe, expect, test } from "bun:test"
import { ansiFg, lightTint, PANE_FG, paletteColor } from "../src/core/colors"

const HEX = /^#[0-9a-f]{6}$/

describe("paletteColor", () => {
	test("returns a 6-digit hex color", () => {
		for (let i = 0; i < 20; i++) expect(paletteColor(i)).toMatch(HEX)
	})

	test("consecutive indices differ (golden-angle spacing)", () => {
		expect(paletteColor(0)).not.toBe(paletteColor(1))
		expect(paletteColor(1)).not.toBe(paletteColor(2))
	})

	test("is deterministic for a given index", () => {
		expect(paletteColor(7)).toBe(paletteColor(7))
	})
})

describe("lightTint", () => {
	test("moves every channel toward white", () => {
		const tint = lightTint("#406080")
		expect(tint).toMatch(HEX)
		const ch = (h: string, i: number) => Number.parseInt(h.slice(1 + i * 2, 3 + i * 2), 16)
		for (let i = 0; i < 3; i++) {
			expect(ch(tint, i)).toBeGreaterThanOrEqual(ch("#406080", i))
		}
	})

	test("amount 1 yields white, amount 0 is unchanged", () => {
		expect(lightTint("#123456", 1)).toBe("#ffffff")
		expect(lightTint("#123456", 0)).toBe("#123456")
	})
})

describe("ansiFg", () => {
	test("emits a 24-bit truecolor foreground sequence", () => {
		expect(ansiFg("#ff8000")).toBe("\x1b[38;2;255;128;0m")
	})
})

test("PANE_FG is a dark readable hex", () => {
	expect(PANE_FG).toMatch(HEX)
})
