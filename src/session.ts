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
import { pickUniqueName } from "./names"
import type { Rect } from "./win32"
import type { Direction } from "./wt"

export interface SatelliteState {
	id: string
	direction: Direction
	color?: string
	cwd?: string
	/** Most recent command sent to this pane (for the session browser). */
	lastCommand?: string
	rect: Rect
}

export interface SessionState {
	name: string
	updatedAt: string
	center: Rect
	satellites: SatelliteState[]
}

/** Where sessions live: %APPDATA%\ordo\sessions (created on demand). */
export function sessionsDir(): string {
	const base = process.env.APPDATA ?? process.env.LOCALAPPDATA ?? process.env.HOME ?? "."
	const dir = join(base, "ordo", "sessions")
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

/** Delete a session and its scrollback. Returns true if the session existed. */
export function deleteSession(name: string): boolean {
	const existed = existsSync(sessionPath(name))
	rmSync(sessionPath(name), { force: true })
	rmSync(scrollbackDir(name), { recursive: true, force: true })
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
	writeFileSync(sessionPath(state.name), JSON.stringify(state, null, 2))
}

/** A unique session name (not colliding with any saved session). */
export function generateSessionName(): string {
	return pickUniqueName(new Set(listSessionNames()))
}
