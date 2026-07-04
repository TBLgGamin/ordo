import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { CaptureWriter } from "../src/daemon/capture"

let tmp: string

beforeEach(() => {
	tmp = mkdtempSync(join(tmpdir(), "ordo-cap-"))
})

afterEach(() => {
	rmSync(tmp, { recursive: true, force: true })
})

const enc = (s: string) => new TextEncoder().encode(s)

describe("CaptureWriter", () => {
	test("preserves write order after close()", async () => {
		const path = join(tmp, "order.log")
		const w = new CaptureWriter(path)
		for (let i = 0; i < 200; i++) w.write(enc(`L${i}\n`))
		await w.close()
		const lines = readFileSync(path, "utf8").trim().split("\n")
		expect(lines).toEqual(Array.from({ length: 200 }, (_, i) => `L${i}`))
	})

	test("releases the file handle so it can be deleted right after close()", async () => {
		const path = join(tmp, "del.log")
		const w = new CaptureWriter(path)
		w.write(enc("some data"))
		await w.close()
		expect(() => rmSync(path, { force: true })).not.toThrow()
		expect(existsSync(path)).toBe(false)
	})

	test("compacts past MAX while keeping the tail", async () => {
		const path = join(tmp, "big.log")
		const w = new CaptureWriter(path)
		const filler = new Uint8Array(256 * 1024).fill(65)
		for (let i = 0; i < 40; i++) w.write(filler)
		w.write(enc("TAIL_MARKER_END"))
		await w.close()
		const size = statSync(path).size
		expect(size).toBeLessThan(9 * 1024 * 1024)
		expect(readFileSync(path, "utf8").endsWith("TAIL_MARKER_END")).toBe(true)
	}, 20000)

	test("appends to an existing capture", async () => {
		const path = join(tmp, "append.log")
		const a = new CaptureWriter(path)
		a.write(enc("first\n"))
		await a.close()
		const b = new CaptureWriter(path)
		b.write(enc("second\n"))
		await b.close()
		expect(readFileSync(path, "utf8")).toBe("first\nsecond\n")
	})
})
