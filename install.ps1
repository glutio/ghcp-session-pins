# install.ps1 - copy the session-pins extension into the canonical Copilot CLI
# extensions directory so the CLI loads it on next startup.
#
# Usage (from the plugin directory):
#   .\install.ps1
#
# Or from anywhere, if the plugin is installed via the Agency Playground marketplace:
#   & "$env:USERPROFILE\.copilot\installed-plugins\agency-playground\session-pins\install.ps1"

param(
    [switch]$Force
)

$ErrorActionPreference = "Stop"

$extSrc = Join-Path $PSScriptRoot "extension"

# Refuse to run if USERPROFILE is unset or a filesystem root, so the recursive
# delete below can never target an unintended location.
if ([string]::IsNullOrWhiteSpace($env:USERPROFILE) -or $env:USERPROFILE -in @("\", "/")) {
    Write-Error "Refusing to install: USERPROFILE is not set. Set it to your home directory and retry."
    exit 1
}

$extDst = Join-Path $env:USERPROFILE ".copilot\extensions\session-pins"

if (-not (Test-Path $extSrc)) {
    Write-Error "Source folder not found: $extSrc"
    exit 1
}

# Install the extension unless it already exists and -Force was not supplied.
# The destination is cleared before copying so an upgrade can't leave stale files.
if ((Test-Path $extDst) -and -not $Force) {
    Write-Host "session-pins extension already installed at $extDst (re-run with -Force to overwrite)."
} else {
    if (Test-Path $extDst) { Remove-Item -Path $extDst -Recurse -Force }
    New-Item -ItemType Directory -Path $extDst -Force | Out-Null
    Copy-Item -Path (Join-Path $extSrc "*") -Destination $extDst -Recurse -Force
    Write-Host "[OK] session-pins extension installed to $extDst"
}

Write-Host ""
Write-Host "Next steps:"
Write-Host "  1. Enable experimental mode so Copilot loads extensions:"
Write-Host "       launch with  copilot --experimental   (or run  /experimental  inside Copilot),"
Write-Host "       then restart your Copilot CLI session so the extension loads at startup."
Write-Host "  2. Try:   /pin add Remember to run tests before committing."
Write-Host "  3. Or ask Copilot:  Create a notes.md and pin it."
Write-Host ""
