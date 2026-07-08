import { readdirSync, readFileSync } from "node:fs"
import {
	buildProcessIndex,
	deepestWhitelisted,
	type ProcInfo,
	snapshotProcesses as snapshotWin32,
} from "./win32/proctree"

export { buildProcessIndex, deepestWhitelisted, type ProcInfo }

function normalizeName(raw: string): string {
	const base = raw.replace(/\\/g, "/").split("/").pop() ?? raw
	return base.toLowerCase().replace(/\.exe$/, "")
}

function snapshotLinux(): ProcInfo[] {
	const out: ProcInfo[] = []
	let entries: string[]
	try {
		entries = readdirSync("/proc")
	} catch {
		return out
	}
	for (const entry of entries) {
		if (!/^\d+$/.test(entry)) continue
		try {
			const stat = readFileSync(`/proc/${entry}/stat`, "utf8")
			const open = stat.indexOf("(")
			const close = stat.lastIndexOf(")")
			if (open < 0 || close < 0) continue
			const pid = Number(stat.slice(0, open).trim())
			const comm = stat.slice(open + 1, close)
			const rest = stat.slice(close + 2).trim().split(/\s+/)
			const ppid = Number(rest[1])
			if (!Number.isFinite(pid) || !Number.isFinite(ppid)) continue
			out.push({ pid, ppid, name: normalizeName(comm) })
		} catch {}
	}
	return out
}

function snapshotPs(): ProcInfo[] {
	try {
		const res = Bun.spawnSync(["ps", "-axo", "pid=,ppid=,comm="])
		if (!res.success) return []
		const text = new TextDecoder().decode(res.stdout)
		const out: ProcInfo[] = []
		for (const line of text.split("\n")) {
			const t = line.trim()
			if (t === "") continue
			const m = t.match(/^(\d+)\s+(\d+)\s+(.*)$/)
			if (!m?.[1] || !m[2] || m[3] === undefined) continue
			out.push({ pid: Number(m[1]), ppid: Number(m[2]), name: normalizeName(m[3]) })
		}
		return out
	} catch {
		return []
	}
}

export function snapshotProcesses(): ProcInfo[] {
	if (process.platform === "win32") return snapshotWin32()
	if (process.platform === "linux") return snapshotLinux()
	return snapshotPs()
}
