#!/usr/bin/env bun
import { buildInWindowArgs, type LaunchIntent, parseInWindowArgs } from "./cli/launch"
import { usageText } from "./cli/usage"
import { BUN_EXE, ENTRY_PATH, PROJECT_DIR } from "./core/config"
import { OrdoError } from "./core/errors"

async function launchInWindow(intent: LaunchIntent) {
	if (intent.kind === "restore") {
		const { sessionExists } = await import("./core/session")
		if (!sessionExists(intent.name)) {
			console.error(`ordo: no saved session "${intent.name}"`)
			process.exit(1)
		}
	}
	const { openSelfWindow } = await import("./platform/wt")
	const commandline = [BUN_EXE, "run", ENTRY_PATH, ...buildInWindowArgs(intent)]
	const restoreName = intent.kind === "restore" ? intent.name : undefined
	await openSelfWindow(commandline, PROJECT_DIR, restoreName)
}

async function runInWindow(intent: LaunchIntent) {
	const [{ createCliRenderer }, { runOrchestrator }] = await Promise.all([
		import("@opentui/core"),
		import("./cli/tui"),
	])
	const renderer = await createCliRenderer({ exitOnCtrlC: false, targetFps: 30, useMouse: true })
	renderer.setBackgroundColor("#0b0e14")
	await runOrchestrator(renderer, intent)
}

async function main() {
	const sub = Bun.argv[2]
	if (sub === "mcp") {
		const { runMcpServer } = await import("./mcp/server")
		await runMcpServer()
		return
	}
	if (sub === "__complete") {
		const { runComplete } = await import("./cli/complete")
		await runComplete(Bun.argv.slice(3))
		return
	}
	if (sub === "completion") {
		const { completionScript } = await import("./cli/completionScripts")
		const shell = Bun.argv[3] ?? "powershell"
		const script = completionScript(shell)
		if (script === "") {
			console.error(`ordo: unknown shell "${shell}" (try powershell, bash, zsh)`)
			process.exit(2)
		}
		console.log(script)
		return
	}
	if (
		sub === "send" ||
		sub === "agents" ||
		sub === "read" ||
		sub === "broadcast" ||
		sub === "status" ||
		sub === "interrupt" ||
		sub === "spawn"
	) {
		const { runAgentCli } = await import("./cli/agentCli")
		await runAgentCli(sub, Bun.argv.slice(3))
		return
	}
	if (sub === "help" || sub === "-h" || sub === "--help") {
		console.log(usageText())
		return
	}
	if (sub === "sessions") {
		const { printSessions } = await import("./cli/sessions")
		printSessions()
		return
	}
	if (sub === "delete") {
		const name = Bun.argv[3]
		if (!name) {
			console.error("ordo: delete requires a session name")
			process.exit(2)
		}
		const [{ killSessionPanes }, { deleteSession }] = await Promise.all([
			import("./daemon/daemonClient"),
			import("./core/session"),
		])
		await killSessionPanes(name)
		const ok = deleteSession(name)
		console.log(ok ? `Deleted session "${name}".` : `No session named "${name}".`)
		return
	}
	if (sub === "__in-window") {
		await runInWindow(parseInWindowArgs(Bun.argv.slice(3)))
		return
	}
	if (sub === undefined) {
		await launchInWindow({ kind: "launcher" })
		return
	}
	if (sub === "new") {
		await launchInWindow({ kind: "new" })
		return
	}
	if (sub === "restore") {
		const name = Bun.argv[3]
		if (!name) {
			console.error("ordo: restore requires a session name")
			process.exit(2)
		}
		await launchInWindow({ kind: "restore", name })
		return
	}
	console.error(`ordo: unknown command "${sub}"\n`)
	console.error(usageText())
	process.exit(1)
}

main().catch((err) => {
	if (err instanceof OrdoError) console.error(`ordo: ${err.message}`)
	else console.error(err)
	process.exit(1)
})
