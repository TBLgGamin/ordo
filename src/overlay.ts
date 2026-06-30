/**
 * A thick, colored "frame" drawn around the focused window — because the Win11
 * DWM border (setWindowHighlight) is only 1px and hard to see.
 *
 * It's built from four thin top-level windows (top/bottom/left/right) that are
 * layered + topmost + click-through (WS_EX_TRANSPARENT) so they never steal
 * focus or block the mouse. They're positioned just outside the target window to
 * frame it, and hidden when no managed window is focused.
 *
 * All FFI is guarded: if class registration or window creation fails, the frame
 * silently disables itself and the caller falls back to the 1px DWM border.
 */

import { dlopen, FFIType, ptr } from "bun:ffi"
import type { Hwnd, Rect } from "./win32"

const user32 = dlopen("user32.dll", {
	RegisterClassExW: { args: [FFIType.ptr], returns: FFIType.u16 },
	CreateWindowExW: {
		args: [
			FFIType.u32, // dwExStyle
			FFIType.ptr, // lpClassName
			FFIType.ptr, // lpWindowName
			FFIType.u32, // dwStyle
			FFIType.i32, // x
			FFIType.i32, // y
			FFIType.i32, // w
			FFIType.i32, // h
			FFIType.ptr, // hWndParent
			FFIType.ptr, // hMenu
			FFIType.ptr, // hInstance
			FFIType.ptr, // lpParam
		],
		returns: FFIType.ptr,
	},
	ShowWindow: { args: [FFIType.ptr, FFIType.i32], returns: FFIType.bool },
	SetWindowPos: {
		args: [
			FFIType.ptr,
			FFIType.i64,
			FFIType.i32,
			FFIType.i32,
			FFIType.i32,
			FFIType.i32,
			FFIType.u32,
		],
		returns: FFIType.bool,
	},
	SetLayeredWindowAttributes: {
		args: [FFIType.ptr, FFIType.u32, FFIType.u8, FFIType.u32],
		returns: FFIType.bool,
	},
	DestroyWindow: { args: [FFIType.ptr], returns: FFIType.bool },
})

const kernel32 = dlopen("kernel32.dll", {
	GetModuleHandleW: { args: [FFIType.ptr], returns: FFIType.ptr },
	GetProcAddress: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.ptr },
})

const gdi32 = dlopen("gdi32.dll", {
	CreateSolidBrush: { args: [FFIType.u32], returns: FFIType.ptr },
})

const WS_POPUP = 0x80000000
const WS_EX_LAYERED = 0x00080000
const WS_EX_TRANSPARENT = 0x00000020
const WS_EX_TOPMOST = 0x00000008
const WS_EX_TOOLWINDOW = 0x00000080
const WS_EX_NOACTIVATE = 0x08000000
const SW_HIDE = 0
const SW_SHOWNOACTIVATE = 8
const LWA_ALPHA = 0x2
const SWP_NOACTIVATE = 0x0010
const HWND_TOPMOST = -1

function wide(s: string): Uint16Array {
	const buf = new Uint16Array(s.length + 1)
	for (let i = 0; i < s.length; i++) buf[i] = s.charCodeAt(i)
	return buf
}
function ascii(s: string): Uint8Array {
	const buf = new Uint8Array(s.length + 1)
	for (let i = 0; i < s.length; i++) buf[i] = s.charCodeAt(i)
	return buf
}
function colorref(hex: string): number {
	const h = hex.replace("#", "")
	const r = Number.parseInt(h.slice(0, 2), 16)
	const g = Number.parseInt(h.slice(2, 4), 16)
	const b = Number.parseInt(h.slice(4, 6), 16)
	return (r | (g << 8) | (b << 16)) >>> 0
}

// Kept alive for the process lifetime (referenced by the registered class).
const CLASS_NAME = wide("cc_overlay_frame")

export class OverlayFrame {
	private bars: Hwnd[] = []
	private ready = false
	private visible = false

	constructor(
		hex: string,
		private thickness = 3,
	) {
		try {
			this.init(hex)
			this.ready = this.bars.length === 4
		} catch {
			this.ready = false
		}
	}

	private init(hex: string): void {
		// lpfnWndProc = native DefWindowProcW (no JS callback / message pump needed).
		const hUser = kernel32.symbols.GetModuleHandleW(ptr(wide("user32.dll")))
		const defWndProc = kernel32.symbols.GetProcAddress(hUser, ptr(ascii("DefWindowProcW")))
		const brush = gdi32.symbols.CreateSolidBrush(colorref(hex))

		// WNDCLASSEXW (x64, 80 bytes).
		const cls = new ArrayBuffer(80)
		const dv = new DataView(cls)
		dv.setUint32(0, 80, true) // cbSize
		dv.setBigUint64(8, BigInt(defWndProc as unknown as number), true) // lpfnWndProc
		dv.setBigUint64(48, BigInt(brush as unknown as number), true) // hbrBackground
		dv.setBigUint64(64, BigInt(ptr(CLASS_NAME) as unknown as number), true) // lpszClassName
		const atom = user32.symbols.RegisterClassExW(ptr(new Uint8Array(cls)))
		if (atom === 0) throw new Error("RegisterClassExW failed")

		const exStyle =
			WS_EX_LAYERED | WS_EX_TRANSPARENT | WS_EX_TOPMOST | WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE
		for (let i = 0; i < 4; i++) {
			const hwnd = user32.symbols.CreateWindowExW(
				exStyle >>> 0,
				ptr(CLASS_NAME),
				null,
				WS_POPUP >>> 0,
				0,
				0,
				0,
				0,
				null,
				null,
				null,
				null,
			)
			if (!hwnd) throw new Error("CreateWindowExW failed")
			user32.symbols.SetLayeredWindowAttributes(hwnd, 0, 255, LWA_ALPHA)
			this.bars.push(hwnd as Hwnd)
		}
	}

	/** Frame the given rect with the thick border. */
	show(rect: Rect): void {
		if (!this.ready) return
		const t = this.thickness
		const { x, y, w, h } = rect
		const rects: Rect[] = [
			{ x: x - t, y: y - t, w: w + 2 * t, h: t }, // top
			{ x: x - t, y: y + h, w: w + 2 * t, h: t }, // bottom
			{ x: x - t, y, w: t, h }, // left
			{ x: x + w, y, w: t, h }, // right
		]
		this.bars.forEach((bar, i) => {
			const r = rects[i]
			if (!r) return
			if (!this.visible) user32.symbols.ShowWindow(bar, SW_SHOWNOACTIVATE)
			// Keep the frame pinned topmost so it sits above the focused window.
			user32.symbols.SetWindowPos(bar, BigInt(HWND_TOPMOST), r.x, r.y, r.w, r.h, SWP_NOACTIVATE)
		})
		this.visible = true
	}

	hide(): void {
		if (!this.ready || !this.visible) return
		for (const bar of this.bars) user32.symbols.ShowWindow(bar, SW_HIDE)
		this.visible = false
	}

	destroy(): void {
		for (const bar of this.bars) user32.symbols.DestroyWindow(bar)
		this.bars = []
		this.ready = false
	}
}
