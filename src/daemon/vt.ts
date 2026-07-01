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

export interface TitleStripperOptions {
	/** Drop the shell's first screen-clear/home (used during restore). */
	suppressStartupClears?: boolean
	/** Called with the path whenever the shell reports its cwd via OSC 9;9. */
	onCwd?: (path: string) => void
}

export class TitleStripper {
	private state: State = "normal"
	private buf: number[] = []
	private oscEscPending = false
	private suppressClears: boolean
	private readonly onCwd?: (path: string) => void
	private static readonly MAX_SEQ = 8192

	constructor(opts: TitleStripperOptions = {}) {
		this.suppressClears = opts.suppressStartupClears ?? false
		this.onCwd = opts.onCwd
	}

	push(chunk: Uint8Array): Uint8Array {
		const out: number[] = []
		for (const b of chunk) {
			switch (this.state) {
				case "normal":
					if (b === ESC) {
						this.state = "esc"
						this.buf = [b]
					} else {
						out.push(b)
						// First visible character from the shell (its prompt) ends the
						// startup-clear suppression window. Control bytes don't count.
						if (this.suppressClears && b >= 0x20 && b !== 0x7f) this.suppressClears = false
					}
					break

				case "esc":
					if (b === OSC_INTRODUCER) {
						this.state = "osc"
						this.buf.push(b)
						this.oscEscPending = false
					} else if (b === CSI_INTRODUCER) {
						this.state = "csi"
						this.buf.push(b)
					} else {
						out.push(...this.buf)
						this.buf = []
						if (b === ESC) {
							this.state = "esc"
							this.buf = [b]
						} else {
							this.state = "normal"
							out.push(b)
						}
					}
					break

				case "csi":
					this.buf.push(b)
					// CSI ends at a final byte in 0x40..0x7e.
					if (b >= 0x40 && b <= 0x7e) {
						this.endCsi(out)
					} else if (this.buf.length > TitleStripper.MAX_SEQ) {
						out.push(...this.buf)
						this.reset()
					}
					break

				case "osc":
					this.buf.push(b)
					if (this.oscEscPending) {
						this.oscEscPending = false
						if (b === BACKSLASH) this.endOsc(out)
					} else if (b === BEL) {
						this.endOsc(out)
					} else if (b === ESC) {
						this.oscEscPending = true
					}
					if (this.state === "osc" && this.buf.length > TitleStripper.MAX_SEQ) {
						out.push(...this.buf)
						this.reset()
					}
					break
			}
		}
		return Uint8Array.from(out)
	}

	/** At a CSI final byte: drop a startup clear/home while suppressing; else emit. */
	private endCsi(out: number[]): void {
		if (this.suppressClears && this.isStartupClearOrHome()) {
			this.reset()
			return
		}
		out.push(...this.buf)
		this.reset()
	}

	/** True for full screen-clears (CSI 2J / 3J) and cursor-home (CSI H/f, 1;1). */
	private isStartupClearOrHome(): boolean {
		// buf = [ESC, '[', ...params..., final]
		const final = this.buf[this.buf.length - 1]
		let params = ""
		for (let i = 2; i < this.buf.length - 1; i++) {
			const c = this.buf[i]
			if (c !== undefined) params += String.fromCharCode(c)
		}
		if (final === 0x4a /* J */) return params === "2" || params === "3"
		if (final === 0x48 /* H */ || final === 0x66 /* f */) {
			return params === "" || params === "1;1" || params === "0;0" || params === "1"
		}
		return false
	}

	private endOsc(out: number[]): void {
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
		if (ps !== 0 && ps !== 1 && ps !== 2) out.push(...this.buf)
		this.reset()
	}

	/** The OSC payload text (between `ESC ]` and the terminator), decoded as UTF-8. */
	private oscPayload(): string {
		// buf = [ESC, ']', ...payload..., BEL]  OR  [..., ESC, '\']
		let end = this.buf.length
		if (this.buf[end - 1] === BEL) end -= 1
		else if (this.buf[end - 1] === BACKSLASH && this.buf[end - 2] === ESC) end -= 2
		return new TextDecoder().decode(Uint8Array.from(this.buf.slice(2, end)))
	}

	private oscOpcode(): number {
		let digits = ""
		for (let i = 2; i < this.buf.length; i++) {
			const c = this.buf[i]
			if (c === undefined || c < DIGIT_0 || c > DIGIT_9) break
			digits += String.fromCharCode(c)
		}
		return digits === "" ? -1 : Number(digits)
	}

	private reset(): void {
		this.state = "normal"
		this.buf = []
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
