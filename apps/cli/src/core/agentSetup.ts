import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import { BUN_EXE, ENTRY_PATH } from "./config"
import { type GooseBlock, mergeGooseExtension } from "./yamlMerge"

export interface SetupResult {
	tool: string
	action: "created" | "updated" | "unchanged" | "skipped"
	detail?: string
}

export type MergeOutcome =
	| { action: "unchanged" | "skipped"; detail?: string }
	| { action: "write"; content: string }

export interface SetupContext {
	home: string
	appData: string
	env: Record<string, string | undefined>
	which: (exe: string) => string | null
}

interface AgentDescriptor {
	id: string
	detect: "always" | { exe: string }
	configPath: (ctx: SetupContext) => string
	merge: (existing: string | null) => MergeOutcome
}

const COMMAND = BUN_EXE
const ARGS = ["run", ENTRY_PATH, "mcp"]

const STDIO_ENTRY = { command: COMMAND, args: ARGS }
const TYPED_STDIO_ENTRY = { type: "stdio", command: COMMAND, args: ARGS }
const COPILOT_ENTRY = { type: "local", command: COMMAND, args: ARGS, tools: ["*"] }
const OPENCODE_ENTRY = { type: "local", command: [COMMAND, ...ARGS], enabled: true }
const GOOSE_BLOCK: GooseBlock = { name: "ordo", cmd: COMMAND, args: ARGS, timeout: 300 }

function errText(e: unknown): string {
	return e instanceof Error ? e.message : String(e)
}

function atomicWrite(path: string, content: string): void {
	mkdirSync(dirname(path), { recursive: true })
	const tmp = `${path}.${process.pid}.${Date.now().toString(36)}.tmp`
	try {
		writeFileSync(tmp, content)
		renameSync(tmp, path)
	} catch (e) {
		try {
			rmSync(tmp, { force: true })
		} catch {}
		throw e
	}
}

function pointsAtOrdo(entry: unknown): boolean {
	if (!entry || typeof entry !== "object") return false
	const e = entry as { command?: unknown; args?: unknown }
	return (
		e.command === COMMAND &&
		Array.isArray(e.args) &&
		e.args.length === ARGS.length &&
		e.args.every((a, i) => a === ARGS[i])
	)
}

function pointsAtOrdoCmdArray(entry: unknown): boolean {
	if (!entry || typeof entry !== "object") return false
	const e = entry as { command?: unknown }
	const expected = [COMMAND, ...ARGS]
	return (
		Array.isArray(e.command) &&
		e.command.length === expected.length &&
		e.command.every((a, i) => a === expected[i])
	)
}

function tomlString(s: string): string {
	return `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`
}

function stripJsonc(text: string): string {
	let out = ""
	let inStr = false
	let esc = false
	for (let i = 0; i < text.length; i++) {
		const c = text[i]
		const n = text[i + 1]
		if (inStr) {
			out += c
			if (esc) esc = false
			else if (c === "\\") esc = true
			else if (c === '"') inStr = false
			continue
		}
		if (c === '"') {
			inStr = true
			out += c
			continue
		}
		if (c === "/" && n === "/") {
			while (i < text.length && text[i] !== "\n") i++
			out += "\n"
			continue
		}
		if (c === "/" && n === "*") {
			i += 2
			while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) i++
			i += 1
			continue
		}
		out += c
	}
	return out.replace(/,(\s*[}\]])/g, "$1")
}

function parseJsonc(text: string): unknown {
	return JSON.parse(stripJsonc(text))
}

function asObject(value: unknown): Record<string, unknown> {
	return value && typeof value === "object" ? (value as Record<string, unknown>) : {}
}

function setOrdoEntry(
	parsed: Record<string, unknown>,
	containerKey: string,
	entry: unknown,
	matches: (existing: unknown) => boolean,
): boolean {
	const container = asObject(parsed[containerKey])
	if (matches(container.ordo)) return false
	parsed[containerKey] = { ...container, ordo: entry }
	return true
}

function jsonMerge(
	containerKey: string,
	entry: unknown,
	matches: (existing: unknown) => boolean,
	opts: { jsonc?: boolean } = {},
): (existing: string | null) => MergeOutcome {
	return (existing) => {
		let parsed: Record<string, unknown>
		if (existing === null) {
			parsed = {}
		} else {
			let value: unknown
			try {
				value = opts.jsonc ? parseJsonc(existing) : JSON.parse(existing)
			} catch {
				return { action: "skipped", detail: "unparseable config file" }
			}
			if (!value || typeof value !== "object") {
				return { action: "skipped", detail: "unexpected config shape" }
			}
			parsed = value as Record<string, unknown>
		}
		if (!setOrdoEntry(parsed, containerKey, entry, matches)) return { action: "unchanged" }
		return { action: "write", content: JSON.stringify(parsed, null, 2) }
	}
}

function kiloMerge(existing: string | null): MergeOutcome {
	let parsed: Record<string, unknown>
	if (existing === null) {
		parsed = {}
	} else {
		let value: unknown
		try {
			value = parseJsonc(existing)
		} catch {
			return { action: "skipped", detail: "unparseable kilo.jsonc" }
		}
		if (!value || typeof value !== "object") {
			return { action: "skipped", detail: "unexpected kilo.jsonc shape" }
		}
		parsed = value as Record<string, unknown>
	}
	let changed = setOrdoEntry(parsed, "mcp", STDIO_ENTRY, pointsAtOrdo)
	const perm = asObject(parsed.permission)
	if (perm["ordo_*"] !== "allow") {
		parsed.permission = { ...perm, "ordo_*": "allow" }
		changed = true
	}
	if (!changed) return { action: "unchanged" }
	return { action: "write", content: JSON.stringify(parsed, null, 2) }
}

/** Drop any `[mcp_servers.ordo]` table (and its subtables) from a TOML text. */
function removeCodexOrdoBlock(text: string): string {
	const lines = text.split(/\r?\n/)
	const out: string[] = []
	let skipping = false
	for (const line of lines) {
		const header = line.match(/^\s*\[([^\]]+)\]/)
		if (header) {
			const name = (header[1] ?? "").replace(/["']/g, "")
			skipping = name === "mcp_servers.ordo" || name.startsWith("mcp_servers.ordo.")
		}
		if (!skipping) out.push(line)
	}
	return out.join("\n")
}

function codexMerge(existing: string | null): MergeOutcome {
	const text = existing ?? ""
	let entry: unknown
	try {
		const parsed = Bun.TOML.parse(text) as { mcp_servers?: Record<string, unknown> }
		entry = parsed?.mcp_servers?.ordo
	} catch {
		// Unparseable TOML: appending or rewriting blind could corrupt it further.
		return { action: "skipped", detail: "unparseable config.toml" }
	}
	// An existing entry only counts if it still points at THIS ordo — a stale
	// path (moved repo, old install) makes codex spawn a dead server, which it
	// reports as "Tools: (none)". Rewrite the block whenever it doesn't match.
	if (pointsAtOrdo(entry)) return { action: "unchanged" }
	const cleaned = entry === undefined ? text : removeCodexOrdoBlock(text)
	const block = `[mcp_servers.ordo]\ncommand = ${tomlString(COMMAND)}\nargs = [${ARGS.map(tomlString).join(", ")}]\n`
	const prefix = cleaned.trim() === "" ? "" : cleaned.replace(/\s*$/, "\n\n")
	return { action: "write", content: prefix + block }
}

function copilotHome(ctx: SetupContext): string {
	return ctx.env.COPILOT_HOME ?? join(ctx.home, ".copilot")
}

const DESCRIPTORS: AgentDescriptor[] = [
	{
		id: "claude",
		detect: "always",
		configPath: (ctx) => join(ctx.home, ".claude.json"),
		merge: jsonMerge("mcpServers", TYPED_STDIO_ENTRY, pointsAtOrdo),
	},
	{
		id: "codex",
		detect: "always",
		configPath: (ctx) => join(ctx.home, ".codex", "config.toml"),
		merge: codexMerge,
	},
	{
		id: "kilo",
		detect: "always",
		configPath: (ctx) => join(ctx.home, ".config", "kilo", "kilo.jsonc"),
		merge: kiloMerge,
	},
	{
		id: "gemini",
		detect: { exe: "gemini" },
		configPath: (ctx) => join(ctx.home, ".gemini", "settings.json"),
		merge: jsonMerge("mcpServers", STDIO_ENTRY, pointsAtOrdo),
	},
	{
		id: "qwen",
		detect: { exe: "qwen" },
		configPath: (ctx) => join(ctx.home, ".qwen", "settings.json"),
		merge: jsonMerge("mcpServers", STDIO_ENTRY, pointsAtOrdo),
	},
	{
		id: "opencode",
		detect: { exe: "opencode" },
		configPath: (ctx) => join(ctx.home, ".config", "opencode", "opencode.json"),
		merge: jsonMerge("mcp", OPENCODE_ENTRY, pointsAtOrdoCmdArray),
	},
	{
		id: "copilot",
		detect: { exe: "copilot" },
		configPath: (ctx) => join(copilotHome(ctx), "mcp-config.json"),
		merge: jsonMerge("mcpServers", COPILOT_ENTRY, pointsAtOrdo),
	},
	{
		id: "cursor",
		detect: { exe: "cursor-agent" },
		configPath: (ctx) => join(ctx.home, ".cursor", "mcp.json"),
		merge: jsonMerge("mcpServers", STDIO_ENTRY, pointsAtOrdo),
	},
	{
		id: "goose",
		detect: { exe: "goose" },
		configPath: (ctx) =>
			process.platform === "win32"
				? join(ctx.appData, "Block", "goose", "config", "config.yaml")
				: join(ctx.home, ".config", "goose", "config.yaml"),
		merge: (existing) => mergeGooseExtension(existing, GOOSE_BLOCK),
	},
	{
		id: "amp",
		detect: { exe: "amp" },
		configPath: (ctx) => join(ctx.home, ".config", "amp", "settings.json"),
		merge: jsonMerge("amp.mcpServers", STDIO_ENTRY, pointsAtOrdo),
	},
	{
		id: "droid",
		detect: { exe: "droid" },
		configPath: (ctx) => join(ctx.home, ".factory", "mcp.json"),
		merge: jsonMerge("mcpServers", TYPED_STDIO_ENTRY, pointsAtOrdo),
	},
]

function runDescriptor(d: AgentDescriptor, ctx: SetupContext): SetupResult {
	const path = d.configPath(ctx)
	try {
		if (d.detect !== "always") {
			const detected = ctx.which(d.detect.exe) !== null || existsSync(dirname(path))
			if (!detected) return { tool: d.id, action: "skipped", detail: "not detected" }
		}
		const existed = existsSync(path)
		const existing = existed ? readFileSync(path, "utf8") : null
		const outcome = d.merge(existing)
		if (outcome.action === "write") {
			atomicWrite(path, outcome.content)
			return { tool: d.id, action: existed ? "updated" : "created" }
		}
		return { tool: d.id, action: outcome.action, detail: outcome.detail }
	} catch (e) {
		return { tool: d.id, action: "skipped", detail: errText(e) }
	}
}

export function ensureAgentIntegrations(
	baseDir: string = homedir(),
	opts: {
		which?: (exe: string) => string | null
		appData?: string
		env?: Record<string, string | undefined>
	} = {},
): SetupResult[] {
	const env = opts.env ?? process.env
	const ctx: SetupContext = {
		home: baseDir,
		appData: opts.appData ?? platformAppData(baseDir, env),
		env,
		which: opts.which ?? ((e) => Bun.which(e)),
	}
	return DESCRIPTORS.map((d) => runDescriptor(d, ctx))
}

function platformAppData(baseDir: string, env: Record<string, string | undefined>): string {
	if (process.platform === "win32") return env.APPDATA ?? join(baseDir, "AppData", "Roaming")
	if (process.platform === "darwin") return join(baseDir, "Library", "Application Support")
	return env.XDG_CONFIG_HOME ?? join(baseDir, ".config")
}
