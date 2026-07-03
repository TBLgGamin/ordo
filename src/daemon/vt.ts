/**
 * Small VT-stream helpers used by the agent.
 *
 *  - `TitleStripper` filters the shell's output before it reaches the real pane:
 *      • always drops title-setting OSC sequences (OSC 0/1/2) so the shell can't
 *        retitle the Windows Terminal window — its title must stay the pane id for
 *        the orchestrator to find it;
 *      • optionally (during a restore) drops the ConPTY's startup screen-clear and
 *        cursor-home so the reconstructed screen we just painted isn't wiped. The
 *        suppression ends as soon as the shell prints its first visible character
 *        (its prompt), so later clears (e.g. `cls`) work normally.
 *
 *  - `CommandLineTracker` watches the bytes typed INTO the shell and yields each
 *    completed command line (on Enter), so the orchestrator can record a pane's
 *    last command even though the user types directly into the pane.
 */

const ESC = 0x1b
const OSC_INTRODUCER = 0x5d // ']'
const CSI_INTRODUCER = 0x5b // '['
const BEL = 0x07
const BACKSLASH = 0x5c // for ST = ESC '\'
const DIGIT_0 = 0x30
const DIGIT_9 = 0x39

type State = "normal" | "esc" | "osc" | "csi"

const EMPTY = new Uint8Array(0)
const oscDecoder = new TextDecoder()

function concatOwned(segs: Uint8Array[]): Uint8Array {
	if (segs.length === 0) return EMPTY
	let total = 0
	for (const s of segs) total += s.length
	const out = new Uint8Array(total)
	let off = 0
	for (const s of segs) {
		out.set(s, off)
		off += s.length
	}
	return out
}

export interface TitleStripperOptions {
	/** Drop the shell's first screen-clear/home (used during restore). */
	suppressStartupClears?: boolean
	/** Called with the path whenever the shell reports its cwd via OSC 9;9. */
	onCwd?: (path: string) => void
}

export class TitleStripper {
	private state: State = "normal"
	private seq = new Uint8Array(256)
	private seqLen = 0
	private oscEscPending = false
	private suppressClears: boolean
	private readonly onCwd?: (path: string) => void
	private static readonly MAX_SEQ = 8192

	constructor(opts: TitleStripperOptions = {}) {
		this.suppressClears = opts.suppressStartupClears ?? false
		this.onCwd = opts.onCwd
	}

	private appendSeq(b: number): void {
		if (this.seqLen === this.seq.length) {
			const next = new Uint8Array(this.seq.length * 2)
			next.set(this.seq)
			this.seq = next
		}
		this.seq[this.seqLen++] = b
	}

	private emitSeq(segs: Uint8Array[]): void {
		if (this.seqLen > 0) segs.push(this.seq.slice(0, this.seqLen))
	}

	push(chunk: Uint8Array): Uint8Array {
		if (this.state === "normal" && chunk.indexOf(ESC) === -1) {
			if (this.suppressClears) {
				for (let i = 0; i < chunk.length; i++) {
					const b = chunk[i] as number
					if (b >= 0x20 && b !== 0x7f) {
						this.suppressClears = false
						break
					}
				}
			}
			return chunk.byteLength === 0 ? EMPTY : new Uint8Array(chunk)
		}

		const segs: Uint8Array[] = []
		let runStart = -1

		let i = 0
		for (; i < chunk.length; i++) {
			const b = chunk[i] as number
			switch (this.state) {
				case "normal":
					if (b === ESC) {
						if (runStart >= 0) {
							segs.push(chunk.subarray(runStart, i))
							runStart = -1
						}
						this.state = "esc"
						this.seqLen = 0
						this.appendSeq(b)
					} else {
						if (runStart < 0) runStart = i
						// First visible character from the shell (its prompt) ends the
						// startup-clear suppression window. Control bytes don't count.
						if (this.suppressClears && b >= 0x20 && b !== 0x7f) this.suppressClears = false
					}
					break

				case "esc":
					if (b === OSC_INTRODUCER) {
						this.state = "osc"
						this.appendSeq(b)
						this.oscEscPending = false
					} else if (b === CSI_INTRODUCER) {
						this.state = "csi"
						this.appendSeq(b)
					} else {
						this.emitSeq(segs)
						this.seqLen = 0
						if (b === ESC) {
							this.state = "esc"
							this.appendSeq(b)
						} else {
							this.state = "normal"
							runStart = i
						}
					}
					break

				case "csi":
					this.appendSeq(b)
					// CSI ends at a final byte in 0x40..0x7e.
					if (b >= 0x40 && b <= 0x7e) {
						this.endCsi(segs)
					} else if (this.seqLen > TitleStripper.MAX_SEQ) {
						this.emitSeq(segs)
						this.reset()
					}
					break

				case "osc":
					this.appendSeq(b)
					if (this.oscEscPending) {
						this.oscEscPending = false
						if (b === BACKSLASH) this.endOsc(segs)
					} else if (b === BEL) {
						this.endOsc(segs)
					} else if (b === ESC) {
						this.oscEscPending = true
					}
					if (this.state === "osc" && this.seqLen > TitleStripper.MAX_SEQ) {
						this.emitSeq(segs)
						this.reset()
					}
					break
			}
		}
		if (runStart >= 0) segs.push(chunk.subarray(runStart, i))
		return concatOwned(segs)
	}

	/** At a CSI final byte: drop a startup clear/home while suppressing; else emit. */
	private endCsi(segs: Uint8Array[]): void {
		if (this.suppressClears && this.isStartupClearOrHome()) {
			this.reset()
			return
		}
		this.emitSeq(segs)
		this.reset()
	}

	/** True for full screen-clears (CSI 2J / 3J) and cursor-home (CSI H/f, 1;1). */
	private isStartupClearOrHome(): boolean {
		// seq = [ESC, '[', ...params..., final]
		const final = this.seq[this.seqLen - 1]
		let params = ""
		for (let i = 2; i < this.seqLen - 1; i++) {
			const c = this.seq[i]
			if (c !== undefined) params += String.fromCharCode(c)
		}
		if (final === 0x4a /* J */) return params === "2" || params === "3"
		if (final === 0x48 /* H */ || final === 0x66 /* f */) {
			return params === "" || params === "1;1" || params === "0;0" || params === "1"
		}
		return false
	}

	private endOsc(segs: Uint8Array[]): void {
		const ps = this.oscOpcode()
		// OSC 9;9;<path> = ConEmu/Windows-Terminal "set cwd". Report it (and keep it
		// in the stream so the terminal can use it too).
		if (ps === 9 && this.onCwd) {
			const payload = this.oscPayload()
			if (payload.startsWith("9;9;")) {
				const path = payload.slice("9;9;".length).replace(/^"|"$/g, "")
				if (path) this.onCwd(path)
			}
		}
		if (ps !== 0 && ps !== 1 && ps !== 2) this.emitSeq(segs)
		this.reset()
	}

	/** The OSC payload text (between `ESC ]` and the terminator), decoded as UTF-8. */
	private oscPayload(): string {
		// seq = [ESC, ']', ...payload..., BEL]  OR  [..., ESC, '\']
		let end = this.seqLen
		if (this.seq[end - 1] === BEL) end -= 1
		else if (this.seq[end - 1] === BACKSLASH && this.seq[end - 2] === ESC) end -= 2
		return oscDecoder.decode(this.seq.subarray(2, end))
	}

	private oscOpcode(): number {
		let digits = ""
		for (let i = 2; i < this.seqLen; i++) {
			const c = this.seq[i]
			if (c === undefined || c < DIGIT_0 || c > DIGIT_9) break
			digits += String.fromCharCode(c)
		}
		return digits === "" ? -1 : Number(digits)
	}

	private reset(): void {
		this.state = "normal"
		this.seqLen = 0
		this.oscEscPending = false
	}
}

/**
 * Reconstructs command lines from what the user types into the shell, so the
 * orchestrator can show a pane's last command.
 *
 * Critically, a ConPTY-hosted shell enables Win32 Input Mode, so keystrokes do
 * NOT arrive as raw characters — they arrive as key-event records of the form
 * `ESC [ Vk ; Sc ; Uc ; Kd ; Cs ; Rc _` (Uc = the Unicode code unit, Kd = 1 for
 * key-down). We decode those (taking the char on key-down) and also still handle
 * raw VT input for terminals that don't use Win32 Input Mode. Best-effort: tracks
 * printable input, backspace and line-kill; ignores arrow keys / history; yields
 * the line on Enter. Not a full readline — good enough for a label.
 */
export class CommandLineTracker {
	private chars: string[] = []
	private state: "normal" | "esc" | "csi" | "escSeq" = "normal"
	private csi: number[] = []

	/** Feed input bytes; returns a completed command line, or null if none yet. */
	feed(chunk: Uint8Array): string | null {
		let completed: string | null = null
		for (const b of chunk) {
			switch (this.state) {
				case "normal":
					if (b === ESC) this.state = "esc"
					else completed = this.applyChar(b) ?? completed
					break
				case "esc":
					if (b === CSI_INTRODUCER) {
						this.state = "csi"
						this.csi = []
					} else if (b === 0x4f /* O */) {
						this.state = "escSeq"
					} else {
						this.state = "normal" // single-char escape; ignore
					}
					break
				case "csi":
					if (b >= 0x40 && b <= 0x7e) {
						// Final byte. `_` (0x5f) marks a Win32 Input Mode key event.
						if (b === 0x5f) completed = this.applyWin32() ?? completed
						this.state = "normal"
					} else {
						this.csi.push(b)
						if (this.csi.length > 64) this.state = "normal" // runaway guard
					}
					break
				case "escSeq":
					if ((b >= 0x40 && b <= 0x7e) || b === BEL) this.state = "normal"
					break
			}
		}
		return completed
	}

	/** Decode a buffered Win32 Input Mode record; apply the char on key-down. */
	private applyWin32(): string | null {
		const fields = String.fromCharCode(...this.csi).split(";")
		const uc = Number(fields[2] ?? "") || 0 // Unicode code unit
		const kd = Number(fields[3] ?? "") || 0 // 1 = key down
		if (kd !== 1 || uc === 0) return null
		return this.applyChar(uc)
	}

	/** Apply one input code unit to the line buffer; return the line on Enter. */
	private applyChar(code: number): string | null {
		if (code === 13 || code === 10) {
			const line = this.chars.join("").trim()
			this.chars = []
			return line || null
		}
		if (code === 8 || code === 127) {
			this.chars.pop() // backspace / delete
		} else if (code === 3 || code === 21) {
			this.chars = [] // Ctrl-C / Ctrl-U cancel the line
		} else if (code >= 32) {
			this.chars.push(String.fromCharCode(code))
		}
		return null
	}
}
