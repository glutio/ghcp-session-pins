# install.ps1 - copy the session-pins extension into the Copilot CLI extensions
# directory so the CLI loads it on next startup.
#
# Usage (from the plugin directory):
#   .\install.ps1
#
# Or from wherever a Copilot plugin marketplace installed the plugin, e.g.:
#   & "<copilot-home>\installed-plugins\<marketplace>\session-pins\install.ps1"
#
# Honors COPILOT_HOME: installs under "$env:COPILOT_HOME\extensions" when set,
# otherwise "$env:USERPROFILE\.copilot\extensions".

[Diagnostics.CodeAnalysis.SuppressMessageAttribute('PSAvoidUsingWriteHost', '', Justification = 'User-facing installer output; the machine-readable signal is the exit code, not stdout.')]
param(
    [switch]$Force
)

$ErrorActionPreference = "Stop"

$extSrc = Join-Path $PSScriptRoot "extension"

# Resolve the Copilot home: prefer COPILOT_HOME (the CLI's configurable home),
# otherwise ~/.copilot. Refuse if the result is empty or a filesystem/drive root
# so the recursive delete below can never target an unintended location.
if (-not [string]::IsNullOrWhiteSpace($env:COPILOT_HOME)) {
    $copilotRoot = $env:COPILOT_HOME.Trim()
    # Expand a leading ~ (e.g. ~\.copilot). PowerShell does not expand ~ stored in
    # an env var, so resolve it against the user's home to avoid writing (and later
    # deleting) under a literal ".\~\.copilot" relative to the current directory.
    if ($copilotRoot -eq '~' -or $copilotRoot -match '^~[\\/]') {
        $homeDir = if ($env:USERPROFILE) { $env:USERPROFILE } else { $HOME }
        $copilotRoot = if ($copilotRoot -eq '~') { $homeDir } else { Join-Path $homeDir $copilotRoot.Substring(2) }
    }
} elseif (-not [string]::IsNullOrWhiteSpace($env:USERPROFILE)) {
    $copilotRoot = Join-Path $env:USERPROFILE ".copilot"
} else {
    Write-Error "Refusing to install: neither COPILOT_HOME nor USERPROFILE is set."
    exit 1
}
$copilotRoot = $copilotRoot.TrimEnd('\', '/')
if ($copilotRoot -match '^[A-Za-z]:$' -or $copilotRoot -in @('', '\', '/')) {
    Write-Error "Refusing to install: resolved Copilot home '$copilotRoot' is a filesystem root."
    exit 1
}

$extDst = Join-Path $copilotRoot "extensions\session-pins"

if (-not (Test-Path $extSrc)) {
    Write-Error "Source folder not found: $extSrc"
    exit 1
}

# Decide what to do by comparing the plugin's extension against the installed copy:
#   - not a directory        -> fresh install
#   - identical contents     -> up to date, nothing to copy (unless -Force)
#   - contents differ (stale) -> update in place, no -Force needed
# This makes plugin updates apply automatically: the marketplace refreshes the plugin
# folder, and the next run of this script syncs the changed files into the extensions
# folder. -Force is only an explicit override to recopy identical content.
function Test-ExtensionUpToDate {
    param([string]$Source, [string]$Dest)
    if (-not (Test-Path -LiteralPath $Dest -PathType Container)) { return $false }
    $srcFiles = @(Get-ChildItem -LiteralPath $Source -Recurse -File)
    $dstFiles = @(Get-ChildItem -LiteralPath $Dest -Recurse -File)
    $srcRel = $srcFiles | ForEach-Object { $_.FullName.Substring($Source.Length).TrimStart('\', '/') } | Sort-Object
    $dstRel = $dstFiles | ForEach-Object { $_.FullName.Substring($Dest.Length).TrimStart('\', '/') } | Sort-Object
    if (($srcRel -join '|') -ne ($dstRel -join '|')) { return $false }
    foreach ($rel in $srcRel) {
        $sh = (Get-FileHash -LiteralPath (Join-Path $Source $rel) -Algorithm SHA256).Hash
        $dh = (Get-FileHash -LiteralPath (Join-Path $Dest   $rel) -Algorithm SHA256).Hash
        if ($sh -ne $dh) { return $false }
    }
    return $true
}

$dstIsDir = Test-Path -LiteralPath $extDst -PathType Container
$upToDate = Test-ExtensionUpToDate -Source $extSrc -Dest $extDst

if ($upToDate -and -not $Force) {
    $state = 'uptodate'
    Write-Host "session-pins is already installed and up to date at $extDst."
} else {
    $state = if ($dstIsDir) { 'updated' } else { 'installed' }
    if (Test-Path -LiteralPath $extDst) { Remove-Item -LiteralPath $extDst -Recurse -Force }
    New-Item -ItemType Directory -Path $extDst -Force | Out-Null
    Copy-Item -Path (Join-Path $extSrc "*") -Destination $extDst -Recurse -Force
    if ($state -eq 'updated') {
        Write-Host "[OK] session-pins extension updated to the current version at $extDst"
    } else {
        Write-Host "[OK] session-pins extension installed to $extDst"
    }
}

Write-Host ""
switch ($state) {
    'uptodate' {
        Write-Host "Nothing to do — the installed extension already matches this plugin."
        Write-Host "If /pin isn't available, relaunch with  copilot --experimental  (extensions only load in experimental mode)."
    }
    'updated' {
        Write-Host "Next step: restart Copilot (relaunch with  copilot --experimental ) so the updated extension loads."
    }
    default {
        Write-Host "Next step: relaunch with  copilot --experimental  (or run  /experimental  and restart)"
        Write-Host "so Copilot loads the extension at startup."
    }
}
Write-Host ""
Write-Host "Usage once active:"
Write-Host "  /pin                       open the pinboard (browse / add / edit / enable / delete)"
Write-Host "  /pin add <text>            pin an instruction"
Write-Host "  /pin add @<path>           pin a live file"
Write-Host '  Or just ask Copilot:  "Pin the rule that ..."  /  "Pin @notes.md"  /  "What''s pinned?"'
Write-Host ""