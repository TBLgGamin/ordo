import type { Rect, WindowHandle, WindowInfo, WindowManager, WmCapabilities } from "../types"
import { runOsa } from "./osascript"

export interface DarwinAppConfig {
	/** AppleScript application name, e.g. "Terminal" or "iTerm". */
	appName: string
}

const MENU_BAR_INSET = 24

function parseNums(line: string): number[] {
	return line
		.split(",")
		.map((s) => Number(s.trim()))
		.filter((n) => Number.isFinite(n))
}

export function createDarwinWindowManager(cfg: DarwinAppConfig): WindowManager {
	const app = cfg.appName
	// group: false is deliberate — macOS's Cmd-Tab switches whole APPLICATIONS,
	// and activating the terminal app raises all of its windows together, so a
	// session already surfaces as one unit; there is no per-window entry to merge.
	const caps: WmCapabilities = { manage: true, focus: true, highlight: false, group: false }

	function listTerminalWindows(): WindowInfo[] {
		const script = `tell application "${app}"
	set out to ""
	repeat with w in windows
		try
			set out to out & (id of w) & "\t" & (name of w) & linefeed
		end try
	end repeat
	return out
end tell`
		const raw = runOsa(script)
		if (raw === null) return []
		const out: WindowInfo[] = []
		for (const line of raw.split("\n")) {
			if (line.trim() === "") continue
			const tab = line.indexOf("\t")
			if (tab < 0) continue
			const id = Number(line.slice(0, tab).trim())
			if (!Number.isFinite(id)) continue
			out.push({ handle: id, title: line.slice(tab + 1) })
		}
		return out
	}

	function getForegroundWindow(): WindowHandle | null {
		const raw = runOsa(`tell application "${app}" to return id of front window`)
		if (raw === null) return null
		const id = Number(raw.trim())
		return Number.isFinite(id) ? id : null
	}

	function setForegroundWindow(handle: WindowHandle): boolean {
		if (typeof handle !== "number") return false
		const raw = runOsa(
			`tell application "${app}"
	activate
	set index of (first window whose id is ${handle}) to 1
end tell`,
		)
		return raw !== null
	}

	function getWindowRect(handle: WindowHandle): Rect | null {
		if (typeof handle !== "number") return null
		const raw = runOsa(`tell application "${app}" to get bounds of (first window whose id is ${handle})`)
		if (raw === null) return null
		const n = parseNums(raw)
		if (n.length < 4) return null
		const [l = 0, t = 0, r = 0, b = 0] = n
		return { x: l, y: t, w: r - l, h: b - t }
	}

	function setWindowRect(handle: WindowHandle, rect: Rect): boolean {
		if (typeof handle !== "number") return false
		const l = Math.round(rect.x)
		const t = Math.round(rect.y)
		const r = Math.round(rect.x + rect.w)
		const b = Math.round(rect.y + rect.h)
		const raw = runOsa(
			`tell application "${app}" to set bounds of (first window whose id is ${handle}) to {${l}, ${t}, ${r}, ${b}}`,
		)
		return raw !== null
	}

	function moveWindow(handle: WindowHandle, x: number, y: number): boolean {
		const cur = getWindowRect(handle)
		if (!cur) return false
		return setWindowRect(handle, { x, y, w: cur.w, h: cur.h })
	}

	function moveWindows(items: Array<{ handle: WindowHandle; x: number; y: number }>): boolean {
		let ok = true
		for (const it of items) ok = moveWindow(it.handle, it.x, it.y) && ok
		return ok
	}

	function getWorkArea(): Rect | null {
		const raw = runOsa(`tell application "Finder" to get bounds of window of desktop`)
		if (raw === null) return null
		const n = parseNums(raw)
		if (n.length < 4) return null
		const [l = 0, t = 0, r = 0, b = 0] = n
		return { x: l, y: t + MENU_BAR_INSET, w: r - l, h: b - t - MENU_BAR_INSET }
	}

	return {
		caps,
		listTerminalWindows,
		getForegroundWindow,
		setForegroundWindow,
		getWindowRect,
		setWindowRect,
		setWindowRectAsync: setWindowRect,
		moveWindow,
		moveWindows,
		getWorkArea,
		setWindowHighlight() {},
		setWindowOwner: () => false,
		getWindowOwner: () => null,
	}
}
