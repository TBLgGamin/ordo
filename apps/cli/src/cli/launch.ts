import { BUN_EXE, ENTRY_PATH, PROJECT_DIR, parseArgValue } from "../core/config"
import { OrdoError } from "../core/errors"
import { sessionExists } from "../core/session"
import { openSelfWindow } from "../platform/wt"

export interface PaneSeed {
	agent?: string
	name?: string
	cwd?: string
}

export type LaunchIntent =
	| { kind: "launcher" }
	| { kind: "new"; seed?: PaneSeed }
	| { kind: "restore"; name: string }

function hasSeedValues(seed: PaneSeed | undefined): seed is PaneSeed {
	return !!seed && (seed.agent !== undefined || seed.name !== undefined || seed.cwd !== undefined)
}

export function parseInWindowArgs(args: readonly string[]): LaunchIntent {
	const [mode, name] = args
	if (mode === undefined) return { kind: "launcher" }
	if (mode === "new") {
		const seed: PaneSeed = {
			agent: parseArgValue(args, "--agent"),
			name: parseArgValue(args, "--name"),
			cwd: parseArgValue(args, "--cwd"),
		}
		return hasSeedValues(seed) ? { kind: "new", seed } : { kind: "new" }
	}
	if (mode === "restore") {
		if (!name) throw new OrdoError("__in-window restore requires a session name")
		return { kind: "restore", name }
	}
	throw new OrdoError(`__in-window: unknown mode "${mode}"`)
}

export function buildInWindowArgs(intent: LaunchIntent): string[] {
	if (intent.kind === "new") {
		const args = ["__in-window", "new"]
		const seed = intent.seed
		if (seed?.agent) args.push("--agent", seed.agent)
		if (seed?.name) args.push("--name", seed.name)
		if (seed?.cwd) args.push("--cwd", seed.cwd)
		return args
	}
	if (intent.kind === "restore") return ["__in-window", "restore", intent.name]
	return ["__in-window"]
}

export async function openCommandCenter(intent: LaunchIntent): Promise<void> {
	if (intent.kind === "restore" && !sessionExists(intent.name)) {
		throw new OrdoError(`no saved session "${intent.name}"`)
	}
	const commandline = [BUN_EXE, "run", ENTRY_PATH, ...buildInWindowArgs(intent)]
	const restoreName = intent.kind === "restore" ? intent.name : undefined
	await openSelfWindow(commandline, PROJECT_DIR, restoreName)
}
