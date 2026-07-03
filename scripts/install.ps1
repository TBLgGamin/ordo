[CmdletBinding()]
param(
	[string]$InstallDir = (Join-Path $HOME 'ordo'),
	[switch]$SkipModel,
	[switch]$Update
)

$ErrorActionPreference = 'Stop'
$RepoUrl = 'https://github.com/TBLgGamin/ordo.git'
$MinBun = [version]'1.3.14'
$BunBin = Join-Path $HOME '.bun\bin'

$Esc = [char]27
$Purple = "$Esc[38;2;214;201;249m"
$PurpleBold = "$Esc[1;38;2;214;201;249m"
$Reset = "$Esc[0m"

function Write-Step($message) { Write-Host "$PurpleBold==>$Reset $Purple$message$Reset" }
function Write-Info($message) { Write-Host "$Purple    $message$Reset" }
function Stop-Fatal($message) {
	Write-Host "$PurpleBold!!$Reset $Purple$message$Reset"
	exit 1
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

function Show-Output($output) {
	foreach ($line in $output) { Write-Info $line }
}

function Test-CommandExists($name) {
	return $null -ne (Get-Command $name -ErrorAction SilentlyContinue)
}

function Add-BunToProcessPath {
	if (Test-Path $BunBin) {
		if ($env:Path -notlike "*$BunBin*") {
			$env:Path = "$BunBin;$env:Path"
		}
	}
}

function Assert-Windows {
	if ($env:OS -ne 'Windows_NT') {
		Stop-Fatal 'ordo is Windows-only (it drives Windows Terminal through bun:ffi).'
	}
}

function Test-OrdoRepo($dir) {
	if (-not $dir) { return $false }
	$pkg = Join-Path $dir 'package.json'
	if (-not (Test-Path $pkg)) { return $false }
	try {
		$json = Get-Content $pkg -Raw | ConvertFrom-Json
		return $json.name -eq 'ordo'
	} catch {
		return $false
	}
}

function Update-Repo($dir) {
	Write-Step 'Updating the clone (git pull --ff-only)'
	$result = Invoke-Quiet 'git' @('-C', $dir, 'pull', '--ff-only')
	if ($result.Code -ne 0) {
		Write-Info 'git pull failed; continuing with the existing checkout.'
	}
}

function Resolve-RepoRoot {
	if ($PSScriptRoot) {
		$candidate = Split-Path -Parent $PSScriptRoot
		if (Test-OrdoRepo $candidate) {
			Write-Step "Using this clone at $candidate"
			if ($Update) { Update-Repo $candidate }
			$script:RepoRoot = $candidate
			return
		}
	}
	if (Test-OrdoRepo $InstallDir) {
		Write-Step "Using existing install at $InstallDir"
		if ($Update) { Update-Repo $InstallDir }
		$script:RepoRoot = $InstallDir
		return
	}
	if (-not (Test-CommandExists 'git')) {
		Stop-Fatal 'git is required to clone ordo. Install it: winget install Git.Git'
	}
	Write-Step "Cloning ordo into $InstallDir"
	$result = Invoke-Quiet 'git' @('clone', $RepoUrl, $InstallDir)
	if ($result.Code -ne 0) {
		Show-Output $result.Output
		Stop-Fatal 'git clone failed.'
	}
	$script:RepoRoot = $InstallDir
}

function Get-BunVersion {
	$raw = & bun --version | Select-Object -First 1
	if ("$raw".Trim() -match '(\d+)\.(\d+)\.(\d+)') {
		return [version]"$($Matches[1]).$($Matches[2]).$($Matches[3])"
	}
	Stop-Fatal "Could not parse bun version output: '$raw'. Reinstall Bun: irm bun.sh/install.ps1 | iex"
}

function Ensure-Bun {
	if (-not (Test-CommandExists 'bun')) {
		Write-Step 'Installing Bun'
		$result = Invoke-Quiet 'powershell' @('-NoProfile', '-Command', 'irm bun.sh/install.ps1 | iex')
		Add-BunToProcessPath
		if (-not (Test-CommandExists 'bun')) {
			Show-Output $result.Output
			Stop-Fatal 'Bun was installed but is not on PATH. Open a new shell and re-run this script.'
		}
	}
	$version = Get-BunVersion
	if ($version -lt $MinBun) {
		Write-Step "Upgrading Bun $version to $MinBun or newer"
		$result = Invoke-Quiet 'bun' @('upgrade')
		$version = Get-BunVersion
		if ($version -lt $MinBun) {
			Show-Output $result.Output
			Stop-Fatal "ordo needs Bun $MinBun+ for Bun.Terminal (ConPTY). Found $version."
		}
	}
	Write-Info "Bun $version"
}

function Test-RuntimeDeps {
	$wtApp = Join-Path $env:LOCALAPPDATA 'Microsoft\WindowsApps\wt.exe'
	if ((Test-CommandExists 'wt') -or (Test-Path $wtApp)) {
		Write-Info 'Windows Terminal found'
	} else {
		Write-Info 'Windows Terminal not found - winget install Microsoft.WindowsTerminal'
	}
	if (Test-CommandExists 'pwsh') {
		Write-Info 'PowerShell 7 (pwsh) found'
	} else {
		Write-Info 'pwsh not found (default shell) - winget install Microsoft.PowerShell, or set ORDO_SHELL'
	}
}

function Install-Deps {
	Write-Step 'Installing dependencies'
	Push-Location $script:RepoRoot
	try {
		$result = Invoke-Quiet 'bun' @('install')
		if ($result.Code -ne 0) {
			Show-Output $result.Output
			Stop-Fatal 'bun install failed.'
		}
	} finally {
		Pop-Location
	}
	Write-Info 'Dependencies installed'
}

function Register-Command {
	Write-Step 'Registering the ordo command'
	Push-Location $script:RepoRoot
	try {
		$result = Invoke-Quiet 'bun' @('link')
		if ($result.Code -ne 0) {
			Show-Output $result.Output
			Stop-Fatal 'bun link failed.'
		}
	} finally {
		Pop-Location
	}
	Add-BunToProcessPath
	if (Test-CommandExists 'ordo') {
		Write-Info 'ordo registered on PATH'
	} else {
		Write-Info "ordo linked, but $BunBin is not on your persistent PATH."
		Write-Info "Add $BunBin to your user PATH, then reopen your shell."
	}
}

function Install-Model {
	if ($SkipModel) {
		Write-Step 'Skipping title-model download (-SkipModel)'
		return
	}
	if ($env:ORDO_TITLE -eq '0') {
		Write-Step 'Skipping title-model download (ORDO_TITLE=0)'
		return
	}
	Write-Step 'Downloading the title model (~230 MB, one-time)'
	Push-Location $script:RepoRoot
	try {
		$result = Invoke-Quiet 'bun' @('scripts/setup-model.ts')
		if ($result.Code -ne 0) {
			Write-Info 'Model download failed; ordo retries it on first run (titling is best-effort).'
		} else {
			Write-Info 'Title model ready'
		}
	} finally {
		Pop-Location
	}
}

function Write-Summary {
	if (Test-CommandExists 'ordo') {
		$ordoStatus = 'on PATH'
	} else {
		$ordoStatus = "linked (add $BunBin to PATH)"
	}
	Write-Host ''
	Write-Host "$PurpleBold ordo is set up.$Reset"
	Write-Host "$Purple   repo:  $script:RepoRoot$Reset"
	Write-Host "$Purple   ordo:  $ordoStatus$Reset"
	Write-Host "$Purple   run:   ordo$Reset"
	Write-Host "$Purple          ordo --sessions    (list saved sessions)$Reset"
	Write-Host "$Purple          ordo --new         (start a fresh session)$Reset"
}

Assert-Windows
Resolve-RepoRoot
Ensure-Bun
Test-RuntimeDeps
Install-Deps
Register-Command
Install-Model
Write-Summary
