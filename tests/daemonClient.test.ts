import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DaemonClient, killSessionPanes } from "../src/daemon/daemonClient"

let tmp: string
let prevAppData: string | undefined

beforeEach(() => {
	prevAppData = process.env.APPDATA
	tmp = mkdtempSync(join(tmpdir(), "ordo-dc-"))
	process.env.APPDATA = tmp
})

afterEach(() => {
	if (prevAppData === undefined) delete process.env.APPDATA
	else process.env.APPDATA = prevAppData
	rmSync(tmp, { recursive: true, force: true })
})

describe("tryAttach", () => {
	test("returns false with no daemon.json and spawns nothing", async () => {
		const dc = new DaemonClient()
		expect(await dc.tryAttach()).toBe(false)
		dc.stop()
		expect(existsSync(join(tmp, "ordo", "daemon.json"))).toBe(false)
	})
})

describe("killSessionPanes", () => {
	test("resolves without side effects when no daemon is running", async () => {
		await killSessionPanes("ghost-session")
		expect(existsSync(join(tmp, "ordo", "daemon.json"))).toBe(false)
	})
})
