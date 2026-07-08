import { describe, expect, test } from "bun:test"
import { buildLinuxArgv } from "../src/platform/linux/terminals"
import { detectTerminal } from "../src/platform/shared/detect"

const whichAll = (e: string) => `/usr/bin/${e}`
const whichNone = () => null

describe("detectTerminal", () => {
	test("ORDO_TERMINAL wins as a known id", () => {
		const c = detectTerminal("linux", { env: { ORDO_TERMINAL: "kitty" }, which: whichAll })
		expect(c.id).toBe("kitty")
		expect(c.exe).toBe("/usr/bin/kitty")
	})

	test("ORDO_TERMINAL as a path becomes generic", () => {
		const c = detectTerminal("linux", {
			env: { ORDO_TERMINAL: "/opt/foo/myterm" },
			which: whichNone,
		})
		expect(c.id).toBe("generic")
		expect(c.exe).toBe("/opt/foo/myterm")
	})

	test("detects the terminal ordo is running inside", () => {
		const c = detectTerminal("linux", { env: { KITTY_WINDOW_ID: "3" }, which: whichAll })
		expect(c.id).toBe("kitty")
	})

	test("falls back through the linux preference list", () => {
		const only = (e: string) => (e === "alacritty" ? "/usr/bin/alacritty" : null)
		const c = detectTerminal("linux", { env: {}, which: only })
		expect(c.id).toBe("alacritty")
	})

	test("darwin always has apple-terminal as a last resort", () => {
		const c = detectTerminal("darwin", { env: {}, which: whichNone })
		expect(c.id).toBe("apple-terminal")
		expect(c.exe).toBe("")
	})

	test("darwin prefers a running iTerm", () => {
		const c = detectTerminal("darwin", { env: { TERM_PROGRAM: "iTerm.app" }, which: whichNone })
		expect(c.id).toBe("iterm2")
	})
})

describe("buildLinuxArgv", () => {
	const cmd = ["bun", "attachClient.ts", "sess", "optio"]

	test("kitty passes title, directory, class and the command", () => {
		const argv = buildLinuxArgv("kitty", "kitty", {
			commandline: cmd,
			cwd: "/home/x",
			title: "optio",
		})
		expect(argv[0]).toBe("kitty")
		expect(argv).toContain("--title")
		expect(argv[argv.indexOf("--directory") + 1]).toBe("/home/x")
		expect(argv.slice(-cmd.length)).toEqual(cmd)
	})

	test("wezterm uses start ... -- <cmd>", () => {
		const argv = buildLinuxArgv("wezterm", "wezterm", { commandline: cmd, cwd: "/w" })
		expect(argv.slice(0, 2)).toEqual(["wezterm", "start"])
		expect(argv[argv.indexOf("--") + 1]).toBe("bun")
	})

	test("gnome-terminal uses -- to separate the command", () => {
		const argv = buildLinuxArgv("gnome-terminal", "gnome-terminal", { commandline: cmd })
		expect(argv.slice(-cmd.length)).toEqual(cmd)
		expect(argv).toContain("--")
	})

	test("unknown id falls back to -e", () => {
		const argv = buildLinuxArgv("generic", "x-terminal-emulator", { commandline: cmd })
		expect(argv).toEqual(["x-terminal-emulator", "-e", ...cmd])
	})
})
