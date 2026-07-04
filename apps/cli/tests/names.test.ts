import { describe, expect, test } from "bun:test"
import { pickUniqueName, ROMAN_SOLDIERS, randomSoldier } from "../src/core/names"

describe("randomSoldier", () => {
	test("always returns a known soldier word", () => {
		for (let i = 0; i < 200; i++) {
			expect(ROMAN_SOLDIERS).toContain(randomSoldier())
		}
	})
})

describe("pickUniqueName", () => {
	test("returns a bare soldier when nothing is taken", () => {
		expect(ROMAN_SOLDIERS).toContain(pickUniqueName(new Set()))
	})

	test("never returns a name already taken", () => {
		const taken = new Set(ROMAN_SOLDIERS) // every single word is taken
		const name = pickUniqueName(taken)
		expect(taken.has(name)).toBe(false)
		// Falls back to a kebab-case compound of soldier words.
		expect(name).toContain("-")
		for (const part of name.split("-")) expect(ROMAN_SOLDIERS).toContain(part)
	})

	test("produces unique names across many draws", () => {
		const taken = new Set<string>()
		for (let i = 0; i < 100; i++) {
			const name = pickUniqueName(taken)
			expect(taken.has(name)).toBe(false)
			taken.add(name)
		}
		expect(taken.size).toBe(100)
	})
})
