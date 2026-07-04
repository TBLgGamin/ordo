import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import { z } from "zod"
import { colorName } from "../core/colors"
import { loadSession } from "../core/session"
import { DaemonClient } from "../daemon/daemonClient"

const NO_IDENTITY =
	"This MCP server only works inside an ordo pane (ORDO_SESSION / ORDO_PANE are not set)."
const NO_DAEMON = "The ordo daemon is not running — is the ordo command center open?"

type ToolResult = { content: Array<{ type: "text"; text: string }>; isError?: boolean }

const ok = (text: string): ToolResult => ({ content: [{ type: "text", text }] })
const fail = (text: string): ToolResult => ({ content: [{ type: "text", text }], isError: true })

function instructions(session: string, pane: string): string {
	return [
		`You are running inside "ordo", a terminal window manager. Your terminal pane is named "${pane}" in session "${session}". Your call sign on the ordo channel is "${pane}". Other panes in this session may be running other AI coding agents or plain shells — they are your peers.`,
		"",
		"How peer messaging works: ordo types your message straight into the target pane's input, exactly as if you had typed it there — nothing is added, no sender tag. So peers identify themselves in the message itself, using a simple radio call sign: open with the peer's pane name, then your own. For example, to hail the pane `optio`:",
		"",
		`    optio, this is ${pane} — could you run the test suite and tell me if it passes?`,
		"",
		`When a message lands in your input that opens by naming you ("${pane}, this is <someone> —"), treat it as that peer agent hailing you, not the human user, and answer with the send_message tool in the same call-sign style ("<peer>, this is ${pane} — ..."). Never reply by printing text addressed to a peer into your own output; always use send_message.`,
		"",
		"Etiquette: call list_agents first to see who is present and what each pane is running. Keep hails short, specific, and self-contained, like a good commit message with a request — include enough context that the peer needs no other state. After hailing with a question, either call wait_for_reply to block for the answer, or just end your turn — the reply arrives as a call-sign message in your input. A pane whose foreground is a plain shell has no agent listening: there, skip the call sign and send_message a literal command (it runs verbatim). Use read_pane to peek at what a peer is doing before interrupting it; use interrupt (Ctrl-C) only when a peer is stuck or the human asked you to stop it.",
		"",
		"You are self-managing — you can shape the session, not just talk on it. spawn_pane opens a new tiled pane and can launch a fresh agent in it (e.g. spin up a `codex` pane to hand off a subtask, then delegate with send_message); close_pane cleans one up. broadcast hails every peer at once for all-hands announcements. Keep set_status current — set it when you start a task, change focus, and finish — so peers and the human can see what you're doing (read it back with list_agents or session_info). Prefer wait_for_event over polling: block for a pane to appear, a peer to finish, or a status to change. Use run_command for quick headless facts (git status, a test run) without disturbing any peer's pane. Call session_info to get the whole board at a glance.",
	].join("\n")
}

async function withDaemon(fn: (dc: DaemonClient) => Promise<ToolResult>): Promise<ToolResult> {
	const dc = new DaemonClient()
	try {
		if (!(await dc.tryAttach())) return fail(NO_DAEMON)
		return await fn(dc)
	} catch (err) {
		return fail(`ordo error: ${err instanceof Error ? err.message : String(err)}`)
	} finally {
		dc.stop()
	}
}

export async function runMcpServer(): Promise<void> {
	const session = process.env.ORDO_SESSION ?? ""
	const pane = process.env.ORDO_PANE ?? ""
	const hasIdentity = session !== "" && pane !== ""

	const server = new McpServer(
		{ name: "ordo", version: "1.0.0" },
		{ instructions: hasIdentity ? instructions(session, pane) : NO_IDENTITY },
	)

	const register = server.registerTool.bind(server) as (
		name: string,
		config: {
			title?: string
			description?: string
			inputSchema?: Record<string, z.ZodTypeAny>
		},
		// biome-ignore lint/suspicious/noExplicitAny: MCP SDK tool-arg generics recurse; validated by zod at runtime.
		cb: (args: any) => Promise<ToolResult> | ToolResult,
	) => void

	register(
		"list_agents",
		{
			title: "List peer agents",
			description:
				"List the other panes (peer agents) in your ordo session. Returns each peer's pane name (use it as the `to` target for send_message), its color, whether its shell is alive, its working directory, the program currently running in its foreground (e.g. 'claude', 'codex', or 'shell' when no agent is running), and its self-reported status/task from the shared status board. Also returns your own current status. Call this before messaging anyone.",
			inputSchema: {},
		},
		async () => {
			if (!hasIdentity) return fail(NO_IDENTITY)
			return withDaemon(async (dc) => {
				const [{ panes }, { entries }] = await Promise.all([
					dc.getState(session),
					dc.getStatus(session),
				])
				const statusByPane = new Map(entries.map((e) => [e.pane, e]))
				const peers = panes
					.filter((p) => p.pane !== pane)
					.map((p) => ({
						pane: p.pane,
						color: p.color ? colorName(p.color) : "none",
						colorHex: p.color,
						status: p.live ? "live" : "dead",
						cwd: p.cwd,
						foreground: p.foreground ?? "shell",
						lastCommand: p.lastCommand,
						activity: statusByPane.get(p.pane)?.status,
						task: statusByPane.get(p.pane)?.task,
					}))
				const mine = statusByPane.get(pane)
				return ok(
					JSON.stringify(
						{ you: pane, session, myStatus: mine?.status, myTask: mine?.task, peers },
						null,
						2,
					),
				)
			})
		},
	)

	register(
		"send_message",
		{
			title: "Send a message to a peer",
			description: `Send a message to a peer pane. Ordo types it verbatim into that pane's input and presses Enter, exactly as if you typed it there — nothing is added. If the target runs an AI agent, open with the call sign so it knows a peer is hailing it: "<peer>, this is ${pane} — ...". If the target is a plain shell, skip the call sign and send a literal command; it runs as-is. If the peer is currently blocked in wait_for_reply, the message is handed to it directly instead of being typed. Keep it short and self-contained.`,
			inputSchema: {
				to: z.string().describe("The peer pane name to message (from list_agents)."),
				message: z.string().describe("The message text to deliver."),
			},
		},
		async ({ to, message }) => {
			if (!hasIdentity) return fail(NO_IDENTITY)
			if (to === pane) return fail("You cannot message yourself.")
			return withDaemon(async (dc) => {
				const res = await dc.sendMessage(session, to, { from: pane, text: message })
				return ok(
					res.delivered === "waiter"
						? `Delivered to ${to} (it was waiting for a reply).`
						: `Delivered — typed into ${to}'s input.`,
				)
			})
		},
	)

	register(
		"read_pane",
		{
			title: "Read a peer's recent output",
			description:
				"Read the most recent terminal output (plain text, escape codes stripped) of a peer pane. Use it to check what a peer is doing or whether it has finished, before messaging or interrupting it.",
			inputSchema: {
				pane: z.string().describe("The peer pane name to read."),
				lines: z.number().int().min(1).max(2000).default(120).describe("How many trailing lines."),
			},
		},
		async ({ pane: target, lines }) => {
			if (!hasIdentity) return fail(NO_IDENTITY)
			return withDaemon(async (dc) => {
				const { text } = await dc.readPane(session, target, lines)
				return ok(text.trim() === "" ? "(no recent output)" : text)
			})
		},
	)

	register(
		"wait_for_reply",
		{
			title: "Wait for a peer message",
			description:
				"Block until a peer sends you a message, then return it as this tool's result (it will NOT also be typed into your input). Optionally filter by sender pane name. Returns a timeout notice if nothing arrives in time. Only messages sent while you are actually waiting are caught — a message sent before you called this was already typed into your input, so check your recent input too.",
			inputSchema: {
				from: z.string().optional().describe("Only accept a message from this pane name."),
				timeout_seconds: z.number().int().min(1).max(300).default(60),
			},
		},
		async ({ from, timeout_seconds }) => {
			if (!hasIdentity) return fail(NO_IDENTITY)
			return withDaemon(async (dc) => {
				const res = await dc.waitForMessage(session, pane, {
					from,
					timeoutMs: timeout_seconds * 1000,
				})
				if ("timeout" in res) return ok("No reply arrived before the timeout.")
				return ok(`${res.from} says: ${res.text}`)
			})
		},
	)

	register(
		"interrupt",
		{
			title: "Interrupt a peer (Ctrl-C)",
			description:
				"Send Ctrl-C to a peer pane to stop whatever is running in its foreground. Disruptive: use only when a peer is stuck, looping, or the user asked you to stop it. Prefer send_message to ask an agent to stop itself.",
			inputSchema: {
				pane: z.string().describe("The peer pane name to interrupt."),
			},
		},
		async ({ pane: target }) => {
			if (!hasIdentity) return fail(NO_IDENTITY)
			if (target === pane) return fail("Refusing to interrupt yourself.")
			return withDaemon(async (dc) => {
				await dc.interrupt(session, target)
				return ok(`Sent Ctrl-C to ${target}.`)
			})
		},
	)

	register(
		"spawn_pane",
		{
			title: "Open a new pane",
			description:
				"Open a new tiled terminal pane (a real window) in your ordo session, and optionally launch an agent CLI or program in it. Requires the ordo command center to be open. Returns the new pane's name; you can then delegate to it with send_message once it's up — poll list_agents until its foreground shows the agent, or wait_for_event for a 'pane-created' event and read_pane to watch it boot. The launched program must be one ordo is allowed to start (the same whitelist it restores, e.g. claude, codex, gemini, opencode).",
			inputSchema: {
				agent: z
					.string()
					.optional()
					.describe(
						"Program to launch in the new pane, e.g. 'claude', 'codex'. Omit for a plain shell.",
					),
				cwd: z.string().optional().describe("Working directory for the new pane."),
				name: z
					.string()
					.regex(/^[a-z][a-z0-9-]*$/i)
					.optional()
					.describe("Preferred pane name; a fresh one is picked if this is taken or invalid."),
			},
		},
		async ({ agent, cwd, name }) => {
			if (!hasIdentity) return fail(NO_IDENTITY)
			return withDaemon(async (dc) => {
				const res = await dc.requestPane(session, { requestedBy: pane, name, cwd, agent })
				return ok(
					agent
						? `Opened pane "${res.pane}" and launched ${agent} in it.`
						: `Opened pane "${res.pane}".`,
				)
			})
		},
	)

	register(
		"close_pane",
		{
			title: "Close a pane",
			description:
				"Close (kill) a peer pane and its shell — use it to clean up a helper pane you spawned, or one the human asked you to close. You cannot close yourself.",
			inputSchema: {
				pane: z.string().describe("The peer pane name to close."),
			},
		},
		async ({ pane: target }) => {
			if (!hasIdentity) return fail(NO_IDENTITY)
			if (target === pane) return fail("Refusing to close yourself.")
			return withDaemon(async (dc) => {
				await dc.killPane(session, target)
				return ok(`Closed pane "${target}".`)
			})
		},
	)

	register(
		"broadcast",
		{
			title: "Broadcast to all peers",
			description: `Send the same message to every other pane in your session at once — an all-hands hail. Each peer receives it exactly as with send_message: typed into its input, or handed over if it's waiting. Open with your call sign so peers know who is broadcasting ("all panes, this is ${pane} — ..."). Returns per-peer delivery results.`,
			inputSchema: {
				message: z.string().min(1).describe("The message to send to every peer."),
			},
		},
		async ({ message }) => {
			if (!hasIdentity) return fail(NO_IDENTITY)
			return withDaemon(async (dc) => {
				const { results } = await dc.broadcast(session, { from: pane, text: message })
				if (results.length === 0) return ok("No other panes to broadcast to.")
				const lines = results.map((r) =>
					r.error ? `${r.pane}: failed (${r.error})` : `${r.pane}: ${r.delivered}`,
				)
				return ok(`Broadcast to ${results.length} peer(s):\n${lines.join("\n")}`)
			})
		},
	)

	register(
		"set_status",
		{
			title: "Set your status",
			description:
				"Publish your current status to the session's shared status board so peers and the human can see what you're doing. Good discipline: set it when you start a task, change focus, and finish. Pass an empty status to clear it. Read everyone's status back with list_agents or session_info.",
			inputSchema: {
				status: z
					.string()
					.max(120)
					.describe("A short status line, e.g. 'reviewing PR #42'. Empty string clears it."),
				task: z
					.string()
					.max(500)
					.optional()
					.describe("Optional longer detail about what you're working on."),
			},
		},
		async ({ status, task }) => {
			if (!hasIdentity) return fail(NO_IDENTITY)
			return withDaemon(async (dc) => {
				await dc.setStatus(session, pane, status, task)
				return ok(status.trim() === "" ? "Status cleared." : `Status set: ${status}`)
			})
		},
	)

	register(
		"wait_for_event",
		{
			title: "Wait for a session event",
			description:
				"Block until something happens in the session — a peer messages anyone, a pane is created, a pane exits, or a peer changes its status — then return what happened. Unlike wait_for_reply this only OBSERVES: a message addressed to you is still typed into your input as normal, never consumed. Use it to coordinate without polling — e.g. wait for a pane you spawned to appear, or for a peer to finish.",
			inputSchema: {
				events: z
					.array(z.enum(["message", "pane-exited", "pane-created", "status-changed"]))
					.min(1)
					.optional()
					.describe("Which event kinds to wait for. Omit to wait for any of them."),
				pane: z.string().optional().describe("Only fire for events about this pane."),
				timeout_seconds: z.number().int().min(1).max(300).default(60),
			},
		},
		async ({ events, pane: filterPane, timeout_seconds }) => {
			if (!hasIdentity) return fail(NO_IDENTITY)
			return withDaemon(async (dc) => {
				const res = await dc.waitForEvent(session, pane, {
					events,
					filterPane,
					timeoutMs: timeout_seconds * 1000,
				})
				if ("timeout" in res) return ok("No matching event before the timeout.")
				return ok(JSON.stringify(res, null, 2))
			})
		},
	)

	register(
		"run_command",
		{
			title: "Run a shell command",
			description:
				"Run a one-shot command in the session (PowerShell) and get back its stdout, stderr, and exit code. It runs headless — no window, no TTY, no peer sees it — so use it for quick facts like `git status` or a test run, not for interactive or long-lived programs (use spawn_pane for those). Output is capped and the command is killed after the timeout.",
			inputSchema: {
				command: z.string().min(1).describe("The command line to run (PowerShell syntax)."),
				cwd: z.string().optional().describe("Working directory for the command."),
				timeout_seconds: z.number().int().min(1).max(300).default(30),
			},
		},
		async ({ command, cwd, timeout_seconds }) => {
			if (!hasIdentity) return fail(NO_IDENTITY)
			return withDaemon(async (dc) => {
				const res = await dc.runCommand(session, {
					command,
					cwd,
					timeoutMs: timeout_seconds * 1000,
				})
				const head = res.timedOut
					? `(timed out after ${timeout_seconds}s)`
					: `(exit ${res.exitCode})`
				const parts = [`${head}${res.truncated ? " (output truncated)" : ""}`]
				if (res.stdout.trim() !== "") parts.push(`stdout:\n${res.stdout.trimEnd()}`)
				if (res.stderr.trim() !== "") parts.push(`stderr:\n${res.stderr.trimEnd()}`)
				return ok(parts.join("\n\n"))
			})
		},
	)

	register(
		"session_info",
		{
			title: "Inspect the session",
			description:
				"Get a structured overview of your ordo session: its title, every pane (name, color, foreground program, cwd, live status, layout direction) and each pane's status-board entry. Use it to orient yourself before delegating or coordinating.",
			inputSchema: {},
		},
		async () => {
			if (!hasIdentity) return fail(NO_IDENTITY)
			return withDaemon(async (dc) => {
				const [{ panes }, { entries }] = await Promise.all([
					dc.getState(session),
					dc.getStatus(session),
				])
				const statusByPane = new Map(entries.map((e) => [e.pane, e]))
				const saved = loadSession(session)
				const paneInfo = panes.map((p) => ({
					pane: p.pane,
					you: p.pane === pane,
					color: p.color ? colorName(p.color) : "none",
					live: p.live,
					foreground: p.foreground ?? "shell",
					cwd: p.cwd,
					lastCommand: p.lastCommand,
					activity: statusByPane.get(p.pane)?.status,
					task: statusByPane.get(p.pane)?.task,
					direction: saved?.satellites.find((s) => s.id === p.pane)?.direction,
				}))
				return ok(
					JSON.stringify({ session, title: saved?.title, you: pane, panes: paneInfo }, null, 2),
				)
			})
		},
	)

	await server.connect(new StdioServerTransport())
	await new Promise<void>((resolve) => {
		process.stdin.once("close", resolve)
		process.stdin.once("end", resolve)
	})
}
