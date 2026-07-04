/**
 * Faithful screen restore from a raw ConPTY capture.
 *
 * The agent tees every byte the pane's shell emitted (raw VT escape sequences,
 * colors and all) to a capture file. To restore a pane we don't re-stream that
 * whole log — replaying it verbatim would animate the entire session and could
 * leave the terminal stuck in a program's alternate screen buffer.
 *
 * Instead we feed the capture through a headless xterm.js terminal, which tracks
 * the resulting screen + scrollback exactly as a real terminal would (alternate
 * screens, cursor moves, clears — all handled). The serialize addon then emits a
 * single VT string that reproduces that final state, which we print before the
 * fresh shell starts. This is the same technique xterm.js documents for
 * "restore terminal state on reconnect".
 */

import { readFile } from "node:fs/promises"
import { SerializeAddon } from "@xterm/addon-serialize"
import { Terminal } from "@xterm/headless"

/**
 * Read a raw-VT capture file and return a VT string that reproduces the final
 * on-screen state (visible screen + up to `scrollback` lines of history) at the
 * given size. Returns an empty string if the capture is missing/empty.
 */
export async function reconstructScreen(
	capturePath: string,
	cols: number,
	rows: number,
	scrollback: number,
): Promise<string> {
	let raw: Buffer
	try {
		raw = await readFile(capturePath)
	} catch {
		return ""
	}
	if (raw.byteLength === 0) return ""

	const term = new Terminal({
		cols: Math.max(1, cols),
		rows: Math.max(1, rows),
		scrollback,
		allowProposedApi: true,
	})
	const serializer = new SerializeAddon()
	term.loadAddon(serializer)

	// xterm.js parses writes asynchronously; wait for the whole capture to drain.
	await new Promise<void>((resolve) => term.write(new Uint8Array(raw), () => resolve()))

	const out = serializer.serialize()
	term.dispose()
	return out
}

export async function textFromVt(
	chunks: readonly Uint8Array[],
	cols: number,
	rows: number,
	maxLines: number,
): Promise<string> {
	const term = new Terminal({
		cols: Math.max(1, cols),
		rows: Math.max(1, rows),
		scrollback: Math.max(maxLines, rows),
		allowProposedApi: true,
	})
	for (const chunk of chunks) {
		if (chunk.byteLength === 0) continue
		await new Promise<void>((resolve) => term.write(chunk, () => resolve()))
	}
	const buffer = term.buffer.active
	const lines: string[] = []
	for (let i = 0; i < buffer.length; i++) {
		const line = buffer.getLine(i)
		lines.push(line ? line.translateToString(true) : "")
	}
	term.dispose()
	while (lines.length > 0 && lines[lines.length - 1]?.trim() === "") lines.pop()
	return lines.slice(-maxLines).join("\n")
}
