import { describe, expect, test } from "bun:test"
import { CommandLineTracker, TitleStripper } from "../src/vt"

const enc = (s: string) => new TextEncoder().encode(s)
const dec = (b: Uint8Array) => new TextDecoder().decode(b)
const strip = (s: string) => dec(new TitleStripper().push(enc(s)))

describe("TitleStripper", () => {
	test("passes plain text through unchanged", () => {
		expect(strip("hello world")).toBe("hello world")
	})

	test("strips an OSC 0 title (BEL-terminated) but keeps surrounding text", () => {
		expect(strip("before\x1b]0;C:\\pwsh.exe\x07after")).toBe("beforeafter")
	})

	test("strips OSC 2 (window title) and OSC 1 (icon)", () => {
		expect(strip("\x1b]2;title\x07X")).toBe("X")
		expect(strip("\x1b]1;icon\x07Y")).toBe("Y")
	})

	test("strips an ST-terminated title (ESC backslash)", () => {
		expect(strip("\x1b]0;title\x1b\\Z")).toBe("Z")
	})

	test("keeps non-title OSC: colors (10/11) and hyperlinks (8)", () => {
		expect(strip("\x1b]11;#000000\x07X")).toBe("\x1b]11;#000000\x07X")
		expect(strip("\x1b]8;;https://example.com\x07link\x1b]8;;\x07")).toBe(
			"\x1b]8;;https://example.com\x07link\x1b]8;;\x07",
		)
	})

	test("keeps CSI color sequences untouched", () => {
		expect(strip("\x1b[31mred\x1b[0m")).toBe("\x1b[31mred\x1b[0m")
	})

	test("buffers a title split across chunks", () => {
		const s = new TitleStripper()
		expect(dec(s.push(enc("A\x1b]0;ti")))).toBe("A")
		expect(dec(s.push(enc("tle\x07B")))).toBe("B")
	})

	test("handles a lone ESC at a chunk boundary", () => {
		const s = new TitleStripper()
		expect(dec(s.push(enc("A\x1b")))).toBe("A")
		expect(dec(s.push(enc("]0;t\x07B")))).toBe("B")
	})

	test("a CSI sequence split after ESC is preserved", () => {
		const s = new TitleStripper()
		expect(dec(s.push(enc("\x1b")))).toBe("")
		expect(dec(s.push(enc("[31mR")))).toBe("\x1b[31mR")
	})

	test("strips multiple titles in one stream", () => {
		expect(strip("\x1b]0;a\x07x\x1b]2;b\x07y")).toBe("xy")
	})

	test("does NOT strip clears by default", () => {
		expect(strip("\x1b[2J\x1b[Hkeep")).toBe("\x1b[2J\x1b[Hkeep")
	})
})

describe("TitleStripper startup-clear suppression", () => {
	const run = (s: string) =>
		new TextDecoder().decode(new TitleStripper({ suppressStartupClears: true }).push(enc(s)))

	test("drops the ConPTY startup clear + home, keeps modes and prompt", () => {
		// Typical pwsh/ConPTY startup frame, then the prompt.
		const out = run("\x1b[?25l\x1b[2J\x1b[m\x1b[HPS C:\\>")
		expect(out).toContain("PS C:\\>")
		expect(out).not.toContain("[2J")
		expect(out).not.toContain("[H")
		expect(out).toContain("\x1b[?25l") // cursor-hide mode preserved
		expect(out).toContain("\x1b[m") // SGR reset preserved
	})

	test("stops suppressing after the first visible character (later clears pass)", () => {
		const s = new TitleStripper({ suppressStartupClears: true })
		const dec = (b: Uint8Array) => new TextDecoder().decode(b)
		// startup clear dropped, prompt shown...
		expect(dec(s.push(enc("\x1b[2JX")))).toBe("X")
		// ...a later clear (e.g. `cls`) must NOT be dropped.
		expect(dec(s.push(enc("\x1b[2JY")))).toBe("\x1b[2JY")
	})

	test("does not drop partial-clear (CSI K) or scroll-region sequences", () => {
		expect(run("\x1b[Kprompt")).toBe("\x1b[Kprompt")
	})
})

describe("CommandLineTracker", () => {
	const feed = (t: CommandLineTracker, s: string) => t.feed(new TextEncoder().encode(s))

	test("yields a command line on Enter", () => {
		const t = new CommandLineTracker()
		expect(feed(t, "git status")).toBeNull()
		expect(feed(t, "\r")).toBe("git status")
	})

	test("applies backspace edits", () => {
		const t = new CommandLineTracker()
		feed(t, "gti")
		feed(t, "\x7f\x7f") // erase "ti"
		feed(t, "it status")
		expect(feed(t, "\r")).toBe("git status")
	})

	test("ignores arrow-key / escape sequences", () => {
		const t = new CommandLineTracker()
		feed(t, "ls")
		feed(t, "\x1b[D\x1b[C") // left, right arrows
		expect(feed(t, "\r")).toBe("ls")
	})

	test("Ctrl-U cancels the current line", () => {
		const t = new CommandLineTracker()
		feed(t, "rm -rf /")
		feed(t, "\x15") // Ctrl-U
		feed(t, "echo safe")
		expect(feed(t, "\r")).toBe("echo safe")
	})

	test("returns null for an empty line", () => {
		const t = new CommandLineTracker()
		expect(feed(t, "\r")).toBeNull()
		expect(feed(t, "   \r")).toBeNull()
	})

	test("handles command and Enter in one chunk", () => {
		const t = new CommandLineTracker()
		expect(feed(t, "whoami\r")).toBe("whoami")
	})
})

describe("CommandLineTracker (Win32 Input Mode)", () => {
	// A ConPTY key event: ESC [ Vk ; Sc ; Uc ; Kd ; Cs ; Rc _  (Uc=char, Kd=1 down)
	const key = (uc: number, down = 1) => `\x1b[0;0;${uc};${down};0;1_`
	const downUp = (uc: number) => key(uc, 1) + key(uc, 0)
	const feed = (t: CommandLineTracker, s: string) => t.feed(new TextEncoder().encode(s))

	test("decodes a typed command from key-event records", () => {
		const t = new CommandLineTracker()
		// type "ls"
		feed(t, downUp(108) + downUp(115)) // 'l','s'
		expect(feed(t, key(13))).toBe("ls") // Enter
	})

	test("ignores key-up events (no double characters)", () => {
		const t = new CommandLineTracker()
		feed(t, key(104, 1) + key(104, 0)) // 'h' down then up
		feed(t, downUp(105)) // 'i'
		expect(feed(t, downUp(13))).toBe("hi")
	})

	test("applies backspace key events", () => {
		const t = new CommandLineTracker()
		feed(t, downUp(103) + downUp(116) + downUp(105)) // "gti"
		feed(t, downUp(8) + downUp(8)) // backspace x2 -> "g"
		feed(t, downUp(105) + downUp(116)) // "it"
		expect(feed(t, key(13))).toBe("git")
	})

	test("ignores non-character keys (arrows: Uc=0)", () => {
		const t = new CommandLineTracker()
		feed(t, downUp(108) + downUp(115)) // "ls"
		feed(t, key(0) + key(0)) // arrow-like events with no char
		expect(feed(t, key(13))).toBe("ls")
	})

	test("the exact bytes a real ConPTY sent for 'echo hello'", () => {
		const t = new CommandLineTracker()
		// Captured from a live agent (Vk/Sc vary; Uc is the char, Kd the 4th field).
		const real =
			"\x1b[69;18;101;1;0;1_\x1b[69;18;101;0;0;1_" + // e
			"\x1b[67;46;99;1;0;1_\x1b[67;46;99;0;0;1_" + // c
			"\x1b[72;35;104;1;0;1_\x1b[72;35;104;0;0;1_" + // h
			"\x1b[79;24;111;1;0;1_\x1b[79;24;111;0;0;1_" + // o
			"\x1b[32;57;32;1;0;1_\x1b[32;57;32;0;0;1_" + // space
			"\x1b[72;35;104;1;0;1_\x1b[72;35;104;0;0;1_" + // h
			"\x1b[69;18;101;1;0;1_\x1b[69;18;101;0;0;1_" + // e
			"\x1b[76;38;108;1;0;1_\x1b[76;38;108;0;0;1_" + // l
			"\x1b[76;38;108;1;0;1_\x1b[76;38;108;0;0;1_" + // l
			"\x1b[79;24;111;1;0;1_\x1b[79;24;111;0;0;1_" // o
		feed(t, real)
		expect(feed(t, "\x1b[13;28;13;1;0;1_")).toBe("echo hello") // Enter
	})
})
