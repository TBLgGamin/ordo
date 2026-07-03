import { dlopen, FFIType, ptr } from "bun:ffi"

const GENERIC_WRITE = 0x40000000
const FILE_SHARE_NONE = 0x0
const OPEN_ALWAYS = 4
const FILE_ATTRIBUTE_NORMAL = 0x80
const INVALID_HANDLE = -1n

function loadKernel32() {
	try {
		return dlopen("kernel32.dll", {
			CreateFileW: {
				args: [
					FFIType.ptr,
					FFIType.u32,
					FFIType.u32,
					FFIType.ptr,
					FFIType.u32,
					FFIType.u32,
					FFIType.ptr,
				],
				returns: FFIType.i64,
			},
			CloseHandle: { args: [FFIType.i64], returns: FFIType.bool },
		})
	} catch {
		return null
	}
}

const kernel32 = loadKernel32()

export const singletonLockSupported = kernel32 !== null

function wide(s: string): Uint16Array {
	const buf = new Uint16Array(s.length + 1)
	for (let i = 0; i < s.length; i++) buf[i] = s.charCodeAt(i)
	return buf
}

export interface SingletonLock {
	release(): void
}

export function acquireSingletonLock(path: string): SingletonLock | null {
	if (!kernel32) return null
	let handle: bigint
	try {
		handle = kernel32.symbols.CreateFileW(
			ptr(wide(path)),
			GENERIC_WRITE,
			FILE_SHARE_NONE,
			null,
			OPEN_ALWAYS,
			FILE_ATTRIBUTE_NORMAL,
			null,
		) as unknown as bigint
	} catch {
		return null
	}
	if (handle === INVALID_HANDLE || handle <= 0n) return null
	let released = false
	return {
		release() {
			if (released) return
			released = true
			try {
				kernel32?.symbols.CloseHandle(handle)
			} catch {}
		},
	}
}
