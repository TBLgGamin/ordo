import { afterEach, describe, expect, test } from "bun:test"
import type { Subprocess } from "bun"
import { foregroundProgram } from "../src/platform/proctree"

let child: Subprocess | undefined
afterEach(() => {
	child?.kill()
	child = undefined
})

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms))

describe("foregroundProgram", () => {
	test("detects a whitelisted descendant of a process", async () => {
		// bun -> cmd -> ping : ping is the deepest descendant of this process.
		child = Bun.spawn(["cmd.exe", "/c", "ping -n 5 127.0.0.1 >nul"], {
			stdin: "ignore",
			stdout: "ignore",
			stderr: "ignore",
		})
		await delay(500)
		expect(foregroundProgram(process.pid, new Set(["cmd", "ping"]))).toBe("ping")
	}, 10000)

	test("returns null when no descendant is whitelisted", async () => {
		child = Bun.spawn(["cmd.exe", "/c", "ping -n 5 127.0.0.1 >nul"], {
			stdin: "ignore",
			stdout: "ignore",
			stderr: "ignore",
		})
		await delay(500)
		expect(foregroundProgram(process.pid, new Set(["vim", "nvim"]))).toBeNull()
	}, 10000)

	test("returns null for an empty whitelist", () => {
		expect(foregroundProgram(process.pid, new Set())).toBeNull()
	})

	test("returns null for a pid with no children", () => {
		expect(foregroundProgram(999_999_999, new Set(["cmd"]))).toBeNull()
	})
})
