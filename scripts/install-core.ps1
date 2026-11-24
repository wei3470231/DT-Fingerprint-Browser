param(
  [Parameter(Mandatory = $true)][string]$Root,
  [Parameter(Mandatory = $true)][ValidateSet('electron', 'chromium')][string]$Core,
  [switch]$ReportProgress
)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)

function Get-Sha256([string]$Path) {
  $file = [IO.File]::OpenRead($Path)
  $sha = [Security.Cryptography.SHA256]::Create()
  try { return [BitConverter]::ToString($sha.ComputeHash($file)).Replace('-', '') }
  finally { $sha.Dispose(); $file.Dispose() }
}
$rootPath = [IO.Path]::GetFullPath($Root)
$manifest = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'cores.json') -Raw | ConvertFrom-Json
$asset = $manifest.$Core

function Report-Progress([string]$Phase, [long]$Bytes = 0) {
  if ($ReportProgress) {
    [Console]::WriteLine("DT_CORE_PROGRESS $Phase $Bytes $($asset.size)")
  }
}

function Download-Archive([string]$Url, [string]$OutputPath) {
  $curlArgs = @('--fail', '--location', '--silent', '--show-error', '--retry', '2',
    '--connect-timeout', '20', '--max-time', '600', '--proto', '=https', '--proto-redir', '=https',
    '--output', ('"' + $OutputPath + '"'), $Url)
  $start = New-Object System.Diagnostics.ProcessStartInfo
  $start.FileName = 'curl.exe'
  $start.Arguments = $curlArgs -join ' '
  $start.UseShellExecute = $false
  $start.CreateNoWindow = $true
  $start.RedirectStandardError = $true
  $curl = [Diagnostics.Process]::Start($start)
  try {
    $details = $curl.StandardError.ReadToEndAsync()
    do {
      $file = Get-Item -LiteralPath $OutputPath -ErrorAction SilentlyContinue
      Report-Progress 'download' $file.Length
    } until ($curl.WaitForExit(350))
    $curl.WaitForExit()
    if ($curl.ExitCode -ne 0) {
      throw "GitHub download failed for $($asset.archive) (exit $($curl.ExitCode)). $($details.GetAwaiter().GetResult())"
    }
    Report-Progress 'download' $asset.size
  } finally {
    $curl.Dispose()
  }
}

$runtime = Join-Path $rootPath 'runtime'
$cores = Join-Path $runtime 'cores'
$destination = Join-Path $cores $Core
$installed = Join-Path $destination $asset.executable
$legacyElectron = Join-Path $runtime 'electron.exe'

$resources = Join-Path $runtime 'resources'
$canLaunchRootApp = ![IO.File]::Exists((Join-Path $rootPath 'app.asar')) -or (
  [IO.File]::Exists((Join-Path $resources 'default_app.asar')) -and
  ![IO.File]::Exists((Join-Path $resources 'app.asar')) -and ![IO.Directory]::Exists((Join-Path $resources 'app'))
)
if ($Core -eq 'electron' -and [IO.File]::Exists($legacyElectron) -and $canLaunchRootApp) {
  Write-Output $legacyElectron
  exit 0
}
if ([IO.File]::Exists($installed)) {
  Write-Output $installed
  exit 0
}

Report-Progress 'checking'
[void][IO.Directory]::CreateDirectory($cores)
$lockPath = Join-Path $cores "$Core.lock"
$deadline = [DateTime]::UtcNow.AddMinutes(25)
$lock = $null
while (!$lock) {
  try {
    $lock = [IO.File]::Open($lockPath, 'OpenOrCreate', 'ReadWrite', 'None')
  } catch [IO.IOException] {
    if ([DateTime]::UtcNow -ge $deadline) { throw "Timed out waiting to install $Core." }
    Start-Sleep -Milliseconds 300
  }
}

$stage = Join-Path $cores ('.' + $Core + '-' + [guid]::NewGuid().ToString('N'))
try {
  if ([IO.File]::Exists($installed)) {
    Write-Output $installed
    exit 0
  }

  [void][IO.Directory]::CreateDirectory($stage)
  $localZip = Join-Path $rootPath $asset.archive
  $zip = Join-Path $stage $asset.archive
  $verified = $false
  if ([IO.File]::Exists($localZip)) {
    Report-Progress 'checking'
    [IO.File]::Copy($localZip, $zip)
    $verified = (Get-Sha256 $zip) -ieq $asset.sha256
  }
  if (!$verified) {
    $url = 'https://github.com/wei3470231/DT-Fingerprint-Browser/releases/download/core/' + $asset.archive
    Download-Archive $url $zip
    Report-Progress 'checking'
    if ((Get-Sha256 $zip) -ine $asset.sha256) {
      throw "SHA-256 verification failed for $($asset.archive)."
    }
  }

  Report-Progress 'extracting'
  Add-Type -AssemblyName System.IO.Compression.FileSystem
  $extracted = Join-Path $stage 'extracted'
  [IO.Compression.ZipFile]::ExtractToDirectory($zip, $extracted)
  $directories = @($extracted) + @(Get-ChildItem -LiteralPath $extracted -Directory | Select-Object -ExpandProperty FullName)
  $matches = @($directories | Where-Object { [IO.File]::Exists((Join-Path $_ $asset.executable)) })
  if ($matches.Count -ne 1) { throw "Unexpected executable layout in $($asset.archive)." }

  if ([IO.Directory]::Exists($destination)) {
    [IO.Directory]::Move($destination, (Join-Path $cores ('.incomplete-' + [guid]::NewGuid().ToString('N'))))
  }
  [IO.Directory]::Move($matches[0], $destination)
  Write-Output $installed
} finally {
  try {
    if ([IO.Directory]::Exists($stage)) { [IO.Directory]::Delete($stage, $true) }
  } finally {
    $lock.Dispose()
  }
}
