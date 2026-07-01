/**
 * The persistent session daemon.
 *
 * It owns every pane's shell + ConPTY and stays alive after the app and its
 * windows close (launched windowless via `Start-Process -WindowStyle Hidden`).
 * Pane clients (one per Windows Terminal pane) attach over loopback TCP to pipe
 * I/O; closing a window just detaches — the shell keeps running. Reopening the
 * session re-attaches to the *same live shell* (warm restore, no reconstruction).
 *
 * Across a reboot (when the daemon is gone) it cold-restores from the per-pane
 * capture file + saved cwd (best-effort, the only option once the process died).
 *
 * Discovery: writes %APPDATA%\ordo\daemon.json = { port, token, pid }.
 *
 * Invoked as: bun daemon.ts   (no args; reads/writes daemon.json)
 */

import {
	closeSync,
	existsSync,
	fstatSync,
	mkdirSync,
	openSync,
	readFileSync,
	rmSync,
	writeFileSync,
	writeSync,
} from "node:fs"
import { dirname, join } from "node:path"
import type { Socket, Subprocess, TCPSocketListener } from "bun"
import { AGENT_SHELL, RESTORE_PROGRAMS, SCROLLBACK_LINES } from "./config"
import type {
	AttachClientMsg,
	ControlEvent,
	ControlRequest,
	ControlResponse,
	Hello,
	PaneState,
} from "./daemonProtocol"
import { foregroundProgram } from "./proctree"
import { encode, LineDecoder } from "./protocol"
import { reconstructScreen } from "./replay"
import { ordoDir, scrollbackPath } from "./session"
import { CommandLineTracker, TitleStripper } from "./vt"

const isPwsh = (shell: string) => /pwsh|powershell/i.test(shell)

/** pwsh prompt wrapper that reports the current location via OSC 9;9 each prompt. */
const PROMPT_CWD_REPORT =
	"$o=$function:prompt; function global:prompt { try { [Console]::Write([char]27+']9;9;'+$PWD.ProviderPath+[char]7) } catch {}; & $o }"

function daemonInfoPath(): string {
	return join(ordoDir(), "daemon.json")
}

/** Append-only raw-VT capture with tail compaction (so a pane can't fill the disk). */
class CaptureWriter {
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

interface PaneOpts {
	cwd?: string
	shell?: string
	/** Cold restore: reconstruct the saved capture into the buffer before the shell. */
	replay?: boolean
	/** Cold restore: re-launch this whitelisted foreground program once up. */
	relaunch?: string
}

/** One live pane: a shell in a ConPTY, its output ring buffer, and attached clients. */
class Pane {
	readonly term: Bun.Terminal
	private readonly child: Subprocess
	private readonly stripper: TitleStripper
	private readonly commands = new CommandLineTracker()
	private readonly writer: CaptureWriter | null
	private readonly clients = new Set<Socket<SockState>>()
	private readonly ring: Uint8Array[] = []
	private ringBytes = 0
	private static readonly RING_MAX = 1024 * 1024
	private fgTimer?: ReturnType<typeof setInterval>
	private lastFg: string | null | undefined
	/** True while detachAll() is closing windows on purpose (don't treat as a user close). */
	private detaching = false
	/** Set when the user closed this pane's window → kill + delete its scrollback. */
	private purged = false
	readonly state: PaneState

	constructor(
		readonly session: string,
		readonly pane: string,
		opts: PaneOpts,
		private readonly onEvent: (e: ControlEvent) => void,
		private readonly onExit: (purged: boolean) => void,
	) {
		const shell = opts.shell ?? AGENT_SHELL
		const cwd = opts.cwd
		const capture = scrollbackPath(session, pane)
		this.state = { pane, cwd, live: true }

		// Cold restore: seed the ring with the reconstructed screen so attaching
		// clients see prior output, and suppress the new shell's startup clear so it
		// doesn't wipe that seed.
		const cols = 80
		const rows = 24
		if (opts.replay && existsSync(capture)) {
			// reconstructScreen is async; seed synchronously-ish via a fire-and-forget.
			reconstructScreen(capture, cols, rows, SCROLLBACK_LINES)
				.then((screen) => {
					if (!screen) return
					const seed = new TextEncoder().encode(
						`${screen}\r\n\x1b[2m──────── restored ────────\x1b[0m\r\n`,
					)
					// Prepend to the ring and push to any already-attached clients.
					this.ring.unshift(seed)
					this.ringBytes += seed.byteLength
					for (const c of this.clients) c.write(seed)
				})
				.catch(() => {})
		}

		this.stripper = new TitleStripper({
			suppressStartupClears: Boolean(opts.replay),
			onCwd: (path) => {
				if (path !== this.state.cwd) {
					this.state.cwd = path
					this.emitState()
				}
			},
		})

		this.writer = new CaptureWriter(capture)

		this.term = new Bun.Terminal({
			cols,
			rows,
			name: "xterm-256color",
			data: (_t, chunk) => {
				const clean = this.stripper.push(chunk)
				this.pushRing(clean)
				this.writer?.write(clean)
				for (const c of this.clients) c.write(clean)
			},
		})

		const args = isPwsh(shell) ? ["-NoLogo", "-NoExit", "-Command", PROMPT_CWD_REPORT] : []
		this.child = Bun.spawn([shell, ...args], {
			terminal: this.term,
			cwd: cwd && existsSync(cwd) ? cwd : undefined,
			onExit: () => this.dispose(),
		})
		this.state.pid = this.child.pid

		if (
			opts.relaunch &&
			/^[a-zA-Z0-9._-]+$/.test(opts.relaunch) &&
			RESTORE_PROGRAMS.has(opts.relaunch.toLowerCase())
		) {
			const prog = opts.relaunch
			setTimeout(() => {
				if (this.state.live) this.term.write(`${prog}\r`)
			}, 800)
		}

		this.fgTimer = setInterval(() => {
			if (!this.state.live) return
			const name = foregroundProgram(this.child.pid, RESTORE_PROGRAMS)
			if (name !== this.lastFg) {
				this.lastFg = name
				this.state.foreground = name ?? undefined
				this.emitState()
			}
		}, 2000)
	}

	private pushRing(chunk: Uint8Array): void {
		if (chunk.byteLength === 0) return
		this.ring.push(chunk)
		this.ringBytes += chunk.byteLength
		while (this.ringBytes > Pane.RING_MAX && this.ring.length > 1) {
			const dropped = this.ring.shift()
			if (dropped) this.ringBytes -= dropped.byteLength
		}
	}

	private emitState(): void {
		this.onEvent({ event: "pane", session: this.session, state: { ...this.state } })
	}

	/** Attach a client: replay the ring buffer, then stream live output. */
	attach(sock: Socket<SockState>, cols: number, rows: number): void {
		// A fresh attach (e.g. a restore) clears any prior "detaching" intent so a
		// later genuine window-close is recognized as a user close.
		this.detaching = false
		for (const chunk of this.ring) sock.write(chunk)
		this.clients.add(sock)
		this.resize(cols, rows)
	}

	detach(sock: Socket<SockState>): void {
		this.clients.delete(sock)
		// The user closed this pane's window (its last client dropped, and we weren't
		// asked to detach the whole session) → permanently remove the pane: kill the
		// shell and delete its scrollback (handled in dispose()).
		if (!this.detaching && this.clients.size === 0 && this.state.live) {
			this.purged = true
			this.kill()
		}
	}

	/** Close every attached client (their windows), but keep the shell alive. */
	detachAll(): void {
		this.detaching = true
		for (const c of this.clients) {
			// terminate(), not end(): end() half-closes and the client window lingers
			// until it also closes; terminate() forces it shut immediately.
			try {
				c.terminate()
			} catch {
				try {
					c.end()
				} catch {}
			}
		}
		this.clients.clear()
	}

	input(bytes: Uint8Array): void {
		if (!this.state.live) return
		this.term.write(bytes)
		const cmd = this.commands.feed(bytes)
		if (cmd) {
			this.state.lastCommand = cmd
			this.emitState()
		}
	}

	resize(cols: number, rows: number): void {
		if (!this.state.live) return
		try {
			this.term.resize(Math.max(1, cols), Math.max(1, rows))
		} catch {}
	}

	kill(): void {
		try {
			this.child.kill()
		} catch {}
		this.dispose()
	}

	private disposed = false
	private dispose(): void {
		if (this.disposed) return
		this.disposed = true
		this.state.live = false
		if (this.fgTimer) clearInterval(this.fgTimer)
		this.writer?.close()
		// User-closed pane: drop its scrollback capture now that the writer's handle
		// is released (so the file isn't locked on Windows).
		if (this.purged) {
			try {
				rmSync(scrollbackPath(this.session, this.pane), { force: true })
			} catch {}
		}
		try {
			this.term.close()
		} catch {}
		for (const c of this.clients) {
			// Force the client window shut now that the shell is gone.
			try {
				c.terminate()
			} catch {
				try {
					c.end()
				} catch {}
			}
		}
		this.clients.clear()
		this.onExit(this.purged)
	}
}

interface SockState {
	decoder: LineDecoder<Hello | ControlRequest | AttachClientMsg>
	kind?: "control" | "attach"
	paneKey?: string
	/** For a control connection: the session its orchestrator owns. */
	ownedSession?: string
}

const key = (session: string, pane: string) => `${session} ${pane}`

class Daemon {
	private readonly panes = new Map<string, Pane>()
	private readonly controls = new Set<Socket<SockState>>()
	private server?: TCPSocketListener<SockState>
	private readonly token = crypto.randomUUID()

	start(): void {
		this.server = Bun.listen<SockState>({
			hostname: "127.0.0.1",
			port: 0,
			socket: {
				open: (sock) => {
					sock.data = { decoder: new LineDecoder<Hello | ControlRequest | AttachClientMsg>() }
				},
				data: (sock, chunk) => this.onData(sock, chunk),
				close: (sock) => this.onClose(sock),
				error: (sock) => this.onClose(sock),
			},
		})
		writeFileSync(
			daemonInfoPath(),
			JSON.stringify({ port: this.server.port, token: this.token, pid: process.pid }),
		)
		// Keep the event loop alive.
		setInterval(() => {}, 1 << 30)
	}

	private onData(sock: Socket<SockState>, chunk: Uint8Array): void {
		// An attached client's bytes after its hello are newline-JSON frames too,
		// so everything flows through the line decoder.
		for (const msg of sock.data.decoder.push(chunk)) {
			if (!sock.data.kind) {
				this.onHello(sock, msg as Hello)
			} else if (sock.data.kind === "control") {
				this.onControl(sock, msg as ControlRequest)
			} else {
				this.onAttachMsg(sock, msg as AttachClientMsg)
			}
		}
	}

	private onHello(sock: Socket<SockState>, hello: Hello): void {
		if (!hello || hello.token !== this.token) {
			sock.end()
			return
		}
		if (hello.kind === "control") {
			sock.data.kind = "control"
			sock.data.ownedSession = hello.session
			this.controls.add(sock)
		} else if (hello.kind === "attach") {
			sock.data.kind = "attach"
			const pane = this.panes.get(key(hello.session, hello.pane))
			if (!pane) {
				sock.end() // orchestrator must createPane first
				return
			}
			sock.data.paneKey = key(hello.session, hello.pane)
			pane.attach(sock, hello.cols, hello.rows)
		} else {
			sock.end()
		}
	}

	private onControl(sock: Socket<SockState>, req: ControlRequest): void {
		const reply = (res: ControlResponse) => {
			sock.write(encode(res))
			sock.flush()
		}
		try {
			switch (req.op) {
				case "ping": {
					reply({ id: req.id, ok: true, result: { pid: process.pid } })
					break
				}
				case "createPane": {
					const k = key(req.session, req.pane)
					const existing = this.panes.get(k)
					if (existing?.state.live) {
						reply({ id: req.id, ok: true, result: { warm: true, state: existing.state } })
						break
					}
					const capture = scrollbackPath(req.session, req.pane)
					const cold = existsSync(capture)
					const pane = new Pane(
						req.session,
						req.pane,
						{
							cwd: req.cwd,
							shell: req.shell,
							replay: cold,
							relaunch: cold ? req.relaunch : undefined,
						},
						(e) => this.emit(e),
						(purged) => {
							this.panes.delete(k)
							// A purged pane (user closed its window) reports paneClosed so the
							// orchestrator de-registers it; a plain shell exit reports paneExited.
							this.emit({
								event: purged ? "paneClosed" : "paneExited",
								session: req.session,
								pane: req.pane,
							})
						},
					)
					this.panes.set(k, pane)
					reply({ id: req.id, ok: true, result: { warm: false, cold, state: pane.state } })
					break
				}
				case "hasPane": {
					const pane = this.panes.get(key(req.session, req.pane))
					reply({ id: req.id, ok: true, result: { live: Boolean(pane?.state.live) } })
					break
				}
				case "getState": {
					const states: PaneState[] = []
					for (const [k, pane] of this.panes) {
						if (k.startsWith(`${req.session} `)) states.push({ ...pane.state })
					}
					reply({ id: req.id, ok: true, result: { panes: states } })
					break
				}
				case "killPane": {
					this.panes.get(key(req.session, req.pane))?.kill()
					reply({ id: req.id, ok: true })
					break
				}
				case "detachSession": {
					this.detachSessionClients(req.session)
					reply({ id: req.id, ok: true })
					break
				}
				case "shutdown": {
					reply({ id: req.id, ok: true })
					for (const pane of this.panes.values()) pane.kill()
					this.server?.stop(true)
					process.exit(0)
				}
			}
		} catch (err) {
			reply({ id: req.id, ok: false, error: (err as Error).message })
		}
	}

	private onAttachMsg(sock: Socket<SockState>, msg: AttachClientMsg): void {
		const pane = sock.data.paneKey ? this.panes.get(sock.data.paneKey) : undefined
		if (!pane) return
		if (msg.t === "i") pane.input(Buffer.from(msg.d, "base64"))
		else if (msg.t === "r") pane.resize(msg.c, msg.r)
	}

	private onClose(sock: Socket<SockState>): void {
		if (this.controls.delete(sock) && sock.data?.ownedSession) {
			// The orchestrator (main window) went away — close its panes' client
			// windows but keep the shells alive for a later restore.
			this.detachSessionClients(sock.data.ownedSession)
		}
		if (sock.data?.paneKey) this.panes.get(sock.data.paneKey)?.detach(sock)
	}

	/** Close every client window of a session's panes; the shells stay alive. */
	private detachSessionClients(session: string): void {
		for (const [k, pane] of this.panes) {
			if (k.startsWith(`${session} `)) pane.detachAll()
		}
	}

	private emit(event: ControlEvent): void {
		const bytes = encode(event)
		for (const c of this.controls) {
			try {
				c.write(bytes)
				c.flush()
			} catch {}
		}
	}
}

new Daemon().start()
