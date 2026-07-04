[CmdletBinding()]
param(
	[switch]$KeepData
)

$ErrorActionPreference = 'Stop'
$BunBin = Join-Path $HOME '.bun\bin'
$DataDir = Join-Path $env:APPDATA 'ordo'

$Esc = [char]27
$Purple = "$Esc[38;2;214;201;249m"
$PurpleBold = "$Esc[1;38;2;214;201;249m"
$Reset = "$Esc[0m"

function Write-Step($message) { Write-Host "$PurpleBold==>$Reset $Purple$message$Reset" }
function Write-Info($message) { Write-Host "$Purple    $message$Reset" }

function Test-CommandExists($name) {
	return $null -ne (Get-Command $name -ErrorAction SilentlyContinue)
}

function Invoke-Quiet($file, $argList) {
	$previous = $ErrorActionPreference
	$ErrorActionPreference = 'Continue'
	try {
		$output = & $file @argList 2>&1
		$code = $LASTEXITCODE
	} finally {
		$ErrorActionPreference = $previous
	}
	return [pscustomobject]@{ Code = $code; Output = $output }
}

function Stop-Daemon {
	$info = Join-Path $DataDir 'daemon.json'
	if (-not (Test-Path $info)) { return }
	Write-Step 'Stopping the session daemon'
	try {
		$daemonPid = (Get-Content $info -Raw | ConvertFrom-Json).pid
		if ($daemonPid) {
			Stop-Process -Id $daemonPid -Force -ErrorAction SilentlyContinue
			Write-Info "stopped daemon (pid $daemonPid)"
		}
	} catch {
		Write-Info 'no running daemon found'
	}
}

function Unregister-Command {
	Write-Step 'Removing the ordo command'
	if (-not (Test-CommandExists 'bun')) {
		Write-Info 'bun not found; skipping unlink'
		return
	}
	$repo = Split-Path -Parent $PSScriptRoot
	$cli = Join-Path $repo 'apps\cli'
	if (Test-Path (Join-Path $cli 'package.json')) {
		$linkDir = $cli
	} elseif (Test-Path (Join-Path $repo 'package.json')) {
		$linkDir = $repo
	} else {
		Write-Info 'could not locate the ordo repo; skipping unlink'
		return
	}
	Push-Location $linkDir
	try {
		$result = Invoke-Quiet 'bun' @('unlink')
		if ($result.Code -eq 0) {
			Write-Info 'unlinked the ordo command'
		} else {
			Write-Info 'bun unlink reported nothing to remove'
		}
	} finally {
		Pop-Location
	}
	if (Test-CommandExists 'ordo') {
		Write-Info "if 'ordo' still resolves, remove $BunBin\ordo* by hand"
	}
}

function Remove-Data {
	if ($KeepData) {
		Write-Step 'Keeping saved sessions + title model (-KeepData)'
		return
	}
	Write-Step 'Removing saved sessions, scrollback, and the title model'
	if (Test-Path $DataDir) {
		Remove-Item -LiteralPath $DataDir -Recurse -Force -ErrorAction SilentlyContinue
		Write-Info "removed $DataDir"
	} else {
		Write-Info 'no data directory to remove'
	}
}

Write-Host ''
Write-Host "$PurpleBold Uninstalling ordo.$Reset"
Stop-Daemon
Unregister-Command
Remove-Data
Write-Host ''
Write-Host "$PurpleBold ordo removed.$Reset"
if ($KeepData) {
	Write-Host "$Purple   data kept at $DataDir$Reset"
}
Write-Host "$Purple   the clone itself is untouched - delete it to finish.$Reset"
