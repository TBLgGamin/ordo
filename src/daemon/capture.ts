import {
	closeSync,
	fstatSync,
	mkdirSync,
	openSync,
	readFileSync,
	writeFileSync,
	writeSync,
} from "node:fs"
import { dirname } from "node:path"

/** Append-only raw-VT capture with tail compaction (so a pane can't fill the disk). */
export class CaptureWriter {
	private fd = -1
	private bytes = 0
	private static readonly MAX = 8 * 1024 * 1024
	private static readonly KEEP = 2 * 1024 * 1024

	constructor(private readonly path: string) {
		try {
			mkdirSync(dirname(path), { recursive: true })
		} catch {}
		try {
			this.fd = openSync(path, "a")
			this.bytes = fstatSync(this.fd).size
		} catch {
			this.fd = -1
		}
	}
	write(chunk: Uint8Array): void {
		if (this.fd < 0) return
		try {
			writeSync(this.fd, chunk)
			this.bytes += chunk.byteLength
			if (this.bytes > CaptureWriter.MAX) this.compact()
		} catch {}
	}
	private compact(): void {
		try {
			const buf = readFileSync(this.path)
			const tail = buf.subarray(Math.max(0, buf.byteLength - CaptureWriter.KEEP))
			closeSync(this.fd)
			writeFileSync(this.path, tail)
			this.fd = openSync(this.path, "a")
			this.bytes = tail.byteLength
		} catch {}
	}
	close(): void {
		if (this.fd >= 0) {
			try {
				closeSync(this.fd)
			} catch {}
			this.fd = -1
		}
	}
}
