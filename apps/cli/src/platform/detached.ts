import { spawn } from "node:child_process"
import { powershellExe } from "./shell"

export async function spawnDetachedDaemon(bunExe: string, daemonPath: string): Promise<void> {
	if (process.platform === "win32") {
		const ps = `Start-Process -FilePath '${bunExe}' -ArgumentList @('run','${daemonPath}') -WindowStyle Hidden`
		const proc = Bun.spawn([powershellExe(), "-NoProfile", "-Command", ps], {
			stdin: "ignore",
			stdout: "ignore",
			stderr: "ignore",
		})
		await proc.exited
		return
	}
	const child = spawn(bunExe, ["run", daemonPath], { detached: true, stdio: "ignore" })
	child.unref()
}
