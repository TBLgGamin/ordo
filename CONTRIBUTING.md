# Contributing to ordo

Thanks for taking the time to improve ordo.

ordo is Windows-first and built around Windows Terminal, Bun, Astro, and a local
daemon. Changes should keep that workflow fast, local, and understandable.

## Before you start

- Search existing issues and pull requests before opening a new one.
- Keep changes focused. A small fix is easier to review than a broad rewrite.
- If you want to change behavior, open an issue or draft PR first so the design
  can be discussed.

## Setup

Requirements:

- Windows 11
- Windows Terminal
- Git
- Bun `1.3.14` or newer

Clone and install:

```powershell
git clone https://github.com/TBLgGamin/ordo.git
cd ordo
bun install
```

Run the CLI in development mode:

```powershell
bun run dev
```

Run the website:

```powershell
bun run --cwd apps/web dev
```

Set up the optional pre-commit hook:

```powershell
bun run setup:hooks
```

The hook runs lint and TypeScript checks before each commit.

## Checks

Before opening a pull request, run:

```powershell
bun run ci
```

If a check fails and you cannot fix it, mention that clearly in the PR.

For local cleanup while developing, you can run:

```powershell
bun run verify
```

`verify` is allowed to apply Biome fixes. CI uses `bun run ci`, which does not
write to the worktree.

## Project layout

```text
apps/
  cli/      CLI, daemon, MCP server, Windows Terminal integration
  web/      Astro website
scripts/
  install.ps1
  uninstall.ps1
  verify.ps1
```

## Code style

- Follow the existing TypeScript and Astro style.
- Prefer small, direct functions over new abstractions.
- Keep user-facing copy plain and specific.
- Do not add a dependency unless it removes real complexity.
- Keep Windows behavior in mind. ordo depends on Windows Terminal.

## Pull requests

A good PR includes:

- A short description of the problem.
- The change you made.
- Screenshots or recordings for website or TUI changes.
- The checks you ran.
- Any known tradeoffs or follow-up work.

## Reporting bugs

Please include:

- Windows version.
- Windows Terminal version if relevant.
- Bun version from `bun --version`.
- The command you ran.
- What happened.
- What you expected to happen.
- Logs or screenshots when useful.

## Security

Please do not open public issues for security-sensitive reports. If the project
does not yet list a private security contact, open a minimal issue asking for a
private reporting channel without posting exploit details.

## License

By contributing, you agree that your contribution will be licensed under the
MIT License.
