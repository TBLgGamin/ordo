import { afterEach, describe, expect, test } from "bun:test"
import { resolveSession } from "../src/cli/agentCli"

const savedEnv = process.env.ORDO_SESSION

afterEach(() => {
	if (savedEnv === undefined) delete process.env.ORDO_SESSION
	else process.env.ORDO_SESSION = savedEnv
})

describe("resolveSession", () => {
	test("prefers ORDO_SESSION env", async () => {
		process.env.ORDO_SESSION = "legate"
		expect(await resolveSession([], async () => ["other"])).toBe("legate")
	})

	test("falls back to --session flag", async () => {
		delete process.env.ORDO_SESSION
		expect(await resolveSession(["--session", "optio"], async () => [])).toBe("optio")
	})

	test("uses the sole live session when unambiguous", async () => {
		delete process.env.ORDO_SESSION
		expect(await resolveSession([], async () => ["only"])).toBe("only")
	})

	test("returns null when zero or multiple live sessions", async () => {
		delete process.env.ORDO_SESSION
		expect(await resolveSession([], async () => [])).toBeNull()
		expect(await resolveSession([], async () => ["a", "b"])).toBeNull()
	})
})
