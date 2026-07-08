<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from "vue"

type DotShape = "rect" | "circle" | "ring" | "triangle" | "diamond" | "cross"
type DotMorph = "none" | "random" | "sequence"

const props = withDefaults(
	defineProps<{
		shapes?: DotShape[]
		morph?: DotMorph
		morphIntervalMs?: number
		gap?: number
		dotRadius?: number
		color?: string
		opacity?: number
		influenceRadius?: number
		intensity?: number
		fill?: number
		floor?: number
	}>(),
	{
		shapes: () => ["rect"],
		morph: "none",
		morphIntervalMs: 4200,
		gap: 13,
		dotRadius: 1.2,
		color: "auto",
		opacity: 1,
		influenceRadius: 96,
		intensity: 1,
		fill: 0.62,
		floor: 0,
	},
)

const TRANSITION_MS = 1500
const EXCITE_FILL = 0.97
const MIN_FLIP_S = 0.5
const MAX_FLIP_S = 2.2
const EASE_BASE = 2.6
const EASE_FAST = 9
const EXCITE_TIME_GAIN = 3
const FALLBACK_DOT_COLOR = "#8e8e99"

const containerRef = ref<HTMLDivElement>()
const canvasRef = ref<HTMLCanvasElement>()

const clamp = (value: number, lo: number, hi: number): number =>
	value < lo ? lo : value > hi ? hi : value

const lerp = (a: number, b: number, t: number): number => a + (b - a) * t

const smoothstep = (edge0: number, edge1: number, x: number): number => {
	const t = clamp((x - edge0) / (edge1 - edge0), 0, 1)
	return t * t * (3 - 2 * t)
}

const easeInOut = (t: number): number => t * t * (3 - 2 * t)

const TRIANGLE_POINTS = [
	[0.5, 0.08],
	[0.92, 0.9],
	[0.08, 0.9],
] as const

const polygonMembership = (
	points: readonly (readonly [number, number])[],
	nx: number,
	ny: number,
	feather: number,
): number => {
	let area = 0
	for (let i = 0; i < points.length; i++) {
		const a = points[i]
		const b = points[(i + 1) % points.length]
		if (!a || !b) continue
		area += a[0] * b[1] - b[0] * a[1]
	}
	const orient = area > 0 ? 1 : -1
	let minDist = Infinity
	for (let i = 0; i < points.length; i++) {
		const a = points[i]
		const b = points[(i + 1) % points.length]
		if (!a || !b) continue
		const ex = b[0] - a[0]
		const ey = b[1] - a[1]
		const len = Math.hypot(ex, ey) || 1
		const cross = (ex * (ny - a[1]) - ey * (nx - a[0])) / len
		const dist = cross * orient
		if (dist < minDist) minDist = dist
	}
	return smoothstep(-feather, feather, minDist)
}

const shapeMembership = (shape: DotShape, nx: number, ny: number): number => {
	const cx = nx - 0.5
	const cy = ny - 0.5
	switch (shape) {
		case "rect": {
			const m = Math.max(Math.abs(cx), Math.abs(cy))
			return 1 - smoothstep(0.47, 0.5, m)
		}
		case "circle": {
			const d = Math.hypot(cx, cy)
			return 1 - smoothstep(0.43, 0.5, d)
		}
		case "ring": {
			const d = Math.hypot(cx, cy)
			return (1 - smoothstep(0.43, 0.5, d)) * smoothstep(0.24, 0.32, d)
		}
		case "diamond": {
			const m = Math.abs(cx) + Math.abs(cy)
			return 1 - smoothstep(0.44, 0.5, m)
		}
		case "cross": {
			const h = 1 - smoothstep(0.12, 0.18, Math.abs(cy))
			const v = 1 - smoothstep(0.12, 0.18, Math.abs(cx))
			return Math.max(h, v)
		}
		case "triangle":
			return polygonMembership(TRIANGLE_POINTS, nx, ny, 0.05)
	}
}

const parseRgb = (value: string): { r: number; g: number; b: number; a: number } | null => {
	const match = /rgba?\(([^)]+)\)/.exec(value)
	if (!match?.[1]) return null
	const parts = match[1].split(",").map((part) => parseFloat(part.trim()))
	const [r, g, b, a] = parts
	if (r === undefined || g === undefined || b === undefined) return null
	return { r, g, b, a: a ?? 1 }
}

const resolveDotColor = (node: HTMLElement, override: string | undefined): string => {
	const token = getComputedStyle(document.documentElement).getPropertyValue("--color-dot").trim()
	const grayToken = token === "" ? FALLBACK_DOT_COLOR : token
	if (override && override !== "auto") return override
	let current: HTMLElement | null = node.parentElement
	while (current) {
		const rgb = parseRgb(getComputedStyle(current).backgroundColor)
		if (rgb && rgb.a > 0.05) {
			const luminance = (0.2126 * rgb.r + 0.7152 * rgb.g + 0.0722 * rgb.b) / 255
			const max = Math.max(rgb.r, rgb.g, rgb.b)
			const min = Math.min(rgb.r, rgb.g, rgb.b)
			const saturation = max === 0 ? 0 : (max - min) / max
			if (luminance > 0.8 && saturation < 0.12) return grayToken
			return "#ffffff"
		}
		current = current.parentElement
	}
	return grayToken
}

let cleanup: (() => void) | undefined

onMounted(() => {
	const shapeList = props.shapes.slice()
	const container = containerRef.value
	const canvas = canvasRef.value
	if (!container || !canvas) return
	const ctx = canvas.getContext("2d")
	if (!ctx) return

	const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches

	let positionsX: number[] = []
	let positionsY: number[] = []
	let memberCurrent: number[] = []
	let memberPrevious: number[] = []
	let alpha: number[] = []
	let target: number[] = []
	let flipTimer: number[] = []
	let jitter: number[] = []
	let count = 0
	let gridCols = 0
	let gridRows = 0
	let dotColor = resolveDotColor(canvas, props.color)

	let shapeIndex = 0
	let previousShapeIndex = 0
	let morphElapsed = 0
	let morphT = 1

	const pickNextShape = (): number => {
		if (props.morph === "sequence") {
			return (shapeIndex + 1) % shapeList.length
		}
		if (shapeList.length < 2) return shapeIndex
		let next = shapeIndex
		while (next === shapeIndex) {
			next = Math.floor(Math.random() * shapeList.length)
		}
		return next
	}

	const computeMembership = (shape: DotShape): number[] => {
		const width = container.clientWidth || 1
		const height = container.clientHeight || 1
		const result: number[] = new Array<number>(count)
		for (let i = 0; i < count; i++) {
			const px = positionsX[i] ?? 0
			const py = positionsY[i] ?? 0
			result[i] = Math.max(props.floor, shapeMembership(shape, px / width, py / height))
		}
		return result
	}

	const build = (): void => {
		const width = container.clientWidth
		const height = container.clientHeight
		const dpr = window.devicePixelRatio || 1
		const g = props.gap
		canvas.width = Math.max(1, Math.round(width * dpr))
		canvas.height = Math.max(1, Math.round(height * dpr))
		canvas.style.width = `${String(width)}px`
		canvas.style.height = `${String(height)}px`
		ctx.setTransform(dpr, 0, 0, dpr, 0, 0)

		const cols = Math.max(1, Math.floor(width / g))
		const rows = Math.max(1, Math.floor(height / g))
		const offset = g / 2

		const prevAlpha = alpha
		const prevFlip = flipTimer
		const prevJitter = jitter
		const prevCols = gridCols
		const prevRows = gridRows

		const newCount = cols * rows
		positionsX = new Array<number>(newCount)
		positionsY = new Array<number>(newCount)
		alpha = new Array<number>(newCount)
		target = new Array<number>(newCount)
		flipTimer = new Array<number>(newCount)
		jitter = new Array<number>(newCount)

		for (let row = 0; row < rows; row++) {
			for (let col = 0; col < cols; col++) {
				const i = row * cols + col
				positionsX[i] = offset + col * g
				positionsY[i] = offset + row * g
			}
		}

		count = newCount
		gridCols = cols
		gridRows = rows

		memberCurrent = computeMembership(shapeList[shapeIndex] ?? "rect")
		memberPrevious = memberCurrent.slice()
		dotColor = resolveDotColor(canvas, props.color)

		for (let row = 0; row < rows; row++) {
			for (let col = 0; col < cols; col++) {
				const i = row * cols + col
				const carried = row < prevRows && col < prevCols
				const oi = row * prevCols + col
				jitter[i] = carried ? (prevJitter[oi] ?? Math.random()) : Math.random()
				flipTimer[i] = carried
					? (prevFlip[oi] ?? MIN_FLIP_S + Math.random() * (MAX_FLIP_S - MIN_FLIP_S))
					: MIN_FLIP_S + Math.random() * (MAX_FLIP_S - MIN_FLIP_S)
				const lit = (memberCurrent[i] ?? 0) * (0.8 + 0.2 * (jitter[i] ?? 0))
				alpha[i] = carried ? (prevAlpha[oi] ?? lit) : lit
				target[i] = lit
			}
		}
	}

	const mouse = { x: 0, y: 0, active: false }

	const drawStatic = (): void => {
		const width = container.clientWidth
		const height = container.clientHeight
		ctx.clearRect(0, 0, width, height)
		ctx.fillStyle = dotColor
		for (let i = 0; i < count; i++) {
			const m = memberCurrent[i] ?? 0
			if (m < 0.04) continue
			ctx.globalAlpha = m * props.opacity
			ctx.beginPath()
			ctx.arc(positionsX[i] ?? 0, positionsY[i] ?? 0, props.dotRadius, 0, Math.PI * 2)
			ctx.fill()
		}
		ctx.globalAlpha = 1
	}

	let raf = 0
	let lastTime = performance.now()

	const frame = (now: number): void => {
		const dt = Math.min(0.05, (now - lastTime) / 1000)
		lastTime = now

		if (props.morph !== "none" && shapeList.length > 1) {
			if (morphT < 1) {
				morphT = Math.min(1, morphT + (dt * 1000) / TRANSITION_MS)
			}
			morphElapsed += dt * 1000
			if (morphElapsed >= props.morphIntervalMs && morphT >= 1) {
				morphElapsed = 0
				previousShapeIndex = shapeIndex
				shapeIndex = pickNextShape()
				memberPrevious = memberCurrent
				memberCurrent = computeMembership(shapeList[shapeIndex] ?? "rect")
				morphT = previousShapeIndex === shapeIndex ? 1 : 0
			}
		}

		const blend = easeInOut(morphT)
		const width = container.clientWidth
		const height = container.clientHeight

		ctx.clearRect(0, 0, width, height)
		ctx.fillStyle = dotColor

		for (let i = 0; i < count; i++) {
			const px = positionsX[i] ?? 0
			const py = positionsY[i] ?? 0
			const membership =
				blend >= 1
					? (memberCurrent[i] ?? 0)
					: lerp(memberPrevious[i] ?? 0, memberCurrent[i] ?? 0, blend)

			let excite = 0
			if (mouse.active) {
				const dist = Math.hypot(px - mouse.x, py - mouse.y)
				excite = 1 - smoothstep(0, props.influenceRadius, dist)
			}

			flipTimer[i] = (flipTimer[i] ?? 0) - dt * props.intensity * (1 + excite * EXCITE_TIME_GAIN)
			if ((flipTimer[i] ?? 0) <= 0) {
				const onProbability = membership * lerp(props.fill, EXCITE_FILL, excite)
				const on = Math.random() < onProbability
				target[i] = on ? membership * (0.8 + 0.2 * (jitter[i] ?? 0)) : 0
				flipTimer[i] = (MIN_FLIP_S + Math.random() * (MAX_FLIP_S - MIN_FLIP_S)) * (1 - 0.6 * excite)
			}
			const easeRate = lerp(EASE_BASE, EASE_FAST, excite)

			const a = alpha[i] ?? 0
			alpha[i] = a + ((target[i] ?? 0) - a) * Math.min(1, dt * easeRate)

			const drawn = (alpha[i] ?? 0) * props.opacity
			if (drawn < 0.01) continue
			ctx.globalAlpha = drawn
			ctx.beginPath()
			ctx.arc(px, py, props.dotRadius, 0, Math.PI * 2)
			ctx.fill()
		}
		ctx.globalAlpha = 1
		raf = window.requestAnimationFrame(frame)
	}

	const onPointerMove = (event: PointerEvent): void => {
		const rect = canvas.getBoundingClientRect()
		mouse.x = event.clientX - rect.left
		mouse.y = event.clientY - rect.top
		mouse.active = true
	}
	const onPointerLeave = (): void => {
		mouse.active = false
	}

	build()

	const observer = new ResizeObserver(() => {
		build()
		if (reduceMotion) drawStatic()
	})
	observer.observe(container)

	const themeObserver = new MutationObserver(() => {
		dotColor = resolveDotColor(canvas, props.color)
		if (reduceMotion) drawStatic()
	})
	themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] })

	if (reduceMotion) {
		drawStatic()
	} else {
		window.addEventListener("pointermove", onPointerMove, { passive: true })
		document.addEventListener("mouseleave", onPointerLeave)
		window.addEventListener("blur", onPointerLeave)
		raf = window.requestAnimationFrame(frame)
	}

	cleanup = () => {
		observer.disconnect()
		themeObserver.disconnect()
		if (raf) window.cancelAnimationFrame(raf)
		window.removeEventListener("pointermove", onPointerMove)
		document.removeEventListener("mouseleave", onPointerLeave)
		window.removeEventListener("blur", onPointerLeave)
	}
})

onBeforeUnmount(() => {
	cleanup?.()
})
</script>

<template>
	<div ref="containerRef" class="pointer-events-none" aria-hidden="true">
		<canvas ref="canvasRef" class="block h-full w-full" />
	</div>
</template>
