/**
 * A thick, colored "frame" drawn around the focused window — because the Win11
 * DWM border (setWindowHighlight) is only 1px and hard to see.
 *
 * The frame is four thin, solid, click-through (WS_EX_TRANSPARENT), topmost
 * tool windows — one per edge — that never steal focus or block the mouse. Each
 * bar is at most `thickness` px in one dimension, so the frame can never fill or
 * cover the window it surrounds: there is no shaped region to fall out of sync
 * and no interior to paint.
 *
 * All FFI is guarded: if class registration or window creation fails, the frame
 * silently disables itself and the caller falls back to the 1px DWM border.
 */

import { dlopen, FFIType, ptr } from "bun:ffi"
import { type Hwnd, hexToColorref, type Rect } from "./win32"

const user32 = dlopen("user32.dll", {
	RegisterClassExW: { args: [FFIType.ptr], returns: FFIType.u16 },
	CreateWindowExW: {
		args: [
			FFIType.u32,
			FFIType.ptr,
			FFIType.ptr,
			FFIType.u32,
			FFIType.i32,
			FFIType.i32,
			FFIType.i32,
			FFIType.i32,
			FFIType.ptr,
			FFIType.ptr,
			FFIType.ptr,
			FFIType.ptr,
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
	DestroyWindow: { args: [FFIType.ptr], returns: FFIType.bool },
})

const kernel32 = dlopen("kernel32.dll", {
	GetModuleHandleW: { args: [FFIType.ptr], returns: FFIType.ptr },
	GetProcAddress: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.ptr },
})

const gdi32 = dlopen("gdi32.dll", {
	CreateSolidBrush: { args: [FFIType.u32], returns: FFIType.ptr },
	DeleteObject: { args: [FFIType.ptr], returns: FFIType.bool },
})

const WS_POPUP = 0x80000000
const WS_EX_TRANSPARENT = 0x00000020
const WS_EX_TOPMOST = 0x00000008
const WS_EX_TOOLWINDOW = 0x00000080
const WS_EX_NOACTIVATE = 0x08000000
const SW_HIDE = 0
const SW_SHOWNOACTIVATE = 8
const SWP_NOACTIVATE = 0x0010
const HWND_TOPMOST = -1
const EDGES = 4

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

// Kept alive for the process lifetime (referenced by the registered class).
const CLASS_NAME = wide("cc_overlay_frame")

// The window class (and its background brush) are registered exactly once per
// process. Re-registering the same class name fails, so a re-created OverlayFrame
// must reuse the existing registration rather than register again.
let overlayClassReady = false
let overlayClassFailed = false

function ensureOverlayClass(hex: string): boolean {
	if (overlayClassReady) return true
	if (overlayClassFailed) return false
	try {
		const hUser = kernel32.symbols.GetModuleHandleW(ptr(wide("user32.dll")))
		const defWndProc = kernel32.symbols.GetProcAddress(hUser, ptr(ascii("DefWindowProcW")))
		const brush = gdi32.symbols.CreateSolidBrush(hexToColorref(hex))
		const cls = new ArrayBuffer(80)
		const dv = new DataView(cls)
		dv.setUint32(0, 80, true) // cbSize
		dv.setBigUint64(8, BigInt(defWndProc as unknown as number), true) // lpfnWndProc
		dv.setBigUint64(48, BigInt(brush as unknown as number), true) // hbrBackground
		dv.setBigUint64(64, BigInt(ptr(CLASS_NAME) as unknown as number), true) // lpszClassName
		const atom = user32.symbols.RegisterClassExW(ptr(new Uint8Array(cls)))
		if (atom === 0) {
			if (brush) gdi32.symbols.DeleteObject(brush)
			overlayClassFailed = true
			return false
		}
		overlayClassReady = true
		return true
	} catch {
		overlayClassFailed = true
		return false
	}
}

type Seg = { x: number; y: number; w: number; h: number }

export class OverlayFrame {
	private bars: Hwnd[] = []
	private ready = false
	private visible = false
	private lastRect?: Rect

	constructor(
		private readonly hex: string,
		private thickness = 3,
	) {
		this.init()
	}

	private init(): boolean {
		if (!ensureOverlayClass(this.hex)) return false
		const exStyle = (WS_EX_TRANSPARENT | WS_EX_TOPMOST | WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE) >>> 0
		const bars: Hwnd[] = []
		try {
			for (let i = 0; i < EDGES; i++) {
				const hwnd = user32.symbols.CreateWindowExW(
					exStyle,
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
				bars.push(hwnd as Hwnd)
			}
			this.bars = bars
			this.ready = true
			return true
		} catch {
			for (const b of bars) {
				try {
					user32.symbols.DestroyWindow(b)
				} catch {}
			}
			this.bars = []
			this.ready = false
			return false
		}
	}

	private segments(rect: Rect): Seg[] {
		const t = this.thickness
		const w = Math.max(0, rect.w)
		const h = Math.max(0, rect.h)
		return [
			{ x: rect.x - t, y: rect.y - t, w: w + 2 * t, h: t },
			{ x: rect.x - t, y: rect.y + h, w: w + 2 * t, h: t },
			{ x: rect.x - t, y: rect.y, w: t, h },
			{ x: rect.x + w, y: rect.y, w: t, h },
		]
	}

	/** Frame the given rect with the thick border. */
	show(rect: Rect): void {
		if (!this.ready) {
			if (overlayClassFailed || !this.init()) return
		}
		if (this.bars.length < EDGES) return
		const prev = this.lastRect
		if (
			this.visible &&
			prev &&
			prev.x === rect.x &&
			prev.y === rect.y &&
			prev.w === rect.w &&
			prev.h === rect.h
		) {
			return
		}
		this.lastRect = { ...rect }
		const segs = this.segments(rect)
		for (let i = 0; i < EDGES; i++) {
			const s = segs[i]
			const bar = this.bars[i]
			if (!s || !bar) continue
			user32.symbols.SetWindowPos(bar, BigInt(HWND_TOPMOST), s.x, s.y, s.w, s.h, SWP_NOACTIVATE)
		}
		if (!this.visible) {
			for (const bar of this.bars) user32.symbols.ShowWindow(bar, SW_SHOWNOACTIVATE)
			this.visible = true
		}
	}

	hide(): void {
		if (!this.ready || !this.visible) return
		for (const bar of this.bars) user32.symbols.ShowWindow(bar, SW_HIDE)
		this.visible = false
		this.lastRect = undefined
	}

	destroy(): void {
		for (const bar of this.bars) {
			try {
				user32.symbols.DestroyWindow(bar)
			} catch {}
		}
		this.bars = []
		this.ready = false
		this.visible = false
		this.lastRect = undefined
	}
}
