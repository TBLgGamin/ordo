import { detectTerminal } from "../shared/detect"
import { nullWindowManager } from "../shared/nullWm"
import type { TerminalBackend, WindowManager } from "../types"
import { createLinuxTerminal } from "./terminals"
import { createX11WindowManager } from "./x11"

export function selectLinuxBackends(): { wm: WindowManager; term: TerminalBackend } {
	const choice = detectTerminal("linux", { env: process.env, which: (e) => Bun.which(e) })
	const term = createLinuxTerminal(choice.id, choice.exe)
	const wm = createX11WindowManager() ?? nullWindowManager
	return { wm, term }
}
