import { dlopen, FFIType, ptr } from "bun:ffi"

const JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x00002000
const JobObjectExtendedLimitInformation = 9
const PROCESS_TERMINATE = 0x0001
const PROCESS_SET_QUOTA = 0x0100
const EXTENDED_LIMIT_INFO_BYTES = 144
const LIMIT_FLAGS_OFFSET = 16

function loadKernel32() {
	try {
		return dlopen("kernel32.dll", {
			CreateJobObjectW: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.i64 },
			SetInformationJobObject: {
				args: [FFIType.i64, FFIType.i32, FFIType.ptr, FFIType.u32],
				returns: FFIType.bool,
			},
			OpenProcess: { args: [FFIType.u32, FFIType.bool, FFIType.u32], returns: FFIType.i64 },
			AssignProcessToJobObject: { args: [FFIType.i64, FFIType.i64], returns: FFIType.bool },
			TerminateJobObject: { args: [FFIType.i64, FFIType.u32], returns: FFIType.bool },
			CloseHandle: { args: [FFIType.i64], returns: FFIType.bool },
		})
	} catch {
		return null
	}
}

const kernel32 = loadKernel32()

export interface PaneJob {
	assign(pid: number): boolean
	terminate(): void
}

export function createPaneJob(): PaneJob | null {
	if (!kernel32) return null
	let hJob: bigint
	try {
		hJob = kernel32.symbols.CreateJobObjectW(null, null) as unknown as bigint
	} catch {
		return null
	}
	if (hJob === 0n) return null

	const info = new Uint8Array(EXTENDED_LIMIT_INFO_BYTES)
	new DataView(info.buffer).setUint32(LIMIT_FLAGS_OFFSET, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE, true)
	try {
		kernel32.symbols.SetInformationJobObject(
			hJob,
			JobObjectExtendedLimitInformation,
			ptr(info),
			EXTENDED_LIMIT_INFO_BYTES,
		)
	} catch {
		try {
			kernel32.symbols.CloseHandle(hJob)
		} catch {}
		return null
	}

	let closed = false
	return {
		assign(pid: number): boolean {
			if (closed || !kernel32) return false
			let hProc: bigint
			try {
				hProc = kernel32.symbols.OpenProcess(
					PROCESS_SET_QUOTA | PROCESS_TERMINATE,
					false,
					pid,
				) as unknown as bigint
			} catch {
				return false
			}
			if (hProc === 0n) return false
			let ok = false
			try {
				ok = Boolean(kernel32.symbols.AssignProcessToJobObject(hJob, hProc))
			} catch {}
			try {
				kernel32.symbols.CloseHandle(hProc)
			} catch {}
			return ok
		},
		terminate(): void {
			if (closed || !kernel32) return
			closed = true
			try {
				kernel32.symbols.TerminateJobObject(hJob, 1)
			} catch {}
			try {
				kernel32.symbols.CloseHandle(hJob)
			} catch {}
		},
	}
}
