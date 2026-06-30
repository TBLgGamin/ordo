# Launches ordo in its own Windows Terminal window (the fixed "center").
#
# Usage:
#   pwsh -File scripts/launch.ps1                       # new session (auto-named)
#   pwsh -File scripts/launch.ps1 --restore <name>      # restore a saved session
#   pwsh -File scripts/launch.ps1 --sessions            # list sessions in THIS terminal
#
# The app captures whichever window it launches in as the center, names the tab
# after the session, and (for --restore) re-creates the saved panes in place.

$ErrorActionPreference = "Stop"

$projectDir = Split-Path -Parent $PSScriptRoot
$entry      = Join-Path $projectDir "src\index.ts"

$bun = (Get-Command bun -ErrorAction SilentlyContinue).Source
if (-not $bun) { throw "bun was not found on PATH. Install Bun or add it to PATH first." }

# Parse passthrough args.
$restore = $null
$delete = $null
$sessions = $false
for ($i = 0; $i -lt $args.Count; $i++) {
    if ($args[$i] -eq "--restore" -or $args[$i] -eq "-restore") { $restore = $args[$i + 1] }
    if ($args[$i] -eq "--delete" -or $args[$i] -eq "-delete") { $delete = $args[$i + 1] }
    if ($args[$i] -eq "--sessions" -or $args[$i] -eq "-sessions") { $sessions = $true }
}

if ($sessions) {
    # Print the session list inline in the current terminal (no new window).
    & $bun run $entry --sessions
} elseif ($delete) {
    & $bun run $entry --delete $delete
} elseif ($restore) {
    wt.exe -w new new-tab --title $restore -d $projectDir $bun run $entry --restore $restore
} else {
    wt.exe -w new new-tab -d $projectDir $bun run $entry
}
