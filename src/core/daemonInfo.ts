import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { ordoDir } from "./session"

/** Discovery record the daemon publishes so clients can find and authenticate to it. */
export interface DaemonInfo {
	port: number
	token: string
	pid: number
}

/** Path of the daemon's discovery file: %APPDATA%\ordo\daemon.json. */
export function daemonInfoPath(): string {
	return join(ordoDir(), "daemon.json")
}

function isDaemonInfo(value: unknown): value is DaemonInfo {
	if (!value || typeof value !== "object") return false
	const v = value as Record<string, unknown>
	return (
		Number.isInteger(v.port) &&
		(v.port as number) > 0 &&
		(v.port as number) <= 65535 &&
		typeof v.token === "string" &&
		v.token !== "" &&
		Number.isInteger(v.pid) &&
		(v.pid as number) > 0
	)
}

/** Read the daemon discovery record, or null if it's absent/unreadable/malformed. */
export function readDaemonInfo(): DaemonInfo | null {
	try {
		const path = daemonInfoPath()
		if (!existsSync(path)) return null
		const parsed: unknown = JSON.parse(readFileSync(path, "utf8"))
		return isDaemonInfo(parsed) ? parsed : null
	} catch {
		return null
	}
}
