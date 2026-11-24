param(
    [string]$BrowserPid,
    [string]$IconPath,
    [string]$AppId,
    [AllowEmptyString()][string]$Relaunch,
    [string]$DisplayName
)

$ErrorActionPreference = 'Stop'
Add-Type -Path (Join-Path $PSScriptRoot 'ChromiumWindowIcon.cs')
[ChromiumWindowIcon]::Main([string[]]@($BrowserPid, $IconPath, $AppId, $Relaunch, $DisplayName))
