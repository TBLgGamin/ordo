import { describe, expect, test } from "bun:test"
import { textFromVt } from "../src/daemon/replay"

const enc = (s: string) => new TextEncoder().encode(s)

describe("textFromVt", () => {
	test("returns plain text with escape codes stripped", async () => {
		const out = await textFromVt([enc("\x1b[31mHELLO\x1b[0m world\r\n")], 80, 24, 120)
		expect(out).toBe("HELLO world")
		expect(out).not.toContain("\x1b")
	})

	test("joins multiple lines and trims trailing blanks", async () => {
		const out = await textFromVt([enc("line1\r\nline2\r\n")], 80, 24, 120)
		expect(out).toBe("line1\nline2")
	})

	test("returns only the last N lines", async () => {
		const out = await textFromVt([enc("a\r\nb\r\nc\r\nd\r\ne\r\n")], 80, 24, 2)
		expect(out).toBe("d\ne")
	})

	test("reflects the final screen after a clear", async () => {
		const out = await textFromVt([enc("junk\r\n\x1b[2J\x1b[HKEEPER\r\n")], 80, 24, 120)
		expect(out).toContain("KEEPER")
		expect(out).not.toContain("junk")
	})

	test("empty input yields an empty string", async () => {
		expect(await textFromVt([], 80, 24, 120)).toBe("")
	})
})
