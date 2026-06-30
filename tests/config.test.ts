import { describe, expect, test } from "bun:test"
import { RESTORE_PROGRAMS, SCROLLBACK_LINES } from "../src/config"

describe("RESTORE_PROGRAMS (defaults)", () => {
	test("is a non-empty set of lowercased program names", () => {
		expect(RESTORE_PROGRAMS.size).toBeGreaterThan(0)
		expect(RESTORE_PROGRAMS.has("vim")).toBe(true)
		expect(RESTORE_PROGRAMS.has("claude")).toBe(true)
		for (const name of RESTORE_PROGRAMS) expect(name).toBe(name.toLowerCase())
	})
})

describe("SCROLLBACK_LINES (default)", () => {
	test("defaults to a positive integer", () => {
		expect(SCROLLBACK_LINES).toBe(1000)
	})
})

describe("ORDO_RESTORE_PROGRAMS override", () => {
	test("parses a space/comma separated, case-insensitive override", async () => {
		const proc = Bun.spawn(
			["bun", "-e", "import('./src/config.ts').then(m=>process.stdout.write(JSON.stringify([...m.RESTORE_PROGRAMS])))"],
			{
				env: { ...process.env, ORDO_RESTORE_PROGRAMS: "Foo, bar  BAZ" },
				stdout: "pipe",
				stderr: "ignore",
			},
		)
		await proc.exited
		const list = JSON.parse(await new Response(proc.stdout).text()) as string[]
		expect(new Set(list)).toEqual(new Set(["foo", "bar", "baz"]))
	}, 15000)

	test("empty override disables relaunch (empty set)", async () => {
		const proc = Bun.spawn(
			["bun", "-e", "import('./src/config.ts').then(m=>process.stdout.write(String(m.RESTORE_PROGRAMS.size)))"],
			{ env: { ...process.env, ORDO_RESTORE_PROGRAMS: "" }, stdout: "pipe", stderr: "ignore" },
		)
		await proc.exited
		expect(await new Response(proc.stdout).text()).toBe("0")
	}, 15000)
})
