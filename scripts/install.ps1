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

function Write-Step($message) { Write-Host "==> $message" -ForegroundColor Cyan }
function Write-Ok($message) { Write-Host "    $message" -ForegroundColor Green }
function Write-Note($message) { Write-Host "    $message" -ForegroundColor Yellow }
function Stop-Fatal($message) {
	Write-Host "ERROR: $message" -ForegroundColor Red
	exit 1
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
	git -C $dir pull --ff-only
	if ($LASTEXITCODE -ne 0) {
		Write-Note 'git pull failed; continuing with the existing checkout.'
	}
}

function Resolve-RepoRoot {
	if ($PSScriptRoot) {
		$candidate = Split-Path -Parent $PSScriptRoot
		if (Test-OrdoRepo $candidate) {
			Write-Ok "Using this clone at $candidate"
			if ($Update) { Update-Repo $candidate }
			$script:RepoRoot = $candidate
			return
		}
	}
	if (Test-OrdoRepo $InstallDir) {
		Write-Ok "Using existing install at $InstallDir"
		if ($Update) { Update-Repo $InstallDir }
		$script:RepoRoot = $InstallDir
		return
	}
	if (-not (Test-CommandExists 'git')) {
		Stop-Fatal 'git is required to clone ordo. Install it: winget install Git.Git'
	}
	Write-Step "Cloning $RepoUrl into $InstallDir"
	git clone $RepoUrl $InstallDir
	if ($LASTEXITCODE -ne 0) { Stop-Fatal 'git clone failed.' }
	$script:RepoRoot = $InstallDir
}

function Get-BunVersion {
	$raw = & bun --version | Select-Object -First 1
	return [version]$raw.Trim()
}

function Ensure-Bun {
	if (-not (Test-CommandExists 'bun')) {
		Write-Step 'Installing Bun (bun.sh/install.ps1)'
		Invoke-RestMethod 'https://bun.sh/install.ps1' | Invoke-Expression
		Add-BunToProcessPath
		if (-not (Test-CommandExists 'bun')) {
			Stop-Fatal 'Bun was installed but is not on PATH. Open a new shell and re-run this script.'
		}
	}
	$version = Get-BunVersion
	if ($version -lt $MinBun) {
		Write-Step "Bun $version is older than $MinBun; upgrading"
		bun upgrade | Out-Null
		$version = Get-BunVersion
		if ($version -lt $MinBun) {
			Stop-Fatal "ordo needs Bun >= $MinBun for Bun.Terminal (ConPTY). Found $version."
		}
	}
	Write-Ok "Bun $version"
}

function Test-RuntimeDeps {
	$wtApp = Join-Path $env:LOCALAPPDATA 'Microsoft\WindowsApps\wt.exe'
	if ((Test-CommandExists 'wt') -or (Test-Path $wtApp)) {
		Write-Ok 'Windows Terminal (wt.exe) found'
	} else {
		Write-Note 'Windows Terminal not found. Install: winget install Microsoft.WindowsTerminal'
	}
	if (Test-CommandExists 'pwsh') {
		Write-Ok 'PowerShell 7 (pwsh) found'
	} else {
		Write-Note 'pwsh not found (ordo default shell). Install: winget install Microsoft.PowerShell (or set ORDO_SHELL)'
	}
}

function Install-Deps {
	Write-Step 'Installing dependencies (bun install)'
	Push-Location $script:RepoRoot
	try {
		bun install
		if ($LASTEXITCODE -ne 0) { Stop-Fatal 'bun install failed.' }
	} finally {
		Pop-Location
	}
	Write-Ok 'Dependencies installed (node-llama-cpp native binary fetched via trustedDependencies)'
}

function Register-Command {
	Write-Step 'Registering the ordo command (bun link)'
	Push-Location $script:RepoRoot
	try {
		bun link
		if ($LASTEXITCODE -ne 0) { Stop-Fatal 'bun link failed.' }
	} finally {
		Pop-Location
	}
	Add-BunToProcessPath
	if (Test-CommandExists 'ordo') {
		Write-Ok 'ordo command registered'
	} else {
		Write-Note "ordo is linked but $BunBin is not on your persistent PATH."
		Write-Note "Add $BunBin to your user PATH (System > Environment Variables), then reopen your shell."
	}
}

function Install-Model {
	if ($SkipModel) {
		Write-Note 'Skipping title-model download (-SkipModel).'
		return
	}
	if ($env:ORDO_TITLE -eq '0') {
		Write-Note 'Skipping title-model download (ORDO_TITLE=0).'
		return
	}
	Write-Step 'Downloading the title model (~230 MB, cached under %APPDATA%\ordo\models)'
	Push-Location $script:RepoRoot
	try {
		bun scripts/setup-model.ts
		if ($LASTEXITCODE -ne 0) {
			Write-Note 'Model download failed; ordo retries it on first run (titling is best-effort).'
		} else {
			Write-Ok 'Title model ready'
		}
	} finally {
		Pop-Location
	}
}

function Write-Summary {
	$ordoStatus = if (Test-CommandExists 'ordo') { 'on PATH' } else { "linked (add $BunBin to PATH)" }
	Write-Host ''
	Write-Host 'ordo is set up.' -ForegroundColor Cyan
	Write-Host "  repo:  $script:RepoRoot"
	Write-Host "  ordo:  $ordoStatus"
	Write-Host '  run:   ordo'
	Write-Host '         ordo --sessions    (list saved sessions)'
	Write-Host '         ordo --new         (start a fresh session)'
}

Assert-Windows
Resolve-RepoRoot
Ensure-Bun
Test-RuntimeDeps
Install-Deps
Register-Command
Install-Model
Write-Summary
