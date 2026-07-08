import { existsSync, mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { ordoBaseDir } from "../core/paths"

let powershellExeCache: string | undefined

export function powershellExe(): string {
	if (powershellExeCache === undefined) {
		powershellExeCache = Bun.which("pwsh") ? "pwsh" : "powershell"
	}
	return powershellExeCache
}

function posixDefaultShell(): string {
	const env = process.env.SHELL
	if (env && env.trim() !== "") return env
	if (process.platform === "darwin") return Bun.which("zsh") ?? "/bin/zsh"
	return Bun.which("bash") ?? Bun.which("sh") ?? "/bin/sh"
}

export function defaultShell(): string {
	const override = process.env.ORDO_SHELL
	if (override && override.trim() !== "") return override
	if (process.platform === "win32") return powershellExe()
	return posixDefaultShell()
}

export function runShellArgv(command: string): string[] {
	if (process.platform === "win32") {
		return [powershellExe(), "-NoProfile", "-NonInteractive", "-Command", command]
	}
	return ["/bin/sh", "-c", command]
}

export function runShellSyntaxName(): string {
	return process.platform === "win32" ? "PowerShell" : "POSIX sh"
}

export function defaultCompletionShell(): string {
	if (process.platform === "win32") return "powershell"
	const sh = (process.env.SHELL ?? "").toLowerCase()
	if (sh.includes("zsh")) return "zsh"
	return "bash"
}

export type ShellKind = "pwsh" | "bash" | "zsh" | "fish" | "other"

export function shellKind(shell: string): ShellKind {
	const base = shell.toLowerCase().replace(/\\/g, "/").split("/").pop() ?? shell
	if (/pwsh|powershell/.test(base)) return "pwsh"
	if (base.startsWith("bash")) return "bash"
	if (base.startsWith("zsh")) return "zsh"
	if (base.startsWith("fish")) return "fish"
	return "other"
}

export const isPwsh = (shell: string): boolean => shellKind(shell) === "pwsh"

export const PROMPT_CWD_REPORT =
	"$o=$function:prompt; function global:prompt { try { [Console]::Write([char]27+']9;9;'+$PWD.ProviderPath+[char]7) } catch {}; & $o }"

const BASH_RC = `[ -f "$HOME/.bashrc" ] && . "$HOME/.bashrc"
__ordo_osc7() { printf '\\033]7;file://%s%s\\007' "\${HOSTNAME:-localhost}" "$PWD"; }
case ";\${PROMPT_COMMAND};" in *";__ordo_osc7;"*) ;; *) PROMPT_COMMAND="__ordo_osc7\${PROMPT_COMMAND:+;$PROMPT_COMMAND}";; esac
`

const ZSH_RC = `[ -f "$HOME/.zshrc" ] && source "$HOME/.zshrc"
__ordo_osc7() { printf '\\033]7;file://%s%s\\007' "\${HOST:-localhost}" "$PWD"; }
typeset -ga precmd_functions
(( \${precmd_functions[(I)__ordo_osc7]} )) || precmd_functions+=(__ordo_osc7)
`

const FISH_INIT =
	"function __ordo_osc7 --on-variable PWD; printf '\\033]7;file://%s%s\\007' (hostname) \"$PWD\"; end; __ordo_osc7"

function shellrcDir(): string {
	return join(ordoBaseDir(), "shellrc")
}

function ensureFile(path: string, content: string): void {
	try {
		if (!existsSync(path)) writeFileSync(path, content)
	} catch {}
}

export interface ShellLaunch {
	args: string[]
	env?: Record<string, string>
}

export function paneShellLaunch(shell: string): ShellLaunch {
	const kind = shellKind(shell)
	if (kind === "pwsh") {
		return { args: ["-NoLogo", "-NoExit", "-Command", PROMPT_CWD_REPORT] }
	}
	if (kind === "bash") {
		const dir = shellrcDir()
		try {
			mkdirSync(dir, { recursive: true })
		} catch {}
		const rc = join(dir, "bashrc")
		ensureFile(rc, BASH_RC)
		return { args: ["--rcfile", rc, "-i"] }
	}
	if (kind === "zsh") {
		const dir = join(shellrcDir(), "zsh")
		try {
			mkdirSync(dir, { recursive: true })
		} catch {}
		ensureFile(join(dir, ".zshrc"), ZSH_RC)
		return { args: ["-i"], env: { ZDOTDIR: dir } }
	}
	if (kind === "fish") {
		return { args: ["-i", "-C", FISH_INIT] }
	}
	return { args: [] }
}
