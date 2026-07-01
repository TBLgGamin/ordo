/**
 * Best-effort foreground-program detection via the Win32 Toolhelp snapshot API
 * (kernel32.dll), bound with bun:ffi — same approach as win32.ts, and far cheaper
 * than spawning a PowerShell/WMI query every couple of seconds in every pane.
 *
 * The agent hosts the pane's shell in a ConPTY and knows that shell's PID. When
 * the user runs a program (e.g. `vim`), it becomes a child of that shell. We walk
 * the process tree from the shell down and report the deepest descendant whose
 * image name is one we know how to relaunch on restore (the RESTORE_PROGRAMS
 * whitelist). At a bare prompt there is no such descendant and we report null.
 */

import { dlopen, FFIType, type Pointer, ptr } from "bun:ffi"

const kernel32 = dlopen("kernel32.dll", {
	CreateToolhelp32Snapshot: { args: [FFIType.u32, FFIType.u32], returns: FFIType.ptr },
	Process32FirstW: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.bool },
	Process32NextW: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.bool },
	CloseHandle: { args: [FFIType.ptr], returns: FFIType.bool },
})

const TH32CS_SNAPPROCESS = 0x00000002

// PROCESSENTRY32W field offsets on x64 (ULONG_PTR forces 8-byte alignment):
//   dwSize @0, th32ProcessID @8, th32ParentProcessID @32, szExeFile @44 (WCHAR[260]).
const PE_SIZE = 568
const OFF_PID = 8
const OFF_PPID = 32
const OFF_EXE = 44
const MAX_PATH = 260

interface ProcInfo {
	pid: number
	ppid: number
	/** Lowercased image name without the trailing ".exe" (e.g. "vim", "pwsh"). */
	name: string
}

function readExeName(view: DataView): string {
	let out = ""
	for (let i = 0; i < MAX_PATH; i++) {
		const c = view.getUint16(OFF_EXE + i * 2, true)
		if (c === 0) break
		out += String.fromCharCode(c)
	}
	return out.toLowerCase().replace(/\.exe$/, "")
}

/** Snapshot every process as { pid, ppid, name }. Empty array on any failure. */
function snapshotProcesses(): ProcInfo[] {
	const snap = kernel32.symbols.CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) as Pointer | null
	// INVALID_HANDLE_VALUE (-1) or null → bail.
	if (!snap) return []
	const out: ProcInfo[] = []
	try {
		const buf = new ArrayBuffer(PE_SIZE)
		const view = new DataView(buf)
		view.setUint32(0, PE_SIZE, true) // dwSize
		const pe = ptr(buf)
		let ok = kernel32.symbols.Process32FirstW(snap, pe)
		while (ok) {
			out.push({
				pid: view.getUint32(OFF_PID, true),
				ppid: view.getUint32(OFF_PPID, true),
				name: readExeName(view),
			})
			ok = kernel32.symbols.Process32NextW(snap, pe)
		}
	} catch {
		// fall through with whatever we gathered
	} finally {
		kernel32.symbols.CloseHandle(snap)
	}
	return out
}

/**
 * The deepest descendant of `rootPid` whose name is in `whitelist`, or null if
 * none. "Deepest" so that, e.g., `pwsh → git → less` reports `less`.
 */
export function foregroundProgram(rootPid: number, whitelist: ReadonlySet<string>): string | null {
	if (whitelist.size === 0) return null
	const procs = snapshotProcesses()
	if (procs.length === 0) return null

	const childrenByParent = new Map<number, ProcInfo[]>()
	for (const p of procs) {
		const arr = childrenByParent.get(p.ppid)
		if (arr) arr.push(p)
		else childrenByParent.set(p.ppid, [p])
	}

	let best: string | null = null
	let bestDepth = -1
	const visited = new Set<number>()
	const walk = (pid: number, depth: number): void => {
		if (visited.has(pid)) return // guard against pid-reuse cycles
		visited.add(pid)
		for (const child of childrenByParent.get(pid) ?? []) {
			if (whitelist.has(child.name) && depth > bestDepth) {
				best = child.name
				bestDepth = depth
			}
			walk(child.pid, depth + 1)
		}
	}
	walk(rootPid, 0)
	return best
}
