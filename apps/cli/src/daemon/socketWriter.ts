interface WritableSocket {
	write(data: Uint8Array): number
	flush(): void
}

export class SocketWriter {
	private readonly queue: Uint8Array[] = []
	private queued = 0
	private readonly emptyCbs = new Set<() => void>()
	private overflowed = false

	constructor(
		private readonly sock: WritableSocket,
		private readonly maxBuffer = 4 * 1024 * 1024,
		private readonly onOverflow?: () => void,
	) {}

	get pending(): number {
		return this.queued
	}

	write(bytes: Uint8Array): void {
		if (bytes.byteLength === 0) return
		if (this.queue.length === 0) {
			const written = this.trySend(bytes)
			if (written >= bytes.byteLength) {
				try {
					this.sock.flush()
				} catch {}
				return
			}
			this.enqueue(written > 0 ? bytes.subarray(written) : bytes)
		} else {
			this.enqueue(bytes)
		}
	}

	drain(): void {
		while (this.queue.length > 0) {
			const head = this.queue[0]
			if (!head) {
				this.queue.shift()
				continue
			}
			const written = this.trySend(head)
			if (written >= head.byteLength) {
				this.queue.shift()
				this.queued -= head.byteLength
			} else {
				if (written > 0) {
					this.queue[0] = head.subarray(written)
					this.queued -= written
				}
				return
			}
		}
		try {
			this.sock.flush()
		} catch {}
		this.fireEmpty()
	}

	onEmpty(cb: () => void): void {
		if (this.queue.length === 0) {
			cb()
			return
		}
		this.emptyCbs.add(cb)
	}

	private enqueue(bytes: Uint8Array): void {
		this.queue.push(bytes)
		this.queued += bytes.byteLength
		if (this.queued > this.maxBuffer && !this.overflowed) {
			this.overflowed = true
			this.onOverflow?.()
		}
	}

	private trySend(bytes: Uint8Array): number {
		try {
			const n = this.sock.write(bytes)
			return typeof n === "number" && n > 0 ? n : 0
		} catch {
			return 0
		}
	}

	private fireEmpty(): void {
		if (this.emptyCbs.size === 0) return
		const cbs = [...this.emptyCbs]
		this.emptyCbs.clear()
		for (const cb of cbs) cb()
	}
}
