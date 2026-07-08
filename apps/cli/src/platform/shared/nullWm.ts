import type { Rect, WindowHandle, WindowInfo, WindowManager, WmCapabilities } from "../types"

const CAPS: WmCapabilities = { manage: false, focus: false, highlight: false, group: false }

export const nullWindowManager: WindowManager = {
	caps: CAPS,
	listTerminalWindows(): WindowInfo[] {
		return []
	},
	getForegroundWindow(): WindowHandle | null {
		return null
	},
	setForegroundWindow(): boolean {
		return false
	},
	getWindowRect(): Rect | null {
		return null
	},
	setWindowRect(): boolean {
		return false
	},
	setWindowRectAsync(): boolean {
		return false
	},
	moveWindow(): boolean {
		return false
	},
	moveWindows(): boolean {
		return false
	},
	getWorkArea(): Rect | null {
		return null
	},
	setWindowHighlight(): void {},
	setWindowOwner(): boolean {
		return false
	},
	getWindowOwner(): WindowHandle | null {
		return null
	},
}
