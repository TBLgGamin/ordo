import { closeSync, openSync, readFileSync, rmSync, statSync, writeSync } from "node:fs"
import { join } from "node:path"

const STALE_LOCK_MS = 15000

function isProcessAlive(pid: number): boolean {
	try {
		process.kill(pid, 0)
		return true
	} catch (e) {
		return (e as NodeJS.ErrnoException).code === "EPERM"
	}
}

export function acquireSpawnLock(dir: string): string | null {
	const path = join(dir, "daemon.lock")
	for (let attempt = 0; attempt < 2; attempt++) {
		try {
			const fd = openSync(path, "wx")
			writeSync(fd, String(process.pid))
			closeSync(fd)
			return path
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

export function releaseSpawnLock(path: string | undefined): void {
	if (!path) return
	try {
		rmSync(path, { force: true })
	} catch {}
}
