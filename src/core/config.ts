/**
 * Central configuration for the orchestrator scaffold.
 *
 * Everything that the hub, the wt.exe wrapper and the agents need to agree on
 * lives here so there is a single source of truth.
 */

import { join, resolve } from "node:path"
import { parseHex } from "./colors"
import { ordoBaseDir } from "./paths"

/** Absolute path to this `src` directory (works regardless of cwd). */
export const SRC_DIR = resolve(import.meta.dir, "..")

/** Project root (parent of `src`). Used as the cwd for the app's own window. */
export const PROJECT_DIR = resolve(SRC_DIR, "..")

/** Absolute path to this entry point — re-run to relaunch the app in a new window. */
export const ENTRY_PATH = resolve(SRC_DIR, "index.ts")

/** Absolute path to the persistent session daemon entry point. */
export const DAEMON_PATH = resolve(SRC_DIR, "daemon", "daemon.ts")

/** Absolute path to the thin pane-client entry point that runs inside each pane. */
export const CLIENT_PATH = resolve(SRC_DIR, "daemon", "attachClient.ts")

/** The Bun executable currently running us — reused to launch agents. */
export const BUN_EXE = process.execPath

/** Read `--flag value` from an argv array. Rejects a missing or flag-like value. */
export function parseArgValue(argv: readonly string[], flag: string): string | undefined {
	const i = argv.indexOf(flag)
	if (i < 0) return undefined
	const next = argv[i + 1]
	if (next === undefined || next.startsWith("--")) return undefined
	return next
}

/**
 * Which Windows Terminal window new panes/tabs attach to.
 *
 * - `"0"` / `"last"` → the most-recently-used window (usually the one the app
 *   is running in). This is the default and needs no special launch.
 * - a name (e.g. `"ordo"`) → a specific named window, for rock-solid attachment.
 * - `"new"` / `"-1"` → always a brand new window.
 *
 * Resolution order: ORDO_WT_WINDOW env → `"0"`.
 */
export const WT_WINDOW = process.env.ORDO_WT_WINDOW ?? "0"

let powershellExeCache: string | undefined

/** Memoized PowerShell executable — resolved lazily so quick CLI commands skip the probe. */
export function powershellExe(): string {
	if (powershellExeCache === undefined) {
		powershellExeCache = Bun.which("pwsh") ? "pwsh" : "powershell"
	}
	return powershellExeCache
}

/** The shell each agent drives inside its pane. Override with ORDO_SHELL. */
export function agentShell(): string {
	return process.env.ORDO_SHELL ?? powershellExe()
}

/**
 * Programs the agent will re-launch on restore (tmux-resurrect style): if one of
 * these was the foreground program when the session was saved, the restored pane
 * re-runs it fresh from the saved cwd. In-memory state is NOT restored — the
 * program just reopens. Override the list with a space/comma-separated
 * ORDO_RESTORE_PROGRAMS (empty string disables relaunch entirely).
 */
const RESTORE_PROGRAMS_DEFAULT =
	"vim nvim vi nano emacs claude codex kilo kilocode gemini opencode copilot qwen cursor-agent goose amp droid less more top btop htop python python3 node ssh lazygit"

export const AGENT_PROGRAMS: ReadonlySet<string> = new Set([
	"claude",
	"codex",
	"kilo",
	"kilocode",
	"gemini",
	"opencode",
	"copilot",
	"qwen",
	"cursor-agent",
	"goose",
	"amp",
	"droid",
])

/** Parse a space/comma-separated program list into a lowercased, deduped set. */
export function parseProgramList(raw: string): Set<string> {
	return new Set(
		raw
			.split(/[\s,]+/)
			.map((s) => s.trim().toLowerCase())
			.filter(Boolean),
	)
}

export const RESTORE_PROGRAMS: ReadonlySet<string> = parseProgramList(
	process.env.ORDO_RESTORE_PROGRAMS ?? RESTORE_PROGRAMS_DEFAULT,
)

/**
 * How many lines of scrollback the headless emulator keeps when reconstructing a
 * pane's screen for restore. More = longer history restored, larger work. Override
 * with ORDO_SCROLLBACK.
 */
export const SCROLLBACK_LINES = numEnv("ORDO_SCROLLBACK", 1000, 0, 50000)

export const SEED_TIMEOUT_MS = numEnv("ORDO_SEED_TIMEOUT", 5000, 500, 15000)

/** Delay (ms) between typing a peer message and pressing Enter, so TUI input boxes settle. */
export const SEND_ENTER_DELAY_MS = numEnv("ORDO_SEND_ENTER_DELAY", 150, 0, 5000)

/** Parse a finite numeric value, clamped to [min, max], falling back to `def`. */
export function parseNumEnv(
	raw: string | undefined,
	def: number,
	min = -Infinity,
	max = Infinity,
): number {
	if (raw === undefined) return def
	const v = raw.trim()
	if (v === "") return def
	const n = Number(v)
	if (!Number.isFinite(n)) return def
	return Math.min(max, Math.max(min, n))
}

/** Read a finite numeric env var, clamped to [min, max], falling back to `def`. */
function numEnv(name: string, def: number, min = -Infinity, max = Infinity): number {
	return parseNumEnv(process.env[name], def, min, max)
}

/**
 * Size of the fixed center window, as a fraction of the monitor work area.
 * The center is resized + centered to this on startup. Override with
 * ORDO_CENTER_W / ORDO_CENTER_H (0..1).
 */
// The command window is now a roomy sessions browser — wide and tall. Width is
// capped in layout.centerWindow so each side column stays ≥ the WT minimum width
// (~480px); on a typical 1080p screen 0.48 leaves the side columns ~500px each.
export const CENTER_W_FRAC = numEnv("ORDO_CENTER_W", 0.48, 0.1, 0.9)
export const CENTER_H_FRAC = numEnv("ORDO_CENTER_H", 0.5, 0.1, 0.95)

/** Pixel gap between tiled windows (and around the center). Override with ORDO_GAP. */
export const TILE_GAP = numEnv("ORDO_GAP", 2, 0, 64)

/**
 * Windows Terminal refuses to make a window narrower than ~476px. We keep every
 * tile at least this wide so they never overlap; the center width is clamped so
 * the side columns stay ≥ this. Override with ORDO_MIN_W.
 */
export const MIN_WIN_W = numEnv("ORDO_MIN_W", 480, 200, 2000)

/** Slide/resize animation duration in ms when tiles rearrange. 0 = instant. */
export const ANIM_MS = numEnv("ORDO_ANIM_MS", 180, 0, 2000)

export const ANIM_FRAME_MS = numEnv("ORDO_ANIM_FRAME_MS", 16, 4, 50)

export const RESIZE_DEBOUNCE_MS = numEnv("ORDO_RESIZE_DEBOUNCE", 100, 0, 1000)

export const CENTER_IDLE_POLL_MS = numEnv("ORDO_CENTER_IDLE_POLL", 120, 30, 500)

export const CENTER_FOLLOW_MS = numEnv("ORDO_CENTER_FOLLOW", 16, 4, 60)

export const CENTER_SETTLE_MS = numEnv("ORDO_CENTER_SETTLE", 150, 30, 1000)

/** Highlight color for the focused pane/window (border + title bar). */
const SELECT_COLOR_DEFAULT = "#d6c9f9"
function validHex(raw: string | undefined): string {
	if (raw === undefined) return SELECT_COLOR_DEFAULT
	const trimmed = raw.trim()
	return parseHex(trimmed)
		? trimmed.startsWith("#")
			? trimmed
			: `#${trimmed}`
		: SELECT_COLOR_DEFAULT
}
export const SELECT_BORDER_COLOR = validHex(process.env.ORDO_SELECT_COLOR)

/**
 * How each satellite window is colored to make it distinct:
 *  - `tab`  : colored tab strip / title bar via `--tabColor`
 *  - `bg`   : subtle whole-window background tint via an OSC 11 escape
 *  - `both` : tab color + background tint
 *  - `off`  : no coloring
 * Override with ORDO_COLOR.
 */
export type ColorMode = "tab" | "bg" | "both" | "off"
const colorEnv = process.env.ORDO_COLOR
export const COLOR_MODE: ColorMode =
	colorEnv === "tab" || colorEnv === "bg" || colorEnv === "both" || colorEnv === "off"
		? colorEnv
		: "tab"

// ---------------------------------------------------------------------------
// Session-title model (src/app/title.ts) — generates a human title from recent pane
// activity using a tiny local GGUF model via node-llama-cpp.
// ---------------------------------------------------------------------------

/** Where the title model GGUF is cached/downloaded. Override with ORDO_MODELS_DIR. */
export const MODELS_DIR = process.env.ORDO_MODELS_DIR ?? join(ordoBaseDir(), "models")

/**
 * The GGUF model used to title sessions — SupraLabs' Supra-Title-350M (LFM2),
 * a tiny model trained specifically to write short conversation titles. Override
 * with ORDO_TITLE_MODEL (any node-llama-cpp model URI or local path).
 */
export const TITLE_MODEL_URI =
	process.env.ORDO_TITLE_MODEL ??
	"hf:SupraLabs/Supra-Title-350M-exp-GGUF/LiquidAI_LFM2.5-350M-Base_1781204855.Q4_K_M.gguf"

/** Title generation is on by default; set ORDO_TITLE=0 to disable it entirely. */
export const TITLE_ENABLED = (process.env.ORDO_TITLE ?? "1") !== "0"

/** Debounce (ms) after pane activity settles before regenerating the title. */
export const TITLE_DEBOUNCE_MS = numEnv("ORDO_TITLE_DEBOUNCE", 15000, 1000, 600000)

/**
 * Max bytes the daemon buffers toward a single (slow) attach client before it
 * gives up and drops that client — a backpressure safety valve so one wedged pane
 * window can't grow the daemon's memory without bound.
 */
export const CLIENT_OVERFLOW_BYTES = 4 * 1024 * 1024
