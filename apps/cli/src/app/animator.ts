import { ANIM_FRAME_MS } from "../core/config"
import {
	type Direction,
	getWindowRect,
	moveWindow,
	moveWindows,
	type Rect,
	setWindowRect,
	type WindowHandle,
} from "../platform"

const SETTLE_CORRECTION_MS = 150

export interface AnimatorOps {
	getRect(handle: WindowHandle): Rect | null
	setRect(handle: WindowHandle, rect: Rect): void
	move(handle: WindowHandle, x: number, y: number): void
	moveBatch(items: Array<{ handle: WindowHandle; x: number; y: number }>): void
	now(): number
}

const defaultOps: AnimatorOps = {
	getRect: getWindowRect,
	setRect: (handle, rect) => {
		setWindowRect(handle, rect)
	},
	move: (handle, x, y) => {
		moveWindow(handle, x, y)
	},
	moveBatch: (items) => {
		moveWindows(items)
	},
	now: () => performance.now(),
}

interface Tween {
	handle: WindowHandle
	from: Rect
	to: Rect
}

export class ZoneAnimator {
	private readonly anims = new Map<Direction, () => void>()

	has(dir: Direction): boolean {
		return this.anims.has(dir)
	}

	hasAny(): boolean {
		return this.anims.size > 0
	}

	cancel(dir: Direction): void {
		this.anims.get(dir)?.()
		this.anims.delete(dir)
	}

	cancelAll(): void {
		for (const cancel of this.anims.values()) cancel()
		this.anims.clear()
	}

	animate(
		dir: Direction,
		items: Array<{ handle: WindowHandle; to: Rect }>,
		animMs: number,
		ops: AnimatorOps = defaultOps,
	): void {
		this.anims.get(dir)?.()
		this.anims.delete(dir)

		if (animMs <= 0 || items.length === 0) {
			for (const it of items) ops.setRect(it.handle, it.to)
			return
		}

		const tweens: Tween[] = []
		for (const it of items) {
			const from = ops.getRect(it.handle)
			if (!from) {
				ops.setRect(it.handle, it.to)
				continue
			}
			tweens.push({ handle: it.handle, from, to: it.to })
		}
		if (tweens.length === 0) return

		for (const tw of tweens) {
			if (Math.round(tw.to.w) !== tw.from.w || Math.round(tw.to.h) !== tw.from.h) {
				ops.setRect(tw.handle, { x: tw.from.x, y: tw.from.y, w: tw.to.w, h: tw.to.h })
			}
		}

		const start = ops.now()
		let frame = 0
		let timer: ReturnType<typeof setTimeout>
		let correction: ReturnType<typeof setTimeout> | undefined

		const cancel = () => {
			clearTimeout(timer)
			if (correction !== undefined) clearTimeout(correction)
		}

		const applyMove = (positions: Array<{ handle: WindowHandle; x: number; y: number }>) => {
			if (positions.length >= 2) ops.moveBatch(positions)
			else for (const p of positions) ops.move(p.handle, p.x, p.y)
		}

		const schedule = () => {
			frame++
			timer = setTimeout(tick, Math.max(0, start + frame * ANIM_FRAME_MS - ops.now()))
		}

		const tick = () => {
			const t = Math.min(1, (ops.now() - start) / animMs)
			const e = 1 - (1 - t) ** 3
			if (t < 1) {
				applyMove(
					tweens.map((tw) => ({
						handle: tw.handle,
						x: tw.from.x + (tw.to.x - tw.from.x) * e,
						y: tw.from.y + (tw.to.y - tw.from.y) * e,
					})),
				)
				schedule()
			} else {
				for (const tw of tweens) ops.setRect(tw.handle, tw.to)
				correction = setTimeout(() => {
					if (this.anims.get(dir) === cancel) {
						for (const tw of tweens) ops.setRect(tw.handle, tw.to)
						this.anims.delete(dir)
					}
				}, SETTLE_CORRECTION_MS)
			}
		}

		this.anims.set(dir, cancel)
		schedule()
	}
}
