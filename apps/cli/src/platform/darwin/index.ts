import { detectTerminal } from "../shared/detect"
import { nullWindowManager } from "../shared/nullWm"
import type { TerminalBackend, WindowManager } from "../types"
import { createDarwinTerminal } from "./terminals"
import { createDarwinWindowManager } from "./windows"

export function selectDarwinBackends(): { wm: WindowManager; term: TerminalBackend } {
	const choice = detectTerminal("darwin", { env: process.env, which: (e) => Bun.which(e) })
	const term = createDarwinTerminal(choice.id, choice.exe)
	let wm: WindowManager
	if (choice.id === "apple-terminal") wm = createDarwinWindowManager({ appName: "Terminal" })
	else if (choice.id === "iterm2") wm = createDarwinWindowManager({ appName: "iTerm" })
	else wm = nullWindowManager
	return { wm, term }
}
