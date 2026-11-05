import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { cleanCaptureLines, gatherActivity, stripPromptPrefix } from "../src/app/title"
import { scrollbackDir, scrollbackPath } from "../src/core/session"

describe("stripPromptPrefix", () => {
	test("strips PowerShell prompts", () => {
		expect(stripPromptPrefix("PS X:\\github\\ordo\\apps\\cli> bun test")).toBe("bun test")
		expect(stripPromptPrefix("PS> git status")).toBe("git status")
	})

	test("strips cmd.exe prompts", () => {
		expect(stripPromptPrefix("C:\\Users\\wajva>dir /b")).toBe("dir /b")
		expect(stripPromptPrefix("X:\\github\\ordo> git log")).toBe("git log")
	})

	test("strips bash/zsh user@host prompts", () => {
		expect(stripPromptPrefix("wajva@devbox:~/github/ordo$ make build")).toBe("make build")
		expect(stripPromptPrefix("root@ci:/srv# systemctl status ordo")).toBe("systemctl status ordo")
		expect(stripPromptPrefix("wajva@mac:~/src% ls -la")).toBe("ls -la")
	})

	test("strips venv and minimal prompts", () => {
		expect(stripPromptPrefix("(venv) $ pytest -x")).toBe("pytest -x")
		expect(stripPromptPrefix("❯ cargo check")).toBe("cargo check")
		expect(stripPromptPrefix("$ npm run dev")).toBe("npm run dev")
	})

	test("leaves plain output alone", () => {
		expect(stripPromptPrefix("12 pass, 0 fail")).toBe("12 pass, 0 fail")
		expect(stripPromptPrefix("git@github.com: Permission denied")).toBe(
			"git@github.com: Permission denied",
		)
		expect(stripPromptPrefix("error TS2345: wrong type")).toBe("error TS2345: wrong type")
	})
})

describe("cleanCaptureLines", () => {
	test("drops prompt-only lines (the idle-shell redraw noise)", () => {
		const text = [
			"PS X:\\github\\ordo\\apps\\cli> bun test",
			"12 pass, 0 fail",
			"PS X:\\github\\ordo\\apps\\cli>",
			"PS X:\\github\\ordo\\apps\\cli>",
			"PS X:\\github\\ordo\\apps\\cli>",
		].join("\n")
		expect(cleanCaptureLines(text)).toEqual(["bun test", "12 pass, 0 fail"])
	})

	test("drops decoration-only lines and blanks", () => {
		const text = "────────────\n\n   \n│ │\n=== done ==="
		expect(cleanCaptureLines(text)).toEqual(["=== done ==="])
	})

	test("collapses consecutive duplicate lines (spinner/TUI redraws)", () => {
		const text = "Compiling...\nCompiling...\nCompiling...\nFinished in 2s"
		expect(cleanCaptureLines(text)).toEqual(["Compiling...", "Finished in 2s"])
	})

	test("drops the restore separator", () => {
		const text = "before\n──────── restored ────────\nafter"
		expect(cleanCaptureLines(text)).toEqual(["before", "after"])
	})

	test("mixed cross-platform session keeps only signal", () => {
		const text = [
			"wajva@devbox:~/ordo$ git pull",
			"Already up to date.",
			"wajva@devbox:~/ordo$",
			"wajva@devbox:~/ordo$",
			"C:\\Users\\wajva>echo hi",
			"hi",
			"C:\\Users\\wajva>",
		].join("\n")
		expect(cleanCaptureLines(text)).toEqual(["git pull", "Already up to date.", "echo hi", "hi"])
	})
})

describe("gatherActivity", () => {
	let tmp: string
	let prevDataDir: string | undefined
	beforeAll(() => {
		prevDataDir = process.env.ORDO_DATA_DIR
		tmp = mkdtempSync(join(tmpdir(), "ordo-title-"))
		process.env.ORDO_DATA_DIR = join(tmp, "ordo")
	})
	afterAll(() => {
		if (prevDataDir === undefined) delete process.env.ORDO_DATA_DIR
		else process.env.ORDO_DATA_DIR = prevDataDir
		rmSync(tmp, { recursive: true, force: true })
	})
	const capture = (pane: string, text: string) => {
		mkdirSync(scrollbackDir("legate"), { recursive: true })
		writeFileSync(scrollbackPath("legate", pane), text)
	}

	test("a chatty pane cannot push quieter panes out of the prompt", () => {
		capture("scout", "git status\nnothing to commit")
		const noisy = Array.from({ length: 200 }, (_, i) => `build step ${i} ${"x".repeat(300)}`)
		capture("forge", noisy.join("\n"))
		capture("relay", "bun test\n366 pass, 0 fail")
		const prompt = gatherActivity("legate", ["scout", "forge", "relay"]) ?? ""
		expect(prompt.length).toBeLessThanOrEqual(32_000)
		expect(prompt).toContain("scout:\ngit status\nnothing to commit")
		expect(prompt).toContain("relay:\nbun test\n366 pass, 0 fail")
		// the noisy pane keeps its newest lines, not its oldest
		expect(prompt).toContain("build step 199")
		expect(prompt).not.toContain("build step 0 ")
	})

	test("returns null when no pane has activity", () => {
		expect(gatherActivity("legate", ["nobody"])).toBeNull()
	})
})
