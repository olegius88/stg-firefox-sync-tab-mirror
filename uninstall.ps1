# Universal Uninstaller for STG Firefox Sync Tab Mirror
# Run remotely from anywhere:
#   irm https://raw.githubusercontent.com/olegius88/stg-firefox-sync-tab-mirror/main/uninstall.ps1 | iex

$ErrorActionPreference = "Stop"
$addonId = "stg-tab-mirror-sync@olegius.org"

$profilesRoot = Join-Path $env:APPDATA "Mozilla\Firefox\Profiles"
if (-not (Test-Path $profilesRoot)) {
    Write-Host "[ERROR] Firefox Profiles folder not found: $profilesRoot" -ForegroundColor Red
    exit 1
}

$profiles = Get-ChildItem -Path $profilesRoot -Directory
foreach ($prof in $profiles) {
    Write-Host "Cleaning profile: $($prof.Name)" -ForegroundColor Cyan

    $destXpi = Join-Path $prof.FullName "extensions\$addonId.xpi"
    if (Test-Path $destXpi) {
        Remove-Item $destXpi -Force
        Write-Host "  [-] Removed extension: $destXpi" -ForegroundColor Yellow
    }
    $stagedXpi = Join-Path $prof.FullName "extensions\staged\$addonId.xpi"
    if (Test-Path $stagedXpi) {
        Remove-Item $stagedXpi -Force
        Write-Host "  [-] Removed staged extension: $stagedXpi" -ForegroundColor Yellow
    }
}

Write-Host "`nUninstall complete! Restart Firefox to apply changes." -ForegroundColor Green
