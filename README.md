# ordo

A terminal UI application built with [OpenTUI](https://github.com/sst/opentui), running on [Bun](https://bun.sh), written in TypeScript, with [Biome](https://biomejs.dev) for linting & formatting.

## Stack

- **Runtime:** Bun **≥ 1.3.14** (required — pane restore uses `Bun.Terminal`, the
  native Windows ConPTY API added in 1.3.14)
- **Language:** TypeScript (strict)
- **TUI:** `@opentui/core`
- **Terminal restore:** `@xterm/headless` + `@xterm/addon-serialize` (pure JS)
- **Session titling:** `node-llama-cpp` running a tiny local GGUF model
- **Lint/Format:** Biome

## Getting started

### One-shot installer (recommended)

From a fresh machine — clones the repo, ensures Bun ≥ 1.3.14, installs deps,
registers the `ordo` command, and pre-downloads the title model:

```powershell
iex (irm https://raw.githubusercontent.com/TBLgGamin/ordo/master/scripts/install.ps1)
```

From an existing clone, run it in place:

```powershell
.\scripts\install.ps1              # set up this clone
.\scripts\install.ps1 -SkipModel   # skip the ~230 MB model download
.\scripts\install.ps1 -Update      # git pull --ff-only, then set up
```

To pass switches to the remote form:

```powershell
& ([scriptblock]::Create((irm https://raw.githubusercontent.com/TBLgGamin/ordo/master/scripts/install.ps1))) -SkipModel
```

### Manual

```bash
bun install        # install deps
bun link           # install the `ordo` command globally (symlinked to this source)
```

`bun link` puts an `ordo` executable in Bun's global bin dir (`~/.bun/bin`,
already on PATH if Bun is installed normally). Because it's a symlink to this
source, edits take effect immediately — no reinstall.

To remove it, run the standalone uninstaller (it stops the daemon, `bun unlink`s
the command, and deletes `%APPDATA%\ordo`):

```powershell
.\scripts\uninstall.ps1             # remove ordo and its data
.\scripts\uninstall.ps1 -KeepData   # remove the command but keep saved sessions
```

Then, from anywhere:

```powershell
ordo                      # open the command center (a launcher; no session yet)
ordo --new                # open it and start a new session immediately
ordo --restore <id>       # open it and restore a saved session
ordo --sessions           # list saved sessions (inline, no window)
ordo --delete <id>        # delete a saved session + its scrollback
```

> The TUI needs a real terminal (TTY). Run it from your terminal, not from a
> non-interactive shell. `ordo` opens its own dedicated Windows Terminal window
> and captures it as the fixed center.

## Scripts

For working on ordo itself:

| Script              | Description                                       |
| ------------------- | ------------------------------------------------- |
| `bun run dev`       | Run the TUI in-place with `--watch` hot reload    |
| `bun run typecheck` | Type-check with `tsc --noEmit`                    |
| `bun run lint`      | Lint with Biome                                   |
| `bun run format`    | Format with Biome (writes)                        |
| `bun run check`     | Lint + format + organize imports (writes)         |

## The command window

Running `ordo` opens the **command center** — a launcher that does *not* start a
session on its own. Its layout: a purple-outlined **sessions sidebar** on the
left (a live, scrollable browser of every saved session, drawn with OpenTUI), an
**input area** filling the space to its right (where you type a session id), and
one continuous **command bar** linking them along the bottom. Each session shows
its generated title, id, pane count and age; each pane line keeps its own pane
color (the only ink that isn't the accent purple), and the running session is
flagged with a `●`. `↑`/`↓` (and `PgUp`/`PgDn`) scroll the list.

There's no choosing left/right/up/down — panes are auto-placed. Drive it with
these commands, by key or by clicking the matching label in the bottom bar:

| key / button    | what it does                                                        |
| --------------- | ------------------------------------------------------------------- |
| **`n`** new     | start a new session (replaces the current one in this window)       |
| **`a`** add pane| spawn one more pane, auto-placed: right → left → up → down → repeat  |
| **`s`** open    | open a previous session — type its id + Enter, or click it in the sidebar |
| **`c`** close   | close the current session (its shells stay alive for later)         |
| **`d`** delete  | delete a saved session — type its id + Enter, or click it (in delete mode) |
| `q` / `Ctrl+C`  | quit (panes stay alive in the daemon)                               |

There's **one session per window**: opening or starting a session while one is
already open closes the old one and brings up the new one in place. `c` drops
back to the launcher without deleting anything. Type directly in each **pane**
window to run commands there. The focused window (a pane *or* the command
window) gets the lavender border + title bar.

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
once, then never moved. Pressing **`a`** places the next satellite in the next
zone — cycling **right → left → up → down → right → …** — and adding more divides
a zone so its windows **slide/resize (animated)** to fit. You don't pick the
side; ordo cycles through them for you.

```
┌──────┬───────┬──────┐   left/right : full-height columns, vertical stack
│      │  up   │      │   up/down    : center-width strips above/below center
│ left ├───────┤right │   center     : fixed, in the middle
│      │CENTER │      │   add order  : right → left → up → down → repeat
│      ├───────┤      │
│      │ down  │      │
└──────┴───────┴──────┘
```

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
`signifer`, `decanus`, …) from a shared pool (`src/core/names.ts`), unique within the
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
a background **daemon** (see below). Closing the **command window** (or switching
sessions) just *detaches* every pane — the shells keep running for a later
restore. Closing a **single pane's window**, by contrast, **permanently removes
that pane**: the daemon kills its shell, deletes its scrollback, and the
orchestrator drops it from the session (the remaining panes re-tile to fill in).

### Sessions (save / restore) — the daemon model

ordo restores like `tmux`, not like a screenshot. A persistent, windowless
**daemon** owns every pane's shell + ConPTY and **survives windows and the app
closing** (it's launched via `Start-Process -WindowStyle Hidden`, so Bun's
inability to detach doesn't matter). The pane windows run a **thin client** that
just pipes stdin/stdout to the daemon. So:

- **Close the command window / switch sessions → the shells stay alive** in the
  daemon (closing a single *pane* window instead removes that pane for good).
- **Restore → re-attach to the *same live shell***: real running processes, real
  cwd, the real scrollback — **nothing is reconstructed**, because nothing died.

Every run gets a unique **session id** from Roman-era soldier types
(`centurion`, `optio`, …; kebab-compounded on collision), shown as the center
window's tab title. The id is the stable **resume key** (`--restore`/`--delete`).
A separate, human-friendly **title** is generated from recent activity (see
[Auto-titled sessions](#auto-titled-sessions)). Layout + per-pane state save
continuously to:

```
%APPDATA%\ordo\sessions\<id>.json        # id, title, center/zone rects, colors, cwd, last command
%APPDATA%\ordo\sessions\<id>.scrollback\<pane>.log   # raw VT capture (for cold restore)
%APPDATA%\ordo\daemon.json               # daemon discovery: { port, token, pid }
%APPDATA%\ordo\models\*.gguf             # cached title model (downloaded on first use)
```

Restore with (the id, not the title):

```powershell
ordo --restore <id>
```

It re-opens the center at its saved position and **re-tiles every pane cleanly by
its saved zone** (right/left/up/down) around it — the same auto-placement used
live, so the layout is always consistent and never overlaps. Then:

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

### Auto-titled sessions

Beyond the soldier-name **id**, each session gets a human-friendly **title**
written by a tiny local model. As you work, ordo reads the recent commands +
output across **all** the session's panes (from their scrollback captures,
ANSI-stripped) and feeds them to [SupraLabs' **Supra-Title-350M**][supra] — an
~230 MB LFM2 GGUF trained purely to write short conversation titles — run
in-process via [`node-llama-cpp`][nlc]. The result (e.g. *"Fixing Sidebar
Layout"*) becomes the session's heading in the browser, with the id beneath it.

- **Automatic & debounced.** Titles regenerate ~15 s after command activity
  settles (`ORDO_TITLE_DEBOUNCE`), and once after a restore. No manual step.
- **Self-contained.** The model is downloaded on first use to
  `%APPDATA%\ordo\models` (silently — no console spam) and cached thereafter.
- **Best-effort.** If the model can't load (offline, disabled, unsupported),
  titling turns itself off and the **id** is shown instead — the app never
  blocks or crashes on it. Disable entirely with `ORDO_TITLE=0`.

[supra]: https://huggingface.co/SupraLabs/Supra-Title-350M-exp-GGUF
[nlc]: https://node-llama-cpp.withcat.ai

#### Listing sessions

```powershell
ordo --sessions              # list sessions (inline, no new window)
ordo --delete <id>           # delete a session + its scrollback
```

`ordo --sessions` prints a small tree of every saved session — its generated
title (with the id beneath), panes (colored with their pane color) and the last
command sent to each — straight into the current terminal (no new window):

```
ordo sessions (2)

Running Dev Server
centurion-optio  2 panes · 3m ago
  ├─ optio          right › npm run dev
  └─ signifer       down  › Get-Process
  resume → ordo --restore centurion-optio

Checking Git Status
legionary        1 pane · 2h ago
  └─ decanus        left  › git status
  resume → ordo --restore legionary
```

### Try it

```bash
ordo                     # opens the command center (launcher)
                         # then press: n  (new session — spawns the first pane)
                         #             a  (add another pane; repeat to tile more)
                         #             s  (open a previous session by id, or click one)
                         #             c  (close the current session)
                         #             d  (delete a saved session by id, or click one)
                         #             q  (quit)
```

`ordo` opens its own dedicated WT window and captures it as the fixed center, so
it never disturbs the terminal you launched it from.

### Configuration (env vars)

| Variable                   | Default       | Purpose                                   |
| -------------------------- | ------------- | ----------------------------------------- |
| `ORDO_CENTER_W`   | `0.48`        | Center width as a fraction of screen      |
| `ORDO_CENTER_H`   | `0.50`        | Center height as a fraction of screen     |
| `ORDO_GAP`        | `2`           | Pixel gap between windows                  |
| `ORDO_MIN_W`      | `480`         | Min window width (WT's floor is ~476)     |
| `ORDO_ANIM_MS`    | `180`         | Slide/resize animation duration (0 = off) |
| `ORDO_COLOR`      | `tab`         | Window coloring: `tab`/`bg`/`both`/`off`  |
| `ORDO_SELECT_COLOR` | `#d6c9f9`   | Highlight color of the focused window     |
| `ORDO_BORDER_THICKNESS` | `3`     | Thickness (px) of the focused-window frame |
| `ORDO_WT_WINDOW`  | `0` (current) | Window target for untiled `tab`/`win`     |
| `ORDO_WT_EXE`     | auto-detected | Path to `wt.exe` if in a custom location  |
| `ORDO_SHELL`      | `pwsh`, else `powershell` | Shell each agent drives       |
| `ORDO_RESTORE_PROGRAMS` | `vim nvim … claude …` | Programs re-launched on cold restore (empty disables) |
| `ORDO_SCROLLBACK` | `1000`        | Scrollback lines reconstructed on cold restore |
| `ORDO_TITLE`      | `1`           | Auto session titling (`0` disables it entirely) |
| `ORDO_TITLE_MODEL`| Supra-Title-350M Q4 | Title model URI/path (any `node-llama-cpp` model URI) |
| `ORDO_TITLE_DEBOUNCE` | `15000`   | Delay (ms) after activity settles before retitling |
| `ORDO_MODELS_DIR` | `%APPDATA%\ordo\models` | Where the title model GGUF is cached |

> Numeric values are clamped to sane ranges (e.g. `ORDO_CENTER_W` 0.1–0.9,
> `ORDO_GAP` 0–64, `ORDO_ANIM_MS` 0–2000); out-of-range or non-numeric values
> fall back to the default.

> Windows-only: the tiling uses `user32.dll` (`EnumWindows`, `SetWindowPos`,
> `GetMonitorInfo`) and foreground detection uses `kernel32.dll` (Toolhelp
> snapshot), both through `bun:ffi`; the daemon hosts shells via the Windows
> ConPTY API (`Bun.Terminal`).

## Project layout

```
src/index.ts               # entrypoint: CLI dispatch (--new/--restore/--sessions/--delete)
src/cli/tui.ts             # sessions-sidebar TUI: widgets, actions, keybindings
src/cli/format.ts          # sidebar styling + relative-time / truncate helpers
src/cli/sessions.ts        # inline (non-TUI) --sessions printer
src/app/orchestrator.ts    # high-level API: openPane(dir)/kill; talks to the daemon, owns tiling
src/app/types.ts           # ManagedPane / OrchestratorEvent types + small helpers
src/app/titler.ts          # debounced session-title (re)generation
src/app/layout.ts          # fixed-center geometry manager + zone tiling
src/app/geometry.ts        # pure zone/slot/clamp rect math
src/app/animator.ts        # zone move/resize tween engine
src/app/title.ts           # local session titling: gather pane activity → Supra-Title-350M (node-llama-cpp)
src/daemon/daemon.ts       # persistent windowless daemon: TCP server, warm/cold restore, entry
src/daemon/pane.ts         # one live pane: shell + ConPTY, ring buffer, attached clients
src/daemon/capture.ts      # append-only raw-VT capture file with tail compaction
src/daemon/attachClient.ts # thin per-pane process: pipes stdin/stdout to the daemon (no shell)
src/daemon/daemonClient.ts # orchestrator-side daemon RPC + hidden Start-Process spawn/discovery
src/daemon/replay.ts       # reconstructs a pane's screen from its raw-VT capture (cold restore)
src/daemon/vt.ts           # title-strip (OSC 0/1/2), startup-clear suppress, OSC 9;9 cwd, command capture
src/platform/win32.ts      # user32.dll bindings (find/move/resize windows) via bun:ffi
src/platform/proctree.ts   # foreground-program detection via Toolhelp snapshot (kernel32)
src/platform/overlay.ts    # click-through FFI windows drawing the focus border
src/platform/wt.ts         # typed wrapper around wt.exe (spawn windows/tabs/panes)
src/core/config.ts         # paths, window target, shell, restore whitelist
src/core/session.ts        # session JSON (id, title, layout) + paths under %APPDATA%\ordo
src/core/daemonProtocol.ts # daemon control + attach wire types
src/core/protocol.ts       # newline-delimited JSON framing (encode / LineDecoder)
src/core/names.ts          # shared Roman-soldier name pool (sessions + panes)
src/core/colors.ts         # unique very-light pastel hues + tint helpers
scripts/install.ps1        # one-shot installer: clone/setup, bun link, model download
scripts/setup-model.ts     # pre-downloads the title model into %APPDATA%\ordo\models
scripts/verify.ps1         # format + typecheck + tests (Stop hook)
biome.json                 # lint + format config
tsconfig.json              # TypeScript config (Bun bundler mode)
.claude/                   # Claude Code hooks/settings
```
