import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
	deleteSession,
	generateSessionId,
	listSessionNames,
	loadSession,
	type SessionState,
	saveSession,
	scrollbackDir,
	scrollbackPath,
	sessionExists,
	sessionsDir,
} from "../src/core/session"

// paths.ts honors ORDO_DATA_DIR above all per-OS logic, so point it at a temp dir
// to isolate the data directory identically on every platform.
let tmp: string
let base: string
let prevDataDir: string | undefined

beforeAll(() => {
	prevDataDir = process.env.ORDO_DATA_DIR
	tmp = mkdtempSync(join(tmpdir(), "ordo-test-"))
	base = join(tmp, "ordo")
	process.env.ORDO_DATA_DIR = base
})

afterAll(() => {
	if (prevDataDir === undefined) delete process.env.ORDO_DATA_DIR
	else process.env.ORDO_DATA_DIR = prevDataDir
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
			anchored: true,
		},
	],
})

describe("save / load", () => {
	test("round-trips pane metadata including its anchor", () => {
		const state = sample("centurion")
		saveSession(state)
		const loaded = loadSession("centurion")
		expect(loaded).toEqual(state)
		expect(loaded?.satellites[0]?.foreground).toBe("vim")
		expect(loaded?.satellites[0]?.anchored).toBe(true)
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

	test("round-trips a manual title flag", () => {
		const state: SessionState = { ...sample("optio2"), title: "My Title", manualTitle: true }
		saveSession(state)
		const loaded = loadSession("optio2")
		expect(loaded?.title).toBe("My Title")
		expect(loaded?.manualTitle).toBe(true)
	})

	test("drops a non-boolean manualTitle", () => {
		writeFileSync(
			join(sessionsDir(), "badflag.json"),
			JSON.stringify({
				id: "badflag",
				updatedAt: "t",
				center: { x: 0, y: 0, w: 1, h: 1 },
				satellites: [],
				manualTitle: "yes",
			}),
		)
		expect(loadSession("badflag")?.manualTitle).toBeUndefined()
	})
})

describe("loadSession validation", () => {
	const writeRaw = (name: string, json: string) => {
		writeFileSync(join(sessionsDir(), `${name}.json`), json)
	}

	test("returns null for a JSON array", () => {
		writeRaw("bad-array", "[]")
		expect(loadSession("bad-array")).toBeNull()
	})

	test("returns null when id is missing", () => {
		writeRaw("no-id", JSON.stringify({ satellites: [], center: { x: 0, y: 0, w: 1, h: 1 } }))
		expect(loadSession("no-id")).toBeNull()
	})

	test("returns null when satellites is not an array", () => {
		writeRaw(
			"bad-sats",
			JSON.stringify({ id: "x", satellites: {}, center: { x: 0, y: 0, w: 1, h: 1 } }),
		)
		expect(loadSession("bad-sats")).toBeNull()
	})

	test("returns null when center is not a rect", () => {
		writeRaw("bad-center", JSON.stringify({ id: "x", satellites: [], center: null }))
		expect(loadSession("bad-center")).toBeNull()
	})

	test("filters out malformed satellite entries", () => {
		writeRaw(
			"mixed-sats",
			JSON.stringify({
				id: "x",
				updatedAt: "t",
				center: { x: 0, y: 0, w: 1, h: 1 },
				satellites: [
					{ id: "ok", direction: "left", rect: { x: 0, y: 0, w: 1, h: 1 } },
					{ id: "bad-dir", direction: "sideways", rect: { x: 0, y: 0, w: 1, h: 1 } },
					{ id: "no-rect", direction: "right" },
					"not-an-object",
				],
			}),
		)
		const loaded = loadSession("mixed-sats")
		expect(loaded?.satellites).toHaveLength(1)
		expect(loaded?.satellites[0]?.id).toBe("ok")
	})
})

describe("saveSession atomicity", () => {
	test("leaves no .tmp file behind", () => {
		saveSession(sample("hastatus"))
		expect(existsSync(join(sessionsDir(), "hastatus.json"))).toBe(true)
		expect(existsSync(join(sessionsDir(), "hastatus.json.tmp"))).toBe(false)
	})
})
