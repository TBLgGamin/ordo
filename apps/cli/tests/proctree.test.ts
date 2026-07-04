import { describe, expect, test } from "bun:test"
import {
	buildProcessIndex,
	deepestWhitelisted,
	type ProcInfo,
	snapshotProcesses,
} from "../src/platform/proctree"

describe("snapshotProcesses", () => {
	test("returns a non-empty snapshot that includes this process", () => {
		const procs = snapshotProcesses()
		expect(procs.length).toBeGreaterThan(0)
		expect(procs.some((p) => p.pid === process.pid)).toBe(true)
		for (const p of procs) expect(p.name).toBe(p.name.toLowerCase())
	})

	test("every entry carries a numeric pid/ppid and a name", () => {
		for (const p of snapshotProcesses().slice(0, 50)) {
			expect(Number.isInteger(p.pid)).toBe(true)
			expect(Number.isInteger(p.ppid)).toBe(true)
			expect(typeof p.name).toBe("string")
		}
	})
})

describe("buildProcessIndex + deepestWhitelisted", () => {
	const procs: ProcInfo[] = [
		{ pid: 1, ppid: 0, name: "root" },
		{ pid: 10, ppid: 1, name: "pwsh" },
		{ pid: 20, ppid: 10, name: "git" },
		{ pid: 30, ppid: 20, name: "less" },
	]

	test("returns the deepest whitelisted descendant", () => {
		expect(deepestWhitelisted(buildProcessIndex(procs), 10, new Set(["git", "less"]))).toBe("less")
	})

	test("prefers the deeper match even when a shallower one is whitelisted too", () => {
		expect(deepestWhitelisted(buildProcessIndex(procs), 1, new Set(["pwsh", "less"]))).toBe("less")
	})

	test("returns null for an empty whitelist", () => {
		expect(deepestWhitelisted(buildProcessIndex(procs), 10, new Set())).toBeNull()
	})

	test("returns null when nothing matches", () => {
		expect(deepestWhitelisted(buildProcessIndex(procs), 10, new Set(["vim"]))).toBeNull()
	})

	test("returns null for a pid with no children", () => {
		expect(deepestWhitelisted(buildProcessIndex(procs), 999_999_999, new Set(["less"]))).toBeNull()
	})

	test("survives a pid-reuse cycle", () => {
		const cyclic: ProcInfo[] = [
			{ pid: 5, ppid: 6, name: "shell" },
			{ pid: 6, ppid: 5, name: "vim" },
		]
		expect(deepestWhitelisted(buildProcessIndex(cyclic), 5, new Set(["vim"]))).toBe("vim")
	})
})
