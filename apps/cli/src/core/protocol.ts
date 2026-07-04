/**
 * Newline-delimited JSON framing shared by every ordo socket connection.
 *
 * Each message is a single JSON object on its own line — trivial to produce and
 * parse in Bun, and it survives partial reads. `encode` frames one message;
 * `LineDecoder` reassembles a byte stream back into whole messages.
 */

const lineEncoder = new TextEncoder()

/** Frame any JSON-serializable message as a single newline-terminated line. */
export function encode(msg: object): Uint8Array {
	return lineEncoder.encode(`${JSON.stringify(msg)}\n`)
}

/**
 * Stateful newline framer. Feed it raw socket chunks; it yields complete
 * messages and buffers any trailing partial line until the next chunk.
 */
export class LineDecoder<T> {
	private buffer = ""
	private scanned = 0
	private readonly decoder = new TextDecoder()

	constructor(
		private readonly maxLine = 1 << 20,
		private readonly onDrop?: (line: string) => void,
	) {}

	push(chunk: Uint8Array): T[] {
		this.buffer += this.decoder.decode(chunk, { stream: true })
		const out: T[] = []
		let start = 0
		let newline = this.buffer.indexOf("\n", this.scanned)
		while (newline !== -1) {
			const line = this.buffer.slice(start, newline).trim()
			start = newline + 1
			if (line) {
				try {
					out.push(JSON.parse(line) as T)
				} catch {
					this.onDrop?.(line)
				}
			}
			newline = this.buffer.indexOf("\n", start)
		}
		if (start > 0) this.buffer = this.buffer.slice(start)
		this.scanned = this.buffer.length
		if (this.buffer.length > this.maxLine) {
			this.buffer = ""
			this.scanned = 0
			throw new Error("line overflow")
		}
		return out
	}
}
