import { getWindowRect, type Hwnd, type Rect, setWindowRect } from "../platform/win32"
import type { Direction } from "../platform/wt"

const FRAME_MS = 16
const SETTLE_CORRECTION_MS = 150

/** Per-zone window slide/resize tweening, superseding in-flight animations. */
export class ZoneAnimator {
	/** Per-zone animation cancel handles, so a new retile supersedes an old one. */
	private readonly anims = new Map<Direction, () => void>()

	has(dir: Direction): boolean {
		return this.anims.has(dir)
	}

	cancel(dir: Direction): void {
		this.anims.get(dir)?.()
		this.anims.delete(dir)
	}

	cancelAll(): void {
		for (const cancel of this.anims.values()) cancel()
		this.anims.clear()
	}

	/** Tween a set of windows from their current rects to their targets. */
	animate(
		dir: Direction,
		items: Array<{ hwnd: Hwnd; to: Rect }>,
		animMs: number,
		setRect: (hwnd: Hwnd, rect: Rect) => void = setWindowRect,
		now: () => number = () => performance.now(),
	): void {
		this.anims.get(dir)?.()
		this.anims.delete(dir)

		if (animMs <= 0 || items.length === 0) {
			for (const it of items) setRect(it.hwnd, it.to)
			return
		}

		const froms = items.map((it) => getWindowRect(it.hwnd))
		const start = now()
		let timer: ReturnType<typeof setTimeout>
		let correction: ReturnType<typeof setTimeout> | undefined

		const cancel = () => {
			clearTimeout(timer)
			if (correction !== undefined) clearTimeout(correction)
		}

		const tick = () => {
			const t = Math.min(1, (now() - start) / animMs)
			const e = 1 - (1 - t) ** 3 // easeOutCubic
			items.forEach((it, i) => {
				const f = froms[i]
				if (!f) return
				setRect(it.hwnd, {
					x: f.x + (it.to.x - f.x) * e,
					y: f.y + (it.to.y - f.y) * e,
					w: f.w + (it.to.w - f.w) * e,
					h: f.h + (it.to.h - f.h) * e,
				})
			})
			if (t < 1) {
				timer = setTimeout(tick, FRAME_MS)
			} else {
				correction = setTimeout(() => {
					if (this.anims.get(dir) === cancel) {
						for (const it of items) setRect(it.hwnd, it.to)
						this.anims.delete(dir)
					}
				}, SETTLE_CORRECTION_MS)
			}
		}

		this.anims.set(dir, cancel)
		timer = setTimeout(tick, FRAME_MS)
	}
}
