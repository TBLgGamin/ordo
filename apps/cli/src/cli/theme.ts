import { parseHex } from "../core/colors"
import { SELECT_BORDER_COLOR } from "../core/config"

/** The one UI accent — the user's light purple. The only ink that isn't a pane color. */
export const PURPLE = SELECT_BORDER_COLOR

function toHex(r: number, g: number, b: number): string {
	const h = (n: number) =>
		Math.max(0, Math.min(255, Math.round(n)))
			.toString(16)
			.padStart(2, "0")
	return `#${h(r)}${h(g)}${h(b)}`
}

/** Linear blend from `a` to `b`; `t` 0 = all `a`, 1 = all `b`. */
export function mixHex(a: string, b: string, t: number): string {
	const ca = parseHex(a)
	const cb = parseHex(b)
	if (!ca || !cb) return a
	const k = Math.max(0, Math.min(1, t))
	return toHex(ca.r + (cb.r - ca.r) * k, ca.g + (cb.g - ca.g) * k, ca.b + (cb.b - ca.b) * k)
}

// Every non-pane color below is derived from the single accent, so overriding
// ORDO_SELECT_COLOR restyles the whole command center consistently.

/** Near-black terminal background with a cast of the accent. */
export const BG = mixHex(PURPLE, "#000000", 0.95)

/** Scrollbar track / subtle fill — a shade above the background. */
export const TRACK_BG = mixHex(PURPLE, "#000000", 0.87)

/** Brighter accent for momentary emphasis (flashes, the light sweeps). */
export const PURPLE_BRIGHT = mixHex(PURPLE, "#ffffff", 0.45)
