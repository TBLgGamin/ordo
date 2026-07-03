import { describe, expect, test } from "bun:test"
import {
	buildFocusArgs,
	buildPaneArgs,
	buildSelfWindowArgs,
	buildTabArgs,
	buildWindowArgs,
	isDirection,
} from "../src/platform/wt"

describe("isDirection", () => {
	test("accepts the four tiling directions", () => {
		for (const d of ["left", "right", "up", "down"]) expect(isDirection(d)).toBe(true)
	})

	test("rejects anything else", () => {
		for (const s of ["", "Left", "north", "tab", "win", "up-down"]) {
			expect(isDirection(s)).toBe(false)
		}
	})
})

const target = ["-w", "0"]
const cmd = ["bun", "attachClient.ts", "--pane", "optio"]

describe("buildPaneArgs", () => {
	test("right splits with -V and no swap", () => {
		expect(buildPaneArgs({ direction: "right", commandline: cmd }, target)).toEqual([
			"-w",
			"0",
			"split-pane",
			"-V",
			...cmd,
		])
	})

	test("left splits with -V then swaps left onto the intended side", () => {
		const args = buildPaneArgs({ direction: "left", commandline: cmd }, target)
		expect(args.slice(0, 4)).toEqual(["-w", "0", "split-pane", "-V"])
		expect(args.slice(-3)).toEqual([";", "swap-pane", "left"])
	})

	test("up splits with -H and swaps up", () => {
		const args = buildPaneArgs({ direction: "up", commandline: cmd }, target)
		expect(args).toContain("-H")
		expect(args.slice(-3)).toEqual([";", "swap-pane", "up"])
	})

	test("down splits with -H and no swap", () => {
		const args = buildPaneArgs({ direction: "down", commandline: cmd }, target)
		expect(args).toContain("-H")
		expect(args).not.toContain("swap-pane")
	})

	test("keeps a cwd/title with spaces as single argv tokens", () => {
		const args = buildPaneArgs(
			{ direction: "right", commandline: cmd, cwd: "C:\\Users\\a\\My Project", title: "leg ion" },
			target,
		)
		const d = args.indexOf("-d")
		expect(args[d + 1]).toBe("C:\\Users\\a\\My Project")
		const t = args.indexOf("--title")
		expect(args[t + 1]).toBe("leg ion")
	})

	test("adds --size when provided", () => {
		const args = buildPaneArgs({ direction: "right", commandline: cmd, size: 0.4 }, target)
		const s = args.indexOf("--size")
		expect(args[s + 1]).toBe("0.4")
	})

	test("gates the window target: empty target omits -w", () => {
		const args = buildPaneArgs({ direction: "right", commandline: cmd }, [])
		expect(args[0]).toBe("split-pane")
		expect(args).not.toContain("-w")
	})
})

describe("buildTabArgs", () => {
	test("builds a new-tab with cwd and title", () => {
		expect(buildTabArgs({ commandline: cmd, cwd: "C:\\w", title: "optio" }, target)).toEqual([
			"-w",
			"0",
			"new-tab",
			"-d",
			"C:\\w",
			"--title",
			"optio",
			...cmd,
		])
	})
})

describe("buildWindowArgs", () => {
	test("always opens a new window and pins the title to find its HWND", () => {
		const args = buildWindowArgs({
			commandline: cmd,
			pos: { x: 10, y: 20 },
			size: { cols: 80, rows: 24 },
			title: "optio",
			tabColor: "#abcdef",
		})
		expect(args.slice(0, 2)).toEqual(["-w", "new"])
		expect(args.indexOf("--pos") >= 0 && args[args.indexOf("--pos") + 1] === "10,20").toBe(true)
		expect(args[args.indexOf("--size") + 1]).toBe("80,24")
		expect(args[args.indexOf("--tabColor") + 1]).toBe("#abcdef")
		expect(args).toContain("--suppressApplicationTitle")
	})

	test("omits --suppressApplicationTitle when there's no title", () => {
		const args = buildWindowArgs({ commandline: cmd })
		expect(args).not.toContain("--suppressApplicationTitle")
	})
})

describe("buildSelfWindowArgs", () => {
	test("opens a fresh window without pinning the title", () => {
		const args = buildSelfWindowArgs(cmd, "C:\\w", "ordo")
		expect(args.slice(0, 5)).toEqual(["-w", "new", "new-tab", "-d", "C:\\w"])
		expect(args).not.toContain("--suppressApplicationTitle")
		expect(args[args.indexOf("--title") + 1]).toBe("ordo")
	})
})

describe("buildFocusArgs", () => {
	test("targets the window and moves focus in a direction", () => {
		expect(buildFocusArgs("left", target)).toEqual(["-w", "0", "move-focus", "left"])
	})
})
