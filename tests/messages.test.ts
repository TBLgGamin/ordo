import { describe, expect, test } from "bun:test"
import type { ControlEvent, WaitableEvent } from "../src/core/daemonProtocol"
import { clampInt, type EventWaiterMatch, matchEventWaiter, matchWaiter } from "../src/daemon/messages"

const waiter = (over: Partial<EventWaiterMatch> = {}): EventWaiterMatch => ({
	session: "s1",
	kinds: new Set<WaitableEvent>(["message", "pane-exited", "pane-created", "status-changed"]),
	...over,
})

describe("matchWaiter", () => {
	test("an unfiltered waiter accepts any sender", () => {
		expect(matchWaiter({}, "anyone")).toBe(true)
	})

	test("a filtered waiter accepts only its sender", () => {
		expect(matchWaiter({ from: "optio" }, "optio")).toBe(true)
		expect(matchWaiter({ from: "optio" }, "legate")).toBe(false)
	})
})

describe("clampInt", () => {
	test("falls back to the default for undefined or non-finite", () => {
		expect(clampInt(undefined, 60, 1, 300)).toBe(60)
		expect(clampInt(Number.NaN, 60, 1, 300)).toBe(60)
		expect(clampInt(Number.POSITIVE_INFINITY, 60, 1, 300)).toBe(60)
	})

	test("clamps to the range and truncates", () => {
		expect(clampInt(0, 60, 1, 300)).toBe(1)
		expect(clampInt(9999, 60, 1, 300)).toBe(300)
		expect(clampInt(42.9, 60, 1, 300)).toBe(42)
	})
})

describe("matchEventWaiter", () => {
	const msg: ControlEvent = {
		event: "message",
		session: "s1",
		from: "optio",
		to: "legate",
		text: "hi",
		ts: 5,
		delivered: "typed",
	}

	test("maps a message event to the 'message' kind and carries fields", () => {
		const res = matchEventWaiter(waiter(), msg)
		expect(res).toMatchObject({ kind: "message", pane: "legate", from: "optio", text: "hi", ts: 5 })
	})

	test("ignores events from other sessions", () => {
		expect(matchEventWaiter(waiter({ session: "other" }), msg)).toBeNull()
	})

	test("respects the kind filter", () => {
		expect(matchEventWaiter(waiter({ kinds: new Set(["pane-exited"]) }), msg)).toBeNull()
	})

	test("filterPane matches the pane the event concerns", () => {
		expect(matchEventWaiter(waiter({ filterPane: "legate" }), msg)).not.toBeNull()
		expect(matchEventWaiter(waiter({ filterPane: "someone" }), msg)).toBeNull()
	})

	test("from filter applies to message senders", () => {
		expect(matchEventWaiter(waiter({ from: "optio" }), msg)).not.toBeNull()
		expect(matchEventWaiter(waiter({ from: "nobody" }), msg)).toBeNull()
	})

	test("paneExited and paneClosed both map to 'pane-exited'", () => {
		const exited: ControlEvent = { event: "paneExited", session: "s1", pane: "velite" }
		const closed: ControlEvent = { event: "paneClosed", session: "s1", pane: "velite" }
		expect(matchEventWaiter(waiter(), exited)).toMatchObject({ kind: "pane-exited", pane: "velite" })
		expect(matchEventWaiter(waiter(), closed)).toMatchObject({ kind: "pane-exited", pane: "velite" })
	})

	test("paneCreated maps to 'pane-created' with the new pane name", () => {
		const created: ControlEvent = {
			event: "paneCreated",
			session: "s1",
			state: { pane: "eques", live: true },
		}
		expect(matchEventWaiter(waiter(), created)).toMatchObject({ kind: "pane-created", pane: "eques" })
	})

	test("status maps to 'status-changed' with status/task", () => {
		const status: ControlEvent = {
			event: "status",
			session: "s1",
			pane: "decanus",
			status: "reviewing",
			task: "pr",
			ts: 9,
		}
		expect(matchEventWaiter(waiter(), status)).toMatchObject({
			kind: "status-changed",
			pane: "decanus",
			status: "reviewing",
			task: "pr",
		})
	})

	test("the plain 'pane' state event is not waitable", () => {
		const pane: ControlEvent = { event: "pane", session: "s1", state: { pane: "x", live: true } }
		expect(matchEventWaiter(waiter(), pane)).toBeNull()
	})
})
