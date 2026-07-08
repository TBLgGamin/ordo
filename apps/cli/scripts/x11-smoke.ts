import { createX11WindowManager } from "../src/platform/linux/x11"

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function main() {
	const wm = createX11WindowManager()
	if (!wm) {
		console.error("x11-smoke: no X11 display / libX11 — cannot run")
		process.exit(1)
	}

	const title = `ordo-smoke-${process.pid}`
	const child = Bun.spawn(["xterm", "-T", title, "-e", "sleep", "60"], {
		stdin: "ignore",
		stdout: "ignore",
		stderr: "ignore",
	})

	let handle: number | string | null = null
	for (let i = 0; i < 50 && handle === null; i++) {
		await sleep(200)
		handle = wm.listTerminalWindows().find((w) => w.title === title)?.handle ?? null
	}
	if (handle === null) {
		child.kill()
		console.error("x11-smoke: spawned xterm not found in _NET_CLIENT_LIST (is a WM running?)")
		process.exit(1)
	}

	const target = { x: 120, y: 140, w: 420, h: 320 }
	wm.setWindowRect(handle, target)
	await sleep(400)
	const rect = wm.getWindowRect(handle)
	child.kill()

	console.log(`x11-smoke: target=${JSON.stringify(target)} readback=${JSON.stringify(rect)}`)
	if (!rect || rect.w < 200 || rect.h < 150) {
		console.error("x11-smoke: geometry readback looks wrong")
		process.exit(1)
	}
	console.log("x11-smoke: OK")
}

main()
