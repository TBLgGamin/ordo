import { type CliRenderer, createTimeline, type EasingFunctions, engine } from "@opentui/core"

/**
 * Micro-animation helpers over OpenTUI's timeline engine. Every helper cleans
 * up after itself (one-shots unregister on completion, loops return a stop
 * function), so the renderer only stays in live mode while something is
 * actually moving — an idle command center renders nothing.
 */

/** Hook the shared timeline engine to the renderer's frame loop. Call once. */
export function attachAnimations(renderer: CliRenderer): void {
	engine.attach(renderer)
}

/**
 * One-shot tween: drives `onTick` with t going 0→1 over `duration` ms, then
 * unregisters itself. The final tick is always exactly 1.
 */
export function animateOnce(
	onTick: (t: number) => void,
	opts: { duration?: number; ease?: EasingFunctions; onDone?: () => void } = {},
): void {
	const duration = opts.duration ?? 300
	const target = { t: 0 }
	const tl = createTimeline({ duration })
	tl.add(target, {
		t: 1,
		duration,
		ease: opts.ease ?? "outQuad",
		onUpdate: () => onTick(target.t),
		onComplete: () => {
			onTick(1)
			engine.unregister(tl)
			opts.onDone?.()
		},
	})
}

/**
 * Looping left-to-right pass: `onTick` receives t going 0→1 each `period` ms,
 * over and over, linearly (callers shape the motion). Returns a stop function.
 */
export function sweepLoop(onTick: (t: number) => void, period = 2000): () => void {
	const target = { t: 0 }
	const tl = createTimeline({ duration: period, loop: true })
	tl.add(target, {
		t: 1,
		duration: period,
		ease: "linear",
		onUpdate: () => onTick(target.t),
	})
	return () => {
		tl.pause()
		engine.unregister(tl)
	}
}

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"]
const SPINNER_FRAME_MS = 90

/**
 * Braille spinner: calls `onFrame` with the next glyph ~11×/s until stopped.
 * Returns the stop function.
 */
export function spin(onFrame: (frame: string) => void): () => void {
	const period = SPINNER_FRAMES.length * SPINNER_FRAME_MS
	const target = { f: 0 }
	let last = -1
	const tl = createTimeline({ duration: period, loop: true })
	tl.add(target, {
		f: SPINNER_FRAMES.length,
		duration: period,
		ease: "linear",
		onUpdate: () => {
			const i = Math.floor(target.f) % SPINNER_FRAMES.length
			if (i === last) return
			last = i
			onFrame(SPINNER_FRAMES[i] ?? "⠋")
		},
	})
	return () => {
		tl.pause()
		engine.unregister(tl)
	}
}
