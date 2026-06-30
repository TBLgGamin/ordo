# ordo

A terminal UI application built with [OpenTUI](https://github.com/sst/opentui), running on [Bun](https://bun.sh), written in TypeScript, with [Biome](https://biomejs.dev) for linting & formatting.

## Stack

- **Runtime:** Bun
- **Language:** TypeScript (strict)
- **TUI:** `@opentui/core`
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

**Close-the-main-closes-all.** Each satellite holds a connection to the hub in
the center window. Close the center (quit, Ctrl+C, or the X) and every satellite
tears itself down with it.

### Sessions (save / restore)

Every run gets a unique **session name** drawn from Roman-era soldier types
(`centurion`, `optio`, `signifer`, …); on collision another word is appended in
kebab-case (`centurion-optio`). The name is shown as the center window's tab
title. The layout is continuously saved to:

```
%APPDATA%\ordo\sessions\<name>.json
```

…capturing the center's rect and every satellite's zone, color, starting
directory, and position. Restore it later with:

```powershell
pwsh -File scripts/launch.ps1 --restore <name>
```

It re-opens the center and every pane at their **exact saved size and
position** (not re-tiled — the precise rects are stored and reapplied), and
**replays each pane's scrollback** so it looks like you never closed it.

How the scrollback works: each pane's agent tees its shell output to a capture
file (`<name>.scrollback/<pane>.log`, capped at 256 KB). On restore the agent
prints that back, draws a `──── restored ────` divider, then starts a fresh
shell. Commands are **not** re-run. A live shell can't truly be snapshotted —
running processes and live variables don't come back (that needs a tmux/screen
style detached server) — but the visual history and layout do.

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
| `ORDO_HUB_PORT`   | `0` (random)  | Hub TCP port                              |

> Windows-only: the tiling uses `user32.dll` (`EnumWindows`, `SetWindowPos`,
> `GetMonitorInfo`) through `bun:ffi`.

## Project layout

```
src/index.ts          # TUI front-end (command bar + window/log view)
src/orchestrator.ts   # high-level API: openPane(dir)/send/broadcast/kill
src/layout.ts         # fixed-center geometry + zone tiling
src/win32.ts          # user32.dll bindings (find/move/resize windows) via bun:ffi
src/wt.ts             # typed wrapper around wt.exe (spawn windows/tabs/panes)
src/colors.ts         # unique very-light pastel hues + tint helpers
src/names.ts          # shared Roman-soldier name pool (sessions + panes)
src/session.ts        # session save/restore (%APPDATA%\ordo)
src/hub.ts            # loopback TCP server + agent registry
src/agent.ts          # runs in each window: drives a shell, relays hub messages
src/protocol.ts       # newline-delimited JSON message types + framing
src/config.ts         # paths, window target, shell, hub host/port
scripts/launch.ps1    # launch the app in a named WT window
biome.json            # lint + format config
tsconfig.json         # TypeScript config (Bun bundler mode)
.claude/              # Claude Code hooks/settings
```
