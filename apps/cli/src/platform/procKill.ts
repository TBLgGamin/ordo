import { createPaneJob as createWin32Job, type PaneJob } from "./win32/job"

export type { PaneJob }

const POSIX_KILL_GRACE_MS = 800

function killGroup(pid: number, signal: NodeJS.Signals): void {
	try {
		process.kill(-pid, signal)
	} catch {
		try {
			process.kill(pid, signal)
		} catch {}
	}
}

function createPosixPaneJob(): PaneJob {
	let pid: number | undefined
	let terminated = false
	return {
		assign(p: number): boolean {
			pid = p
			return true
		},
		terminate(): void {
			if (terminated) return
			terminated = true
			if (pid === undefined) return
			const target = pid
			killGroup(target, "SIGHUP")
			setTimeout(() => killGroup(target, "SIGKILL"), POSIX_KILL_GRACE_MS)
		},
	}
}

export function createPaneJob(): PaneJob | null {
	if (process.platform === "win32") return createWin32Job()
	return createPosixPaneJob()
}
