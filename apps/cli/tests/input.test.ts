import { describe, expect, test } from "bun:test"
import { handleKey, handlePaste, type InputState } from "../src/cli/input"

const base = (over: Partial<InputState> = {}): InputState => ({
	mode: "none",
	buffer: "",
	pendingDelete: "",
	hasSession: false,
	...over,
})

describe("handleKey — resting mode", () => {
	test("q requests shutdown", () => {
		expect(handleKey(base(), { sequence: "q" }).action).toEqual({ type: "shutdown" })
	})

	test("s enters open mode", () => {
		const r = handleKey(base(), { sequence: "s" })
		expect(r.state.mode).toBe("open")
		expect(r.action).toEqual({ type: "redraw" })
	})

	test("r with no session yields a status message, not rename mode", () => {
		const r = handleKey(base({ hasSession: false }), { sequence: "r" })
		expect(r.state.mode).toBe("none")
		expect(r.action.type).toBe("status")
	})

	test("r with a session enters rename mode", () => {
		const r = handleKey(base({ hasSession: true }), { sequence: "r" })
		expect(r.state.mode).toBe("rename")
	})

	test("ctrl+c requests shutdown from any mode", () => {
		expect(handleKey(base({ mode: "open" }), { ctrl: true, name: "c" }).action).toEqual({
			type: "shutdown",
		})
	})

	test("arrow keys scroll", () => {
		expect(handleKey(base(), { name: "up" }).action).toEqual({ type: "scroll", by: -2 })
		expect(handleKey(base(), { name: "pagedown" }).action).toEqual({ type: "scroll", by: 10 })
	})
})

describe("handleKey — text entry", () => {
	test("printable characters append to the buffer", () => {
		const r = handleKey(base({ mode: "open", buffer: "op" }), { sequence: "t" })
		expect(r.state.buffer).toBe("opt")
	})

	test("DEL (0x7f) is not appended", () => {
		const r = handleKey(base({ mode: "open", buffer: "op" }), { sequence: "\x7f" })
		expect(r.state.buffer).toBe("op")
		expect(r.action.type).toBe("none")
	})

	test("backspace trims the buffer", () => {
		const r = handleKey(base({ mode: "rename", buffer: "abc" }), { name: "backspace" })
		expect(r.state.buffer).toBe("ab")
	})

	test("escape returns to resting mode", () => {
		const r = handleKey(base({ mode: "delete", buffer: "x" }), { name: "escape" })
		expect(r.state.mode).toBe("none")
		expect(r.state.buffer).toBe("")
	})

	test("enter in open mode emits an open action and resets", () => {
		const r = handleKey(base({ mode: "open", buffer: "optio" }), { name: "return" })
		expect(r.action).toEqual({ type: "open", id: "optio" })
		expect(r.state.mode).toBe("none")
	})

	test("enter in delete mode arms a confirmation", () => {
		const r = handleKey(base({ mode: "delete", buffer: "optio" }), { name: "return" })
		expect(r.state.mode).toBe("confirmDelete")
		expect(r.state.pendingDelete).toBe("optio")
	})

	test("empty delete entry just resets", () => {
		const r = handleKey(base({ mode: "delete", buffer: "   " }), { name: "return" })
		expect(r.state.mode).toBe("none")
		expect(r.action.type).toBe("redraw")
	})
})

describe("handleKey — confirmDelete", () => {
	test("y confirms the delete", () => {
		const r = handleKey(base({ mode: "confirmDelete", pendingDelete: "optio" }), { sequence: "y" })
		expect(r.action).toEqual({ type: "delete", id: "optio" })
		expect(r.state.mode).toBe("none")
	})

	test("n cancels", () => {
		const r = handleKey(base({ mode: "confirmDelete", pendingDelete: "optio" }), { sequence: "n" })
		expect(r.state.mode).toBe("none")
		expect(r.action.type).toBe("redraw")
	})
})

describe("handlePaste", () => {
	test("pasted text is appended (control chars stripped) in text mode", () => {
		const r = handlePaste(base({ mode: "open", buffer: "a" }), "b\tc\n")
		expect(r.state.buffer).toBe("abc")
	})

	test("paste in resting mode is ignored (no destructive key firing)", () => {
		const r = handlePaste(base({ mode: "none" }), "q\nnad")
		expect(r.action.type).toBe("none")
		expect(r.state.mode).toBe("none")
	})
})
