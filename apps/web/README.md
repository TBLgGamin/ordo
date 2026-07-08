# @ordo/web

The ordo landing page and docs — a static marketing site with the OS-aware
install command and a link to the repo. Live at
[ordo.wena.one](https://ordo.wena.one).

Stack: **Astro + Vue + Tailwind**, static output.

```sh
bun run --cwd apps/web dev     # local dev server
bun run --cwd apps/web build   # static build to dist/
```

This package stays fully isolated from `apps/cli`: the installers
(`scripts/install.ps1`, `scripts/install.sh`) and the CLI never reference it, and
its build output (`dist/`, `.astro/`) is gitignored.
