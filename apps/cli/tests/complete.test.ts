import { describe, expect, test } from "bun:test"
import { type CompletionContext, completionCandidates } from "../src/cli/complete"

const ctx: CompletionContext = {
	subcommands: [
		"send",
		"agents",
		"read",
		"broadcast",
		"status",
		"spawn",
		"new",
		"restore",
		"delete",
		"sessions",
	],
	panes: ["saggitarius", "optio", "legate"],
	sessions: ["centurion", "optio-legate"],
	agents: ["claude", "codex", "gemini"],
}

describe("completionCandidates", () => {
	test("first word completes subcommands", () => {
		expect(completionCandidates(["se"], ctx)).toEqual(["send", "sessions"])
		expect(completionCandidates([""], ctx)).toEqual(ctx.subcommands)
	})

	test("session names complete after restore", () => {
		expect(completionCandidates(["restore", "cent"], ctx)).toEqual(["centurion"])
	})

	test("all session names complete after delete", () => {
		expect(completionCandidates(["delete", ""], ctx)).toEqual(ctx.sessions)
	})

	test("pane target completes after send/read/interrupt", () => {
		expect(completionCandidates(["send", "sag"], ctx)).toEqual(["saggitarius"])
		expect(completionCandidates(["read", "o"], ctx)).toEqual(["optio"])
	})

	test("no pane completion for the message body", () => {
		expect(completionCandidates(["send", "optio", "hel"], ctx)).toEqual([])
	})

	test("session names complete after --session", () => {
		expect(completionCandidates(["send", "--session", "cent"], ctx)).toEqual(["centurion"])
	})

	test("agents complete after spawn --agent", () => {
		expect(completionCandidates(["spawn", "--agent", "c"], ctx)).toEqual(["claude", "codex"])
	})

	test("broadcast/status take no positional pane target", () => {
		expect(completionCandidates(["broadcast", "opt"], ctx)).toEqual([])
	})
})
