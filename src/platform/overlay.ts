/**
 * A thick, colored "frame" drawn around the focused window — because the Win11
 * DWM border (setWindowHighlight) is only 1px and hard to see.
 *
 * It's a single top-level, topmost, click-through (WS_EX_TRANSPARENT) window
 * that never steals focus or blocks the mouse. Its window region is a
 * rounded-rectangle *ring* (an outer rounded rect minus an inner rounded rect)
 * whose inner corner radius matches Windows 11's rounded window corners — so the
 * frame hugs the terminal's actual shape instead of boxing it in a hard
 * rectangle. The class background brush paints that ring purple.
 *
 * NOTE: the window is deliberately NOT layered — a layered window (via
 * SetLayeredWindowAttributes) is shaped by its alpha and ignores SetWindowRgn,
 * which would paint the whole rectangle instead of the ring. The ring region is
 * the only part of the window that exists, so its hollow interior is inherently
 * click-through even before WS_EX_TRANSPARENT.
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
	SetWindowRgn: { args: [FFIType.ptr, FFIType.ptr, FFIType.bool], returns: FFIType.i32 },
	DestroyWindow: { args: [FFIType.ptr], returns: FFIType.bool },
})

const kernel32 = dlopen("kernel32.dll", {
	GetModuleHandleW: { args: [FFIType.ptr], returns: FFIType.ptr },
	GetProcAddress: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.ptr },
})

const gdi32 = dlopen("gdi32.dll", {
	CreateSolidBrush: { args: [FFIType.u32], returns: FFIType.ptr },
	CreateRoundRectRgn: {
		args: [FFIType.i32, FFIType.i32, FFIType.i32, FFIType.i32, FFIType.i32, FFIType.i32],
		returns: FFIType.ptr,
	},
	CombineRgn: { args: [FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.i32], returns: FFIType.i32 },
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
const RGN_DIFF = 4
/** Win11's default top-level window corner radius (device pixels at 100% DPI). */
const CORNER_RADIUS = 8

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

export class OverlayFrame {
	private bar: Hwnd | null = null
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
		try {
			const exStyle = WS_EX_TRANSPARENT | WS_EX_TOPMOST | WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE
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
			this.bar = hwnd as Hwnd
			this.ready = true
			return true
		} catch {
			this.bar = null
			this.ready = false
			return false
		}
	}

	/**
	 * Shape the overlay window (size fw×fh) into a rounded-rectangle ring of the
	 * current thickness — outer rounded rect minus the inner rounded rect that
	 * traces the framed window's own rounded corners.
	 */
	private applyRegion(bar: Hwnd, fw: number, fh: number): boolean {
		const t = this.thickness
		const outer = gdi32.symbols.CreateRoundRectRgn(
			0,
			0,
			fw + 1,
			fh + 1,
			(CORNER_RADIUS + t) * 2,
			(CORNER_RADIUS + t) * 2,
		)
		const inner = gdi32.symbols.CreateRoundRectRgn(
			t,
			t,
			fw - t + 1,
			fh - t + 1,
			CORNER_RADIUS * 2,
			CORNER_RADIUS * 2,
		)
		if (!outer || !inner) {
			if (outer) gdi32.symbols.DeleteObject(outer)
			if (inner) gdi32.symbols.DeleteObject(inner)
			return false
		}
		gdi32.symbols.CombineRgn(outer, outer, inner, RGN_DIFF)
		// SetWindowRgn takes ownership of `outer` only on success; free the temporary
		// `inner` always, and `outer` too if the system didn't take it.
		const setOk = user32.symbols.SetWindowRgn(bar, outer, true)
		gdi32.symbols.DeleteObject(inner)
		if (!setOk) {
			gdi32.symbols.DeleteObject(outer)
			return false
		}
		return true
	}

	/** Frame the given rect with the thick, rounded border. */
	show(rect: Rect): void {
		if (!this.ready) {
			if (overlayClassFailed || !this.init()) return
		}
		const bar = this.bar
		if (!bar) return
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
		const t = this.thickness
		const fx = rect.x - t
		const fy = rect.y - t
		const fw = rect.w + 2 * t
		const fh = rect.h + 2 * t
		// The ring shape is window-local, so only rebuild it when the size changes.
		// If the region can't be built, hide rather than flash a full purple rectangle.
		if (!prev || prev.w !== rect.w || prev.h !== rect.h) {
			if (!this.applyRegion(bar, fw, fh)) {
				this.hide()
				return
			}
		}
		if (!this.visible) user32.symbols.ShowWindow(bar, SW_SHOWNOACTIVATE)
		// Keep the frame pinned topmost so it sits above the focused window.
		user32.symbols.SetWindowPos(bar, BigInt(HWND_TOPMOST), fx, fy, fw, fh, SWP_NOACTIVATE)
		this.visible = true
	}

	hide(): void {
		if (!this.ready || !this.visible || !this.bar) return
		user32.symbols.ShowWindow(this.bar, SW_HIDE)
		this.visible = false
		this.lastRect = undefined
	}

	destroy(): void {
		if (this.bar) {
			try {
				user32.symbols.DestroyWindow(this.bar)
			} catch {}
		}
		this.bar = null
		this.ready = false
		this.visible = false
		this.lastRect = undefined
	}
}
