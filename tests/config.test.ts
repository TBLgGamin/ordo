import { describe, expect, test } from "bun:test"
import {
	AGENT_PROGRAMS,
	parseArgValue,
	parseNumEnv,
	parseProgramList,
	RESTORE_PROGRAMS,
	SCROLLBACK_LINES,
} from "../src/core/config"

describe("RESTORE_PROGRAMS (defaults)", () => {
	test("is a non-empty set of lowercased program names", () => {
		expect(RESTORE_PROGRAMS.size).toBeGreaterThan(0)
		expect(RESTORE_PROGRAMS.has("vim")).toBe(true)
		expect(RESTORE_PROGRAMS.has("claude")).toBe(true)
		for (const name of RESTORE_PROGRAMS) expect(name).toBe(name.toLowerCase())
	})

	test("includes the newly supported agent CLIs", () => {
		for (const name of ["gemini", "opencode", "copilot", "qwen", "cursor-agent", "goose", "amp", "droid"]) {
			expect(RESTORE_PROGRAMS.has(name)).toBe(true)
		}
	})
})

describe("AGENT_PROGRAMS", () => {
	test("is a subset of the restore programs and contains the agent CLIs", () => {
		expect(AGENT_PROGRAMS.has("claude")).toBe(true)
		expect(AGENT_PROGRAMS.has("gemini")).toBe(true)
		expect(AGENT_PROGRAMS.has("droid")).toBe(true)
		expect(AGENT_PROGRAMS.has("vim")).toBe(false)
		for (const name of AGENT_PROGRAMS) expect(RESTORE_PROGRAMS.has(name)).toBe(true)
	})
})

describe("SCROLLBACK_LINES (default)", () => {
	test("defaults to a positive integer", () => {
		expect(SCROLLBACK_LINES).toBe(1000)
	})
})

describe("parseProgramList", () => {
	test("parses a space/comma separated, case-insensitive list", () => {
		expect(parseProgramList("Foo, bar  BAZ")).toEqual(new Set(["foo", "bar", "baz"]))
	})

	test("an empty string yields an empty set (relaunch disabled)", () => {
		expect(parseProgramList("").size).toBe(0)
	})

	test("dedupes repeats", () => {
		expect(parseProgramList("vim vim VIM")).toEqual(new Set(["vim"]))
	})
})

describe("parseNumEnv clamping", () => {
	test("clamps above max", () => {
		expect(parseNumEnv("5", 0.48, 0.1, 0.9)).toBe(0.9)
	})
	test("clamps below min", () => {
		expect(parseNumEnv("-3", 2, 0, 64)).toBe(0)
	})
	test("undefined falls back to default", () => {
		expect(parseNumEnv(undefined, 2, 0, 64)).toBe(2)
	})
	test("empty string falls back to default", () => {
		expect(parseNumEnv("", 0.48, 0.1, 0.9)).toBe(0.48)
	})
	test("garbage falls back to default", () => {
		expect(parseNumEnv("abc", 2, 0, 64)).toBe(2)
	})
	test("a valid in-range value passes through", () => {
		expect(parseNumEnv("0.5", 0.48, 0.1, 0.9)).toBe(0.5)
	})
})

describe("parseArgValue", () => {
	test("reads a normal value", () => {
		expect(parseArgValue(["--session", "mysess"], "--session")).toBe("mysess")
	})
	test("rejects a flag-like value", () => {
		expect(parseArgValue(["--session", "--lines"], "--session")).toBeUndefined()
	})
	test("undefined when the flag is last", () => {
		expect(parseArgValue(["--session"], "--session")).toBeUndefined()
	})
	test("undefined when the flag is absent", () => {
		expect(parseArgValue(["--other", "x"], "--session")).toBeUndefined()
	})
})
