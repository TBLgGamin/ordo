import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { ensureAgentIntegrations, type SetupResult } from "../src/core/agentSetup"

let base: string
beforeEach(() => {
	base = mkdtempSync(join(tmpdir(), "ordo-setup-"))
})
afterEach(() => {
	rmSync(base, { recursive: true, force: true })
})

const claudePath = () => join(base, ".claude.json")
const codexPath = () => join(base, ".codex", "config.toml")
const kiloPath = () => join(base, ".config", "kilo", "kilo.jsonc")

const stripJsonc = (t: string) => t.replace(/\/\/[^\n]*/g, "").replace(/,(\s*[}\]])/g, "$1")
const none = () => null
const byTool = (results: SetupResult[], id: string): SetupResult | undefined =>
	results.find((r) => r.tool === id)

describe("ensureAgentIntegrations (always-on trio)", () => {
	test("creates claude/codex/kilo from scratch, then is idempotent", () => {
		const first = ensureAgentIntegrations(base, { which: none })
		expect(byTool(first, "claude")?.action).toBe("created")
		expect(byTool(first, "codex")?.action).toBe("created")
		expect(byTool(first, "kilo")?.action).toBe("created")
		expect(existsSync(claudePath())).toBe(true)
		expect(existsSync(codexPath())).toBe(true)
		expect(existsSync(kiloPath())).toBe(true)

		const claude = JSON.parse(readFileSync(claudePath(), "utf8"))
		expect(claude.mcpServers.ordo.command).toBeString()
		expect(claude.mcpServers.ordo.args).toContain("mcp")

		const codex = readFileSync(codexPath(), "utf8")
		expect(codex).toContain("[mcp_servers.ordo]")

		const kilo = JSON.parse(stripJsonc(readFileSync(kiloPath(), "utf8")))
		expect(kilo.mcp.ordo.command).toBeString()
		expect(kilo.permission["ordo_*"]).toBe("allow")

		const second = ensureAgentIntegrations(base, { which: none })
		expect(byTool(second, "claude")?.action).toBe("unchanged")
		expect(byTool(second, "codex")?.action).toBe("unchanged")
		expect(byTool(second, "kilo")?.action).toBe("unchanged")
	})

	test("claude: merges without clobbering existing servers", () => {
		writeFileSync(
			claudePath(),
			JSON.stringify({ mcpServers: { other: { command: "x", args: [] } }, misc: 1 }, null, 2),
		)
		expect(byTool(ensureAgentIntegrations(base, { which: none }), "claude")?.action).toBe("updated")
		const parsed = JSON.parse(readFileSync(claudePath(), "utf8"))
		expect(parsed.mcpServers.other).toBeDefined()
		expect(parsed.mcpServers.ordo).toBeDefined()
		expect(parsed.misc).toBe(1)
	})

	test("claude: unparseable file is skipped, not clobbered", () => {
		writeFileSync(claudePath(), "{ this is not json")
		expect(byTool(ensureAgentIntegrations(base, { which: none }), "claude")?.action).toBe("skipped")
		expect(readFileSync(claudePath(), "utf8")).toBe("{ this is not json")
	})

	test("codex: appends to a file with unrelated sections, preserving them", () => {
		mkdirSync(join(base, ".codex"), { recursive: true })
		writeFileSync(codexPath(), '[model]\nname = "gpt"\n')
		expect(byTool(ensureAgentIntegrations(base, { which: none }), "codex")?.action).toBe("updated")
		const text = readFileSync(codexPath(), "utf8")
		expect(text).toContain("[model]")
		expect(text).toContain("[mcp_servers.ordo]")
		expect(byTool(ensureAgentIntegrations(base, { which: none }), "codex")?.action).toBe("unchanged")
	})

	test("codex: rewrites a stale ordo entry (old path) without touching the rest", () => {
		mkdirSync(join(base, ".codex"), { recursive: true })
		writeFileSync(
			codexPath(),
			[
				'[model]',
				'name = "gpt"',
				"",
				"[mcp_servers.ordo]",
				'command = "C:\\\\old\\\\bun.exe"',
				'args = ["run", "X:\\\\old\\\\repo\\\\src\\\\index.ts", "mcp"]',
				"",
				"[mcp_servers.ordo.env]",
				'STALE = "1"',
				"",
				"[mcp_servers.other]",
				'command = "keep-me"',
				"",
			].join("\n"),
		)
		expect(byTool(ensureAgentIntegrations(base, { which: none }), "codex")?.action).toBe("updated")
		const text = readFileSync(codexPath(), "utf8")
		expect(text).toContain('[model]')
		expect(text).toContain("keep-me")
		expect(text).not.toContain("X:\\\\old\\\\repo")
		expect(text).not.toContain("STALE")
		expect(text).toContain("[mcp_servers.ordo]")
		const parsed = Bun.TOML.parse(text) as {
			mcp_servers: { ordo: { command: string; args: string[] }; other: { command: string } }
		}
		expect(parsed.mcp_servers.ordo.args).toContain("mcp")
		expect(parsed.mcp_servers.other.command).toBe("keep-me")
		expect(byTool(ensureAgentIntegrations(base, { which: none }), "codex")?.action).toBe("unchanged")
	})

	test("codex: unparseable toml is skipped, not clobbered", () => {
		mkdirSync(join(base, ".codex"), { recursive: true })
		writeFileSync(codexPath(), "[model\nbroken = ")
		expect(byTool(ensureAgentIntegrations(base, { which: none }), "codex")?.action).toBe("skipped")
		expect(readFileSync(codexPath(), "utf8")).toBe("[model\nbroken = ")
	})

	test("kilo: merges into a commented jsonc file", () => {
		mkdirSync(join(base, ".config", "kilo"), { recursive: true })
		writeFileSync(kiloPath(), '{\n  // my config\n  "mcp": { "other": {} },\n}\n')
		expect(byTool(ensureAgentIntegrations(base, { which: none }), "kilo")?.action).toBe("updated")
		const parsed = JSON.parse(stripJsonc(readFileSync(kiloPath(), "utf8")))
		expect(parsed.mcp.other).toBeDefined()
		expect(parsed.mcp.ordo).toBeDefined()
		expect(parsed.permission["ordo_*"]).toBe("allow")
	})
})

describe("ensureAgentIntegrations (detection-gated agents)", () => {
	test("undetected agents are skipped without writing anything", () => {
		const results = ensureAgentIntegrations(base, { which: none })
		for (const id of ["gemini", "qwen", "opencode", "copilot", "cursor", "goose", "amp", "droid"]) {
			expect(byTool(results, id)?.action).toBe("skipped")
			expect(byTool(results, id)?.detail).toBe("not detected")
		}
		expect(existsSync(join(base, ".gemini"))).toBe(false)
	})

	test("an existing config dir counts as detection (gemini)", () => {
		mkdirSync(join(base, ".gemini"), { recursive: true })
		expect(byTool(ensureAgentIntegrations(base, { which: none }), "gemini")?.action).toBe("created")
		const parsed = JSON.parse(readFileSync(join(base, ".gemini", "settings.json"), "utf8"))
		expect(parsed.mcpServers.ordo.command).toBeString()
		expect(parsed.mcpServers.ordo.args).toContain("mcp")
	})

	test("a which() hit triggers opencode with an array command", () => {
		const which = (e: string) => (e === "opencode" ? "C:\\bin\\opencode.exe" : null)
		expect(byTool(ensureAgentIntegrations(base, { which }), "opencode")?.action).toBe("created")
		const parsed = JSON.parse(
			readFileSync(join(base, ".config", "opencode", "opencode.json"), "utf8"),
		)
		expect(parsed.mcp.ordo.type).toBe("local")
		expect(parsed.mcp.ordo.enabled).toBe(true)
		expect(Array.isArray(parsed.mcp.ordo.command)).toBe(true)
		expect(parsed.mcp.ordo.command).toContain("mcp")
	})

	test("copilot honors COPILOT_HOME and writes tools: ['*']", () => {
		const home = join(base, "copilot-home")
		mkdirSync(home, { recursive: true })
		const res = ensureAgentIntegrations(base, {
			which: none,
			env: { COPILOT_HOME: home },
		})
		expect(byTool(res, "copilot")?.action).toBe("created")
		const parsed = JSON.parse(readFileSync(join(home, "mcp-config.json"), "utf8"))
		expect(parsed.mcpServers.ordo.type).toBe("local")
		expect(parsed.mcpServers.ordo.tools).toEqual(["*"])
	})

	test("amp uses a flat dotted key and preserves siblings", () => {
		mkdirSync(join(base, ".config", "amp"), { recursive: true })
		writeFileSync(join(base, ".config", "amp", "settings.json"), JSON.stringify({ "amp.foo": 1 }))
		expect(byTool(ensureAgentIntegrations(base, { which: none }), "amp")?.action).toBe("updated")
		const parsed = JSON.parse(readFileSync(join(base, ".config", "amp", "settings.json"), "utf8"))
		expect(parsed["amp.foo"]).toBe(1)
		expect(parsed["amp.mcpServers"].ordo.command).toBeString()
	})

	test("goose writes a YAML extensions block", () => {
		const appData = join(base, "AppData", "Roaming")
		const which = (e: string) => (e === "goose" ? "C:\\bin\\goose.exe" : null)
		expect(byTool(ensureAgentIntegrations(base, { which, appData }), "goose")?.action).toBe(
			"created",
		)
		const goosePath =
			process.platform === "win32"
				? join(appData, "Block", "goose", "config", "config.yaml")
				: join(base, ".config", "goose", "config.yaml")
		const yaml = readFileSync(goosePath, "utf8")
		expect(yaml).toContain("extensions:")
		expect(yaml).toContain("ordo:")
		expect(yaml).toContain("type: stdio")
	})

	test("detected agents are idempotent on a second run", () => {
		mkdirSync(join(base, ".gemini"), { recursive: true })
		ensureAgentIntegrations(base, { which: none })
		expect(byTool(ensureAgentIntegrations(base, { which: none }), "gemini")?.action).toBe(
			"unchanged",
		)
	})
})
