/**
 * Typed wrapper around Windows Terminal's `wt.exe` command line.
 *
 * Key facts that drive this design (verified against Microsoft Learn docs):
 *
 *  - `wt -w <window-id> <commands...>` sends commands to an EXISTING window,
 *    which is how we attach new panes/tabs to the central app's window.
 *    `<window-id>` may be an integer id, a name, `0`/`last`, or `-1`/`new`.
 *  - Commands are chained with a bare `;` token. We pass each token as its own
 *    argv element, so Bun (not a shell) builds the command line — no fragile
 *    quoting/escaping of `;` or paths with spaces.
 *  - `split-pane -V` puts the new pane to the RIGHT, `-H` puts it BELOW. To land
 *    on the LEFT/UP side we split then `swap-pane` the freshly-focused pane.
 *  - `wt -w <existing>` returns almost immediately (it's a thin client that
 *    forwards to the running instance), so spawning never blocks the app.
 *
 * There is intentionally NO "send keystrokes to a running pane" here: wt.exe has
 * no such command (microsoft/terminal#12487, #12925). That capability lives in
 * the hub/agent IPC layer instead.
 */

import { lstatSync } from "node:fs"
import { join } from "node:path"
import { WT_WINDOW } from "./config"

export type Direction = "left" | "right" | "up" | "down"

/**
 * Resolve the wt.exe to spawn.
 *
 * `wt.exe` lives as an "app execution alias" in `%LOCALAPPDATA%\Microsoft\
 * WindowsApps`, which is on the *interactive* shell's PATH but is often NOT on
 * the PATH a child process inherits — so `Bun.spawn(["wt.exe", …])` fails with
 * "Executable not found in $PATH". We therefore probe the known alias location
 * and fall back to bare `wt.exe` (PATH) only if that's missing.
 *
 * Override with ORDO_WT_EXE if Windows Terminal lives somewhere custom.
 */
function resolveWtExe(): string {
	const override = process.env.ORDO_WT_EXE
	if (override) return override
	const localAppData = process.env.LOCALAPPDATA
	if (localAppData) {
		const aliased = join(localAppData, "Microsoft", "WindowsApps", "wt.exe")
		// The alias is a 0-byte app-execution-link reparse point whose real target
		// sits in the ACL-locked Program Files\WindowsApps. existsSync() follows the
		// reparse and fails on the protected target, so use lstatSync to test the
		// alias file itself. CreateProcess resolves the link when we spawn the path.
		try {
			lstatSync(aliased)
			return aliased
		} catch {
			// fall through to PATH lookup
		}
	}
	return "wt.exe"
}

const WT_EXE = resolveWtExe()

/** How a direction maps to a split axis and whether the new pane must be swapped. */
interface SplitPlan {
	/** `-V` (side-by-side) or `-H` (stacked). */
	axis: "-V" | "-H"
	/** If set, swap the just-created pane this way so it lands on the intended side. */
	swap?: Direction
}

const DIRECTION_PLANS: Record<Direction, SplitPlan> = {
	// -V focuses a new pane on the right; right needs no swap, left swaps over.
	right: { axis: "-V" },
	left: { axis: "-V", swap: "left" },
	// -H focuses a new pane below; down needs no swap, up swaps over.
	down: { axis: "-H" },
	up: { axis: "-H", swap: "up" },
}

export function isDirection(value: string): value is Direction {
	return value === "left" || value === "right" || value === "up" || value === "down"
}

/**
 * Low-level: run `wt.exe` with a pre-built argv. Resolves to the exit code.
 *
 * We launch via `cmd.exe /c <wt> …` rather than spawning wt directly. wt.exe is
 * an "app execution alias" reparse point, and Windows only resolves those when
 * the path arrives through a process's *command line* (lpCommandLine) — not via
 * CreateProcess's lpApplicationName, which is exactly how Bun/libuv spawns. That
 * makes a direct `Bun.spawn([wt, …])` fail with "Executable not found", even
 * with the absolute path. Routing through cmd.exe (a normal executable libuv can
 * launch) puts wt on the command line, so the kernel resolves the alias. This is
 * the same workaround Microsoft's own docs use for non-interactive callers.
 *
 * Note: `;` is NOT special to cmd's parser for external commands, so the
 * `; swap-pane …` chaining tokens pass straight through to wt untouched.
 */
async function runWt(args: string[]): Promise<number> {
	const proc = Bun.spawn(["cmd.exe", "/d", "/c", WT_EXE, ...args], {
		stdin: "ignore",
		stdout: "ignore",
		stderr: "pipe",
	})
	const code = await proc.exited
	if (code !== 0) {
		const err = await new Response(proc.stderr).text()
		throw new Error(`wt.exe exited ${code}: ${err.trim() || "(no stderr)"}`)
	}
	return code
}

/** Prefix that targets the configured window (omitted when WT_WINDOW is empty). */
function windowTarget(): string[] {
	return WT_WINDOW ? ["-w", WT_WINDOW] : []
}

export interface SpawnPaneOptions {
	direction: Direction
	/** Executable + args to run inside the new pane. */
	commandline: string[]
	/** Starting directory for the pane. */
	cwd?: string
	/** Fraction of the parent pane the new pane takes (e.g. 0.4 → 40%). */
	size?: number
	/** Optional pane title. */
	title?: string
}

/**
 * Split the focused pane of the target window in the given direction and run
 * `commandline` inside the new pane.
 */
export async function spawnPane(opts: SpawnPaneOptions): Promise<void> {
	const plan = DIRECTION_PLANS[opts.direction]
	const args: string[] = [...windowTarget(), "split-pane", plan.axis]

	if (opts.size !== undefined) args.push("--size", String(opts.size))
	if (opts.cwd) args.push("-d", opts.cwd)
	if (opts.title) args.push("--title", opts.title)

	// First non-flag token starts the commandline; everything after is its args.
	args.push(...opts.commandline)

	// Chain a swap so the new pane lands on the requested side.
	if (plan.swap) args.push(";", "swap-pane", plan.swap)

	await runWt(args)
}

export interface SpawnTabOptions {
	commandline: string[]
	cwd?: string
	title?: string
}

/** Open a new tab in the target window running `commandline`. */
export async function spawnTab(opts: SpawnTabOptions): Promise<void> {
	const args: string[] = [...windowTarget(), "new-tab"]
	if (opts.cwd) args.push("-d", opts.cwd)
	if (opts.title) args.push("--title", opts.title)
	args.push(...opts.commandline)
	await runWt(args)
}

export interface SpawnWindowOptions {
	commandline: string[]
	cwd?: string
	title?: string
	/** Tab/title-bar color as #RGB or #RRGGBB. */
	tabColor?: string
	/** Screen position in pixels. */
	pos?: { x: number; y: number }
	/** Window size in character cells. */
	size?: { cols: number; rows: number }
}

/**
 * Open a brand-new window running `commandline`, optionally positioned/sized so
 * callers can "layer" satellite windows around the central one.
 */
export async function spawnWindow(opts: SpawnWindowOptions): Promise<void> {
	const args: string[] = ["-w", "new"]
	if (opts.pos) args.push("--pos", `${opts.pos.x},${opts.pos.y}`)
	if (opts.size) args.push("--size", `${opts.size.cols},${opts.size.rows}`)
	args.push("new-tab")
	if (opts.cwd) args.push("-d", opts.cwd)
	if (opts.tabColor) args.push("--tabColor", opts.tabColor)
	// --suppressApplicationTitle keeps the title pinned to `title` so the shell
	// can't rename the window — we rely on the title to locate its HWND.
	if (opts.title) args.push("--title", opts.title, "--suppressApplicationTitle")
	args.push(...opts.commandline)
	await runWt(args)
}

/**
 * Open a fresh dedicated window and run `commandline` in it — the app's own
 * "center" window. This is what the old `scripts/launch.ps1` did: give ordo a
 * clean window to capture as the fixed center rather than hijacking whatever
 * terminal it was launched from.
 *
 * Unlike `spawnWindow` (used for satellites) this does NOT pin/suppress the
 * title, so the app is free to name the tab after the session via OSC 0. Pass a
 * `title` only to seed it (e.g. the session name on restore).
 */
export async function openSelfWindow(
	commandline: string[],
	cwd: string,
	title?: string,
): Promise<void> {
	const args = ["-w", "new", "new-tab", "-d", cwd]
	if (title) args.push("--title", title)
	args.push(...commandline)
	await runWt(args)
}

/** Move keyboard focus between panes of the target window. */
export async function moveFocus(direction: Direction): Promise<void> {
	await runWt([...windowTarget(), "move-focus", direction])
}
