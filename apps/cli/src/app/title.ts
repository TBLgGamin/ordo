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

/** How much of each pane's capture tail to read / feed (bytes, lines, chars). */
const READ_TAIL_BYTES = 16 * 1024
const LINES_PER_PANE = 12
const MAX_PROMPT_CHARS = 3000

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

/** Read the cleaned tail (last few lines) of one pane's scrollback capture. */
function paneTail(sessionId: string, paneId: string): string[] {
	try {
		const buf = readFileSync(scrollbackPath(sessionId, paneId))
		const tail = buf.subarray(Math.max(0, buf.byteLength - READ_TAIL_BYTES))
		const text = stripAnsi(captureDecoder.decode(tail))
		return text
			.split("\n")
			.map((l) => l.replace(/\s+$/, ""))
			.filter((l) => l.trim().length > 0 && !l.includes("──────── restored ────────"))
			.slice(-LINES_PER_PANE)
	} catch {
		return []
	}
}

/**
 * Build the model prompt from the recent commands + output across every pane.
 * Returns null when there's nothing meaningful to title yet.
 */
export function gatherActivity(sessionId: string, paneIds: string[]): string | null {
	const blocks: string[] = []
	for (const paneId of paneIds) {
		const lines = paneTail(sessionId, paneId)
		if (lines.length > 0) blocks.push(`${paneId}:\n${lines.join("\n")}`)
	}
	if (blocks.length === 0) return null
	let prompt = blocks.join("\n\n")
	if (prompt.length > MAX_PROMPT_CHARS) prompt = prompt.slice(-MAX_PROMPT_CHARS)
	return prompt
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
			m.context = await m.model.createContext({ contextSize: 1024 })
			m.sequence = m.context.getSequence()
		}
		const session = new LlamaChatSession({
			contextSequence: m.sequence,
			systemPrompt: "", // crucial: this model was trained without a system prompt
		})
		const raw = await session.prompt(activity, { maxTokens: 16, temperature: 0.3 })
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
