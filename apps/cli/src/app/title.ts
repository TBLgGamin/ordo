/**
 * Local session titling.
 *
 * Generates a short, human-friendly session title from recent pane activity
 * using SupraLabs' Supra-Title-350M — a tiny LFM2 GGUF model trained purely to
 * write conversation titles — run in-process via node-llama-cpp.
 *
 * Everything here is best-effort: if the model can't be downloaded or loaded
 * (offline, disabled, unsupported), titling silently turns itself off and the
 * caller falls back to showing the session id. The model is loaded lazily on the
 * first request and reused; node-llama-cpp does inference on native threads, so
 * a generation doesn't block the TUI's event loop.
 *
 * The model expects the conversation text as the user turn with NO system prompt
 * (it wasn't trained with one), so we send the gathered activity verbatim.
 */

import { readFileSync } from "node:fs"
import { MODELS_DIR, TITLE_MODEL_URI } from "../core/config"
import { scrollbackPath } from "../core/session"

// node-llama-cpp's types — imported lazily so the native binding only loads if
// titling actually runs (and a missing/broken install can't crash startup).
type Llama = Awaited<ReturnType<typeof import("node-llama-cpp").getLlama>>
type LlamaModel = Awaited<ReturnType<Llama["loadModel"]>>
type LlamaContext = Awaited<ReturnType<LlamaModel["createContext"]>>
type LlamaContextSequence = ReturnType<LlamaContext["getSequence"]>

interface Loaded {
	model: LlamaModel
	context?: LlamaContext
	sequence?: LlamaContextSequence
}

let loaded: Loaded | null = null
let disabled = false
let failures = 0
let retryAt = 0
/** De-duplicate concurrent load attempts. */
let loadPromise: Promise<Loaded | null> | null = null

const MAX_LOAD_FAILURES = 5
const RETRY_BASE_MS = 60_000
const RETRY_CAP_MS = 3_600_000

/**
 * How much of each pane's capture tail to read / feed. Generous on purpose:
 * we want the title to reflect the whole session, not the last command. The
 * char cap is only a coarse safety net — the precise limit is enforced in
 * tokens against the model context right before generation.
 */
const READ_TAIL_BYTES = 256 * 1024
const LINES_PER_PANE = 200
const MAX_PROMPT_CHARS = 32_000
/** Model context (tokens) for the title context; prompts are trimmed to fit. */
const CONTEXT_SIZE = 8192
/** Tokens reserved for the chat template wrapper + the generated title. */
const CONTEXT_RESERVE_TOKENS = 128

// biome-ignore lint/suspicious/noControlCharactersInRegex: matching VT CSI escape bytes
const ANSI_CSI = /\x1b\[[0-9;?]*[ -/]*[@-~]/g
// biome-ignore lint/suspicious/noControlCharactersInRegex: matching VT OSC escape bytes
const ANSI_OSC = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g
// biome-ignore lint/suspicious/noControlCharactersInRegex: matching two-byte VT escapes
const ANSI_ESC = /\x1b[@-Z\\-_]/g
const CR = /\r/g
const captureDecoder = new TextDecoder()

/** Strip the ANSI/VT control sequences out of raw terminal capture. */
function stripAnsi(s: string): string {
	return s.replace(ANSI_CSI, "").replace(ANSI_OSC, "").replace(ANSI_ESC, "").replace(CR, "")
}

/**
 * Shell-prompt prefixes across the platforms we run on. A line that is ONLY a
 * prompt carries no signal (idle shells redraw them constantly); a line that
 * starts with one is a command — the prefix is stripped, the command kept.
 */
const PROMPT_PREFIXES = [
	/^PS(?: [^>]*)?>\s?/, // PowerShell: `PS C:\path>`
	/^>>\s/, // PowerShell/cmd continuation prompt
	/^[A-Za-z]:\\[^<>|]*>\s?/, // cmd.exe: `C:\path>`
	/^[^\s@]+@[^\s:]+:[^\n$#%]*[$#%]\s?/, // bash/zsh: `user@host:~/dir$`
	/^\([^)]+\)\s*[$#%]\s/, // venv/conda: `(env) $`
	/^~?[/\\][^\s$#%>]*\s*[$#%>]\s/, // bare-path prompts: `~/dir $`
	/^[❯➜»%$#]\s/, // starship / oh-my-zsh / minimal `$ `-style prompts
]

/**
 * Remove leading shell prompts from a line, if recognized. Applied repeatedly:
 * captures often contain doubled prompts on one line (`PS C:\x> PS C:\x>`)
 * when a redraw lands mid-line.
 */
export function stripPromptPrefix(line: string): string {
	let cur = line
	for (let guard = 0; guard < 8; guard++) {
		let next = cur.trimStart()
		for (const re of PROMPT_PREFIXES) {
			const stripped = next.replace(re, "")
			if (stripped !== next) {
				next = stripped
				break
			}
		}
		if (next === cur) return cur
		cur = next
	}
	return cur
}

/**
 * Clean raw (ANSI-stripped) capture text into signal lines: prompts stripped
 * off commands, prompt-only/decoration lines dropped, consecutive duplicates
 * (TUI redraws, spinners) collapsed.
 */
export function cleanCaptureLines(text: string): string[] {
	const out: string[] = []
	for (const raw of text.split("\n")) {
		if (raw.includes("──────── restored ────────")) continue
		const line = stripPromptPrefix(raw.replace(/\s+$/, "")).trim()
		// No letters or digits → blank, bare prompt, or box-drawing decoration.
		if (!/[\p{L}\p{N}]/u.test(line)) continue
		if (out[out.length - 1] === line) continue
		out.push(line)
	}
	return out
}

/** Read the cleaned tail of one pane's scrollback capture. */
function paneTail(sessionId: string, paneId: string): string[] {
	try {
		const buf = readFileSync(scrollbackPath(sessionId, paneId))
		const tail = buf.subarray(Math.max(0, buf.byteLength - READ_TAIL_BYTES))
		return cleanCaptureLines(stripAnsi(captureDecoder.decode(tail))).slice(-LINES_PER_PANE)
	} catch {
		return []
	}
}

/** The newest whole lines of `lines` that fit in `budget` characters (joined with "\n"). */
function tailWithin(lines: string[], budget: number): string[] {
	const out: string[] = []
	let used = 0
	for (let i = lines.length - 1; i >= 0; i--) {
		const line = lines[i] ?? ""
		const cost = line.length + (out.length > 0 ? 1 : 0)
		if (used + cost > budget) break
		out.unshift(line)
		used += cost
	}
	return out
}

/**
 * Build the model prompt from the recent commands + output across every pane.
 * The character budget is shared fairly: quiet panes keep all their lines and
 * the remainder is split evenly among busier ones, each keeping its newest
 * lines, so one chatty pane can't push the others out of the title.
 * Returns null when there's nothing meaningful to title yet.
 */
export function gatherActivity(sessionId: string, paneIds: string[]): string | null {
	const panes = paneIds
		.map((id) => ({ id, lines: paneTail(sessionId, id) }))
		.filter((p) => p.lines.length > 0)
	if (panes.length === 0) return null
	const header = (id: string) => `${id}:\n`.length
	const separators = (panes.length - 1) * 2
	let remaining = MAX_PROMPT_CHARS - separators - panes.reduce((n, p) => n + header(p.id), 0)
	const share = new Map<string, number>()
	const bySize = [...panes].sort((a, b) => a.lines.join("\n").length - b.lines.join("\n").length)
	bySize.forEach((p, i) => {
		const fair = Math.max(0, Math.floor(remaining / (bySize.length - i)))
		const give = Math.min(p.lines.join("\n").length, fair)
		share.set(p.id, give)
		remaining -= give
	})
	const blocks = panes
		.map((p) => ({ id: p.id, lines: tailWithin(p.lines, share.get(p.id) ?? 0) }))
		.filter((p) => p.lines.length > 0)
		.map((p) => `${p.id}:\n${p.lines.join("\n")}`)
	return blocks.length > 0 ? blocks.join("\n\n") : null
}

/** Lazily download + load the title model. Returns null (and disables) on failure. */
async function ensureModel(): Promise<Loaded | null> {
	if (loaded) return loaded
	if (disabled || Date.now() < retryAt) return null
	if (loadPromise) return loadPromise
	loadPromise = (async () => {
		try {
			const { getLlama, resolveModelFile } = await import("node-llama-cpp")
			// `cli: false` keeps the downloader's progress bar out of the TUI's stdout.
			const modelPath = await resolveModelFile(TITLE_MODEL_URI, {
				directory: MODELS_DIR,
				cli: false,
			})
			const llama = await getLlama()
			const model = await llama.loadModel({ modelPath })
			loaded = { model }
			failures = 0
			retryAt = 0
			return loaded
		} catch {
			failures++
			retryAt = Date.now() + Math.min(RETRY_BASE_MS * 2 ** (failures - 1), RETRY_CAP_MS)
			if (failures >= MAX_LOAD_FAILURES) disabled = true
			return null
		} finally {
			loadPromise = null
		}
	})()
	return loadPromise
}

/** Tidy the model's raw output into a compact, single-line title. */
function cleanTitle(raw: string): string {
	const firstLine = raw.split("\n")[0] ?? ""
	return firstLine
		.replace(/^["'`\s]+|["'`\s]+$/g, "") // surrounding quotes/space
		.replace(/[.\s]+$/, "") // trailing period/space
		.slice(0, 48)
		.trim()
}

/**
 * Generate a session title from gathered pane activity. Returns null if titling
 * is unavailable or the output is empty — callers then fall back to the id.
 */
export async function generateTitle(activity: string): Promise<string | null> {
	const m = await ensureModel()
	if (!m) return null
	try {
		const { LlamaChatSession } = await import("node-llama-cpp")
		// Create the context + sequence once and reuse them across generations —
		// node-llama-cpp overrides the sequence state per session, so a fresh
		// LlamaChatSession on the same sequence stays independent (no leakage).
		if (!m.context || !m.sequence) {
			m.context = await m.model.createContext({ contextSize: CONTEXT_SIZE })
			m.sequence = m.context.getSequence()
		}
		// Trim to the model context precisely, in tokens. The prompt is already
		// budgeted per pane upstream, so cutting from the front only drops the
		// oldest lines of the first pane in the rare case the char cap overshoots.
		let prompt = activity
		const budget = CONTEXT_SIZE - CONTEXT_RESERVE_TOKENS
		const tokens = m.model.tokenize(prompt)
		if (tokens.length > budget) prompt = m.model.detokenize(tokens.slice(-budget))
		const session = new LlamaChatSession({
			contextSequence: m.sequence,
			systemPrompt: "", // crucial: this model was trained without a system prompt
		})
		const raw = await session.prompt(prompt, { maxTokens: 16, temperature: 0.3 })
		const title = cleanTitle(raw)
		return title.length > 0 ? title : null
	} catch {
		// Self-heal: drop the (possibly wedged) context so the next call rebuilds it.
		try {
			await m.context?.dispose()
		} catch {}
		m.context = undefined
		m.sequence = undefined
		return null
	}
}

/** Free the model + context (best-effort) on shutdown. */
export async function disposeTitleModel(): Promise<void> {
	const m = loaded
	loaded = null
	disabled = true
	try {
		await m?.context?.dispose()
	} catch {}
	await m?.model.dispose().catch(() => {})
}
