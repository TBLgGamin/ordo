import { existsSync, rmSync } from "node:fs"
import type { Socket, Subprocess } from "bun"
import { agentShell, RESTORE_PROGRAMS, SCROLLBACK_LINES, SEED_TIMEOUT_MS } from "../core/config"
import type {
	AttachClientMsg,
	ControlEvent,
	ControlRequest,
	Hello,
	PaneState,
} from "../core/daemonProtocol"
import { encode, type LineDecoder } from "../core/protocol"
import { scrollbackPath } from "../core/session"
import { createPaneJob, type PaneJob } from "../platform/job"
import { CaptureWriter } from "./capture"
import { reconstructScreen } from "./replay"
import type { SocketWriter } from "./socketWriter"
import { CommandLineTracker, TitleStripper } from "./vt"

const seedEncoder = new TextEncoder()

export const isPwsh = (shell: string) => /pwsh|powershell/i.test(shell)

/** pwsh prompt wrapper that reports the current location via OSC 9;9 each prompt. */
export const PROMPT_CWD_REPORT =
	"$o=$function:prompt; function global:prompt { try { [Console]::Write([char]27+']9;9;'+$PWD.ProviderPath+[char]7) } catch {}; & $o }"

export interface SockState {
	decoder: LineDecoder<Hello | ControlRequest | AttachClientMsg>
	writer?: SocketWriter
	kind?: "control" | "attach"
	paneKey?: string
	/** For a control connection: the session its orchestrator owns. */
	ownedSession?: string
}

export interface PaneOpts {
	cwd?: string
	/** Cold restore: reconstruct the saved capture into the buffer before the shell. */
	replay?: boolean
	/** Cold restore: re-launch this whitelisted foreground program once up. */
	relaunch?: string
}

/** One live pane: a shell in a ConPTY, its output ring buffer, and attached clients. */
export class Pane {
	readonly term: Bun.Terminal
	private readonly child: Subprocess
	private job: PaneJob | null
	private readonly stripper: TitleStripper
	private readonly commands = new CommandLineTracker()
	private readonly writer: CaptureWriter | null
	private readonly clients = new Set<Socket<SockState>>()
	private readonly ring: Uint8Array[] = []
	private ringBytes = 0
	private static readonly RING_MAX = 1024 * 1024
	private static readonly HELD_MAX = 1024 * 1024
	private static readonly ATTACH_ACK = encode({ ok: true })
	private lastFg: string | null | undefined
	/** True while detachAll() is closing windows on purpose (don't treat as a user close). */
	private detaching = false
	/** Set when the user closed this pane's window → kill + delete its scrollback. */
	private purged = false
	/** While a cold-restore seed is still being reconstructed, live output is held. */
	private pendingSeed = false
	private seedDone = false
	private readonly heldOutput: Uint8Array[] = []
	private heldBytes = 0
	readonly state: PaneState

	/** A pane is alive only while its shell process is actually running. */
	get alive(): boolean {
		return this.state.live && this.child.exitCode === null && !this.child.killed
	}

	constructor(
		readonly session: string,
		readonly pane: string,
		opts: PaneOpts,
		private readonly onEvent: (e: ControlEvent) => void,
		private readonly onExit: (purged: boolean) => void,
	) {
		const shell = agentShell()
		const cwd = opts.cwd
		const capture = scrollbackPath(session, pane)
		this.state = { pane, cwd, live: true }

		// Cold restore: seed the ring with the reconstructed screen so attaching
		// clients see prior output, and suppress the new shell's startup clear so it
		// doesn't wipe that seed.
		const cols = 80
		const rows = 24
		if (opts.replay && existsSync(capture)) {
			this.pendingSeed = true
			const finishSeed = (screen: string | null) => {
				if (this.seedDone) return
				this.seedDone = true
				if (screen) {
					const seed = seedEncoder.encode(
						`${screen}\r\n\x1b[2m──────── restored ────────\x1b[0m\r\n`,
					)
					this.ring.unshift(seed)
					this.ringBytes += seed.byteLength
					for (const c of this.clients) c.data.writer?.write(seed)
				}
				this.flushHeld()
			}
			reconstructScreen(capture, cols, rows, SCROLLBACK_LINES)
				.then(finishSeed)
				.catch(() => finishSeed(null))
			setTimeout(() => finishSeed(null), SEED_TIMEOUT_MS)
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
				if (clean.byteLength === 0) return
				if (this.pendingSeed) {
					this.pushHeld(clean)
					return
				}
				this.handleOutput(clean)
			},
		})

		const args = isPwsh(shell) ? ["-NoLogo", "-NoExit", "-Command", PROMPT_CWD_REPORT] : []
		this.child = Bun.spawn([shell, ...args], {
			terminal: this.term,
			cwd: cwd && existsSync(cwd) ? cwd : undefined,
			onExit: () => this.dispose(),
		})
		this.state.pid = this.child.pid
		this.job = createPaneJob()
		if (this.job && this.child.pid !== undefined && !this.job.assign(this.child.pid)) {
			this.job.terminate()
			this.job = null
		}

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
	}

	/** Called by the daemon's shared foreground scan with this pane's resolved program. */
	updateForeground(name: string | null): void {
		if (!this.alive || name === this.lastFg) return
		this.lastFg = name
		this.state.foreground = name ?? undefined
		this.emitState()
	}

	private handleOutput(clean: Uint8Array): void {
		this.pushRing(clean)
		this.writer?.write(clean)
		for (const c of this.clients) c.data.writer?.write(clean)
	}

	private pushHeld(chunk: Uint8Array): void {
		this.heldOutput.push(chunk)
		this.heldBytes += chunk.byteLength
		while (this.heldBytes > Pane.HELD_MAX && this.heldOutput.length > 1) {
			const dropped = this.heldOutput.shift()
			if (dropped) this.heldBytes -= dropped.byteLength
		}
	}

	private flushHeld(): void {
		this.pendingSeed = false
		this.heldBytes = 0
		const held = this.heldOutput.splice(0)
		for (const chunk of held) this.handleOutput(chunk)
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
		sock.data.writer?.write(Pane.ATTACH_ACK)
		for (const chunk of this.ring) sock.data.writer?.write(chunk)
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
		if (this.job) {
			this.job.terminate()
			this.job = null
		} else {
			try {
				this.child.kill()
			} catch {}
		}
		this.dispose()
	}

	private disposed = false
	flushed: Promise<void> = Promise.resolve()
	private dispose(): void {
		if (this.disposed) return
		this.disposed = true
		this.state.live = false
		if (this.job) {
			this.job.terminate()
			this.job = null
		}
		const closed = this.writer ? this.writer.close() : Promise.resolve()
		this.flushed = closed
		if (this.purged) {
			void closed.then(() => {
				try {
					rmSync(scrollbackPath(this.session, this.pane), { force: true })
				} catch {}
			})
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
