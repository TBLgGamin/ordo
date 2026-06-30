/**
 * Minimal Win32 (user32.dll) bindings via bun:ffi.
 *
 * Why this exists: to get a truly fixed-size, never-moving center window with
 * satellite windows tiled around it, we position/resize top-level Windows
 * Terminal windows directly with SetWindowPos. wt.exe has no command to move or
 * resize an existing window, so we drop to the Win32 API.
 *
 * Handles (HWND) are bun:ffi `Pointer` values; we only ever round-trip them back
 * into other user32 calls, never dereference them ourselves.
 */

import { dlopen, FFIType, JSCallback, type Pointer, ptr } from "bun:ffi"

/** A native window handle (HWND). Opaque pointer-sized value. */
export type Hwnd = Pointer

const user32 = dlopen("user32.dll", {
	EnumWindows: { args: [FFIType.ptr, FFIType.i64], returns: FFIType.bool },
	GetWindowTextW: { args: [FFIType.ptr, FFIType.ptr, FFIType.i32], returns: FFIType.i32 },
	GetClassNameW: { args: [FFIType.ptr, FFIType.ptr, FFIType.i32], returns: FFIType.i32 },
	IsWindowVisible: { args: [FFIType.ptr], returns: FFIType.bool },
	GetWindowRect: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.bool },
	SetWindowPos: {
		args: [
			FFIType.ptr,
			FFIType.ptr,
			FFIType.i32,
			FFIType.i32,
			FFIType.i32,
			FFIType.i32,
			FFIType.u32,
		],
		returns: FFIType.bool,
	},
	GetForegroundWindow: { args: [], returns: FFIType.ptr },
	MonitorFromWindow: { args: [FFIType.ptr, FFIType.u32], returns: FFIType.ptr },
	GetMonitorInfoW: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.bool },
})

const dwmapi = dlopen("dwmapi.dll", {
	// DwmSetWindowAttribute(hwnd, attr, pvAttribute, cbAttribute)
	DwmSetWindowAttribute: {
		args: [FFIType.ptr, FFIType.u32, FFIType.ptr, FFIType.u32],
		returns: FFIType.i32,
	},
})

/** Windows Terminal's top-level window class. */
export const WT_WINDOW_CLASS = "CASCADIA_HOSTING_WINDOW_CLASS"

const SWP_NOZORDER = 0x0004
const SWP_NOACTIVATE = 0x0010
const MONITOR_DEFAULTTONEAREST = 0x0002

// DWM window-attribute constants (Windows 11 22000+).
const DWMWA_BORDER_COLOR = 34
const DWMWA_CAPTION_COLOR = 35
const DWMWA_TEXT_COLOR = 36
const DWMWA_COLOR_DEFAULT = 0xffffffff

function hexToColorref(hex: string): number {
	const h = hex.replace("#", "")
	const r = Number.parseInt(h.slice(0, 2), 16)
	const g = Number.parseInt(h.slice(2, 4), 16)
	const b = Number.parseInt(h.slice(4, 6), 16)
	return (r | (g << 8) | (b << 16)) >>> 0 // COLORREF = 0x00BBGGRR
}

function dwmColor(hwnd: Hwnd, attr: number, colorref: number): void {
	const buf = new Uint32Array([colorref >>> 0])
	dwmapi.symbols.DwmSetWindowAttribute(hwnd, attr, ptr(buf), 4)
}

/**
 * Highlight a window (Win11): color its border AND title bar with `hex` (and the
 * caption text dark for contrast). `null` resets all three to the default.
 */
export function setWindowHighlight(hwnd: Hwnd, hex: string | null): void {
	if (hex === null) {
		dwmColor(hwnd, DWMWA_BORDER_COLOR, DWMWA_COLOR_DEFAULT)
		dwmColor(hwnd, DWMWA_CAPTION_COLOR, DWMWA_COLOR_DEFAULT)
		dwmColor(hwnd, DWMWA_TEXT_COLOR, DWMWA_COLOR_DEFAULT)
		return
	}
	const cr = hexToColorref(hex)
	dwmColor(hwnd, DWMWA_BORDER_COLOR, cr)
	dwmColor(hwnd, DWMWA_CAPTION_COLOR, cr)
	dwmColor(hwnd, DWMWA_TEXT_COLOR, hexToColorref("#202020"))
}

/** A screen rectangle in pixels. */
export interface Rect {
	x: number
	y: number
	w: number
	h: number
}

export interface WindowInfo {
	hwnd: Hwnd
	title: string
	className: string
}

function readWideString(buf: Uint16Array, len: number): string {
	let out = ""
	for (let i = 0; i < len; i++) out += String.fromCharCode(buf[i] ?? 0)
	return out
}

function getWindowText(hwnd: Hwnd): string {
	const buf = new Uint16Array(512)
	const len = user32.symbols.GetWindowTextW(hwnd, ptr(buf), buf.length)
	return readWideString(buf, len)
}

function getClassName(hwnd: Hwnd): string {
	const buf = new Uint16Array(256)
	const len = user32.symbols.GetClassNameW(hwnd, ptr(buf), buf.length)
	return readWideString(buf, len)
}

/** Enumerate visible top-level windows with their title and class. */
export function listTopWindows(): WindowInfo[] {
	const out: WindowInfo[] = []
	const cb = new JSCallback(
		(hwnd: Hwnd) => {
			if (user32.symbols.IsWindowVisible(hwnd)) {
				out.push({ hwnd, title: getWindowText(hwnd), className: getClassName(hwnd) })
			}
			return 1 // keep enumerating
		},
		{ args: [FFIType.ptr, FFIType.i64], returns: FFIType.i32 },
	)
	user32.symbols.EnumWindows(cb.ptr, 0n)
	cb.close()
	return out
}

/** All visible Windows Terminal windows. */
export function listTerminalWindows(): WindowInfo[] {
	return listTopWindows().filter((w) => w.className === WT_WINDOW_CLASS)
}

/** The currently focused window's handle (0 if none). */
export function getForegroundWindow(): Hwnd {
	return (user32.symbols.GetForegroundWindow() ?? 0) as unknown as Hwnd
}

/** Find the first Windows Terminal window whose title contains `needle`. */
export function findTerminalWindowByTitle(needle: string): Hwnd | null {
	const match = listTerminalWindows().find((w) => w.title.includes(needle))
	return match ? match.hwnd : null
}

/** Find the Windows Terminal window whose title is exactly `title`. */
export function findTerminalWindowByExactTitle(title: string): Hwnd | null {
	const match = listTerminalWindows().find((w) => w.title === title)
	return match ? match.hwnd : null
}

export function getWindowRect(hwnd: Hwnd): Rect {
	const buf = new Int32Array(4) // left, top, right, bottom
	user32.symbols.GetWindowRect(hwnd, ptr(buf))
	const [left = 0, top = 0, right = 0, bottom = 0] = buf
	return { x: left, y: top, w: right - left, h: bottom - top }
}

/** Move + resize a window without changing z-order or stealing focus. */
export function setWindowRect(hwnd: Hwnd, rect: Rect): boolean {
	return user32.symbols.SetWindowPos(
		hwnd,
		null,
		Math.round(rect.x),
		Math.round(rect.y),
		Math.round(rect.w),
		Math.round(rect.h),
		SWP_NOZORDER | SWP_NOACTIVATE,
	)
}

/** Work area (screen minus taskbar) of the monitor containing `hwnd`. */
export function getWorkArea(hwnd: Hwnd): Rect {
	const monitor = user32.symbols.MonitorFromWindow(hwnd, MONITOR_DEFAULTTONEAREST)
	// MONITORINFO: cbSize(4) + rcMonitor(16) + rcWork(16) + dwFlags(4) = 40 bytes.
	const buf = new ArrayBuffer(40)
	const view = new DataView(buf)
	view.setUint32(0, 40, true) // cbSize
	user32.symbols.GetMonitorInfoW(monitor, ptr(new Uint8Array(buf)))
	const left = view.getInt32(20, true)
	const top = view.getInt32(24, true)
	const right = view.getInt32(28, true)
	const bottom = view.getInt32(32, true)
	return { x: left, y: top, w: right - left, h: bottom - top }
}
