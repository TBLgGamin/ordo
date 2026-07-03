# Format + lint (auto-fix), type-check, and run the full test suite.
# Invoked by the Stop hook (.claude/settings.json) so every turn ends verified.
# Exits 2 when anything fails, which makes the Stop hook block and feed the
# output back so regressions get fixed before the turn ends.
$ErrorActionPreference = "Continue"
Set-Location -LiteralPath $PSScriptRoot/..
bun run verify
if ($LASTEXITCODE -eq 0) { exit 0 } else { exit 2 }
