/**
 * Central configuration for the orchestrator scaffold.
 *
 * Everything that the hub, the wt.exe wrapper and the agents need to agree on
 * lives here so there is a single source of truth.
 */

import { resolve } from "node:path"

/** Absolute path to this `src` directory (works regardless of cwd). */
export const SRC_DIR = import.meta.dir

/** Absolute path to the persistent session daemon entry point. */
export const DAEMON_PATH = resolve(SRC_DIR, "daemon.ts")

/** Absolute path to the thin pane-client entry point that runs inside each pane. */
export const CLIENT_PATH = resolve(SRC_DIR, "client.ts")

/** The Bun executable currently running us — reused to launch agents. */
export const BUN_EXE = process.execPath

/** Read `--flag value` from the process argv, if present. */
function argValue(flag: string): string | undefined {
	const i = Bun.argv.indexOf(flag)
	return i >= 0 ? Bun.argv[i + 1] : undefined
}

/**
 * Which Windows Terminal window new panes/tabs attach to.
 *
 * - `"0"` / `"last"` → the most-recently-used window (usually the one the app
 *   is running in). This is the default and needs no special launch.
 * - a name (e.g. `"ordo"`) → a specific named window. Launch the app
 *   inside that named window (see scripts/launch.ps1) for rock-solid attachment.
 * - `"new"` / `"-1"` → always a brand new window.
 *
 * Resolution order: `--window <name>` CLI arg → ORDO_WT_WINDOW env →
 * `"0"`. The CLI arg is used by launch.ps1 because env vars don't reliably reach
 * a pane spawned by an already-running Windows Terminal server.
 */
export const WT_WINDOW = argValue("--window") ?? process.env.ORDO_WT_WINDOW ?? "0"

/** Session name to restore, from `--restore <name>` (undefined = new session). */
export const RESTORE_NAME = argValue("--restore")

/** `--sessions` lists saved sessions instead of starting one. */
export const SESSIONS_MODE = Bun.argv.includes("--sessions")

/** `--delete <name>` deletes a saved session (and its scrollback), then exits. */
export const DELETE_NAME = argValue("--delete")

/** The shell each agent drives inside its pane. Override with ORDO_SHELL. */
export const AGENT_SHELL = process.env.ORDO_SHELL ?? "pwsh"

/**
 * Programs the agent will re-launch on restore (tmux-resurrect style): if one of
 * these was the foreground program when the session was saved, the restored pane
 * re-runs it fresh from the saved cwd. In-memory state is NOT restored — the
 * program just reopens. Override the list with a space/comma-separated
 * ORDO_RESTORE_PROGRAMS (empty string disables relaunch entirely).
 */
const RESTORE_PROGRAMS_DEFAULT =
	"vim nvim vi nano emacs claude less more top btop htop python python3 node ssh lazygit"
export const RESTORE_PROGRAMS: ReadonlySet<string> = new Set(
	(process.env.ORDO_RESTORE_PROGRAMS ?? RESTORE_PROGRAMS_DEFAULT)
		.split(/[\s,]+/)
		.map((s) => s.trim().toLowerCase())
		.filter(Boolean),
)

/**
 * How many lines of scrollback the headless emulator keeps when reconstructing a
 * pane's screen for restore. More = longer history restored, larger work. Override
 * with ORDO_SCROLLBACK.
 */
export const SCROLLBACK_LINES = numEnv("ORDO_SCROLLBACK", 1000)

/** Read a finite numeric env var, falling back to `def`. */
function numEnv(name: string, def: number): number {
	const v = process.env[name]
	if (v === undefined) return def
	const n = Number(v)
	return Number.isFinite(n) ? n : def
}

/**
 * Size of the fixed center window, as a fraction of the monitor work area.
 * The center is resized + centered to this on startup. Override with
 * ORDO_CENTER_W / ORDO_CENTER_H (0..1).
 */
export const CENTER_W_FRAC = numEnv("ORDO_CENTER_W", 0.36)
// ≤0.4 makes the top/bottom strips ≥¾ of the center height; 0.38 leaves margin
// for the gap + rounding so every tiled pane clears the ¾-center-height minimum.
export const CENTER_H_FRAC = numEnv("ORDO_CENTER_H", 0.38)

/** Pixel gap between tiled windows (and around the center). Override with ORDO_GAP. */
export const TILE_GAP = numEnv("ORDO_GAP", 2)

/**
 * Windows Terminal refuses to make a window narrower than ~476px. We keep every
 * tile at least this wide so they never overlap; the center width is clamped so
 * the side columns stay ≥ this. Override with ORDO_MIN_W.
 */
export const MIN_WIN_W = numEnv("ORDO_MIN_W", 480)

/** Slide/resize animation duration in ms when tiles rearrange. 0 = instant. */
export const ANIM_MS = numEnv("ORDO_ANIM_MS", 180)

/** Highlight color for the focused pane/window (border + title bar). */
export const SELECT_BORDER_COLOR = process.env.ORDO_SELECT_COLOR ?? "#d6c9f9"

/** Thickness (px) of the overlay frame drawn around the focused window. */
export const BORDER_THICKNESS = numEnv("ORDO_BORDER_THICKNESS", 3)

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
