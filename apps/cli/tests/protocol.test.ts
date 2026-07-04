import { describe, expect, test } from "bun:test"
import { encode, LineDecoder } from "../src/core/protocol"

type TestMsg = { type: string; [k: string]: unknown }

describe("encode", () => {
	test("produces a single newline-terminated JSON line", () => {
		const bytes = encode({ type: "shutdown" })
		const text = new TextDecoder().decode(bytes)
		expect(text.endsWith("\n")).toBe(true)
		expect(text.split("\n").filter(Boolean)).toHaveLength(1)
		expect(JSON.parse(text)).toEqual({ type: "shutdown" })
	})
})

describe("LineDecoder", () => {
	const enc = (s: string) => new TextEncoder().encode(s)

	test("decodes one whole message", () => {
		const dec = new LineDecoder<TestMsg>()
		const out = dec.push(encode({ type: "hello", paneId: "optio", pid: 42 }))
		expect(out).toEqual([{ type: "hello", paneId: "optio", pid: 42 }])
	})

	test("decodes multiple messages in one chunk", () => {
		const dec = new LineDecoder<TestMsg>()
		const chunk = new Uint8Array([
			...encode({ type: "hello", paneId: "a", pid: 1 }),
			...encode({ type: "exit", paneId: "a", code: 0 }),
		])
		const out = dec.push(chunk)
		expect(out).toHaveLength(2)
		expect(out[0]?.type).toBe("hello")
		expect(out[1]?.type).toBe("exit")
	})

	test("buffers a message split across chunks", () => {
		const dec = new LineDecoder<TestMsg>()
		const full = new TextDecoder().decode(encode({ type: "output", paneId: "x", data: "hi" }))
		const mid = Math.floor(full.length / 2)
		expect(dec.push(enc(full.slice(0, mid)))).toEqual([])
		expect(dec.push(enc(full.slice(mid)))).toEqual([{ type: "output", paneId: "x", data: "hi" }])
	})

	test("ignores blank lines between messages", () => {
		const dec = new LineDecoder<TestMsg>()
		const out = dec.push(enc(`\n\n${JSON.stringify({ type: "run", command: "ls" })}\n\n`))
		expect(out).toEqual([{ type: "run", command: "ls" }])
	})

	test("round-trips the foreground message", () => {
		const dec = new LineDecoder<TestMsg>()
		const out = dec.push(encode({ type: "foreground", paneId: "p", name: "vim" }))
		expect(out).toEqual([{ type: "foreground", paneId: "p", name: "vim" }])
		const out2 = dec.push(encode({ type: "foreground", paneId: "p", name: null }))
		expect(out2[0]).toEqual({ type: "foreground", paneId: "p", name: null })
	})

	test("drops a malformed line but keeps valid ones in the same chunk", () => {
		const dec = new LineDecoder<TestMsg>()
		const chunk = enc(
			`this is not json\n${JSON.stringify({ type: "exit", paneId: "a", code: 0 })}\n`,
		)
		expect(dec.push(chunk)).toEqual([{ type: "exit", paneId: "a", code: 0 }])
	})

	test("throws when a line exceeds maxLine without a newline", () => {
		const dec = new LineDecoder<TestMsg>(16)
		expect(() => dec.push(enc("x".repeat(64)))).toThrow()
	})

	test("resets its buffer after an overflow throw", () => {
		const dec = new LineDecoder<TestMsg>(16)
		expect(() => dec.push(enc("x".repeat(64)))).toThrow()
		expect(dec.push(encode({ type: "exit", paneId: "a", code: 0 }))).toEqual([
			{ type: "exit", paneId: "a", code: 0 },
		])
	})

	test("decodes a large burst of messages in one chunk correctly", () => {
		const dec = new LineDecoder<TestMsg>()
		const parts: number[] = []
		for (let i = 0; i < 10000; i++) parts.push(...encode({ type: "n", i }))
		const out = dec.push(new Uint8Array(parts))
		expect(out).toHaveLength(10000)
		expect(out[0]).toEqual({ type: "n", i: 0 })
		expect(out[9999]).toEqual({ type: "n", i: 9999 })
	})

	test("invokes the onDrop hook for each malformed line", () => {
		const dropped: string[] = []
		const dec = new LineDecoder<TestMsg>(1 << 20, (line) => dropped.push(line))
		const chunk = enc(`not json\n${JSON.stringify({ type: "ok" })}\nalso bad\n`)
		const out = dec.push(chunk)
		expect(out).toEqual([{ type: "ok" }])
		expect(dropped).toEqual(["not json", "also bad"])
	})
})
