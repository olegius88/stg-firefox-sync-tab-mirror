# Universal Local & Remote Installer for STG Firefox Sync Tab Mirror
# Run remotely from anywhere:
#   irm https://raw.githubusercontent.com/olegius88/stg-firefox-sync-tab-mirror/main/install.ps1 | iex

$ErrorActionPreference = "Stop"
$addonId = "stg-tab-mirror-sync@olegius.org"
$remoteXpiUrl = "https://raw.githubusercontent.com/olegius88/stg-firefox-sync-tab-mirror/main/stg-tab-mirror-sync.xpi"

$scriptDir = $null
if ($MyInvocation.MyCommand.Path) {
    $scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
}

$xpiSource = $null
if ($scriptDir) {
    $candidate = Join-Path $scriptDir "stg-tab-mirror-sync.xpi"
    if (Test-Path $candidate) {
        $xpiSource = $candidate
    }
}

if (-not $xpiSource) {
    $xpiSource = Join-Path $env:TEMP "stg-tab-mirror-sync.xpi"
    Write-Host "Downloading latest stg-tab-mirror-sync.xpi from GitHub..." -ForegroundColor Cyan
    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
    Invoke-WebRequest -Uri $remoteXpiUrl -OutFile $xpiSource -UseBasicParsing
    Write-Host "  [+] Downloaded to $xpiSource" -ForegroundColor Green
}

$profilesRoot = Join-Path $env:APPDATA "Mozilla\Firefox\Profiles"
if (-not (Test-Path $profilesRoot)) {
    Write-Host "[ERROR] Firefox Profiles folder not found: $profilesRoot" -ForegroundColor Red
    exit 1
}

$profiles = Get-ChildItem -Path $profilesRoot -Directory
foreach ($prof in $profiles) {
    Write-Host "Processing profile: $($prof.Name)" -ForegroundColor Cyan

    # 1. Configure user.js for Experiment API and Firefox Sync extension-storage engine
    $userJsPath = Join-Path $prof.FullName "user.js"
    $userJsContent = ""
    if (Test-Path $userJsPath) {
        $userJsContent = Get-Content $userJsPath -Raw -Encoding UTF8
    }

    $requiredPrefs = @(
        'user_pref("xpinstall.signatures.required", false);',
        'user_pref("extensions.experiments.enabled", true);',
        'user_pref("extensions.autoDisableScopes", 0);',
        'user_pref("services.sync.engine.extension-storage.force", true);'
    )

    $modified = $false
    foreach ($prefLine in $requiredPrefs) {
        $prefName = ($prefLine -split '"')[1]
        if ($userJsContent -notmatch [regex]::Escape($prefName)) {
            $userJsContent = $userJsContent.TrimEnd() + "`r`n" + $prefLine + "`r`n"
            $modified = $true
        }
    }

    if ($modified) {
        Set-Content -Path $userJsPath -Value $userJsContent.TrimStart() -Encoding UTF8
        Write-Host "  [+] Updated user.js (enabled experiments & Firefox Sync extension-storage)" -ForegroundColor Green
    }

    # 2. Copy XPI to profile extensions directory
    $extDir = Join-Path $prof.FullName "extensions"
    if (-not (Test-Path $extDir)) {
        New-Item -ItemType Directory -Path $extDir -Force | Out-Null
    }

    $destXpi = Join-Path $extDir "$addonId.xpi"
    try {
        Copy-Item -Path $xpiSource -Destination $destXpi -Force -ErrorAction Stop
        Write-Host "  [+] Installed extension: $destXpi" -ForegroundColor Green
    } catch {
        $stagedDir = Join-Path $extDir "staged"
        if (-not (Test-Path $stagedDir)) {
            New-Item -ItemType Directory -Path $stagedDir -Force | Out-Null
        }
        $stagedXpi = Join-Path $stagedDir "$addonId.xpi"
        Copy-Item -Path $xpiSource -Destination $stagedXpi -Force
        Write-Host "  [+] Extension is active in Firefox; staged update for next restart: $stagedXpi" -ForegroundColor Green
    }
}

Write-Host "`nDone! Restart Firefox to activate STG Firefox Sync Tab Mirror." -ForegroundColor Green
