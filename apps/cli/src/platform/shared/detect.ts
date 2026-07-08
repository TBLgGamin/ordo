export interface TerminalChoice {
	id: string
	exe: string
}

export interface DetectDeps {
	env: Record<string, string | undefined>
	which: (exe: string) => string | null
}

const KNOWN_EXE: Record<string, string> = {
	kitty: "kitty",
	wezterm: "wezterm",
	alacritty: "alacritty",
	ghostty: "ghostty",
	"gnome-terminal": "gnome-terminal",
	konsole: "konsole",
	"xfce4-terminal": "xfce4-terminal",
	xterm: "xterm",
}

const APP_TERMINALS = new Set(["apple-terminal", "iterm2"])

const DARWIN_PREFS = ["kitty", "wezterm", "alacritty", "ghostty"]
const LINUX_PREFS = [
	"kitty",
	"wezterm",
	"alacritty",
	"ghostty",
	"gnome-terminal",
	"konsole",
	"xfce4-terminal",
	"xterm",
]

function runningInside(env: Record<string, string | undefined>): string | null {
	const tp = env.TERM_PROGRAM
	if (tp === "iTerm.app") return "iterm2"
	if (tp === "Apple_Terminal") return "apple-terminal"
	if (tp === "WezTerm") return "wezterm"
	if (tp === "ghostty") return "ghostty"
	if (env.KITTY_WINDOW_ID) return "kitty"
	if (env.KONSOLE_VERSION) return "konsole"
	if (env.GNOME_TERMINAL_SERVICE || env.GNOME_TERMINAL_SCREEN) return "gnome-terminal"
	if (env.ALACRITTY_WINDOW_ID || env.TERM === "alacritty") return "alacritty"
	return null
}

function resolve(
	id: string,
	which: (exe: string) => string | null,
): TerminalChoice | null {
	if (APP_TERMINALS.has(id)) return { id, exe: "" }
	const exeName = KNOWN_EXE[id]
	if (!exeName) return null
	const exe = which(exeName)
	return exe ? { id, exe } : null
}

export function detectTerminal(platform: NodeJS.Platform, deps: DetectDeps): TerminalChoice {
	const { env, which } = deps

	const override = env.ORDO_TERMINAL
	if (override && override.trim() !== "") {
		if (APP_TERMINALS.has(override)) return { id: override, exe: "" }
		if (KNOWN_EXE[override]) return { id: override, exe: which(KNOWN_EXE[override]) ?? KNOWN_EXE[override] }
		return { id: "generic", exe: which(override) ?? override }
	}

	const inside = runningInside(env)
	if (inside) {
		const choice = resolve(inside, which)
		if (choice) return choice
	}

	const prefs = platform === "darwin" ? DARWIN_PREFS : LINUX_PREFS
	for (const id of prefs) {
		const choice = resolve(id, which)
		if (choice) return choice
	}

	if (platform === "darwin") return { id: "apple-terminal", exe: "" }

	const generic = env.TERMINAL ?? "x-terminal-emulator"
	return { id: "generic", exe: which(generic) ?? which("x-terminal-emulator") ?? generic }
}
