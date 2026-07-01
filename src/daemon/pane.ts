import { existsSync, rmSync } from "node:fs"
import type { Socket, Subprocess } from "bun"
import { AGENT_SHELL, RESTORE_PROGRAMS, SCROLLBACK_LINES } from "../core/config"
import type {
	AttachClientMsg,
	ControlEvent,
	ControlRequest,
	Hello,
	PaneState,
} from "../core/daemonProtocol"
import type { LineDecoder } from "../core/protocol"
import { scrollbackPath } from "../core/session"
import { foregroundProgram } from "../platform/proctree"
import { CaptureWriter } from "./capture"
import { reconstructScreen } from "./replay"
import { CommandLineTracker, TitleStripper } from "./vt"

export const isPwsh = (shell: string) => /pwsh|powershell/i.test(shell)

/** pwsh prompt wrapper that reports the current location via OSC 9;9 each prompt. */
export const PROMPT_CWD_REPORT =
	"$o=$function:prompt; function global:prompt { try { [Console]::Write([char]27+']9;9;'+$PWD.ProviderPath+[char]7) } catch {}; & $o }"

export interface SockState {
	decoder: LineDecoder<Hello | ControlRequest | AttachClientMsg>
	kind?: "control" | "attach"
	paneKey?: string
	/** For a control connection: the session its orchestrator owns. */
	ownedSession?: string
}

export interface PaneOpts {
	cwd?: string
	shell?: string
	/** Cold restore: reconstruct the saved capture into the buffer before the shell. */
	replay?: boolean
	/** Cold restore: re-launch this whitelisted foreground program once up. */
	relaunch?: string
}

/** One live pane: a shell in a ConPTY, its output ring buffer, and attached clients. */
export class Pane {
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
