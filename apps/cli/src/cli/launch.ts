import { OrdoError } from "../core/errors"

export type LaunchIntent =
	| { kind: "launcher" }
	| { kind: "new" }
	| { kind: "restore"; name: string }

export function parseInWindowArgs(args: readonly string[]): LaunchIntent {
	const [mode, name] = args
	if (mode === undefined) return { kind: "launcher" }
	if (mode === "new") return { kind: "new" }
	if (mode === "restore") {
		if (!name) throw new OrdoError("__in-window restore requires a session name")
		return { kind: "restore", name }
	}
	throw new OrdoError(`__in-window: unknown mode "${mode}"`)
}

export function buildInWindowArgs(intent: LaunchIntent): string[] {
	if (intent.kind === "new") return ["__in-window", "new"]
	if (intent.kind === "restore") return ["__in-window", "restore", intent.name]
	return ["__in-window"]
}
