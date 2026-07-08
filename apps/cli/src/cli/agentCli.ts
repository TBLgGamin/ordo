import { AGENT_PROGRAMS, parseArgValue } from "../core/config"
import type { PaneState, StatusEntry } from "../core/daemonProtocol"
import { OrdoError, reportError } from "../core/errors"
import { listSessionNames, sessionExists } from "../core/session"
import { DaemonClient, SPAWN_CLIENT_TIMEOUT_MS } from "../daemon/daemonClient"
import { openCommandCenter } from "./launch"
import { resolvePane } from "./resolve"

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

export type AgentCliCmd =
	| "send"
	| "agents"
	| "read"
	| "broadcast"
	| "status"
	| "interrupt"
	| "spawn"

function stripFlag(args: string[], flag: string): string[] {
	const out: string[] = []
	for (let i = 0; i < args.length; i++) {
		if (args[i] === flag) {
			i++
			continue
		}
		const value = args[i]
		if (value !== undefined) out.push(value)
	}
	return out
}

function stripFlags(args: string[], flags: string[]): string[] {
	let out = args
	for (const f of flags) out = stripFlag(out, f)
	return out
}

export async function resolveSession(
	args: string[],
	liveSessions: () => Promise<string[]>,
): Promise<string | null> {
	const fromEnv = process.env.ORDO_SESSION
	if (fromEnv) return fromEnv
	const fromFlag = parseArgValue(args, "--session")
	if (fromFlag) return fromFlag
	const live = await liveSessions()
	return live.length === 1 ? (live[0] ?? null) : null
}

function printAgents(you: string | undefined, panes: PaneState[]): void {
	if (panes.length === 0) {
		console.log("(no panes in this session)")
		return
	}
	const rows = panes.map((p) => ({
		pane: p.pane + (p.pane === you ? " (you)" : ""),
		status: p.live ? "live" : "dead",
		foreground: p.foreground ?? "shell",
		cwd: p.cwd ?? "",
	}))
	const width = (key: keyof (typeof rows)[number]) =>
		Math.max(key.length, ...rows.map((r) => r[key].length))
	const wPane = width("pane")
	const wStatus = width("status")
	const wFg = width("foreground")
	console.log(
		`${"pane".padEnd(wPane)}  ${"status".padEnd(wStatus)}  ${"foreground".padEnd(wFg)}  cwd`,
	)
	for (const r of rows) {
		console.log(
			`${r.pane.padEnd(wPane)}  ${r.status.padEnd(wStatus)}  ${r.foreground.padEnd(wFg)}  ${r.cwd}`,
		)
	}
}

function printStatus(you: string | undefined, panes: PaneState[], entries: StatusEntry[]): void {
	const byPane = new Map(entries.map((e) => [e.pane, e]))
	const live = panes.filter((p) => p.live)
	if (live.length === 0) {
		console.log("(no live panes in this session)")
		return
	}
	const rows = live.map((p) => {
		const e = byPane.get(p.pane)
		return {
			pane: p.pane + (p.pane === you ? " (you)" : ""),
			status: e?.status ?? "-",
			task: e?.task ?? "",
		}
	})
	const width = (key: keyof (typeof rows)[number]) =>
		Math.max(key.length, ...rows.map((r) => r[key].length))
	const wPane = width("pane")
	const wStatus = width("status")
	console.log(`${"pane".padEnd(wPane)}  ${"status".padEnd(wStatus)}  task`)
	for (const r of rows) {
		console.log(`${r.pane.padEnd(wPane)}  ${r.status.padEnd(wStatus)}  ${r.task}`)
	}
}

async function livePaneNames(dc: DaemonClient, session: string): Promise<string[]> {
	const { panes } = await dc.getState(session)
	return panes.filter((p) => p.live).map((p) => p.pane)
}

async function resolveTarget(dc: DaemonClient, session: string, input: string): Promise<string> {
	const names = await livePaneNames(dc, session)
	const r = resolvePane(input, names)
	if (r.ok) return r.pane
	if (r.candidates.length > 0) {
		throw new OrdoError(
			`"${input}" is ambiguous or unknown — candidates: ${r.candidates.join(", ")}`,
			{ exitCode: 2 },
		)
	}
	throw new OrdoError(`no pane matching "${input}"`, { exitCode: 2 })
}

async function livePanes(dc: DaemonClient, session: string): Promise<PaneState[]> {
	try {
		const { panes } = await dc.getState(session)
		return panes.filter((p) => p.live)
	} catch {
		return []
	}
}

async function ensureAttached(dc: DaemonClient): Promise<void> {
	if (!dc.isConnected) await dc.tryAttach().catch(() => {})
}

async function waitUntil<T>(
	fn: () => Promise<T | null | undefined>,
	opts: { timeoutMs: number; intervalMs: number },
): Promise<T | null> {
	const deadline = Date.now() + opts.timeoutMs
	for (;;) {
		const r = await fn()
		if (r) return r
		if (Date.now() >= deadline) return null
		await sleep(opts.intervalMs)
	}
}

async function reachableSessions(dc: DaemonClient): Promise<Set<string>> {
	const out = new Set<string>()
	for (const name of listSessionNames()) {
		if ((await livePanes(dc, name)).length > 0) out.add(name)
	}
	return out
}

async function ensureReachable(dc: DaemonClient, session: string): Promise<void> {
	if ((await livePanes(dc, session)).length > 0) return
	if (!sessionExists(session)) {
		throw new OrdoError(`no saved session "${session}"`, { exitCode: 2 })
	}
	await openCommandCenter({ kind: "restore", name: session })
	const ok = await waitUntil(
		async () => {
			await ensureAttached(dc)
			return (await livePanes(dc, session)).length > 0 ? true : null
		},
		{ timeoutMs: SPAWN_CLIENT_TIMEOUT_MS, intervalMs: 300 },
	)
	if (!ok) throw new OrdoError(`session "${session}" did not come up`)
}

function printSpawned(pane: string, agent: string | undefined): void {
	console.log(agent ? `opened "${pane}" running ${agent}` : `opened "${pane}"`)
}

function isNoOwner(e: unknown): boolean {
	return (
		e instanceof OrdoError &&
		(e.code === "no-owner" || e.message.includes("command center for this session is not open"))
	)
}

async function runSpawn(dc: DaemonClient, args: string[]): Promise<void> {
	const cwd = parseArgValue(args, "--cwd")
	const agent = parseArgValue(args, "--agent")
	const name = parseArgValue(args, "--name")
	if (agent && !AGENT_PROGRAMS.has(agent.toLowerCase())) {
		throw new OrdoError(
			`"${agent}" is not a launchable agent (${[...AGENT_PROGRAMS].join(", ")})`,
			{ exitCode: 2 },
		)
	}
	const from = process.env.ORDO_PANE ?? "cli"
	const session = await resolveSession(args, async () => [...(await reachableSessions(dc))])
	const paneOpts = { requestedBy: from, name, cwd, agent }

	if (session) {
		try {
			const res = await dc.requestPane(session, paneOpts)
			printSpawned(res.pane, agent)
			return
		} catch (e) {
			if (!isNoOwner(e)) throw e
		}
		if (!sessionExists(session))
			throw new OrdoError(`no saved session "${session}"`, { exitCode: 2 })
		await openCommandCenter({ kind: "restore", name: session })
		const res = await waitUntil(
			async () => {
				await ensureAttached(dc)
				try {
					return await dc.requestPane(session, paneOpts)
				} catch (e) {
					if (isNoOwner(e)) return null
					throw e
				}
			},
			{ timeoutMs: SPAWN_CLIENT_TIMEOUT_MS, intervalMs: 300 },
		)
		if (!res) throw new OrdoError(`session "${session}" did not come up`)
		printSpawned(res.pane, agent)
		return
	}

	const before = await reachableSessions(dc)
	await openCommandCenter({ kind: "new", seed: { agent, name, cwd } })
	const pane = await waitUntil(
		async () => {
			await ensureAttached(dc)
			for (const s of listSessionNames()) {
				if (before.has(s)) continue
				const live = await livePanes(dc, s)
				if (live.length === 0) continue
				const match = name ? live.find((p) => p.pane === name) : live[0]
				if (match) return match.pane
			}
			return null
		},
		{ timeoutMs: SPAWN_CLIENT_TIMEOUT_MS, intervalMs: 300 },
	)
	if (!pane) throw new OrdoError("the new ordo session did not come up")
	printSpawned(pane, agent)
}

export async function runAgentCli(cmd: AgentCliCmd, args: string[]): Promise<void> {
	try {
		await runAgentCliCore(cmd, args)
	} catch (e) {
		reportError(e)
	}
}

async function runAgentCliCore(cmd: AgentCliCmd, args: string[]): Promise<void> {
	const dc = new DaemonClient()
	try {
		await dc.tryAttach()

		if (cmd === "spawn") {
			await runSpawn(dc, args)
			return
		}

		const session = await resolveSession(args, async () => [...(await reachableSessions(dc))])
		if (!session) {
			throw new OrdoError("could not determine session (set ORDO_SESSION or pass --session <id>)", {
				exitCode: 2,
			})
		}
		await ensureReachable(dc, session)

		if (cmd === "agents") {
			const { panes } = await dc.getState(session)
			printAgents(process.env.ORDO_PANE, panes)
			return
		}

		if (cmd === "status") {
			const positional = stripFlag(args, "--session")
			const text = positional.join(" ").trim()
			if (text === "") {
				const [{ panes }, { entries }] = await Promise.all([
					dc.getState(session),
					dc.getStatus(session),
				])
				printStatus(process.env.ORDO_PANE, panes, entries)
				return
			}
			const me = process.env.ORDO_PANE
			if (!me) {
				throw new OrdoError("setting a status requires running inside a pane (ORDO_PANE)", {
					exitCode: 2,
				})
			}
			await dc.setStatus(session, me, text)
			console.log(`status set: ${text}`)
			return
		}

		if (cmd === "broadcast") {
			const positional = stripFlag(args, "--session")
			const text = positional.join(" ")
			if (text.trim() === "") {
				throw new OrdoError("usage: ordo broadcast <text...>", { exitCode: 2 })
			}
			const from = process.env.ORDO_PANE ?? "cli"
			const { results } = await dc.broadcast(session, { from, text })
			if (results.length === 0) {
				console.log("(no other panes to broadcast to)")
				return
			}
			for (const r of results) {
				console.log(r.error ? `${r.pane}: failed (${r.error})` : `${r.pane}: ${r.delivered}`)
			}
			return
		}

		const positional = stripFlags(args, ["--session", "--lines"])
		const target = positional[0]

		if (cmd === "read") {
			if (!target) throw new OrdoError("usage: ordo read <pane> [--lines N]", { exitCode: 2 })
			const resolved = await resolveTarget(dc, session, target)
			const lines = Number(parseArgValue(args, "--lines")) || undefined
			const { text } = await dc.readPane(session, resolved, lines)
			console.log(text.trim() === "" ? "(no recent output)" : text)
			return
		}

		if (cmd === "interrupt") {
			if (!target) throw new OrdoError("usage: ordo interrupt <pane>", { exitCode: 2 })
			const resolved = await resolveTarget(dc, session, target)
			await dc.interrupt(session, resolved)
			console.log(`sent Ctrl-C to ${resolved}`)
			return
		}

		const message = positional.slice(1).join(" ")
		if (!target || message === "") {
			throw new OrdoError("usage: ordo send <pane> <text...>", { exitCode: 2 })
		}
		const resolved = await resolveTarget(dc, session, target)
		const from = process.env.ORDO_PANE ?? "cli"
		const res = await dc.sendMessage(session, resolved, { from, text: message })
		console.log(
			res.delivered === "waiter"
				? `delivered to ${resolved} (it was waiting)`
				: `delivered — typed into ${resolved}`,
		)
	} finally {
		dc.stop()
	}
}
