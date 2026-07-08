import { AGENT_PROGRAMS } from "../core/config"
import { listSessionNames } from "../core/session"
import { DaemonClient } from "../daemon/daemonClient"
import { resolveSession } from "./agentCli"

export interface CompletionContext {
	subcommands: string[]
	panes: string[]
	sessions: string[]
	agents: string[]
}

const SUBCOMMANDS = [
	"send",
	"agents",
	"read",
	"broadcast",
	"status",
	"interrupt",
	"spawn",
	"completion",
	"new",
	"restore",
	"delete",
	"sessions",
	"help",
]

const SESSION_ARG_SUBS = new Set(["restore", "delete"])

const PANE_TARGET_SUBS = new Set(["send", "read", "interrupt"])

const FLAG_SUBS: Record<string, string[]> = {
	new: ["--agent", "--name", "--cwd"],
	spawn: ["--agent", "--name", "--cwd"],
}

function filt(pool: string[], partial: string): string[] {
	const p = partial.toLowerCase()
	return pool.filter((c) => c.toLowerCase().startsWith(p))
}

export function completionCandidates(words: string[], ctx: CompletionContext): string[] {
	const partial = words[words.length - 1] ?? ""
	const before = words.slice(0, -1)
	const prev = before[before.length - 1]
	if (prev === "--session") return filt(ctx.sessions, partial)
	if (prev === "--agent") return filt(ctx.agents, partial)
	const positionals = before.filter((w) => !w.startsWith("--"))
	if (positionals.length === 0) return filt(ctx.subcommands, partial)
	const sub = positionals[0]
	if (sub && PANE_TARGET_SUBS.has(sub) && positionals.length === 1) {
		return filt(ctx.panes, partial)
	}
	if (sub && SESSION_ARG_SUBS.has(sub) && positionals.length === 1) {
		return filt(ctx.sessions, partial)
	}
	if (sub && FLAG_SUBS[sub] && partial.startsWith("-")) {
		const used = new Set(before.filter((w) => w.startsWith("--")))
		return filt(
			FLAG_SUBS[sub].filter((f) => !used.has(f)),
			partial,
		)
	}
	return []
}

async function livePanesForCompletion(dc: DaemonClient, before: string[]): Promise<string[]> {
	const session = await resolveSession(before, async () => {
		const live: string[] = []
		for (const name of listSessionNames()) {
			try {
				const { panes } = await dc.getState(name)
				if (panes.some((p) => p.live)) live.push(name)
			} catch {}
		}
		return live
	})
	if (!session) return []
	const { panes } = await dc.getState(session)
	return panes.filter((p) => p.live).map((p) => p.pane)
}

export async function runComplete(words: string[]): Promise<void> {
	let sessions: string[] = []
	try {
		sessions = listSessionNames()
	} catch {}

	const before = words.slice(0, -1)
	const positionals = before.filter((w) => !w.startsWith("--"))
	const sub = positionals[0]
	const needPanes = Boolean(sub && PANE_TARGET_SUBS.has(sub) && positionals.length === 1)

	let panes: string[] = []
	if (needPanes) {
		const dc = new DaemonClient()
		try {
			if (await dc.tryAttach({ connectTimeoutMs: 250 })) {
				panes = await livePanesForCompletion(dc, before)
			}
		} catch {
		} finally {
			dc.stop()
		}
	}

	const out = completionCandidates(words, {
		subcommands: SUBCOMMANDS,
		panes,
		sessions,
		agents: [...AGENT_PROGRAMS],
	})
	if (out.length > 0) process.stdout.write(`${out.join("\n")}\n`)
}
