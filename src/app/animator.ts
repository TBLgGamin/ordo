import { getWindowRect, type Hwnd, type Rect, setWindowRect } from "../platform/win32"
import type { Direction } from "../platform/wt"

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
	animate(dir: Direction, items: Array<{ hwnd: Hwnd; to: Rect }>, animMs: number): void {
		// Supersede any in-flight animation for this zone.
		this.anims.get(dir)?.()
		this.anims.delete(dir)

		if (animMs <= 0 || items.length === 0) {
			for (const it of items) setWindowRect(it.hwnd, it.to)
			return
		}

		const froms = items.map((it) => getWindowRect(it.hwnd))
		const frameMs = 16
		const steps = Math.max(1, Math.round(animMs / frameMs))
		let step = 0
		let timer: ReturnType<typeof setTimeout>

		const tick = () => {
			step++
			const t = step / steps
			const e = 1 - (1 - t) ** 3 // easeOutCubic
			items.forEach((it, i) => {
				const f = froms[i]
				if (!f) return
				setWindowRect(it.hwnd, {
					x: f.x + (it.to.x - f.x) * e,
					y: f.y + (it.to.y - f.y) * e,
					w: f.w + (it.to.w - f.w) * e,
					h: f.h + (it.to.h - f.h) * e,
				})
			})
			if (step < steps) {
				timer = setTimeout(tick, frameMs)
			} else {
				this.anims.delete(dir)
				// Final correction in case WT applied a late size to a new window.
				setTimeout(() => {
					if (!this.anims.has(dir)) for (const it of items) setWindowRect(it.hwnd, it.to)
				}, 150)
			}
		}

		this.anims.set(dir, () => clearTimeout(timer))
		timer = setTimeout(tick, frameMs)
	}
}
