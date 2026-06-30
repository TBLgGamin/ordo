/**
 * The agent: runs INSIDE each spawned Windows Terminal pane.
 *
 * The shell is fully interactive — the user types directly into the pane (stdio
 * is inherited, so PSReadLine / line editing / echo all work normally). For
 * scrollback restore we don't tee bytes (that would disable interactivity);
 * instead pwsh records the session to a transcript file via Start-Transcript,
 * which we replay on the next restore.
 *
 * The agent itself just: replays prior scrollback, launches the shell, and holds
 * a hub connection so that closing the main window closes this pane too.
 *
 * Invoked as: bun <agent.ts> --id <id> --port <hubPort> [--shell <exe>]
 *             [--bg #hex] [--fg #hex] [--capture <file>] [--replay]
 */

import { existsSync, mkdirSync, readFileSync } from "node:fs"
import { dirname } from "node:path"
import { type AgentMessage, encode, type HubMessage, LineDecoder } from "./protocol"

interface Args {
	id: string
	port: number
	shell: string
	bg?: string
	fg?: string
	capture?: string
	replay: boolean
}

function parseArgs(argv: string[]): Args {
	const get = (flag: string): string | undefined => {
		const i = argv.indexOf(flag)
		return i >= 0 ? argv[i + 1] : undefined
	}
	const id = get("--id")
	const port = Number(get("--port"))
	if (!id || !Number.isInteger(port) || port <= 0) {
		throw new Error("agent requires --id <paneId> and --port <hubPort>")
	}
	return {
		id,
		port,
		shell: get("--shell") ?? "pwsh",
		bg: get("--bg"),
		fg: get("--fg"),
		capture: get("--capture"),
		replay: argv.includes("--replay"),
	}
}

const isPwsh = (shell: string) => /pwsh|powershell/i.test(shell)

/** Strip Start-Transcript boilerplate so the replayed history reads cleanly. */
function cleanTranscript(text: string): string {
	const skip =
		/^\*{5,}$|^(Windows PowerShell transcript|Start time|End time|Username|RunAs User|Configuration Name|Machine|Host Application|Process ID|PSVersion|PSEdition|GitCommitId|OS|Platform|PSCompatibleVersions|PSRemotingProtocolVersion|SerializationVersion|WSManStackVersion|Transcript (started|ended))/i
	return text
		.split(/\r?\n/)
		.filter((line) => !skip.test(line.trim()))
		.join("\r\n")
		.replace(/(\r?\n){3,}/g, "\r\n\r\n")
		.trim()
}

async function main() {
	const { id, port, shell, bg, fg, capture, replay } = parseArgs(Bun.argv.slice(2))

	// Recolor the pane via native VT sequences first: OSC 11 = bg, OSC 10 = fg.
	if (bg) process.stdout.write(`\x1b]11;${bg}\x07`)
	if (fg) process.stdout.write(`\x1b]10;${fg}\x07`)

	// Restore: replay the saved transcript, then a divider, before the shell.
	if (replay && capture && existsSync(capture)) {
		try {
			const history = cleanTranscript(readFileSync(capture, "utf8"))
			if (history) {
				process.stdout.write(history)
				process.stdout.write("\r\n\x1b[2m──────── restored ────────\x1b[0m\r\n")
			}
		} catch {
			// ignore a missing/unreadable capture
		}
	}

	// Make sure the capture directory exists so Start-Transcript can write.
	if (capture) {
		try {
			mkdirSync(dirname(capture), { recursive: true })
		} catch {}
	}

	// Build an interactive shell invocation. For pwsh we also start a transcript.
	const args: string[] = []
	if (isPwsh(shell)) {
		args.push("-NoLogo")
		if (capture) {
			const path = capture.replace(/'/g, "''")
			args.push(
				"-NoExit",
				"-Command",
				`try { $null = Start-Transcript -LiteralPath '${path}' -Append -Force } catch {}`,
			)
		}
	}

	const child = Bun.spawn([shell, ...args], {
		stdin: "inherit",
		stdout: "inherit",
		stderr: "inherit",
		onExit: (_proc, code) => {
			send({ type: "exit", paneId: id, code: code ?? 0 })
			process.exit(code ?? 0)
		},
	})

	const decoder = new LineDecoder<HubMessage>()
	let send: (msg: AgentMessage) => void = () => {}

	function teardown(): never {
		child.kill()
		process.exit(0)
	}

	const socket = await Bun.connect({
		hostname: "127.0.0.1",
		port,
		socket: {
			open: (sock) => {
				send = (msg) => {
					sock.write(encode(msg))
					sock.flush()
				}
				send({ type: "hello", paneId: id, pid: process.pid })
			},
			data: (_sock, chunk) => {
				for (const msg of decoder.push(chunk)) {
					// Only `shutdown` is actionable now that panes are typed directly.
					if (msg.type === "shutdown") {
						socket.end()
						teardown()
					}
				}
			},
			// The hub (main window) is gone — close this pane too.
			close: () => teardown(),
		},
	})
}

main().catch((err) => {
	console.error("[ordo agent] fatal:", err)
	process.exit(1)
})
