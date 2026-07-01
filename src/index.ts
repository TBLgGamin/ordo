#!/usr/bin/env bun
import { createCliRenderer } from "@opentui/core"
import { printSessions } from "./cli/sessions"
import { runOrchestrator } from "./cli/tui"
import {
	BUN_EXE,
	DELETE_NAME,
	ENTRY_PATH,
	IN_WINDOW,
	NEW_SESSION,
	PROJECT_DIR,
	RESTORE_NAME,
	SESSIONS_MODE,
} from "./core/config"
import { deleteSession } from "./core/session"
import { openSelfWindow } from "./platform/wt"

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
	// Launch / restore: re-spawn into a fresh dedicated Windows Terminal window
	// (the job the old launch.ps1 did) so the app captures a clean window as its
	// fixed center instead of hijacking whatever terminal `ordo` was typed in. The
	// spawned child carries `--in-window`, so it skips this branch and runs the TUI.
	if (!IN_WINDOW) {
		const commandline = [BUN_EXE, "run", ENTRY_PATH, "--in-window"]
		if (RESTORE_NAME) commandline.push("--restore", RESTORE_NAME)
		else if (NEW_SESSION) commandline.push("--new")
		await openSelfWindow(commandline, PROJECT_DIR, RESTORE_NAME)
		return
	}
	const renderer = await createCliRenderer({ exitOnCtrlC: false, targetFps: 30, useMouse: true })
	renderer.setBackgroundColor("#0b0e14")
	await runOrchestrator(renderer)
}

main().catch((err) => {
	console.error(err)
	process.exit(1)
})
