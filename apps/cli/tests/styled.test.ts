import { describe, expect, test } from "bun:test"
import type { SessionState } from "../src/core/session"
import { LOGO_MARK, logoMarkChunks, sessionChunks } from "../src/cli/styled"

const textOf = (chunks: { text?: unknown }[]): string =>
	chunks.map((c) => String((c as { text: unknown }).text ?? "")).join("")

describe("LOGO_MARK", () => {
	test("all rows are the same width", () => {
		const widths = new Set(LOGO_MARK.map((l) => [...l].length))
		expect(widths.size).toBe(1)
	})
})

describe("logoMarkChunks", () => {
	test("resting mark reproduces the art verbatim", () => {
		expect(textOf(logoMarkChunks())).toBe(LOGO_MARK.join("\n"))
	})

	test("reveal 0 keeps the footprint but blanks every row", () => {
		const flat = textOf(logoMarkChunks({ reveal: 0 }))
		expect(flat.split("\n")).toHaveLength(LOGO_MARK.length)
		expect(flat.replace(/\n/g, "").trim()).toBe("")
	})

	test("partial reveal shows rows from the bottom up", () => {
		const lines = textOf(logoMarkChunks({ reveal: 0.5 })).split("\n")
		expect(lines[0]?.trim()).toBe("")
		expect(lines[lines.length - 1]).toBe(LOGO_MARK[LOGO_MARK.length - 1])
	})

	test("sweep splits rows into per-character chunks without changing the text", () => {
		expect(textOf(logoMarkChunks({ sweep: 5 }))).toBe(LOGO_MARK.join("\n"))
	})
})

describe("sessionChunks", () => {
	test("the live sweep never splits an emoji in a renamed title", () => {
		const state = {
			id: "legate",
			title: "ship 🚀 release",
			satellites: [],
			updatedAt: Date.now(),
		} as unknown as SessionState
		const chunks = sessionChunks(state, true, 5)
		const texts = chunks.map((c) => c.text)
		expect(texts).toContain("🚀")
		expect(texts.some((t) => /^[\uD800-\uDFFF]$/.test(t))).toBe(false)
		expect(textOf(chunks)).toContain("ship 🚀 release")
	})
})
