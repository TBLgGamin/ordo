import { describe, expect, test } from "bun:test"
import { reconnectDecision } from "../src/app/reconnect"

describe("reconnectDecision", () => {
	test("same pid resyncs without reopening", () => {
		expect(reconnectDecision(1234, 1234, 0, 10_000)).toBe("resync")
	})

	test("a new pid reopens when past the min interval", () => {
		expect(reconnectDecision(1234, 5678, 0, 10_000)).toBe("reopen")
	})

	test("a new pid within the min interval is skipped", () => {
		expect(reconnectDecision(1234, 5678, 9_000, 10_000)).toBe("skip")
	})

	test("unknown previous pid reopens (first reconnect)", () => {
		expect(reconnectDecision(undefined, 5678, 0, 10_000)).toBe("reopen")
	})

	test("unknown new pid does not count as same", () => {
		expect(reconnectDecision(1234, undefined, 0, 10_000)).toBe("reopen")
	})
})
