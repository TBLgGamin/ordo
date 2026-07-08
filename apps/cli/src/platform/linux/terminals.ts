import { existsSync } from "node:fs"
import type { SpawnWindowOptions, TerminalBackend, WindowHandle } from "../types"

const CLASS = "ordo-pane"

export function buildLinuxArgv(id: string, exe: string, opts: SpawnWindowOptions): string[] {
	const cmd = opts.commandline
	const cwd = opts.cwd
	const title = opts.title
	switch (id) {
		case "kitty":
			return [
				exe,
				...(title ? ["--title", title] : []),
				...(cwd ? ["--directory", cwd] : []),
				"--class",
				CLASS,
				...cmd,
			]
		case "wezterm":
			return [exe, "start", ...(cwd ? ["--cwd", cwd] : []), "--class", CLASS, "--", ...cmd]
		case "alacritty":
			return [
				exe,
				...(title ? ["--title", title] : []),
				...(cwd ? ["--working-directory", cwd] : []),
				"--class",
				CLASS,
				"-e",
				...cmd,
			]
		case "ghostty":
			return [
				exe,
				...(title ? [`--title=${title}`] : []),
				...(cwd ? [`--working-directory=${cwd}`] : []),
				`--class=${CLASS}`,
				"-e",
				...cmd,
			]
		case "gnome-terminal":
			return [
				exe,
				...(title ? [`--title=${title}`] : []),
				...(cwd ? [`--working-directory=${cwd}`] : []),
				"--",
				...cmd,
			]
		case "konsole":
			return [
				exe,
				...(cwd ? ["--workdir", cwd] : []),
				...(title ? ["-p", `tabtitle=${title}`] : []),
				"-e",
				...cmd,
			]
		case "xfce4-terminal":
			return [
				exe,
				...(title ? [`--title=${title}`] : []),
				...(cwd ? [`--working-directory=${cwd}`] : []),
				"-x",
				...cmd,
			]
		case "xterm":
			return [exe, ...(title ? ["-T", title] : []), "-e", ...cmd]
		default:
			return [exe, "-e", ...cmd]
	}
}

function spawnDetached(argv: string[], cwd?: string): void {
	Bun.spawn(argv, {
		stdin: "ignore",
		stdout: "ignore",
		stderr: "ignore",
		cwd: cwd && existsSync(cwd) ? cwd : undefined,
	})
}

export function createLinuxTerminal(id: string, exe: string): TerminalBackend {
	return {
		id,
		minWindowWidth: 200,
		async spawnWindow(opts: SpawnWindowOptions): Promise<{ handle?: WindowHandle }> {
			spawnDetached(buildLinuxArgv(id, exe, opts), opts.cwd)
			return {}
		},
		async openSelfWindow(commandline: string[], cwd: string, title?: string): Promise<void> {
			spawnDetached(buildLinuxArgv(id, exe, { commandline, cwd, title }), cwd)
		},
	}
}
