# 双击根目录“启动多标签浏览器.cmd”调用；不需要 Node.js。运行时定位顺序与 scripts/runtime-path.js 相同。
$ErrorActionPreference = 'Stop'
$appDir = $PSScriptRoot
$projectDir = (Resolve-Path (Join-Path $appDir '..\..\..')).Path
$electron = $env:FP_DEMO_ELECTRON
if (-not $electron) {
    $runtimeConfig = Join-Path $projectDir 'runtime\current.json'
    $localConfig = Join-Path $projectDir '.fp-local.json'
    if (Test-Path -LiteralPath $runtimeConfig) {
        $electron = (Get-Content -LiteralPath $runtimeConfig -Raw -Encoding UTF8 | ConvertFrom-Json).executable
    }
    if (-not $electron -and (Test-Path -LiteralPath $localConfig)) {
        $electron = (Get-Content -LiteralPath $localConfig -Raw -Encoding UTF8 | ConvertFrom-Json).electron
    }
    if (-not $electron) { $electron = 'runtime\electron.exe' }
}
if (-not [System.IO.Path]::IsPathRooted($electron)) { $electron = Join-Path $projectDir $electron }
try {
    if (-not (Test-Path -LiteralPath $electron -PathType Leaf)) {
        throw "Custom Electron not found: $electron. Set FP_DEMO_ELECTRON to your custom electron.exe."
    }
    Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
    Start-Process -FilePath $electron -ArgumentList ('"' + $appDir + '"') -WorkingDirectory $appDir | Out-Null
} catch {
    Add-Type -AssemblyName System.Windows.Forms
    [System.Windows.Forms.MessageBox]::Show($_.Exception.Message, 'FP Tab Browser - Startup error') | Out-Null
    exit 1
}
