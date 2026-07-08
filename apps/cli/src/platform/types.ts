export type WindowHandle = number | string

export interface Rect {
	x: number
	y: number
	w: number
	h: number
}

export interface WindowInfo {
	handle: WindowHandle
	title: string
}

export type Direction = "left" | "right" | "up" | "down"

export function isDirection(value: string): value is Direction {
	return value === "left" || value === "right" || value === "up" || value === "down"
}

export interface WmCapabilities {
	manage: boolean
	focus: boolean
	highlight: boolean
}

export interface WindowManager {
	readonly caps: WmCapabilities
	listTerminalWindows(): WindowInfo[]
	getForegroundWindow(): WindowHandle | null
	setForegroundWindow(handle: WindowHandle): boolean
	getWindowRect(handle: WindowHandle): Rect | null
	setWindowRect(handle: WindowHandle, rect: Rect): boolean
	setWindowRectAsync(handle: WindowHandle, rect: Rect): boolean
	moveWindow(handle: WindowHandle, x: number, y: number): boolean
	moveWindows(items: Array<{ handle: WindowHandle; x: number; y: number }>): boolean
	getWorkArea(handle: WindowHandle | null): Rect | null
	setWindowHighlight(handle: WindowHandle, hex: string | null): void
}

export interface SpawnWindowOptions {
	commandline: string[]
	cwd?: string
	title?: string
	tabColor?: string
	pos?: { x: number; y: number }
	size?: { cols: number; rows: number }
}

export interface TerminalBackend {
	readonly id: string
	readonly minWindowWidth: number
	spawnWindow(opts: SpawnWindowOptions): Promise<{ handle?: WindowHandle }>
	openSelfWindow(commandline: string[], cwd: string, title?: string): Promise<void>
}
