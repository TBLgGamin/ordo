import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { reconstructScreen } from "../src/daemon/replay"

let tmp: string
beforeAll(() => {
	tmp = mkdtempSync(join(tmpdir(), "ordo-replay-"))
})
afterAll(() => {
	rmSync(tmp, { recursive: true, force: true })
})

describe("reconstructScreen", () => {
	test("preserves text and color from a raw-VT capture", async () => {
		const cap = join(tmp, "a.vt")
		// red "HELLO", reset, then "world".
		writeFileSync(cap, "\x1b[31mHELLO\x1b[0m world\r\n")
		const screen = await reconstructScreen(cap, 80, 24, 200)
		expect(screen).toContain("HELLO")
		expect(screen).toContain("world")
		// The serialized output should still carry the red attribute (SGR 31).
		expect(/\[31m/.test(screen)).toBe(true)
	})

	test("reflects the final screen after a clear (no stale lines)", async () => {
		const cap = join(tmp, "b.vt")
		// Print junk, then clear screen + home, then the keeper line.
		writeFileSync(cap, "junk-old-content\r\n\x1b[2J\x1b[HKEEPER\r\n")
		const screen = await reconstructScreen(cap, 80, 24, 200)
		expect(screen).toContain("KEEPER")
		expect(screen).not.toContain("junk-old-content")
	})

	test("returns empty string for a missing file", async () => {
		expect(await reconstructScreen(join(tmp, "does-not-exist.vt"), 80, 24, 200)).toBe("")
	})

	test("returns empty string for an empty capture", async () => {
		const cap = join(tmp, "empty.vt")
		writeFileSync(cap, "")
		expect(await reconstructScreen(cap, 80, 24, 200)).toBe("")
	})
})
