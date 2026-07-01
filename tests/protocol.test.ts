import { describe, expect, test } from "bun:test"
import { type AgentMessage, encode, type HubMessage, LineDecoder } from "../src/core/protocol"

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
		const dec = new LineDecoder<AgentMessage>()
		const out = dec.push(encode({ type: "hello", paneId: "optio", pid: 42 }))
		expect(out).toEqual([{ type: "hello", paneId: "optio", pid: 42 }])
	})

	test("decodes multiple messages in one chunk", () => {
		const dec = new LineDecoder<AgentMessage>()
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
		const dec = new LineDecoder<AgentMessage>()
		const full = new TextDecoder().decode(encode({ type: "output", paneId: "x", data: "hi" }))
		const mid = Math.floor(full.length / 2)
		expect(dec.push(enc(full.slice(0, mid)))).toEqual([])
		expect(dec.push(enc(full.slice(mid)))).toEqual([{ type: "output", paneId: "x", data: "hi" }])
	})

	test("ignores blank lines between messages", () => {
		const dec = new LineDecoder<HubMessage>()
		const out = dec.push(enc(`\n\n${JSON.stringify({ type: "run", command: "ls" })}\n\n`))
		expect(out).toEqual([{ type: "run", command: "ls" }])
	})

	test("round-trips the foreground message", () => {
		const dec = new LineDecoder<AgentMessage>()
		const out = dec.push(encode({ type: "foreground", paneId: "p", name: "vim" }))
		expect(out).toEqual([{ type: "foreground", paneId: "p", name: "vim" }])
		const out2 = dec.push(encode({ type: "foreground", paneId: "p", name: null }))
		expect(out2[0]).toEqual({ type: "foreground", paneId: "p", name: null })
	})
})
