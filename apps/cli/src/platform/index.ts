import { nullWindowManager } from "./shared/nullWm"
import { unsupportedTerminal } from "./shared/unsupported"
import type {
	Rect,
	SpawnWindowOptions,
	TerminalBackend,
	WindowHandle,
	WindowInfo,
	WindowManager,
} from "./types"
import { win32WindowManager } from "./win32/windows"
import { wtTerminal } from "./win32/wt"

export type {
	Direction,
	Rect,
	SpawnWindowOptions,
	TerminalBackend,
	WindowHandle,
	WindowInfo,
	WindowManager,
	WmCapabilities,
} from "./types"
export { isDirection } from "./types"

function selectBackends(): { wm: WindowManager; term: TerminalBackend } {
	if (process.platform === "win32") {
		return { wm: win32WindowManager, term: wtTerminal }
	}
	if (process.platform === "darwin") {
		const { selectDarwinBackends } = require("./darwin") as typeof import("./darwin")
		return selectDarwinBackends()
	}
	if (process.platform === "linux") {
		const { selectLinuxBackends } = require("./linux") as typeof import("./linux")
		return selectLinuxBackends()
	}
	return { wm: nullWindowManager, term: unsupportedTerminal }
}

let selected: { wm: WindowManager; term: TerminalBackend } | undefined

function backends(): { wm: WindowManager; term: TerminalBackend } {
	if (!selected) selected = selectBackends()
	return selected
}

export function wmCaps() {
	return backends().wm.caps
}

export function activeTerminal(): TerminalBackend {
	return backends().term
}

export function listTerminalWindows(): WindowInfo[] {
	return backends().wm.listTerminalWindows()
}

export function getForegroundWindow(): WindowHandle | null {
	return backends().wm.getForegroundWindow()
}

export function setForegroundWindow(handle: WindowHandle): boolean {
	return backends().wm.setForegroundWindow(handle)
}

export function getWindowRect(handle: WindowHandle): Rect | null {
	return backends().wm.getWindowRect(handle)
}

export function setWindowRect(handle: WindowHandle, rect: Rect): boolean {
	return backends().wm.setWindowRect(handle, rect)
}

export function setWindowRectAsync(handle: WindowHandle, rect: Rect): boolean {
	return backends().wm.setWindowRectAsync(handle, rect)
}

export function moveWindow(handle: WindowHandle, x: number, y: number): boolean {
	return backends().wm.moveWindow(handle, x, y)
}

export function moveWindows(
	items: Array<{ handle: WindowHandle; x: number; y: number }>,
): boolean {
	return backends().wm.moveWindows(items)
}

export function getWorkArea(handle: WindowHandle | null): Rect | null {
	return backends().wm.getWorkArea(handle)
}

export function setWindowHighlight(handle: WindowHandle, hex: string | null): void {
	backends().wm.setWindowHighlight(handle, hex)
}

export function setWindowOwner(handle: WindowHandle, owner: WindowHandle | null): boolean {
	return backends().wm.setWindowOwner(handle, owner)
}

export function getWindowOwner(handle: WindowHandle): WindowHandle | null {
	return backends().wm.getWindowOwner(handle)
}

export function spawnWindow(opts: SpawnWindowOptions): Promise<{ handle?: WindowHandle }> {
	return backends().term.spawnWindow(opts)
}

export function openSelfWindow(commandline: string[], cwd: string, title?: string): Promise<void> {
	return backends().term.openSelfWindow(commandline, cwd, title)
}
