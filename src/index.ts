#!/usr/bin/env bun
import {
	BUN_EXE,
	DELETE_NAME,
	ENTRY_PATH,
	flagPresent,
	IN_WINDOW,
	NEW_SESSION,
	PROJECT_DIR,
	RESTORE_NAME,
	SESSIONS_MODE,
} from "./core/config"
import { OrdoError } from "./core/errors"

async function main() {
	for (const flag of ["--restore", "--delete"] as const) {
		const value = flag === "--restore" ? RESTORE_NAME : DELETE_NAME
		if (flagPresent(flag) && value === undefined) {
			console.error(`ordo: ${flag} requires a session name`)
			process.exit(2)
		}
	}
	// `--delete <name>` removes a session (and its scrollback), then exits. Kill the
	// daemon's shells for it first so their capture-file handles are released.
	if (DELETE_NAME) {
		const [{ killSessionPanes }, { deleteSession }] = await Promise.all([
			import("./daemon/daemonClient"),
			import("./core/session"),
		])
		await killSessionPanes(DELETE_NAME)
		const ok = deleteSession(DELETE_NAME)
		console.log(ok ? `Deleted session "${DELETE_NAME}".` : `No session named "${DELETE_NAME}".`)
		return
	}
	// `--sessions` just prints the tree to the current terminal and exits — no TUI.
	if (SESSIONS_MODE) {
		const { printSessions } = await import("./cli/sessions")
		printSessions()
		return
	}
	// Launch / restore: re-spawn into a fresh dedicated Windows Terminal window
	// (the job the old launch.ps1 did) so the app captures a clean window as its
	// fixed center instead of hijacking whatever terminal `ordo` was typed in. The
	// spawned child carries `--in-window`, so it skips this branch and runs the TUI.
	if (!IN_WINDOW) {
		if (RESTORE_NAME) {
			const { sessionExists } = await import("./core/session")
			if (!sessionExists(RESTORE_NAME)) {
				console.error(`ordo: no saved session "${RESTORE_NAME}"`)
				process.exit(1)
			}
		}
		const { openSelfWindow } = await import("./platform/wt")
		const commandline = [BUN_EXE, "run", ENTRY_PATH, "--in-window"]
		if (RESTORE_NAME) commandline.push("--restore", RESTORE_NAME)
		else if (NEW_SESSION) commandline.push("--new")
		await openSelfWindow(commandline, PROJECT_DIR, RESTORE_NAME)
		return
	}
	const [{ createCliRenderer }, { runOrchestrator }] = await Promise.all([
		import("@opentui/core"),
		import("./cli/tui"),
	])
	const renderer = await createCliRenderer({ exitOnCtrlC: false, targetFps: 30, useMouse: true })
	renderer.setBackgroundColor("#0b0e14")
	await runOrchestrator(renderer)
}

main().catch((err) => {
	if (err instanceof OrdoError) console.error(`ordo: ${err.message}`)
	else console.error(err)
	process.exit(1)
})
