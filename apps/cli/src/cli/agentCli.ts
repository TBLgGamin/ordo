import { AGENT_PROGRAMS, parseArgValue } from "../core/config"
import type { PaneState, StatusEntry } from "../core/daemonProtocol"
import { listSessionNames } from "../core/session"
import { DaemonClient } from "../daemon/daemonClient"
import { resolvePane } from "./resolve"

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
		console.error(
			`ordo: "${input}" is ambiguous or unknown — candidates: ${r.candidates.join(", ")}`,
		)
	} else {
		console.error(`ordo: no pane matching "${input}"`)
	}
	process.exit(2)
}

export async function runAgentCli(cmd: AgentCliCmd, args: string[]): Promise<void> {
	const dc = new DaemonClient()
	try {
		if (!(await dc.tryAttach())) {
			console.error("ordo: daemon not running")
			process.exit(1)
		}
		const session = await resolveSession(args, async () => {
			const live: string[] = []
			for (const name of listSessionNames()) {
				try {
					const { panes } = await dc.getState(name)
					if (panes.some((p) => p.live)) live.push(name)
				} catch {}
			}
			return live
		})
		if (!session) {
			console.error("ordo: could not determine session (set ORDO_SESSION or pass --session <id>)")
			process.exit(2)
		}

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
				console.error("ordo: setting a status requires running inside a pane (ORDO_PANE)")
				process.exit(2)
			}
			await dc.setStatus(session, me, text)
			console.log(`status set: ${text}`)
			return
		}

		if (cmd === "broadcast") {
			const positional = stripFlag(args, "--session")
			const text = positional.join(" ")
			if (text.trim() === "") {
				console.error("ordo: usage: ordo broadcast <text...>")
				process.exit(2)
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

		if (cmd === "spawn") {
			const cwd = parseArgValue(args, "--cwd")
			const agent = parseArgValue(args, "--agent")
			const name = parseArgValue(args, "--name")
			if (agent && !AGENT_PROGRAMS.has(agent.toLowerCase())) {
				console.error(
					`ordo: "${agent}" is not a launchable agent (${[...AGENT_PROGRAMS].join(", ")})`,
				)
				process.exit(2)
			}
			const from = process.env.ORDO_PANE ?? "cli"
			const res = await dc.requestPane(session, { requestedBy: from, name, cwd, agent })
			console.log(agent ? `opened "${res.pane}" running ${agent}` : `opened "${res.pane}"`)
			return
		}

		const positional = stripFlags(args, ["--session", "--lines"])
		const target = positional[0]

		if (cmd === "read") {
			if (!target) {
				console.error("ordo: usage: ordo read <pane> [--lines N]")
				process.exit(2)
			}
			const resolved = await resolveTarget(dc, session, target)
			const lines = Number(parseArgValue(args, "--lines")) || undefined
			const { text } = await dc.readPane(session, resolved, lines)
			console.log(text.trim() === "" ? "(no recent output)" : text)
			return
		}

		if (cmd === "interrupt") {
			if (!target) {
				console.error("ordo: usage: ordo interrupt <pane>")
				process.exit(2)
			}
			const resolved = await resolveTarget(dc, session, target)
			await dc.interrupt(session, resolved)
			console.log(`sent Ctrl-C to ${resolved}`)
			return
		}

		const message = positional.slice(1).join(" ")
		if (!target || message === "") {
			console.error("ordo: usage: ordo send <pane> <text...>")
			process.exit(2)
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
