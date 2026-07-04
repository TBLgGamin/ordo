export type InputMode = "none" | "open" | "delete" | "rename" | "confirmDelete"

export interface InputState {
	mode: InputMode
	buffer: string
	pendingDelete: string
	hasSession: boolean
}

export interface KeyLike {
	ctrl?: boolean
	shift?: boolean
	name?: string
	sequence?: string
}

export type InputAction =
	| { type: "none" }
	| { type: "redraw" }
	| { type: "status"; message: string }
	| { type: "scroll"; by: number }
	| { type: "shutdown" }
	| { type: "focusNext" }
	| { type: "focusPrev" }
	| { type: "new" }
	| { type: "add" }
	| { type: "close" }
	| { type: "open"; id: string }
	| { type: "delete"; id: string }
	| { type: "rename"; title: string }

export interface InputResult {
	state: InputState
	action: InputAction
}

function keep(state: InputState, action: InputAction): InputResult {
	return { state, action }
}

function reset(state: InputState, action: InputAction): InputResult {
	return { state: { ...state, mode: "none", buffer: "" }, action }
}

function isPrintable(seq: string | undefined): seq is string {
	return seq !== undefined && seq.length === 1 && seq >= " " && seq !== "\x7f"
}

function sanitize(text: string): string {
	let out = ""
	for (const ch of text) {
		const code = ch.charCodeAt(0)
		if (code >= 0x20 && code !== 0x7f) out += ch
	}
	return out
}

export function handleKey(state: InputState, key: KeyLike): InputResult {
	if (key.ctrl && key.name === "c") return keep(state, { type: "shutdown" })
	if (key.name === "up") return keep(state, { type: "scroll", by: -2 })
	if (key.name === "down") return keep(state, { type: "scroll", by: 2 })
	if (key.name === "pageup") return keep(state, { type: "scroll", by: -10 })
	if (key.name === "pagedown") return keep(state, { type: "scroll", by: 10 })

	if (state.mode === "confirmDelete") {
		if (key.name === "escape" || key.sequence === "n") return reset(state, { type: "redraw" })
		if (key.sequence === "y" || key.name === "return" || key.name === "enter") {
			return reset(state, { type: "delete", id: state.pendingDelete })
		}
		return keep(state, { type: "none" })
	}

	if (state.mode === "open" || state.mode === "delete" || state.mode === "rename") {
		if (key.name === "escape") return reset(state, { type: "redraw" })
		if (key.name === "return" || key.name === "enter") {
			if (state.mode === "rename") return reset(state, { type: "rename", title: state.buffer })
			if (state.mode === "delete") {
				const id = state.buffer.trim()
				if (!id) return reset(state, { type: "redraw" })
				return {
					state: { ...state, mode: "confirmDelete", buffer: "", pendingDelete: id },
					action: { type: "redraw" },
				}
			}
			return reset(state, { type: "open", id: state.buffer })
		}
		if (key.name === "backspace") {
			return keep({ ...state, buffer: state.buffer.slice(0, -1) }, { type: "redraw" })
		}
		if (isPrintable(key.sequence)) {
			return keep({ ...state, buffer: state.buffer + key.sequence }, { type: "redraw" })
		}
		return keep(state, { type: "none" })
	}

	if (key.name === "tab") return keep(state, { type: key.shift ? "focusPrev" : "focusNext" })
	if (key.sequence === "q") return keep(state, { type: "shutdown" })
	if (key.sequence === "n") return keep(state, { type: "new" })
	if (key.sequence === "a") return keep(state, { type: "add" })
	if (key.sequence === "s") return keep({ ...state, mode: "open", buffer: "" }, { type: "redraw" })
	if (key.sequence === "c") return keep(state, { type: "close" })
	if (key.sequence === "r") {
		if (!state.hasSession) return keep(state, { type: "status", message: "· no session to rename" })
		return keep({ ...state, mode: "rename", buffer: "" }, { type: "redraw" })
	}
	if (key.sequence === "d")
		return keep({ ...state, mode: "delete", buffer: "" }, { type: "redraw" })
	return keep(state, { type: "none" })
}

export function handlePaste(state: InputState, text: string): InputResult {
	if (state.mode === "open" || state.mode === "delete" || state.mode === "rename") {
		const clean = sanitize(text)
		if (!clean) return keep(state, { type: "none" })
		return keep({ ...state, buffer: state.buffer + clean }, { type: "redraw" })
	}
	return keep(state, { type: "none" })
}
