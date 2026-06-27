<#
    DockView drop-in installer for existing Vesktop users (Windows).

    Copies the four DockView Vencord files sitting next to this script into your
    Vesktop custom-Vencord directory, replacing whatever Vencord build was there.
    See README.md in this bundle for what this is and the settings caveat.

    Usage (PowerShell):
        .\install-dockview.ps1

    If Windows blocks the script, run it once as:
        powershell -ExecutionPolicy Bypass -File .\install-dockview.ps1
#>

$ErrorActionPreference = "Stop"

# Where this script (and the four files) live.
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path

$Files = @(
    "vencordDesktopMain.js",
    "vencordDesktopPreload.js",
    "vencordDesktopRenderer.js",
    "vencordDesktopRenderer.css"
)

# Make sure all four files are present before we touch anything.
foreach ($f in $Files) {
    if (-not (Test-Path (Join-Path $ScriptDir $f))) {
        Write-Error "Missing $f next to this script. Unzip the whole bundle and run again."
    }
}

# Vesktop on Windows lives under %APPDATA%\vesktop.
$VesktopBase = Join-Path $env:APPDATA "vesktop"
$Target = Join-Path $VesktopBase "sessionData\vencordFilesCustom"

if (Test-Path $VesktopBase) {
    Write-Host "Found Vesktop config at: $VesktopBase"
} else {
    Write-Host "No existing Vesktop config found; using the default location."
}

New-Item -ItemType Directory -Force -Path $Target | Out-Null

foreach ($f in $Files) {
    Copy-Item -Force -Path (Join-Path $ScriptDir $f) -Destination (Join-Path $Target $f)
    Write-Host "  copied $f"
}

Write-Host ""
Write-Host "DockView Vencord files installed to:"
Write-Host "    $Target"
Write-Host ""
Write-Host "Now FULLY restart Vesktop (quit from the tray, not just close the window)."
Write-Host "If DockView doesn't show up, open Vesktop Settings -> Vencord and make sure"
Write-Host "the custom Vencord build is enabled (see README.md)."
