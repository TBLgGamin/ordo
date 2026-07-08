[CmdletBinding()]
param(
	[string]$InstallDir = (Join-Path $env:LOCALAPPDATA 'Programs\ordo'),
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
	$cli = Join-Path $InstallDir 'apps\cli'
	if ((Test-CommandExists 'bun') -and (Test-Path (Join-Path $cli 'package.json'))) {
		Push-Location $cli
		try {
			$result = Invoke-Quiet 'bun' @('unlink')
			if ($result.Code -eq 0) {
				Write-Info 'unlinked the ordo command'
			}
		} finally {
			Pop-Location
		}
	}
	if (Test-Path $BunBin) {
		Get-ChildItem -LiteralPath $BunBin -Filter 'ordo*' -ErrorAction SilentlyContinue |
			Remove-Item -Force -ErrorAction SilentlyContinue
	}
	if (Test-CommandExists 'ordo') {
		Write-Info "if 'ordo' still resolves, remove stale shims from $BunBin"
	} else {
		Write-Info 'ordo command removed'
	}
}

function Remove-Completion {
	Write-Step 'Removing PowerShell tab-completion'
	try {
		if (-not (Test-Path $PROFILE)) {
			Write-Info 'no PowerShell profile found'
			return
		}
		$current = Get-Content $PROFILE -Raw
		$pattern = "(?ms)\r?\n?# >>> ordo completion >>>.*?# <<< ordo completion <<<\r?\n?"
		$updated = [regex]::Replace($current, $pattern, '')
		if ($updated -eq $current) {
			Write-Info 'no ordo completion block found'
			return
		}
		Set-Content -Path $PROFILE -Value $updated -NoNewline
		Write-Info 'removed completion from your PowerShell profile'
	} catch {
		Write-Info "Could not update your PowerShell profile: $($_.Exception.Message)"
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

function Remove-AppFiles {
	Write-Step 'Removing ordo application files'
	if (Test-Path $InstallDir) {
		Remove-Item -LiteralPath $InstallDir -Recurse -Force -ErrorAction SilentlyContinue
		Write-Info "removed $InstallDir"
	} else {
		Write-Info 'no application directory to remove'
	}
}

Write-Host ''
Write-Host "$PurpleBold Uninstalling ordo.$Reset"
Stop-Daemon
Unregister-Command
Remove-Completion
Remove-AppFiles
Remove-Data
Write-Host ''
Write-Host "$PurpleBold ordo removed.$Reset"
if ($KeepData) {
	Write-Host "$Purple   data kept at $DataDir$Reset"
}
