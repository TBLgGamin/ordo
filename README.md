# ordo

A terminal UI application built with [OpenTUI](https://github.com/sst/opentui), running on [Bun](https://bun.sh), written in TypeScript, with [Biome](https://biomejs.dev) for linting & formatting.

## Stack

- **Runtime:** Bun **≥ 1.3.14** (required — pane restore uses `Bun.Terminal`, the
  native Windows ConPTY API added in 1.3.14)
- **Language:** TypeScript (strict)
- **TUI:** `@opentui/core`
- **Terminal restore:** `@xterm/headless` + `@xterm/addon-serialize` (pure JS)
- **Lint/Format:** Biome

## Getting started

```bash
bun install        # install deps
bun run dev        # run the app with hot reload
bun run start      # run the app once
```

> The TUI needs a real terminal (TTY). Run it from your terminal, not from a non-interactive shell.

## Scripts

| Script              | Description                                  |
| ------------------- | -------------------------------------------- |
| `bun run dev`       | Run with `--watch` hot reload                |
| `bun run start`     | Run the app                                  |
| `bun run typecheck` | Type-check with `tsc --noEmit`               |
| `bun run lint`      | Lint with Biome                              |
| `bun run format`    | Format with Biome (writes)                   |
| `bun run check`     | Lint + format + organize imports (writes)    |

## Controls

- `space` — increment the counter
- `r` — reset
- `q` / `Ctrl+C` — quit

## Automation

A Claude Code **Stop hook** (`.claude/settings.json`) runs `biome check --write .`
after each turn, so code is auto-formatted and linted as it's written.

## Orchestration scaffold

The app drives **Windows Terminal** to spawn satellite windows tiled around a
**fixed center**, and to push commands into them on demand.

### Two constraints that shaped the design

1. **`wt.exe` can't send input to a running pane/window** — an open feature
   request ([#12487](https://github.com/microsoft/terminal/issues/12487),
   [#12925](https://github.com/microsoft/terminal/issues/12925)); the only
   `sendInput` is a keybinding, not a CLI command. → We use a **hub-and-spoke**
   design: each spawned window runs our own agent that connects back over
   loopback TCP and executes whatever the hub sends.
2. **`wt.exe` can't keep a pane a fixed pixel size** — panes are a tree of
   *fractional* splits that rebalance on every change, and there's no command to
   move/resize an existing window. → We make each satellite a **separate window**
   and position/resize them with **Win32 `SetWindowPos`** (via `bun:ffi`), while
   never touching the center window.

```
        central app (TUI)                      satellite window
  ┌────────────────────────────┐         ┌──────────────────────┐
  │ Orchestrator               │         │ agent.ts             │
  │  ├─ Hub (loopback TCP) ◄────┼─────────┼─ connects on start   │
  │  ├─ wt.ts  → spawn window ──┼──wt───► │  drives a real shell │
  │  └─ layout + win32 ─────────┼─SetWindowPos─► tiles it        │
  └────────────────────────────┘         └──────────────────────┘
```

### Fixed center, tiled satellites

The center is the app's own WT window, captured at startup, resized + centered
once, then never moved. Each direction opens a satellite window in that zone;
adding more divides the zone and the windows **slide/resize (animated)** to fit.

```
┌──────┬───────┬──────┐   left/right : full-height columns, vertical stack
│      │  up   │      │   up/down    : center-width strips above/below center
│ left ├───────┤right │   center     : fixed, in the middle
│      │CENTER │      │
│      ├───────┤      │
│      │ down  │      │
└──────┴───────┴──────┘
```

| command | result                               |
| ------- | ------------------------------------ |
| `right` | stack a window in the right column   |
| `left`  | stack a window in the left column    |
| `up`    | place a window above the center      |
| `down`  | place a window below the center      |

**Why vertical stacking?** Windows Terminal refuses to make a window narrower
than ~476px, so side-by-side tiles would overlap as they got thin. Splitting by
**height** instead (no minimum) keeps every tile full-column-wide and ≥¾ of the
center's height (up to ~3 per side), and they never overlap.

**Follow the center.** A watcher tracks the center window; if you drag or resize
it — even onto another monitor — the satellites smoothly re-tile to follow and
stay on that screen. Tiles always stay within the monitor's work area.

**Interactive panes.** Each pane runs a normal interactive shell — just **type
directly into the pane window** to run commands there (full PSReadLine / line
editing / history). The center window is a dashboard for spawning, tiling, and
naming; it no longer sends commands.

**Named panes.** Each pane is named after a Roman soldier type (`optio`,
`signifer`, `decanus`, …) from a shared pool (`src/names.ts`), unique within the
session.

**Focused-window highlight.** The window you're currently in — any pane *or* the
center command window — gets a **thick lavender frame** drawn around it (four
layered, click-through overlay windows), plus the Win11 DWM border/title-bar
color underneath. Override the color with `ORDO_SELECT_COLOR` and the
thickness with `ORDO_BORDER_THICKNESS`.

**Distinct colors.** Each window gets a unique very-light pastel hue (generated
by walking the hue circle in golden-angle steps, so colors never collide). By
default only the **tab/title bar** is colored (`--tabColor`) and the body stays
black. Set `ORDO_COLOR` to `bg` (light background tint via OSC 11 + dark
text via OSC 10), `both`, or `off`. The session list colors each pane name with
its own pastel too.

**Persistent shells.** Pane shells don't live in the pane windows — they live in
a background **daemon** (see below). Closing a satellite window (or the whole
app) just detaches; the shell keeps running. Reopening re-attaches to it.

### Sessions (save / restore) — the daemon model

ordo restores like `tmux`, not like a screenshot. A persistent, windowless
**daemon** owns every pane's shell + ConPTY and **survives windows and the app
closing** (it's launched via `Start-Process -WindowStyle Hidden`, so Bun's
inability to detach doesn't matter). The pane windows run a **thin client** that
just pipes stdin/stdout to the daemon. So:

- **Close a window / quit the app → the shell stays alive** in the daemon.
- **Restore → re-attach to the *same live shell***: real running processes, real
  cwd, the real scrollback — **nothing is reconstructed**, because nothing died.

Every run gets a unique **session name** from Roman-era soldier types
(`centurion`, `optio`, …; kebab-compounded on collision), shown as the center
window's tab title. Layout + per-pane state save continuously to:

```
%APPDATA%\ordo\sessions\<name>.json      # center/zone rects, colors, cwd, last command
%APPDATA%\ordo\sessions\<name>.scrollback\<pane>.log   # raw VT capture (for cold restore)
%APPDATA%\ordo\daemon.json               # daemon discovery: { port, token, pid }
```

Restore with:

```powershell
pwsh -File scripts/launch.ps1 --restore <name>
```

It re-opens the center and every pane at their **exact saved size/position** and:

- **Warm restore** (daemon still running — you closed windows but didn't reboot):
  re-attaches to the live shell. The daemon replays its in-memory ring buffer (the
  real recent output) and the shell carries on — running programs and all.
- **Cold restore** (after a reboot, when the daemon is gone): the daemon starts a
  fresh shell **in the saved cwd**, replays the capture file through a headless
  emulator (`@xterm/headless`) so the prior screen comes back, and best-effort
  re-launches the whitelisted foreground program (`vim`, `claude`, `top`, …) — the
  only option once the OS has killed every process. Tune the whitelist with
  `ORDO_RESTORE_PROGRAMS` (empty disables relaunch).

The working directory follows you correctly because the shell reports it via an
injected **OSC 9;9** prompt hook (PowerShell's `cd` only moves `$PWD`, not the
process cwd, so this is the reliable source). The last command is captured from
the keystroke stream (decoding Win32 Input Mode, which is how a ConPTY delivers
input).

#### Listing sessions

```bash
bun run sessions                                   # list sessions
pwsh -File scripts/launch.ps1 --sessions           # same, inline
pwsh -File scripts/launch.ps1 --delete <name>      # delete a session + its scrollback
```

`bun run sessions` prints a small tree of every saved session — its panes
(colored with their pane color) and the last command sent to each — straight
into the current terminal (no new window):

```
ordo sessions (2)

centurion-optio  2 panes · 3m ago
  ├─ optio          right › npm run dev
  └─ signifer       down  › Get-Process
  resume → pwsh -File scripts\launch.ps1 --restore centurion-optio

legionary        1 pane · 2h ago
  └─ decanus        left  › git status
  resume → pwsh -File scripts\launch.ps1 --restore legionary
```

### Try it

```bash
bun run start            # then type: right, left, up, down
                         #            send pane1 Get-Date
                         #            all  echo hi
                         #            kill pane1
```

The center is captured from the **foreground** WT window at startup, so just run
it in the window you want fixed. `scripts/launch.ps1` opens a dedicated named
window first if you prefer.

### Configuration (env vars)

| Variable                   | Default       | Purpose                                   |
| -------------------------- | ------------- | ----------------------------------------- |
| `ORDO_CENTER_W`   | `0.36`        | Center width as a fraction of screen      |
| `ORDO_CENTER_H`   | `0.38`        | Center height as a fraction of screen     |
| `ORDO_GAP`        | `2`           | Pixel gap between windows                  |
| `ORDO_MIN_W`      | `480`         | Min window width (WT's floor is ~476)     |
| `ORDO_ANIM_MS`    | `180`         | Slide/resize animation duration (0 = off) |
| `ORDO_COLOR`      | `tab`         | Window coloring: `tab`/`bg`/`both`/`off`  |
| `ORDO_SELECT_COLOR` | `#d6c9f9`   | Highlight color of the focused window     |
| `ORDO_BORDER_THICKNESS` | `3`     | Thickness (px) of the focused-window frame |
| `ORDO_WT_WINDOW`  | `0` (current) | Window target for untiled `tab`/`win`     |
| `ORDO_WT_EXE`     | auto-detected | Path to `wt.exe` if in a custom location  |
| `ORDO_SHELL`      | `pwsh`        | Shell each agent drives                   |
| `ORDO_RESTORE_PROGRAMS` | `vim nvim … claude …` | Programs re-launched on cold restore (empty disables) |
| `ORDO_SCROLLBACK` | `1000`        | Scrollback lines reconstructed on cold restore |

> Windows-only: the tiling uses `user32.dll` (`EnumWindows`, `SetWindowPos`,
> `GetMonitorInfo`) and foreground detection uses `kernel32.dll` (Toolhelp
> snapshot), both through `bun:ffi`; the daemon hosts shells via the Windows
> ConPTY API (`Bun.Terminal`).

## Project layout

```
src/index.ts          # TUI front-end (command bar + window/log view)
src/orchestrator.ts   # high-level API: openPane(dir)/kill; talks to the daemon, owns tiling
src/daemon.ts         # persistent windowless daemon: hosts every shell+ConPTY, IPC, capture
src/client.ts         # thin per-pane process: pipes stdin/stdout to the daemon (no shell)
src/daemonClient.ts   # orchestrator-side daemon RPC + hidden Start-Process spawn/discovery
src/daemonProtocol.ts # daemon control + attach wire types
src/layout.ts         # fixed-center geometry + zone tiling
src/win32.ts          # user32.dll bindings (find/move/resize windows) via bun:ffi
src/wt.ts             # typed wrapper around wt.exe (spawn windows/tabs/panes)
src/colors.ts         # unique very-light pastel hues + tint helpers
src/names.ts          # shared Roman-soldier name pool (sessions + panes)
src/session.ts        # session JSON + paths under %APPDATA%\ordo
src/replay.ts         # reconstructs a pane's screen from its raw-VT capture (cold restore)
src/vt.ts             # title-strip (OSC 0/1/2), startup-clear suppress, OSC 9;9 cwd, command capture
src/proctree.ts       # foreground-program detection via Toolhelp snapshot (kernel32)
src/protocol.ts       # newline-delimited JSON framing (encode / LineDecoder)
src/config.ts         # paths, window target, shell, restore whitelist
scripts/launch.ps1    # launch the app in a named WT window
scripts/verify.ps1    # format + typecheck + tests (Stop hook)
biome.json            # lint + format config
tsconfig.json         # TypeScript config (Bun bundler mode)
.claude/              # Claude Code hooks/settings
```
