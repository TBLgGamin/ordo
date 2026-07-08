import { dlopen, FFIType, ptr } from "bun:ffi"
import { closeSync, openSync, readFileSync, rmSync, statSync, writeSync } from "node:fs"

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

const kernel32 = process.platform === "win32" ? loadKernel32() : null

export const singletonLockSupported = process.platform === "win32" ? kernel32 !== null : true

function wide(s: string): Uint16Array {
	const buf = new Uint16Array(s.length + 1)
	for (let i = 0; i < s.length; i++) buf[i] = s.charCodeAt(i)
	return buf
}

export interface SingletonLock {
	release(): void
}

const STALE_LOCK_MS = 30000

function isProcessAlive(pid: number): boolean {
	try {
		process.kill(pid, 0)
		return true
	} catch (e) {
		return (e as NodeJS.ErrnoException).code === "EPERM"
	}
}

function acquirePosixLock(path: string): SingletonLock | null {
	for (let attempt = 0; attempt < 2; attempt++) {
		try {
			const fd = openSync(path, "wx")
			writeSync(fd, String(process.pid))
			closeSync(fd)
			let released = false
			return {
				release() {
					if (released) return
					released = true
					try {
						rmSync(path, { force: true })
					} catch {}
				},
			}
		} catch (e) {
			if ((e as NodeJS.ErrnoException).code !== "EEXIST") return null
			try {
				const pid = Number(readFileSync(path, "utf8").trim())
				if (Number.isInteger(pid) && pid > 0 && !isProcessAlive(pid)) {
					rmSync(path, { force: true })
					continue
				}
			} catch {}
			try {
				if (Date.now() - statSync(path).mtimeMs > STALE_LOCK_MS) {
					rmSync(path, { force: true })
					continue
				}
			} catch {}
			return null
		}
	}
	return null
}

export function acquireSingletonLock(path: string): SingletonLock | null {
	if (process.platform !== "win32") return acquirePosixLock(path)
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
