# ordo

> Your terminal, in formation.

ordo is a tiling terminal multiplexer for Windows, macOS, and Linux. It opens
real terminal windows around a command center, keeps shells alive in a
background daemon, and gives AI agent panes a shared MCP radio so they can find
each other, send messages, read output, broadcast, interrupt, and spawn more
panes.

Website and docs: [ordo.wena.one](https://ordo.wena.one).

<p align="center">
  <img src="apps/web/public/product/hero-formation.png" alt="Ordo tiling several terminal panes around a command center" width="100%">
</p>

## Why ordo exists

Most terminal multiplexers hide work in tabs and splits. ordo does the opposite:
it spreads work out into real windows and keeps those windows in formation.

That makes it useful when you are running more than one shell, and especially
useful when those shells are agent CLIs. Each pane gets a name. Each agent gets
the tools to talk to the rest of the room. You can watch, steer, interrupt, or
script the whole thing from one place.

## What you get

- **Real tiled windows** - panes arrange around the center command window.
- **Persistent sessions** - closing a window does not kill the shell inside it.
- **Warm restore** - reconnect to still-running panes.
- **Cold restore** - rebuild sessions after a reboot with scrollback, working
  directories, and foreground programs where possible.
- **Agent orchestration** - supported agent CLIs get ordo MCP tools
  automatically.
- **Scriptable commands** - anything the launcher does can also be called from a
  shell.
- **Local titles** - a small local model can name sessions from recent pane
  activity. No cloud call required.

## Requirements

All platforms need Git and Bun `1.3.14` or newer. The installer checks these and
installs or updates Bun when needed.

- **Windows 11** with **Windows Terminal** (`wt.exe`).
- **macOS 13+** with any supported terminal. Terminal.app and iTerm2 tile with no
  extra setup; kitty, WezTerm, Alacritty, and Ghostty need Accessibility
  permission (System Settings → Privacy & Security → Accessibility) to be tiled.
- **Linux** on an **X11** session with a terminal emulator (kitty, WezTerm,
  Alacritty, GNOME Terminal, Konsole, xterm, …). On **Wayland**, ordo cannot
  position other windows, so panes open untiled; run under XWayland to tile.

ordo auto-detects your terminal; set `ORDO_TERMINAL` to force a specific one.

## Install

**Windows** — run this in PowerShell:

```powershell
irm https://raw.githubusercontent.com/TBLgGamin/ordo/master/scripts/install.ps1 | iex
```

**macOS / Linux** — run this in your shell:

```sh
curl -fsSL https://raw.githubusercontent.com/TBLgGamin/ordo/master/scripts/install.sh | bash
```

Then open ordo:

```sh
ordo
```

The launcher opens in a new terminal window. From there you can start a fresh
session, restore saved work, and spawn panes.

To remove ordo later:

```powershell
irm https://raw.githubusercontent.com/TBLgGamin/ordo/master/scripts/uninstall.ps1 | iex
```

```sh
curl -fsSL https://raw.githubusercontent.com/TBLgGamin/ordo/master/scripts/uninstall.sh | bash
```

Pass `-KeepData` (Windows) or `--keep-data` (macOS/Linux) to keep saved sessions
and local model files.

## Daily use

Start a fresh room:

```sh
ordo new
```

Open agent panes:

```sh
ordo spawn --agent claude --name legatus
ordo spawn --agent codex --name optio
```

Send work to a pane:

```sh
ordo send optio "inspect apps/cli/src/core and report back"
```

Read a pane without focusing its window:

```sh
ordo read optio --lines 80
```

Tell the whole room something:

```sh
ordo broadcast "wrap up and leave a short status"
```

Restore saved work:

```sh
ordo sessions
ordo restore centurion-optio
```

Full command docs: [ordo.wena.one/docs](https://ordo.wena.one/docs).

## Commands at a glance

| Command                      | What it is for                     |
| ---------------------------- | ---------------------------------- |
| `ordo`                       | Open the launcher.                 |
| `ordo new`                   | Start a fresh session immediately. |
| `ordo restore <id>`          | Reopen a saved session.            |
| `ordo sessions`              | List saved sessions.               |
| `ordo delete <id>`           | Delete a saved session.            |
| `ordo agents`                | List panes in the active session.  |
| `ordo spawn`                 | Open a shell or agent pane.        |
| `ordo send <pane> <text...>` | Send a message to a pane.          |
| `ordo read <pane>`           | Read recent pane output.           |
| `ordo broadcast <text...>`   | Send one message to every pane.    |
| `ordo status`                | Read or set pane status.           |
| `ordo interrupt <pane>`      | Send Ctrl-C to a pane.             |
| `ordo completion [shell]`    | Print shell completion setup.      |
| `ordo help`                  | Show short CLI help.               |

## Agent support

ordo recognizes these launchable agent programs:

- `claude`
- `codex`
- `gemini`
- `opencode`
- `copilot`
- `qwen`
- `cursor-agent`
- `goose`
- `amp`
- `droid`
- `kilo`
- `kilocode`

When one of these runs inside an ordo pane, ordo wires in MCP tools so the agent
can discover peers, read pane output, send messages, broadcast, interrupt panes,
update status, and spawn new panes.

## Screenshots

### Launcher

The launcher shows saved sessions, panes, and daemon activity.

<p align="center">
  <img src="apps/web/public/product/launcher-cli.png" alt="Ordo launcher TUI" width="100%">
</p>

### Agent communication

Agent panes can talk through ordo while the command center keeps the session
visible.

<p align="center">
  <img src="apps/web/public/product/agent-communication.png" alt="Two Claude Code agents communicating through Ordo" width="100%">
</p>

### Restore

Sessions can come back with their pane formation, working directories, and
recent terminal state.

<p align="center">
  <img src="apps/web/public/product/session-restore.png" alt="Ordo restoring a saved terminal session" width="100%">
</p>

## Configuration

Common environment variables:

| Variable                         | Purpose                                                       |
| -------------------------------- | ------------------------------------------------------------- |
| `ORDO_SESSION`                   | Select the active session for CLI commands.                   |
| `ORDO_SHELL`                     | Override the shell launched inside agent panes.               |
| `ORDO_TERMINAL`                  | Force a specific terminal emulator instead of auto-detecting. |
| `ORDO_RESTORE_PROGRAMS`          | Override which foreground programs are relaunched on restore. |
| `ORDO_SCROLLBACK`                | Set captured scrollback lines for restore.                    |
| `ORDO_CENTER_W`, `ORDO_CENTER_H` | Tune the center window size as a monitor fraction.            |
| `ORDO_GAP`                       | Set the pixel gap between tiled windows.                      |
| `ORDO_COLOR`                     | Choose pane coloring mode: `tab`, `bg`, `both`, or `off`.     |
| `ORDO_TITLE`                     | Set to `0` to disable local title generation.                 |
| `ORDO_TITLE_MODEL`               | Use a different local or Hugging Face GGUF title model.       |
| `ORDO_MODELS_DIR`                | Change where local models are cached.                         |

Session data lives under `%APPDATA%\ordo` (Windows),
`~/Library/Application Support/ordo` (macOS), and `$XDG_DATA_HOME/ordo` or
`~/.local/share/ordo` (Linux). More detail lives in the docs:
[ordo.wena.one/docs](https://ordo.wena.one/docs).

## Development

Clone and install dependencies:

```sh
git clone https://github.com/TBLgGamin/ordo.git
cd ordo
bun install
```

Run the CLI in development mode:

```sh
bun run dev
```

Run checks:

```sh
bun run ci
```

Set up the optional pre-commit hook:

```sh
bun run setup:hooks
```

Run the website:

```sh
bun run --cwd apps/web dev
```

Repository layout:

```text
apps/
  cli/      ordo CLI, daemon, MCP server, per-OS terminal + window integration
  web/      Astro website
scripts/
  install.ps1     install.sh
  uninstall.ps1   uninstall.sh
  verify.ps1
```

Platform-specific code lives under `apps/cli/src/platform/{win32,darwin,linux}`
behind a shared interface in `apps/cli/src/platform/types.ts`.

## Contributing

Issues and pull requests are welcome. Start with
[CONTRIBUTING.md](CONTRIBUTING.md) so the setup, checks, and project conventions
are clear before you open a PR.

## License

ordo is released under the [MIT License](LICENSE).
