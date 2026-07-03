import {
	closeSync,
	read as fsRead,
	fstatSync,
	write as fsWrite,
	mkdirSync,
	openSync,
	renameSync,
} from "node:fs"
import { writeFile } from "node:fs/promises"
import { dirname } from "node:path"

function writeAll(fd: number, buf: Uint8Array): Promise<void> {
	return new Promise((resolve, reject) => {
		fsWrite(fd, buf, 0, buf.byteLength, null, (err) => (err ? reject(err) : resolve()))
	})
}

function readAt(fd: number, buf: Uint8Array, position: number): Promise<number> {
	return new Promise((resolve, reject) => {
		fsRead(fd, buf, 0, buf.byteLength, position, (err, bytesRead) =>
			err ? reject(err) : resolve(bytesRead),
		)
	})
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function retry<T>(fn: () => T, attempts = 5, delayMs = 40): Promise<T> {
	for (let i = 0; ; i++) {
		try {
			return fn()
		} catch (e) {
			if (i >= attempts - 1) throw e
			await sleep(delayMs)
		}
	}
}

/** Append-only raw-VT capture with async tail compaction (so a pane can't fill the disk). */
export class CaptureWriter {
	private fd = -1
	private bytes = 0
	private ok = false
	private static readonly MAX = 8 * 1024 * 1024
	private static readonly KEEP = 2 * 1024 * 1024
	private static readonly QUEUE_MAX = 8 * 1024 * 1024
	private static readonly BATCH = 256 * 1024
	private readonly queue: Uint8Array[] = []
	private queued = 0
	private pumping = false
	private closing = false
	private readonly idle: Array<() => void> = []

	constructor(private readonly path: string) {
		try {
			mkdirSync(dirname(path), { recursive: true })
		} catch {}
		try {
			this.fd = openSync(path, "a")
			this.bytes = fstatSync(this.fd).size
			this.ok = true
		} catch {
			this.fd = -1
		}
	}

	write(chunk: Uint8Array): void {
		if (!this.ok || this.closing || chunk.byteLength === 0) return
		this.queue.push(chunk)
		this.queued += chunk.byteLength
		while (this.queued > CaptureWriter.QUEUE_MAX && this.queue.length > 1) {
			const dropped = this.queue.shift()
			if (dropped) this.queued -= dropped.byteLength
		}
		if (!this.pumping) void this.pump()
	}

	private async pump(): Promise<void> {
		this.pumping = true
		try {
			while (this.queue.length > 0) {
				if (this.fd < 0) {
					this.queue.length = 0
					this.queued = 0
					break
				}
				const batch: Uint8Array[] = []
				let size = 0
				while (this.queue.length > 0 && size < CaptureWriter.BATCH) {
					const c = this.queue.shift() as Uint8Array
					batch.push(c)
					size += c.byteLength
					this.queued -= c.byteLength
				}
				const buf = batch.length === 1 ? (batch[0] as Uint8Array) : Buffer.concat(batch)
				try {
					await writeAll(this.fd, buf)
					this.bytes += buf.byteLength
				} catch {}
				if (this.bytes > CaptureWriter.MAX) await this.compact()
			}
		} finally {
			this.pumping = false
			if (this.queue.length > 0 && this.fd >= 0) {
				void this.pump()
			} else {
				const waiters = this.idle.splice(0)
				for (const w of waiters) w()
			}
		}
	}

	private async compact(): Promise<void> {
		if (this.fd < 0) return
		try {
			closeSync(this.fd)
		} catch {}
		this.fd = -1
		try {
			const readFd = openSync(this.path, "r")
			const size = fstatSync(readFd).size
			const keep = Math.min(CaptureWriter.KEEP, size)
			const buf = new Uint8Array(keep)
			if (keep > 0) await readAt(readFd, buf, size - keep)
			closeSync(readFd)
			const tmp = `${this.path}.tmp`
			await writeFile(tmp, buf)
			await retry(() => renameSync(tmp, this.path))
		} catch {}
		try {
			this.fd = await retry(() => openSync(this.path, "a"))
			this.bytes = fstatSync(this.fd).size
		} catch {
			this.fd = -1
			this.ok = false
			console.error(`[ordo daemon] capture compaction failed to reopen ${this.path}`)
		}
	}

	async close(): Promise<void> {
		this.closing = true
		if (this.pumping) {
			await new Promise<void>((resolve) => this.idle.push(resolve))
		}
		if (this.fd >= 0) {
			try {
				closeSync(this.fd)
			} catch {}
			this.fd = -1
		}
	}
}
