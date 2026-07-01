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

let loaded: { model: LlamaModel } | null = null
let disabled = false
/** De-duplicate concurrent load attempts. */
let loadPromise: Promise<{ model: LlamaModel } | null> | null = null

/** How much of each pane's capture tail to read / feed (bytes, lines, chars). */
const READ_TAIL_BYTES = 16 * 1024
const LINES_PER_PANE = 12
const MAX_PROMPT_CHARS = 3000

/** Strip the ANSI/VT control sequences out of raw terminal capture. */
function stripAnsi(s: string): string {
	// biome-ignore lint/suspicious/noControlCharactersInRegex: matching VT CSI escape bytes
	const csi = /\x1b\[[0-9;?]*[ -/]*[@-~]/g
	// biome-ignore lint/suspicious/noControlCharactersInRegex: matching VT OSC escape bytes
	const osc = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g
	// biome-ignore lint/suspicious/noControlCharactersInRegex: matching two-byte VT escapes
	const esc = /\x1b[@-Z\\-_]/g
	const cr = /\r/g
	return s.replace(csi, "").replace(osc, "").replace(esc, "").replace(cr, "")
}

/** Read the cleaned tail (last few lines) of one pane's scrollback capture. */
function paneTail(sessionId: string, paneId: string): string[] {
	try {
		const buf = readFileSync(scrollbackPath(sessionId, paneId))
		const tail = buf.subarray(Math.max(0, buf.byteLength - READ_TAIL_BYTES))
		const text = stripAnsi(new TextDecoder().decode(tail))
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
async function ensureModel(): Promise<{ model: LlamaModel } | null> {
	if (loaded) return loaded
	if (disabled) return null
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
			return loaded
		} catch {
			disabled = true // don't hammer a broken/offline setup on every activity tick
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
	let context: Awaited<ReturnType<LlamaModel["createContext"]>> | undefined
	try {
		const { LlamaChatSession } = await import("node-llama-cpp")
		context = await m.model.createContext({ contextSize: 1024 })
		const session = new LlamaChatSession({
			contextSequence: context.getSequence(),
			systemPrompt: "", // crucial: this model was trained without a system prompt
		})
		const raw = await session.prompt(activity, { maxTokens: 16, temperature: 0.3 })
		const title = cleanTitle(raw)
		return title.length > 0 ? title : null
	} catch {
		return null
	} finally {
		await context?.dispose().catch(() => {})
	}
}

/** Free the model (best-effort) on shutdown. */
export async function disposeTitleModel(): Promise<void> {
	const m = loaded
	loaded = null
	disabled = true
	await m?.model.dispose().catch(() => {})
}
