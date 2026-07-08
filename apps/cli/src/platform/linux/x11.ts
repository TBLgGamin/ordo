import { dlopen, FFIType, type Pointer, ptr, toArrayBuffer } from "bun:ffi"
import type { Rect, WindowHandle, WindowInfo, WindowManager, WmCapabilities } from "../types"

const XA_WM_NAME = 39n
const SubstructureRedirectMask = 1 << 20
const SubstructureNotifyMask = 1 << 19
const ClientMessage = 33

function loadXlib() {
	for (const name of ["libX11.so.6", "libX11.so"]) {
		try {
			return dlopen(name, {
				XOpenDisplay: { args: [FFIType.ptr], returns: FFIType.ptr },
				XCloseDisplay: { args: [FFIType.ptr], returns: FFIType.i32 },
				XDefaultRootWindow: { args: [FFIType.ptr], returns: FFIType.u64 },
				XInternAtom: { args: [FFIType.ptr, FFIType.ptr, FFIType.bool], returns: FFIType.u64 },
				XGetWindowProperty: {
					args: [
						FFIType.ptr,
						FFIType.u64,
						FFIType.u64,
						FFIType.i64,
						FFIType.i64,
						FFIType.bool,
						FFIType.u64,
						FFIType.ptr,
						FFIType.ptr,
						FFIType.ptr,
						FFIType.ptr,
						FFIType.ptr,
					],
					returns: FFIType.i32,
				},
				XFree: { args: [FFIType.ptr], returns: FFIType.i32 },
				XFlush: { args: [FFIType.ptr], returns: FFIType.i32 },
				XMoveResizeWindow: {
					args: [FFIType.ptr, FFIType.u64, FFIType.i32, FFIType.i32, FFIType.u32, FFIType.u32],
					returns: FFIType.i32,
				},
				XMoveWindow: {
					args: [FFIType.ptr, FFIType.u64, FFIType.i32, FFIType.i32],
					returns: FFIType.i32,
				},
				XGetGeometry: {
					args: [
						FFIType.ptr,
						FFIType.u64,
						FFIType.ptr,
						FFIType.ptr,
						FFIType.ptr,
						FFIType.ptr,
						FFIType.ptr,
						FFIType.ptr,
						FFIType.ptr,
					],
					returns: FFIType.i32,
				},
				XTranslateCoordinates: {
					args: [
						FFIType.ptr,
						FFIType.u64,
						FFIType.u64,
						FFIType.i32,
						FFIType.i32,
						FFIType.ptr,
						FFIType.ptr,
						FFIType.ptr,
					],
					returns: FFIType.bool,
				},
				XSendEvent: {
					args: [FFIType.ptr, FFIType.u64, FFIType.bool, FFIType.i64, FFIType.ptr],
					returns: FFIType.i32,
				},
			})
		} catch {}
	}
	return null
}

type Xlib = NonNullable<ReturnType<typeof loadXlib>>

const utf8 = new TextDecoder("utf-8", { fatal: true })

function decodeLatin1(bytes: Uint8Array): string {
	let out = ""
	for (const b of bytes) out += String.fromCharCode(b)
	return out
}

function cstring(s: string): Uint8Array {
	return new TextEncoder().encode(`${s}\0`)
}

class X11 {
	private readonly atoms = new Map<string, bigint>()

	constructor(
		private readonly lib: Xlib,
		private readonly display: Pointer,
		readonly root: bigint,
	) {}

	atom(name: string): bigint {
		const cached = this.atoms.get(name)
		if (cached !== undefined) return cached
		const a = this.lib.symbols.XInternAtom(
			this.display,
			ptr(cstring(name)),
			false,
		) as unknown as bigint
		this.atoms.set(name, a)
		return a
	}

	private getProperty(
		window: bigint,
		property: bigint,
	): { format: number; count: number; ptr: Pointer } | null {
		const actualType = new BigUint64Array(1)
		const actualFormat = new Int32Array(1)
		const nitems = new BigUint64Array(1)
		const bytesAfter = new BigUint64Array(1)
		const propPtr = new BigUint64Array(1)
		const status = this.lib.symbols.XGetWindowProperty(
			this.display,
			window,
			property,
			0,
			0x7fffffff,
			false,
			0n,
			ptr(actualType),
			ptr(actualFormat),
			ptr(nitems),
			ptr(bytesAfter),
			ptr(propPtr),
		)
		if (status !== 0) return null
		const count = Number(nitems[0])
		const address = propPtr[0] ?? 0n
		if (address === 0n || count === 0) {
			if (address !== 0n) this.lib.symbols.XFree(Number(address) as Pointer)
			return null
		}
		return { format: actualFormat[0] ?? 0, count, ptr: Number(address) as Pointer }
	}

	getCardinals(window: bigint, property: bigint): number[] {
		const prop = this.getProperty(window, property)
		if (!prop || prop.format !== 32) {
			if (prop) this.lib.symbols.XFree(prop.ptr)
			return []
		}
		// Format-32 properties are returned as an array of C `long` (8 bytes each on 64-bit).
		const view = new DataView(toArrayBuffer(prop.ptr, 0, prop.count * 8))
		const out: number[] = []
		for (let i = 0; i < prop.count; i++) {
			out.push(Number(view.getBigUint64(i * 8, true) & 0xffffffffn))
		}
		this.lib.symbols.XFree(prop.ptr)
		return out
	}

	getString(window: bigint, property: bigint): string {
		const prop = this.getProperty(window, property)
		if (!prop || prop.format !== 8) {
			if (prop) this.lib.symbols.XFree(prop.ptr)
			return ""
		}
		const bytes = new Uint8Array(toArrayBuffer(prop.ptr, 0, prop.count)).slice()
		this.lib.symbols.XFree(prop.ptr)
		try {
			return utf8.decode(bytes)
		} catch {
			return decodeLatin1(bytes)
		}
	}

	sendClientMessage(window: bigint, messageType: bigint, data: bigint[]): void {
		const buf = new ArrayBuffer(192)
		const view = new DataView(buf)
		view.setInt32(0, ClientMessage, true)
		view.setBigUint64(32, window, true)
		view.setBigUint64(40, messageType, true)
		view.setInt32(48, 32, true)
		for (let i = 0; i < 5; i++) view.setBigInt64(56 + i * 8, data[i] ?? 0n, true)
		this.lib.symbols.XSendEvent(
			this.display,
			this.root,
			false,
			BigInt(SubstructureRedirectMask | SubstructureNotifyMask),
			ptr(new Uint8Array(buf)),
		)
		this.lib.symbols.XFlush(this.display)
	}

	moveResize(window: bigint, r: Rect): void {
		this.lib.symbols.XMoveResizeWindow(
			this.display,
			window,
			Math.round(r.x),
			Math.round(r.y),
			Math.max(1, Math.round(r.w)),
			Math.max(1, Math.round(r.h)),
		)
	}

	move(window: bigint, x: number, y: number): void {
		this.lib.symbols.XMoveWindow(this.display, window, Math.round(x), Math.round(y))
	}

	geometry(window: bigint): Rect | null {
		const rootRet = new BigUint64Array(1)
		const gx = new Int32Array(1)
		const gy = new Int32Array(1)
		const gw = new Uint32Array(1)
		const gh = new Uint32Array(1)
		const border = new Uint32Array(1)
		const depth = new Uint32Array(1)
		const ok = this.lib.symbols.XGetGeometry(
			this.display,
			window,
			ptr(rootRet),
			ptr(gx),
			ptr(gy),
			ptr(gw),
			ptr(gh),
			ptr(border),
			ptr(depth),
		)
		if (!ok) return null
		const rx = new Int32Array(1)
		const ry = new Int32Array(1)
		const child = new BigUint64Array(1)
		this.lib.symbols.XTranslateCoordinates(
			this.display,
			window,
			this.root,
			0,
			0,
			ptr(rx),
			ptr(ry),
			ptr(child),
		)
		return { x: rx[0] ?? 0, y: ry[0] ?? 0, w: gw[0] ?? 0, h: gh[0] ?? 0 }
	}

	flush(): void {
		this.lib.symbols.XFlush(this.display)
	}
}

export function createX11WindowManager(): WindowManager | null {
	if (!process.env.DISPLAY || process.env.DISPLAY.trim() === "") return null
	const lib = loadXlib()
	if (!lib) return null
	const display = lib.symbols.XOpenDisplay(null) as Pointer | null
	if (!display || (display as unknown as number) === 0) return null
	const root = lib.symbols.XDefaultRootWindow(display) as unknown as bigint
	const x = new X11(lib, display, root)

	const caps: WmCapabilities = { manage: true, focus: true, highlight: false }

	function listTerminalWindows(): WindowInfo[] {
		const ids = x.getCardinals(root, x.atom("_NET_CLIENT_LIST"))
		const out: WindowInfo[] = []
		for (const id of ids) {
			const w = BigInt(id)
			let title = x.getString(w, x.atom("_NET_WM_NAME"))
			if (title === "") title = x.getString(w, XA_WM_NAME)
			out.push({ handle: id, title })
		}
		return out
	}

	function getForegroundWindow(): WindowHandle | null {
		const active = x.getCardinals(root, x.atom("_NET_ACTIVE_WINDOW"))
		const id = active[0]
		return id && id !== 0 ? id : null
	}

	function setForegroundWindow(handle: WindowHandle): boolean {
		if (typeof handle !== "number") return false
		x.sendClientMessage(BigInt(handle), x.atom("_NET_ACTIVE_WINDOW"), [2n, 0n, 0n])
		return true
	}

	function getWindowRect(handle: WindowHandle): Rect | null {
		if (typeof handle !== "number") return null
		return x.geometry(BigInt(handle))
	}

	function setWindowRect(handle: WindowHandle, rect: Rect): boolean {
		if (typeof handle !== "number") return false
		x.moveResize(BigInt(handle), rect)
		x.flush()
		return true
	}

	function moveWindow(handle: WindowHandle, mx: number, my: number): boolean {
		if (typeof handle !== "number") return false
		x.move(BigInt(handle), mx, my)
		x.flush()
		return true
	}

	function moveWindows(items: Array<{ handle: WindowHandle; x: number; y: number }>): boolean {
		for (const it of items) {
			if (typeof it.handle === "number") x.move(BigInt(it.handle), it.x, it.y)
		}
		x.flush()
		return true
	}

	function getWorkArea(): Rect | null {
		const wa = x.getCardinals(root, x.atom("_NET_WORKAREA"))
		if (wa.length < 4) return null
		return { x: wa[0] ?? 0, y: wa[1] ?? 0, w: wa[2] ?? 0, h: wa[3] ?? 0 }
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
	}
}
