import { describe, expect, test } from "bun:test"
import { type GooseBlock, mergeGooseExtension } from "../src/core/yamlMerge"

const block: GooseBlock = {
	name: "ordo",
	cmd: "C:\\Users\\me\\.bun\\bin\\bun.exe",
	args: ["run", "X:\\ordo\\src\\index.ts", "mcp"],
	timeout: 300,
}

describe("mergeGooseExtension", () => {
	test("creates a fresh document when there is no file", () => {
		const res = mergeGooseExtension(null, block)
		expect(res.action).toBe("write")
		if (res.action === "write") {
			expect(res.content).toContain("extensions:")
			expect(res.content).toContain("  ordo:")
			expect(res.content).toContain("type: stdio")
			expect(res.content).toContain("enabled: true")
			expect(res.content).toContain("timeout: 300")
			expect(res.content).toContain('"C:\\\\Users\\\\me\\\\.bun\\\\bin\\\\bun.exe"')
		}
	})

	test("inserts under an existing extensions block, preserving siblings", () => {
		const existing = "extensions:\n  weather:\n    cmd: uvx\n    enabled: true\n"
		const res = mergeGooseExtension(existing, block)
		expect(res.action).toBe("write")
		if (res.action === "write") {
			expect(res.content).toContain("weather:")
			expect(res.content).toContain("ordo:")
			expect(res.content.indexOf("ordo:")).toBeGreaterThan(res.content.indexOf("extensions:"))
		}
	})

	test("is unchanged when ordo already present", () => {
		const existing = "extensions:\n  ordo:\n    name: ordo\n    enabled: true\n"
		expect(mergeGooseExtension(existing, block).action).toBe("unchanged")
	})

	test("appends a fresh extensions block when the file has other top-level keys", () => {
		const existing = "GOOSE_MODEL: gpt\n"
		const res = mergeGooseExtension(existing, block)
		expect(res.action).toBe("write")
		if (res.action === "write") {
			expect(res.content).toContain("GOOSE_MODEL: gpt")
			expect(res.content).toContain("extensions:")
			expect(res.content).toContain("ordo:")
		}
	})

	test("skips an inline flow-style extensions mapping rather than corrupt it", () => {
		const existing = "extensions: {}\n"
		expect(mergeGooseExtension(existing, block).action).toBe("skipped")
	})

	test("skips a file that uses tabs", () => {
		const existing = "extensions:\n\tordo:\n"
		expect(mergeGooseExtension(existing, block).action).toBe("skipped")
	})
})
