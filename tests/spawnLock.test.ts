import { existsSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { acquireSpawnLock, releaseSpawnLock } from "../src/daemon/spawnLock"

let dir: string

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "ordo-spawnlock-"))
})

afterEach(() => {
	try {
		rmSync(dir, { recursive: true, force: true })
	} catch {}
})

describe("spawn lock", () => {
	test("acquires when free and writes the owner pid", () => {
		const path = acquireSpawnLock(dir)
		expect(path).not.toBeNull()
		expect(readFileSync(path as string, "utf8")).toBe(String(process.pid))
	})

	test("a second acquire fails while a live owner holds it", () => {
		const first = acquireSpawnLock(dir)
		expect(first).not.toBeNull()
		expect(acquireSpawnLock(dir)).toBeNull()
	})

	test("reclaims a lock held by a dead pid", () => {
		const path = join(dir, "daemon.lock")
		writeFileSync(path, "999999999")
		const got = acquireSpawnLock(dir)
		expect(got).toBe(path)
		expect(readFileSync(path, "utf8")).toBe(String(process.pid))
	})

	test("reclaims a stale lock older than the timeout", () => {
		const path = join(dir, "daemon.lock")
		writeFileSync(path, "not-a-pid")
		const old = new Date(Date.now() - 60_000)
		utimesSync(path, old, old)
		expect(acquireSpawnLock(dir)).toBe(path)
	})

	test("release removes the lock file", () => {
		const path = acquireSpawnLock(dir)
		releaseSpawnLock(path as string)
		expect(existsSync(path as string)).toBe(false)
	})
})
