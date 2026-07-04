/**
 * Named sessions: save the current layout and restore it later.
 *
 * Each session gets a unique name drawn from a pool of Roman-era soldier types.
 * If the drawn name is already taken, another soldier word is appended in
 * kebab-case (e.g. `centurion-optio`) until it's unique. Sessions are stored as
 * JSON under %APPDATA%\ordo\sessions so they survive across runs.
 */

import {
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs"
import { join } from "node:path"
import type { Rect } from "../platform/win32"
import type { Direction } from "../platform/wt"
import { isDirection } from "../platform/wt"
import { pickUniqueName } from "./names"
import { ordoBaseDir } from "./paths"

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
	 * file names, `restore`/`delete`, and daemon session keys all use it.
	 */
	id: string
	/**
	 * Human-friendly title generated from recent pane activity by the local
	 * title model (see src/app/title.ts). Shown in the session browser above the id;
	 * absent until generated, in which case the id is shown instead.
	 */
	title?: string
	/** Set when the user renamed the session by hand, so the auto-titler won't override it. */
	manualTitle?: boolean
	updatedAt: string
	center: Rect
	satellites: SatelliteState[]
}

let ordoDirCache: string | null = null

/** Root ordo data dir: %APPDATA%\ordo (created on demand). */
export function ordoDir(): string {
	const dir = ordoBaseDir()
	if (ordoDirCache === dir) return dir
	mkdirSync(dir, { recursive: true })
	ordoDirCache = dir
	return dir
}

let sessionsDirCache: { root: string; dir: string } | null = null

/** Where sessions live: %APPDATA%\ordo\sessions (created on demand). */
export function sessionsDir(): string {
	const root = ordoDir()
	if (sessionsDirCache?.root === root) return sessionsDirCache.dir
	const dir = join(root, "sessions")
	mkdirSync(dir, { recursive: true })
	sessionsDirCache = { root, dir }
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

function isRect(value: unknown): value is Rect {
	if (!value || typeof value !== "object") return false
	const r = value as Record<string, unknown>
	return (
		Number.isFinite(r.x) && Number.isFinite(r.y) && Number.isFinite(r.w) && Number.isFinite(r.h)
	)
}

function isSatellite(value: unknown): value is SatelliteState {
	if (!value || typeof value !== "object") return false
	const s = value as Record<string, unknown>
	return (
		typeof s.id === "string" &&
		typeof s.direction === "string" &&
		isDirection(s.direction) &&
		isRect(s.rect)
	)
}

export function loadSession(name: string): SessionState | null {
	let parsed: unknown
	try {
		parsed = JSON.parse(readFileSync(sessionPath(name), "utf8"))
	} catch {
		return null
	}
	if (!parsed || typeof parsed !== "object") return null
	const state = parsed as Record<string, unknown>
	if (typeof state.id !== "string" || state.id === "") return null
	if (!Array.isArray(state.satellites)) return null
	if (!isRect(state.center)) return null
	state.satellites = state.satellites.filter(isSatellite)
	if (typeof state.updatedAt !== "string") state.updatedAt = ""
	if (state.title !== undefined && typeof state.title !== "string") delete state.title
	if (state.manualTitle !== undefined && typeof state.manualTitle !== "boolean") {
		delete state.manualTitle
	}
	return state as unknown as SessionState
}

export function saveSession(state: SessionState): void {
	const target = sessionPath(state.id)
	const tmp = `${target}.${process.pid}.${Date.now().toString(36)}.tmp`
	try {
		writeFileSync(tmp, JSON.stringify(state, null, 2))
		renameSync(tmp, target)
	} catch (e) {
		try {
			rmSync(tmp, { force: true })
		} catch {}
		throw e
	}
}

/** A unique session id (a soldier name not colliding with any saved session). */
export function generateSessionId(): string {
	return pickUniqueName(new Set(listSessionNames()))
}
