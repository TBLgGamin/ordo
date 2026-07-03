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
import { OrdoError } from "../core/errors"

/** A native window handle (HWND). Opaque pointer-sized value. */
export type Hwnd = Pointer

function loadUser32() {
	try {
		return dlopen("user32.dll", {
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
			SetForegroundWindow: { args: [FFIType.ptr], returns: FFIType.bool },
			MonitorFromWindow: { args: [FFIType.ptr, FFIType.u32], returns: FFIType.ptr },
			GetMonitorInfoW: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.bool },
			BeginDeferWindowPos: { args: [FFIType.i32], returns: FFIType.ptr },
			DeferWindowPos: {
				args: [
					FFIType.ptr,
					FFIType.ptr,
					FFIType.ptr,
					FFIType.i32,
					FFIType.i32,
					FFIType.i32,
					FFIType.i32,
					FFIType.u32,
				],
				returns: FFIType.ptr,
			},
			EndDeferWindowPos: { args: [FFIType.ptr], returns: FFIType.bool },
		})
	} catch {
		return null
	}
}

function loadDwmapi() {
	try {
		return dlopen("dwmapi.dll", {
			DwmSetWindowAttribute: {
				args: [FFIType.ptr, FFIType.u32, FFIType.ptr, FFIType.u32],
				returns: FFIType.i32,
			},
		})
	} catch {
		return null
	}
}

const user32lib = loadUser32()
const dwmapiLib = loadDwmapi()

function user32() {
	if (!user32lib) {
		throw new OrdoError("window management unavailable: could not load user32.dll")
	}
	return user32lib.symbols
}

/** Windows Terminal's top-level window class. */
export const WT_WINDOW_CLASS = "CASCADIA_HOSTING_WINDOW_CLASS"

const SWP_NOSIZE = 0x0001
const SWP_NOZORDER = 0x0004
const SWP_NOACTIVATE = 0x0010
const SWP_ASYNCWINDOWPOS = 0x4000
const MONITOR_DEFAULTTONEAREST = 0x0002

// DWM window-attribute constants (Windows 11 22000+).
const DWMWA_BORDER_COLOR = 34
const DWMWA_CAPTION_COLOR = 35
const DWMWA_TEXT_COLOR = 36
const DWMWA_COLOR_DEFAULT = 0xffffffff

export function hexToColorref(hex: string): number {
	const h = hex.replace("#", "")
	const r = Number.parseInt(h.slice(0, 2), 16) || 0
	const g = Number.parseInt(h.slice(2, 4), 16) || 0
	const b = Number.parseInt(h.slice(4, 6), 16) || 0
	return (r | (g << 8) | (b << 16)) >>> 0 // COLORREF = 0x00BBGGRR
}

function dwmColor(hwnd: Hwnd, attr: number, colorref: number): void {
	if (!dwmapiLib) return
	const buf = new Uint32Array([colorref >>> 0])
	dwmapiLib.symbols.DwmSetWindowAttribute(hwnd, attr, ptr(buf), 4)
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

// Reused across every enumeration: EnumWindows is synchronous and the runtime is
// single-threaded, so these scratch buffers never see reentrant use.
const textScratch = new Uint16Array(512)
const classScratch = new Uint16Array(256)
const textScratchBytes = new Uint8Array(textScratch.buffer)
const classScratchBytes = new Uint8Array(classScratch.buffer)
const wideDecoder = new TextDecoder("utf-16")

function getWindowText(hwnd: Hwnd): string {
	const len = user32().GetWindowTextW(hwnd, ptr(textScratch), textScratch.length)
	return len > 0 ? wideDecoder.decode(textScratchBytes.subarray(0, len * 2)) : ""
}

function getClassName(hwnd: Hwnd): string {
	const len = user32().GetClassNameW(hwnd, ptr(classScratch), classScratch.length)
	return len > 0 ? wideDecoder.decode(classScratchBytes.subarray(0, len * 2)) : ""
}

// One persistent JSCallback reused across every enumeration. EnumWindows is
// synchronous and the runtime single-threaded, so there is no reentrancy: each
// call resets the sink, runs the enum, and returns the freshly filled array.
let enumSink: WindowInfo[] = []
let enumCallback: JSCallback | undefined

function enumWindowsCallback(): JSCallback {
	if (!enumCallback) {
		enumCallback = new JSCallback(
			(hwnd: Hwnd) => {
				if (user32().IsWindowVisible(hwnd)) {
					enumSink.push({ hwnd, title: getWindowText(hwnd), className: getClassName(hwnd) })
				}
				return 1
			},
			{ args: [FFIType.ptr, FFIType.i64], returns: FFIType.i32 },
		)
	}
	return enumCallback
}

/** Enumerate visible top-level windows with their title and class. */
export function listTopWindows(): WindowInfo[] {
	enumSink = []
	user32().EnumWindows(enumWindowsCallback().ptr, 0n)
	return enumSink
}

/** All visible Windows Terminal windows. */
export function listTerminalWindows(): WindowInfo[] {
	return listTopWindows().filter((w) => w.className === WT_WINDOW_CLASS)
}

/** The currently focused window's handle (0 if none). */
export function getForegroundWindow(): Hwnd {
	return (user32().GetForegroundWindow() ?? 0) as unknown as Hwnd
}

/** Bring a window to the foreground (best-effort — Windows may restrict it). */
export function setForegroundWindow(hwnd: Hwnd): boolean {
	if (!hwnd) return false
	return user32().SetForegroundWindow(hwnd)
}

const rectScratch = new Int32Array(4) // left, top, right, bottom

export function getWindowRect(hwnd: Hwnd): Rect | null {
	if (!user32().GetWindowRect(hwnd, ptr(rectScratch))) return null
	const [left = 0, top = 0, right = 0, bottom = 0] = rectScratch
	return { x: left, y: top, w: right - left, h: bottom - top }
}

/** Move + resize a window without changing z-order or stealing focus. */
export function setWindowRect(hwnd: Hwnd, rect: Rect): boolean {
	return user32().SetWindowPos(
		hwnd,
		null,
		Math.round(rect.x),
		Math.round(rect.y),
		Math.round(rect.w),
		Math.round(rect.h),
		SWP_NOZORDER | SWP_NOACTIVATE,
	)
}

export function setWindowRectAsync(hwnd: Hwnd, rect: Rect): boolean {
	return user32().SetWindowPos(
		hwnd,
		null,
		Math.round(rect.x),
		Math.round(rect.y),
		Math.round(rect.w),
		Math.round(rect.h),
		SWP_NOZORDER | SWP_NOACTIVATE | SWP_ASYNCWINDOWPOS,
	)
}

export function moveWindow(hwnd: Hwnd, x: number, y: number): boolean {
	return user32().SetWindowPos(
		hwnd,
		null,
		Math.round(x),
		Math.round(y),
		0,
		0,
		SWP_NOZORDER | SWP_NOACTIVATE | SWP_NOSIZE | SWP_ASYNCWINDOWPOS,
	)
}

export function moveWindows(items: Array<{ hwnd: Hwnd; x: number; y: number }>): boolean {
	if (items.length === 0) return true
	let hdwp = user32().BeginDeferWindowPos(items.length)
	if (!hdwp) return moveEach(items)
	for (const it of items) {
		hdwp = user32().DeferWindowPos(
			hdwp,
			it.hwnd,
			null,
			Math.round(it.x),
			Math.round(it.y),
			0,
			0,
			SWP_NOZORDER | SWP_NOACTIVATE | SWP_NOSIZE,
		)
		if (!hdwp) return moveEach(items)
	}
	return user32().EndDeferWindowPos(hdwp)
}

function moveEach(items: Array<{ hwnd: Hwnd; x: number; y: number }>): boolean {
	let ok = true
	for (const it of items) ok = moveWindow(it.hwnd, it.x, it.y) && ok
	return ok
}

// MONITORINFO: cbSize(4) + rcMonitor(16) + rcWork(16) + dwFlags(4) = 40 bytes.
const monitorInfoBytes = new Uint8Array(40)
const monitorInfoView = new DataView(monitorInfoBytes.buffer)
monitorInfoView.setUint32(0, 40, true)

/** Work area (screen minus taskbar) of the monitor containing `hwnd`. */
export function getWorkArea(hwnd: Hwnd): Rect | null {
	const monitor = user32().MonitorFromWindow(hwnd, MONITOR_DEFAULTTONEAREST)
	if (!monitor) return null
	if (!user32().GetMonitorInfoW(monitor, ptr(monitorInfoBytes))) return null
	const left = monitorInfoView.getInt32(20, true)
	const top = monitorInfoView.getInt32(24, true)
	const right = monitorInfoView.getInt32(28, true)
	const bottom = monitorInfoView.getInt32(32, true)
	return { x: left, y: top, w: right - left, h: bottom - top }
}
