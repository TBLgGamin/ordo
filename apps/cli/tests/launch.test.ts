import { describe, expect, test } from "bun:test"
import { buildInWindowArgs, type LaunchIntent, parseInWindowArgs } from "../src/cli/launch"
import { OrdoError } from "../src/core/errors"

describe("parseInWindowArgs", () => {
	test("no args is the launcher", () => {
		expect(parseInWindowArgs([])).toEqual({ kind: "launcher" })
	})
	test("new starts a fresh session", () => {
		expect(parseInWindowArgs(["new"])).toEqual({ kind: "new" })
	})
	test("restore carries the session name", () => {
		expect(parseInWindowArgs(["restore", "centurion"])).toEqual({
			kind: "restore",
			name: "centurion",
		})
	})
	test("restore without a name throws", () => {
		expect(() => parseInWindowArgs(["restore"])).toThrow(OrdoError)
	})
	test("an unknown mode throws", () => {
		expect(() => parseInWindowArgs(["bogus"])).toThrow(OrdoError)
	})
	test("new carries a pane seed from flags", () => {
		expect(parseInWindowArgs(["new", "--agent", "claude", "--name", "legatus"])).toEqual({
			kind: "new",
			seed: { agent: "claude", name: "legatus", cwd: undefined },
		})
	})
	test("new without seed flags stays bare", () => {
		expect(parseInWindowArgs(["new"])).toEqual({ kind: "new" })
	})
})

describe("buildInWindowArgs round-trips", () => {
	const intents: LaunchIntent[] = [
		{ kind: "launcher" },
		{ kind: "new" },
		{ kind: "new", seed: { agent: "codex", name: "primus", cwd: "X:/work" } },
		{ kind: "restore", name: "optio-legate" },
	]
	for (const intent of intents) {
		test(intent.kind, () => {
			expect(parseInWindowArgs(buildInWindowArgs(intent).slice(1))).toEqual(intent)
		})
	}
})
