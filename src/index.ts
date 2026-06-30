import {
	BoxRenderable,
	type CliRenderer,
	createCliRenderer,
	type KeyEvent,
	TextRenderable,
} from "@opentui/core"
import { ansiFg } from "./colors"
import { DELETE_NAME, SESSIONS_MODE } from "./config"
import { Orchestrator } from "./orchestrator"
import { deleteSession, listSessionNames, loadSession, type SessionState } from "./session"
import { isDirection } from "./wt"

const HELP = [
	"Commands:",
	"  right | left | up | down   tile a window on that side of the center",
	"  tab                        open a new tab (untiled)",
	"  win                        open a new free window (untiled)",
	"  kill <name>                close a pane",
	"  help                       show this help",
	"  quit                       exit (Ctrl+C also works)",
	"",
	"Type directly in each pane window to run commands there.",
	"The focused window (panes or this one) gets a lavender",
	"border + title bar. Panes are named after Roman soldiers.",
].join("\n")

async function main() {
	// `--delete <name>` removes a session (and its scrollback), then exits.
	if (DELETE_NAME) {
		const ok = deleteSession(DELETE_NAME)
		console.log(ok ? `Deleted session "${DELETE_NAME}".` : `No session named "${DELETE_NAME}".`)
		return
	}
	// `--sessions` just prints the tree to the current terminal and exits — no TUI.
	if (SESSIONS_MODE) {
		printSessions()
		return
	}
	const renderer = await createCliRenderer({ exitOnCtrlC: false, targetFps: 30 })
	renderer.setBackgroundColor("#0b0e14")
	await runOrchestrator(renderer)
}

// ---------------------------------------------------------------------------
// Orchestrator UI — the live session
// ---------------------------------------------------------------------------
async function runOrchestrator(renderer: CliRenderer) {
	const orchestrator = new Orchestrator()

	const root = new BoxRenderable(renderer, {
		id: "root",
		flexDirection: "column",
		padding: 1,
		flexGrow: 1,
	})
	renderer.root.add(root)

	const header = new BoxRenderable(renderer, {
		id: "header",
		border: true,
		borderStyle: "rounded",
		borderColor: "#39bae6",
		title: " ordo · pane orchestrator ",
		titleAlignment: "center",
		paddingLeft: 1,
		paddingRight: 1,
	})
	root.add(header)
	const headerText = new TextRenderable(renderer, {
		id: "headerText",
		content: "starting hub…",
		fg: "#e6e1cf",
	})
	header.add(headerText)

	const middle = new BoxRenderable(renderer, {
		id: "middle",
		flexDirection: "row",
		flexGrow: 1,
		marginTop: 1,
	})
	root.add(middle)

	const panesBox = new BoxRenderable(renderer, {
		id: "panesBox",
		border: true,
		borderStyle: "single",
		borderColor: "#566370",
		title: " panes ",
		padding: 1,
		width: 34,
	})
	middle.add(panesBox)
	const panesText = new TextRenderable(renderer, {
		id: "panesText",
		content: "(none)",
		fg: "#bae67e",
	})
	panesBox.add(panesText)

	const logBox = new BoxRenderable(renderer, {
		id: "logBox",
		border: true,
		borderStyle: "single",
		borderColor: "#566370",
		title: " log ",
		padding: 1,
		flexGrow: 1,
		marginLeft: 1,
	})
	middle.add(logBox)
	const logText = new TextRenderable(renderer, { id: "logText", content: HELP, fg: "#c5c8c6" })
	logBox.add(logText)

	const prompt = new BoxRenderable(renderer, {
		id: "prompt",
		border: true,
		borderStyle: "rounded",
		borderColor: "#ffa759",
		paddingLeft: 1,
		paddingRight: 1,
		marginTop: 1,
	})
	root.add(prompt)
	const promptText = new TextRenderable(renderer, {
		id: "promptText",
		content: "› ",
		fg: "#ffd580",
	})
	prompt.add(promptText)

	const logLines: string[] = []
	function pushLog(line: string): void {
		logLines.push(line)
		if (logLines.length > 200) logLines.shift()
		logText.content = logLines.slice(-14).join("\n")
	}

	function renderPanes(): void {
		const panes = orchestrator.list()
		if (panes.length === 0) {
			panesText.content = "(none)\n\ntype a direction\nto spawn one"
			return
		}
		panesText.content = panes
			.map((p) => {
				const dot = p.status === "connected" ? "●" : p.status === "spawning" ? "◍" : "○"
				const where = p.direction ? p.direction : p.kind
				return `${dot} ${p.id}  ${where}`
			})
			.join("\n")
	}

	orchestrator.on((e) => {
		if (e.type === "log") pushLog(e.message)
		else if (e.type === "panes-changed") renderPanes()
	})

	const port = orchestrator.start()
	// Name the center window's tab after the session (OSC 0). Done before the
	// renderer takes over stdout so it sticks.
	process.stdout.write(`\x1b]0;${orchestrator.sessionName}\x07`)
	headerText.content = `session: ${orchestrator.sessionName}    hub :${port}`

	let buffer = ""
	function redrawPrompt(): void {
		promptText.content = `› ${buffer}`
	}

	async function execute(line: string): Promise<void> {
		const trimmed = line.trim()
		if (!trimmed) return
		const [cmd, ...rest] = trimmed.split(/\s+/)

		if (cmd === "quit" || cmd === "exit") return shutdown()
		if (cmd === "help") {
			logText.content = HELP
			return
		}
		if (cmd && isDirection(cmd)) {
			await orchestrator.openPane(cmd).catch(() => {})
			return
		}
		switch (cmd) {
			case "tab":
				await orchestrator.openTab().catch(() => {})
				break
			case "win":
				await orchestrator.openWindow().catch(() => {})
				break
			case "kill":
				if (!rest[0]) pushLog("usage: kill <name>")
				else orchestrator.kill(rest[0])
				break
			default:
				pushLog(`unknown command: ${cmd}  (try "help")`)
		}
	}

	function shutdown(): never {
		orchestrator.stop()
		renderer.destroy()
		process.exit(0)
	}

	renderer.keyInput.on("keypress", (key: KeyEvent) => {
		if (key.ctrl && key.name === "c") return shutdown()
		if (key.name === "return" || key.name === "enter") {
			const line = buffer
			buffer = ""
			redrawPrompt()
			void execute(line)
			return
		}
		if (key.name === "backspace") {
			buffer = buffer.slice(0, -1)
			redrawPrompt()
			return
		}
		if (key.sequence && key.sequence.length === 1 && key.sequence >= " ") {
			buffer += key.sequence
			redrawPrompt()
		}
	})

	renderPanes()
	redrawPrompt()
	renderer.start()

	// Restore a saved session's panes (no-op for a fresh session).
	void orchestrator.applyRestore()
}

// ---------------------------------------------------------------------------
// Session list — `--sessions` (printed inline, no TUI)
// ---------------------------------------------------------------------------
function printSessions(): void {
	const C = {
		reset: "\x1b[0m",
		bold: "\x1b[1m",
		dim: "\x1b[2m",
		cyan: "\x1b[36m",
		green: "\x1b[32m",
	}
	const sessions = listSessionNames()
		.map(loadSession)
		.filter((s): s is SessionState => s !== null)
		.sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""))

	if (sessions.length === 0) {
		console.log(`\n${C.dim}No saved sessions yet. Start one with:${C.reset} bun run start\n`)
		return
	}

	const trunc = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s)
	const rel = (iso: string): string => {
		const t = Date.parse(iso)
		if (!t) return "?"
		const s = Math.max(0, (Date.now() - t) / 1000)
		if (s < 60) return `${Math.round(s)}s ago`
		if (s < 3600) return `${Math.round(s / 60)}m ago`
		if (s < 86400) return `${Math.round(s / 3600)}h ago`
		return `${Math.round(s / 86400)}d ago`
	}

	console.log(`\n${C.bold}ordo sessions (${sessions.length})${C.reset}\n`)
	for (const s of sessions) {
		const count = `${s.satellites.length} pane${s.satellites.length === 1 ? "" : "s"}`
		console.log(
			`${C.cyan}${C.bold}${s.name}${C.reset}  ${C.dim}${count} · ${rel(s.updatedAt)}${C.reset}`,
		)
		s.satellites.forEach((p, j) => {
			const branch = j === s.satellites.length - 1 ? "└─" : "├─"
			const cmd = p.lastCommand
				? `${C.dim}› ${trunc(p.lastCommand, 50)}${C.reset}`
				: `${C.dim}(no commands)${C.reset}`
			// Color the pane name with its own pastel color (same as its tab).
			const name = p.color ? `${ansiFg(p.color)}${p.id.padEnd(14)}${C.reset}` : p.id.padEnd(14)
			console.log(
				`  ${C.dim}${branch}${C.reset} ${name} ${C.dim}${p.direction.padEnd(5)}${C.reset} ${cmd}`,
			)
		})
		console.log(
			`  ${C.dim}resume →${C.reset} ${C.green}pwsh -File scripts\\launch.ps1 --restore ${s.name}${C.reset}\n`,
		)
	}
}

main().catch((err) => {
	console.error(err)
	process.exit(1)
})
