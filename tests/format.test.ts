import { describe, expect, test } from "bun:test"
import type { SessionState } from "../src/core/session"
import { relativeTime, truncate } from "../src/cli/format"
import { sessionChunks } from "../src/cli/styled"

describe("relativeTime", () => {
	const ago = (ms: number) => new Date(Date.now() - ms).toISOString()

	test("buckets seconds/minutes/hours/days", () => {
		expect(relativeTime(ago(5_000))).toMatch(/s ago$/)
		expect(relativeTime(ago(5 * 60_000))).toMatch(/m ago$/)
		expect(relativeTime(ago(3 * 3_600_000))).toMatch(/h ago$/)
		expect(relativeTime(ago(2 * 86_400_000))).toMatch(/d ago$/)
	})

	test("returns '?' for an unparseable timestamp", () => {
		expect(relativeTime("not-a-date")).toBe("?")
	})
})

describe("truncate", () => {
	test("leaves short strings untouched", () => {
		expect(truncate("hello", 10)).toBe("hello")
	})
	test("adds an ellipsis past the limit", () => {
		expect(truncate("hello world", 5)).toBe("hell…")
	})
})

describe("sessionChunks", () => {
	const sample: SessionState = {
		id: "centurion",
		updatedAt: new Date().toISOString(),
		center: { x: 0, y: 0, w: 1, h: 1 },
		satellites: [{ id: "optio", direction: "right", rect: { x: 0, y: 0, w: 1, h: 1 } }],
	}

	test("produces chunks and does not throw for a live session", () => {
		expect(sessionChunks(sample, true).length).toBeGreaterThan(0)
	})

	test("tolerates a satellite with no color", () => {
		expect(() => sessionChunks(sample, false)).not.toThrow()
	})
})
