import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

let dir: string
const origDataDir = process.env.ORDO_DATA_DIR

beforeAll(() => {
	dir = mkdtempSync(join(tmpdir(), "ordo-daemoninfo-"))
	process.env.ORDO_DATA_DIR = join(dir, "ordo")
})

afterAll(() => {
	if (origDataDir === undefined) delete process.env.ORDO_DATA_DIR
	else process.env.ORDO_DATA_DIR = origDataDir
	try {
		rmSync(dir, { recursive: true, force: true })
	} catch {}
})

async function readInfoWith(content: string | null) {
	const { daemonInfoPath, readDaemonInfo } = await import("../src/core/daemonInfo")
	const path = daemonInfoPath()
	if (content === null) rmSync(path, { force: true })
	else writeFileSync(path, content)
	return readDaemonInfo()
}

describe("readDaemonInfo validation", () => {
	test("returns null when the file is absent", async () => {
		expect(await readInfoWith(null)).toBeNull()
	})

	test("returns null for empty object", async () => {
		expect(await readInfoWith("{}")).toBeNull()
	})

	test("returns null for a non-integer / out-of-range port", async () => {
		expect(await readInfoWith(JSON.stringify({ port: 0, token: "t", pid: 1 }))).toBeNull()
		expect(await readInfoWith(JSON.stringify({ port: 70000, token: "t", pid: 1 }))).toBeNull()
		expect(await readInfoWith(JSON.stringify({ port: "80", token: "t", pid: 1 }))).toBeNull()
	})

	test("returns null for a missing/blank token or bad pid", async () => {
		expect(await readInfoWith(JSON.stringify({ port: 5000, token: "", pid: 1 }))).toBeNull()
		expect(await readInfoWith(JSON.stringify({ port: 5000, token: "t", pid: 0 }))).toBeNull()
	})

	test("returns null for truncated / invalid JSON", async () => {
		expect(await readInfoWith('{"port":5000,')).toBeNull()
	})

	test("accepts a well-formed record", async () => {
		const info = await readInfoWith(JSON.stringify({ port: 51234, token: "abc", pid: 999 }))
		expect(info).toEqual({ port: 51234, token: "abc", pid: 999 })
	})
})
