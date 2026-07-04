# @ordo/web

Reserved slot for the ordo landing page — a static marketing site with the
install command and a link to the repo.

Planned stack: **Astro + Vue + Tailwind**, static output. Not scaffolded yet.

When built, this package stays fully isolated from `apps/cli`: the installer
(`scripts/install.ps1`) and the CLI never reference it, and its build output
(`dist/`, `.astro/`) is gitignored.
