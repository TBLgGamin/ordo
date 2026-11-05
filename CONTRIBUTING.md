# Contributing to ordo

Thanks for taking the time to improve ordo.

ordo is cross-platform (Windows, macOS, Linux), built around Bun, Astro, a local
daemon, and a per-OS terminal + window-management layer. Changes should keep that
workflow fast, local, and understandable. By taking part you agree to follow the
[Code of Conduct](CODE_OF_CONDUCT.md).

## Before you start

- Search existing issues and pull requests before opening a new one.
- Keep changes focused. A small fix is easier to review than a broad rewrite.
- If you want to change behavior, open an issue or draft PR first so the design
  can be discussed.

## Setup

Requirements:

- Git and Bun `1.3.14` or newer.
- Windows 11 + Windows Terminal, **or** macOS 13+ with a terminal, **or** Linux
  on an X11 session with a terminal emulator.

Clone and install:

```sh
git clone https://github.com/TBLgGamin/ordo.git
cd ordo
bun install
```

Run the CLI in development mode:

```sh
bun run dev
```

Run the website:

```sh
bun run --cwd apps/web dev
```

Set up the optional pre-commit hook:

```sh
bun run setup:hooks
```

The hook runs lint and TypeScript checks before each commit.

## Checks

Before opening a pull request, run:

```sh
bun run ci
```

If a check fails and you cannot fix it, mention that clearly in the PR.

For local cleanup while developing, you can run:

```sh
bun run verify
```

`verify` is allowed to apply Biome fixes. CI uses `bun run ci`, which does not
write to the worktree.

## Project layout

```text
apps/
  cli/      CLI, daemon, MCP server, per-OS terminal + window integration
  web/      Astro website
scripts/
  install.ps1     install.sh
  uninstall.ps1   uninstall.sh
  verify.ps1
```

Platform-specific code lives under `apps/cli/src/platform/`: `types.ts` defines
the shared `WindowManager` / `TerminalBackend` interfaces, and `win32/`,
`darwin/`, and `linux/` implement them. `index.ts` selects a backend at runtime.

## Code style

- Follow the existing TypeScript and Astro style.
- Prefer small, direct functions over new abstractions.
- Keep user-facing copy plain and specific.
- Do not add a dependency unless it removes real complexity.
- Keep all three platforms in mind. New OS-specific behavior belongs in
  `apps/cli/src/platform/<os>/` behind the shared interface, never inline; keep
  the Windows path unchanged unless a change is deliberately cross-platform.

## Pull requests

A good PR includes:

- A short description of the problem.
- The change you made.
- Screenshots or recordings for website or TUI changes.
- The checks you ran.
- Any known tradeoffs or follow-up work.

Pull requests are squash-merged and the PR title becomes the commit message, so
write it as a [Conventional Commit](https://www.conventionalcommits.org), the
style of the history: `feat(cli): ...`, `fix(wm): ...`, `docs: ...`.

## Reporting bugs

Use the bug report form when you open an issue. It asks for:

- Your OS and version.
- Your terminal emulator (and, on Linux, your window manager / compositor and
  whether you are on X11 or Wayland).
- Bun version from `bun --version`.
- The command you ran.
- What happened.
- What you expected to happen.
- Logs or screenshots when useful.

## Security

Never open a public issue for a vulnerability. Report it privately as described
in [SECURITY.md](SECURITY.md).

## License

By contributing, you agree that your contribution will be licensed under the
MIT License.
