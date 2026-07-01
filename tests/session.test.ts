import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
	deleteSession,
	generateSessionId,
	listSessionNames,
	loadSession,
	saveSession,
	scrollbackDir,
	scrollbackPath,
	type SessionState,
	sessionExists,
	sessionsDir,
} from "../src/core/session"

// session.ts reads process.env.APPDATA at call time, so point it at a temp dir.
let tmp: string
let prevAppData: string | undefined

beforeAll(() => {
	prevAppData = process.env.APPDATA
	tmp = mkdtempSync(join(tmpdir(), "ordo-test-"))
	process.env.APPDATA = tmp
})

afterAll(() => {
	if (prevAppData === undefined) delete process.env.APPDATA
	else process.env.APPDATA = prevAppData
	rmSync(tmp, { recursive: true, force: true })
})

const sample = (id: string): SessionState => ({
	id,
	updatedAt: new Date().toISOString(),
	center: { x: 10, y: 20, w: 800, h: 600 },
	satellites: [
		{
			id: "optio",
			direction: "right",
			color: "#abcdef",
			cwd: "C:\\work",
			lastCommand: "git status",
			foreground: "vim",
			rect: { x: 1, y: 2, w: 3, h: 4 },
		},
	],
})

describe("save / load", () => {
	test("round-trips a session including the foreground field", () => {
		const state = sample("centurion")
		saveSession(state)
		const loaded = loadSession("centurion")
		expect(loaded).toEqual(state)
		expect(loaded?.satellites[0]?.foreground).toBe("vim")
	})

	test("loadSession returns null for a missing session", () => {
		expect(loadSession("nope-not-here")).toBeNull()
	})

	test("sessionsDir lives under the APPDATA we set", () => {
		expect(sessionsDir().startsWith(tmp)).toBe(true)
	})
})

describe("listing & existence", () => {
	test("listSessionNames includes saved sessions", () => {
		saveSession(sample("legionary"))
		saveSession(sample("decanus"))
		const names = listSessionNames()
		expect(names).toContain("legionary")
		expect(names).toContain("decanus")
	})

	test("sessionExists reflects presence", () => {
		saveSession(sample("signifer"))
		expect(sessionExists("signifer")).toBe(true)
		expect(sessionExists("ghost")).toBe(false)
	})
})

describe("delete", () => {
	test("removes the session file and its scrollback dir", () => {
		saveSession(sample("triarius"))
		// Drop a fake scrollback capture alongside it.
		const cap = scrollbackPath("triarius", "optio")
		mkdirSync(scrollbackDir("triarius"), { recursive: true })
		writeFileSync(cap, "raw-bytes")
		expect(existsSync(cap)).toBe(true)

		expect(deleteSession("triarius")).toBe(true)
		expect(sessionExists("triarius")).toBe(false)
		expect(existsSync(scrollbackDir("triarius"))).toBe(false)
	})

	test("returns false when the session did not exist", () => {
		expect(deleteSession("was-never-here")).toBe(false)
	})
})

describe("generateSessionId", () => {
	test("does not collide with existing sessions", () => {
		saveSession(sample("legionary"))
		const id = generateSessionId()
		expect(listSessionNames()).not.toContain(id)
	})
})

describe("title", () => {
	test("round-trips the optional title field", () => {
		const state: SessionState = { ...sample("aquilifer"), title: "Fixing The Sidebar" }
		saveSession(state)
		expect(loadSession("aquilifer")?.title).toBe("Fixing The Sidebar")
	})
})
