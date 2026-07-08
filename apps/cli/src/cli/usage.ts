const LINES = [
	"ordo — a terminal multiplexer for orchestrating AI agents",
	"",
	"Usage: ordo [command] [args]",
	"",
	"Session commands:",
	"  ordo                 open the launcher in a fresh window",
	"  ordo new             start a fresh session immediately (--agent, --name, --cwd)",
	"  ordo restore <id>    reopen a saved session",
	"  ordo sessions        list saved sessions",
	"  ordo delete <id>     delete a saved session",
	"",
	"Agent commands:",
	"  ordo agents          list live agent panes",
	"  ordo spawn           spawn an agent pane (--agent, --cwd, --name)",
	"  ordo send <pane>     send a message to a pane",
	"  ordo read <pane>     read a pane's output (--lines N)",
	"  ordo broadcast       send a message to every agent",
	"  ordo status          show agent statuses",
	"  ordo interrupt <pane>  interrupt a pane",
	"",
	"Other commands:",
	"  ordo completion [shell]  print the shell completion script",
	"  ordo help            show this help",
	"",
	"Agent commands open (or reopen) a command center automatically when one",
	"isn't running, so they work from any terminal.",
]

export function usageText(): string {
	return LINES.join("\n")
}
