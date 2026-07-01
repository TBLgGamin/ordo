/**
 * Named sessions: save the current layout and restore it later.
 *
 * Each session gets a unique name drawn from a pool of Roman-era soldier types.
 * If the drawn name is already taken, another soldier word is appended in
 * kebab-case (e.g. `centurion-optio`) until it's unique. Sessions are stored as
 * JSON under %APPDATA%\ordo\sessions so they survive across runs.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import type { Rect } from "../platform/win32"
import type { Direction } from "../platform/wt"
import { pickUniqueName } from "./names"

export interface SatelliteState {
	id: string
	direction: Direction
	color?: string
	cwd?: string
	/** Most recent command sent to this pane (for the session browser). */
	lastCommand?: string
	/**
	 * Whitelisted program that was in the foreground when this pane was saved, if
	 * any (e.g. `"vim"`). On restore the pane re-launches it fresh. See config's
	 * RESTORE_PROGRAMS.
	 */
	foreground?: string
	rect: Rect
}

export interface SessionState {
	/**
	 * Stable unique identifier (a Roman-soldier name). This is the resume key —
	 * file names, `--restore`/`--delete`, and daemon session keys all use it.
	 */
	id: string
	/**
	 * Human-friendly title generated from recent pane activity by the local
	 * title model (see src/app/title.ts). Shown in the session browser above the id;
	 * absent until generated, in which case the id is shown instead.
	 */
	title?: string
	updatedAt: string
	center: Rect
	satellites: SatelliteState[]
}

/** Root ordo data dir: %APPDATA%\ordo (created on demand). */
export function ordoDir(): string {
	const base = process.env.APPDATA ?? process.env.LOCALAPPDATA ?? process.env.HOME ?? "."
	const dir = join(base, "ordo")
	mkdirSync(dir, { recursive: true })
	return dir
}

/** Where sessions live: %APPDATA%\ordo\sessions (created on demand). */
export function sessionsDir(): string {
	const dir = join(ordoDir(), "sessions")
	mkdirSync(dir, { recursive: true })
	return dir
}

function sessionPath(name: string): string {
	return join(sessionsDir(), `${name}.json`)
}

/** Directory holding a session's per-pane scrollback capture files. */
export function scrollbackDir(sessionName: string): string {
	return join(sessionsDir(), `${sessionName}.scrollback`)
}

/** Capture-file path for one pane's scrollback. */
export function scrollbackPath(sessionName: string, paneId: string): string {
	return join(scrollbackDir(sessionName), `${paneId}.log`)
}

/**
 * Delete a session and its scrollback. Returns true if the session existed.
 * Each removal is best-effort: if the daemon still holds a capture file open
 * (deleting a live session), the JSON is still removed so the session disappears
 * from listings, and the scrollback is cleaned up when those handles close.
 */
export function deleteSession(name: string): boolean {
	const existed = existsSync(sessionPath(name))
	try {
		rmSync(sessionPath(name), { force: true })
	} catch {}
	try {
		rmSync(scrollbackDir(name), { recursive: true, force: true })
	} catch {}
	return existed
}

export function listSessionNames(): string[] {
	try {
		return readdirSync(sessionsDir())
			.filter((f) => f.endsWith(".json"))
			.map((f) => f.slice(0, -".json".length))
	} catch {
		return []
	}
}

export function sessionExists(name: string): boolean {
	return existsSync(sessionPath(name))
}

export function loadSession(name: string): SessionState | null {
	try {
		return JSON.parse(readFileSync(sessionPath(name), "utf8")) as SessionState
	} catch {
		return null
	}
}

export function saveSession(state: SessionState): void {
	writeFileSync(sessionPath(state.id), JSON.stringify(state, null, 2))
}

/** A unique session id (a soldier name not colliding with any saved session). */
export function generateSessionId(): string {
	return pickUniqueName(new Set(listSessionNames()))
}
