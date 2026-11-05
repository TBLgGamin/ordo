import { describe, expect, test } from "bun:test"
import { LOG_CAP, type LogEntry, LogStore, timeLabel } from "../src/cli/logstore"

const entry = (over: Partial<LogEntry> = {}): LogEntry => ({
	ts: 0,
	kind: "action",
	level: "info",
	text: "did a thing",
	...over,
})

describe("LogStore", () => {
	test("default view shows user entries plus warnings and errors; verbose shows everything", () => {
		const store = new LogStore()
		store.push(entry({ kind: "user", text: "new session" }))
		store.push(entry({ text: "pane spawned" }))
		store.push(entry({ kind: "event", text: "panes changed" }))
		store.push(entry({ level: "error", text: 'no saved session "x"' }))
		store.push(entry({ level: "warn", text: "terminal not tiled" }))
		expect(store.visible(false, 10).map((e) => e.text)).toEqual([
			"new session",
			'no saved session "x"',
			"terminal not tiled",
		])
		expect(store.visible(true, 10)).toHaveLength(5)
	})

	test("visible() returns the newest entries up to the limit", () => {
		const store = new LogStore()
		for (let i = 0; i < 5; i++) store.push(entry({ kind: "user", text: `line ${i}` }))
		expect(store.visible(false, 2).map((e) => e.text)).toEqual(["line 3", "line 4"])
	})

	test("caps stored history at LOG_CAP", () => {
		const store = new LogStore()
		for (let i = 0; i < LOG_CAP + 10; i++) store.push(entry({ text: `line ${i}` }))
		expect(store.visible(true, Number.POSITIVE_INFINITY)).toHaveLength(LOG_CAP)
		expect(store.visible(true, 1)[0]?.text).toBe(`line ${LOG_CAP + 9}`)
	})

	test("shows() mirrors visibility rules", () => {
		const store = new LogStore()
		expect(store.shows(entry({ kind: "user" }), false)).toBe(true)
		expect(store.shows(entry(), false)).toBe(false)
		expect(store.shows(entry({ level: "error" }), false)).toBe(true)
		expect(store.shows(entry({ kind: "event", level: "warn" }), false)).toBe(true)
		expect(store.shows(entry({ kind: "event" }), false)).toBe(false)
		expect(store.shows(entry(), true)).toBe(true)
		expect(store.shows(entry({ kind: "event" }), true)).toBe(true)
	})
})

describe("timeLabel", () => {
	test("formats as HH:MM:SS", () => {
		expect(timeLabel(new Date(2026, 0, 1, 9, 5, 3).getTime())).toBe("09:05:03")
	})
})
