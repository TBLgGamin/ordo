import { existsSync } from "node:fs"
import type { SpawnWindowOptions, TerminalBackend, WindowHandle } from "../types"
import { runOsa } from "./osascript"

function shq(s: string): string {
	return `'${s.replace(/'/g, `'\\''`)}'`
}

function shellCommand(cwd: string | undefined, cmd: string[]): string {
	const inner = cmd.map(shq).join(" ")
	return cwd ? `cd ${shq(cwd)} && exec ${inner}` : `exec ${inner}`
}

function osaStr(s: string): string {
	return s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')
}

function spawnDetached(argv: string[], cwd?: string): void {
	Bun.spawn(argv, {
		stdin: "ignore",
		stdout: "ignore",
		stderr: "ignore",
		cwd: cwd && existsSync(cwd) ? cwd : undefined,
	})
}

function appleTerminal(): TerminalBackend {
	return {
		id: "apple-terminal",
		minWindowWidth: 240,
		async spawnWindow(opts: SpawnWindowOptions): Promise<{ handle?: WindowHandle }> {
			const cmd = osaStr(shellCommand(opts.cwd, opts.commandline))
			const setTitle = opts.title
				? `\n\tset custom title of selected tab of front window to "${osaStr(opts.title)}"`
				: ""
			const raw = runOsa(
				`tell application "Terminal"\n\tactivate\n\tdo script "${cmd}"${setTitle}\n\treturn id of front window\nend tell`,
			)
			const id = raw === null ? Number.NaN : Number(raw.trim())
			return Number.isFinite(id) ? { handle: id } : {}
		},
		async openSelfWindow(commandline: string[], cwd: string): Promise<void> {
			const cmd = osaStr(shellCommand(cwd, commandline))
			runOsa(`tell application "Terminal"\n\tactivate\n\tdo script "${cmd}"\nend tell`)
		},
	}
}

function iterm2(): TerminalBackend {
	return {
		id: "iterm2",
		minWindowWidth: 240,
		async spawnWindow(opts: SpawnWindowOptions): Promise<{ handle?: WindowHandle }> {
			const cmd = osaStr(shellCommand(opts.cwd, opts.commandline))
			const raw = runOsa(
				`tell application "iTerm"\n\tactivate\n\tset w to (create window with default profile command "${cmd}")\n\treturn id of w\nend tell`,
			)
			const id = raw === null ? Number.NaN : Number(raw.trim())
			return Number.isFinite(id) ? { handle: id } : {}
		},
		async openSelfWindow(commandline: string[], cwd: string): Promise<void> {
			const cmd = osaStr(shellCommand(cwd, commandline))
			runOsa(
				`tell application "iTerm"\n\tactivate\n\tcreate window with default profile command "${cmd}"\nend tell`,
			)
		},
	}
}

function cliArgv(id: string, exe: string, opts: SpawnWindowOptions): string[] {
	const cmd = opts.commandline
	const cwd = opts.cwd
	const title = opts.title
	switch (id) {
		case "kitty":
			return [
				exe,
				...(title ? ["--title", title] : []),
				...(cwd ? ["--directory", cwd] : []),
				...cmd,
			]
		case "wezterm":
			return [exe, "start", ...(cwd ? ["--cwd", cwd] : []), "--", ...cmd]
		case "alacritty":
			return [
				exe,
				...(title ? ["--title", title] : []),
				...(cwd ? ["--working-directory", cwd] : []),
				"-e",
				...cmd,
			]
		case "ghostty":
			return [
				"open",
				"-na",
				"Ghostty",
				"--args",
				...(cwd ? [`--working-directory=${cwd}`] : []),
				"-e",
				...cmd,
			]
		default:
			return [exe, "-e", ...cmd]
	}
}

function cliTerminal(id: string, exe: string): TerminalBackend {
	return {
		id,
		minWindowWidth: 200,
		async spawnWindow(opts: SpawnWindowOptions): Promise<{ handle?: WindowHandle }> {
			spawnDetached(cliArgv(id, exe, opts), opts.cwd)
			return {}
		},
		async openSelfWindow(commandline: string[], cwd: string, title?: string): Promise<void> {
			spawnDetached(cliArgv(id, exe, { commandline, cwd, title }), cwd)
		},
	}
}

export function createDarwinTerminal(id: string, exe: string): TerminalBackend {
	if (id === "apple-terminal") return appleTerminal()
	if (id === "iterm2") return iterm2()
	return cliTerminal(id, exe)
}
