param(
    [string]$Setup = (Join-Path $PSScriptRoot '..\dist\DT-Fingerprint-Browser-v3.1-Full-Setup.exe'),
    [string]$Previous = (Join-Path $PSScriptRoot '..\dist\DT-Fingerprint-Browser-v2.7-Setup.exe')
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.IO.Compression,System.IO.Compression.FileSystem
$sandboxId = [Guid]::NewGuid().ToString('N')
$testDir = Join-Path ([IO.Path]::GetTempPath()) ('dt-installer-test-' + $sandboxId)
$registryName = 'Software\DT-Installer-Test-' + $sandboxId
$null = [IO.Directory]::CreateDirectory($testDir)
$flags = [Reflection.BindingFlags]'Static,NonPublic'

function Assert-Equal($actual, $expected, [string]$description) {
    if ($actual -cne $expected) { throw "$description (expected '$expected', got '$actual')" }
}

function Invoke-Static([Reflection.MethodInfo]$method, [object[]]$arguments) {
    $values = [object[]]::new($arguments.Length)
    for ($i = 0; $i -lt $arguments.Length; $i++) {
        if ($null -ne $arguments[$i]) { $values[$i] = $arguments[$i].PSObject.BaseObject }
    }
    try { $method.Invoke($null, $values) }
    catch {
        $exception = $_.Exception
        while ($exception.InnerException) { $exception = $exception.InnerException }
        throw $exception
    }
}

function Use-Payload($assembly, [scriptblock]$action) {
    $resource = $assembly.GetManifestResourceStream('payload.zip')
    if (!$resource) { throw "No installer payload in $($assembly.Location)" }
    $zip = [IO.Compression.ZipArchive]::new($resource, [IO.Compression.ZipArchiveMode]::Read)
    try { & $action $zip } finally { $zip.Dispose() }
}

function Write-Fixture([string]$file, [string]$value) {
    $null = [IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($file))
    [IO.File]::WriteAllText($file, $value)
}

function New-TestShortcut($shell, [string]$file, [string]$target) {
    $shortcut = $shell.CreateShortcut($file)
    $shortcut.TargetPath = $target
    $shortcut.Save()
}

$key = $null
$helperPath = $null
$maintenance = $null
try {
    $install = Join-Path $testDir 'Existing DT & Browser'
    $null = [IO.Directory]::CreateDirectory($install)
    $oldAssembly = [Reflection.Assembly]::LoadFile((Resolve-Path -LiteralPath $Previous).Path)
    Use-Payload $oldAssembly { param($zip) [IO.Compression.ZipFileExtensions]::ExtractToDirectory($zip, $install) }
    $data = Join-Path $install 'data'
    $fixture = @{
        'environments.json' = '[{"id":"env-existing","name":"Old environment","group":"Existing group","userDataDir":"data\\profiles\\env-existing","fp":{"uaString":"Existing fixture UA"}},{"id":"env-unlaunched","name":"Unlaunched legacy environment","group":"Existing group"}]'
        'environments.bak.json' = '[{"id":"env-archived","name":"Archived backup"}]'
        'settings.json' = '{"groups":["Existing group"],"autoStartSilent":true}'
        'settings.bak.json' = '{"groups":["Archived settings"]}'
        'bookmarks.json' = '[{"title":"Old bookmark","url":"https://example.test/"}]'
        'bookmarks.bak.json' = '[]'
        'profiles\env-existing\Preferences' = '{"fixture":true}'
        'profiles\env-existing\Network\Cookies' = 'fixture electron cookies'
        'profiles\chromium\env-other\Default\Local Storage\leveldb\CURRENT' = 'fixture chromium storage'
        'custom\index.bin' = 'fixture custom bytes'
    }
    foreach ($name in $fixture.Keys) { Write-Fixture (Join-Path $data $name) $fixture[$name] }
    $setupAssembly = [Reflection.Assembly]::LoadFile((Resolve-Path -LiteralPath $Setup).Path)
    $installer = $setupAssembly.GetType('BitFPManager.InstallerForm', $true)
    $maintenance = $setupAssembly.GetType('BitFPManager.InstallMaintenance', $true)
    $progress = [Action[int,int,string]]{ param($count, $total, $name) }
    $extract = $installer.GetMethod('ExtractPayload', $flags)
    Use-Payload $setupAssembly { param($zip) Invoke-Static $extract @($zip, $install, $progress) }
    foreach ($name in $fixture.Keys) {
        Assert-Equal ([IO.File]::ReadAllText((Join-Path $data $name))) $fixture[$name] "Installer preserves $name"
    }
    Invoke-Static ($installer.GetMethod('PreserveEmbeddedAppOnUpgrade', $flags)) @($install)
    Assert-Equal (Test-Path -LiteralPath (Join-Path $install 'app.asar')) $true 'v3 archive installed'
    $launcher = Join-Path $install 'DT-CLI.exe'
    $job = Start-Job -ArgumentList $launcher -ScriptBlock {
        param($executable)
        $json = & $executable list --json | Out-String
        if ($LASTEXITCODE -ne 0) { throw "Installed CLI exited with code $LASTEXITCODE" }
        $json
    }
    try {
        $response = Receive-Job $job -Wait -ErrorAction Stop | ConvertFrom-Json
    } finally { Remove-Job $job -Force }
    Assert-Equal $response.data[0].name 'Old environment' 'Upgraded CLI reads the old environment'
    Assert-Equal $response.data[0].browserCore 'electron' 'The existing Electron profile stays on Electron'
    Assert-Equal $response.data[1].browserCore 'electron' 'An unlaunched v2 environment stays on Electron'
    Assert-Equal $response.data[0].fp.uaString 'Existing fixture UA' 'Existing UA is preserved'
    Assert-Equal ([IO.File]::ReadAllText((Join-Path $data 'environments.bak.json'))) $fixture['environments.bak.json'] 'CLI migration preserves the previous recovery backup'
    Write-Output 'PASS actual installer payload overlays v2.7 and the upgraded CLI loads the saved environment'

    $other = Join-Path $testDir 'Other application'
    $roaming = Join-Path $testDir 'Roaming data'
    $cache = Join-Path $testDir 'Local app\runtime-cache\fixture-key'
    $roamingData = Join-Path $roaming 'data'
    $localEmpty = Join-Path $testDir 'Empty legacy install'
    $null = [IO.Directory]::CreateDirectory((Join-Path $localEmpty 'data\profiles'))
    Write-Fixture (Join-Path $roamingData 'environments.json') $fixture['environments.json']
    $useRoaming = $maintenance.GetMethod('UsesRoamingData', $flags)
    Assert-Equal (Invoke-Static $useRoaming @($localEmpty, $roamingData, $true)) $true 'Registered legacy roaming data is kept active'
    Assert-Equal (Invoke-Static $useRoaming @($install, $roamingData, $true)) $false 'Existing local data takes precedence'
    Assert-Equal (Invoke-Static $useRoaming @($localEmpty, $roamingData, $false)) $false 'An independent install does not claim roaming data'
    Write-Fixture (Join-Path $cache 'asset\chromium\chrome.exe') 'fixture cache'
    Write-Fixture (Join-Path $other 'untouched.txt') 'other app'

    $key = [Microsoft.Win32.Registry]::CurrentUser.CreateSubKey($registryName)
    $initialPath = '"C:\Existing path\";%DT_BROWSER_DIR%;' + $install.ToUpperInvariant() + '\;;C:\Other path '
    $key.SetValue('Path', $initialPath, [Microsoft.Win32.RegistryValueKind]::ExpandString)
    $key.SetValue('DT_BROWSER_DIR', $install)
    $key.SetValue('DT_CLI_PATH', $launcher)
    $key.SetValue('DTFingerprintBrowser', '"' + (Join-Path $install 'DT-Fingerprint-Browser.exe') + '" --minimized')
    $otherRun = '"' + (Join-Path $other 'electron.exe') + '"'
    $key.SetValue('electron.app.Electron', $otherRun)
    $configure = $maintenance.GetMethod('ConfigureEnvironment', $flags)
    Invoke-Static $configure @($key, $install, $true)
    $getRaw = [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames
    $otherPath = '"C:\Existing path\";;C:\Other path '
    Assert-Equal ($key.GetValue('Path', '', $getRaw)) ($otherPath + ';' + $install) 'PATH has one canonical install entry'

    $desktop = Join-Path $testDir 'Desktop'
    $programs = Join-Path $testDir 'Programs'
    $startMenu = Join-Path $programs ([string]::Concat('DT - ', [char]0x6307, [char]0x7EB9, [char]0x6D4F, [char]0x89C8, [char]0x5668))
    $null = [IO.Directory]::CreateDirectory($desktop)
    $null = [IO.Directory]::CreateDirectory($startMenu)
    $shell = New-Object -ComObject WScript.Shell
    $ownedLink = Join-Path $desktop 'DT-Fingerprint-Browser.lnk'
    $otherLink = Join-Path $startMenu 'Other application.lnk'
    New-TestShortcut $shell $ownedLink (Join-Path $install 'DT-Fingerprint-Browser.exe')
    New-TestShortcut $shell $otherLink (Join-Path $other 'electron.exe')

    $uninstall = Join-Path $install 'Uninstall.exe'
    $uninstaller = [Reflection.Assembly]::Load([IO.File]::ReadAllBytes($uninstall)).GetType('BitFPManager.UninstallerProgram', $true)
    $complete = $uninstaller.GetMethod('CompleteUninstall', $flags)
    $clear = [Action]{
        Invoke-Static $configure @($key, $install, $false)
        Invoke-Static ($maintenance.GetMethod('ClearOwnedAutoStart', $flags)) @($key, $install)
        Invoke-Static ($maintenance.GetMethod('ClearOwnedShortcuts', $flags)) @($install, $desktop, $programs)
    }
    Invoke-Static $complete @($install, $false, $roaming, $cache, $clear)
    Assert-Equal (Test-Path -LiteralPath $uninstall) $false 'Uninstaller removes itself'
    Assert-Equal (Test-Path -LiteralPath $cache) $false 'The installed core cache is removed'
    Assert-Equal (Test-Path -LiteralPath $roamingData) $true 'Keep-data uninstall preserves roaming data'
    Assert-Equal (Test-Path -LiteralPath (Join-Path $data 'profiles\env-existing\Network\Cookies')) $true 'Keep-data uninstall preserves the local profile'
    Assert-Equal ($key.GetValue('Path', '', $getRaw)) $otherPath 'Uninstall preserves unrelated raw PATH entries'
    Assert-Equal ($key.GetValueKind('Path')) ([Microsoft.Win32.RegistryValueKind]::ExpandString) 'PATH registry type is preserved'
    Assert-Equal ($key.GetValue('DT_BROWSER_DIR')) $null 'DT_BROWSER_DIR is removed'
    Assert-Equal ($key.GetValue('DT_CLI_PATH')) $null 'DT_CLI_PATH is removed'
    Assert-Equal ($key.GetValue('DTFingerprintBrowser')) $null 'Owned autorun is removed'
    Assert-Equal ($key.GetValue('electron.app.Electron')) $otherRun 'Unrelated autorun is preserved'
    Assert-Equal (Test-Path -LiteralPath $ownedLink) $false 'Owned shortcut is removed'
    Assert-Equal (Test-Path -LiteralPath $otherLink) $true 'Unrelated Start Menu shortcut is preserved'
    Write-Output 'PASS keep-data uninstall, PATH reconciliation, autorun and shortcut ownership'

    Write-Fixture $uninstall 'fixture uninstaller'
    Write-Fixture (Join-Path $cache 'asset\electron\electron.exe') 'fixture cache'
    $junction = Join-Path $install 'external-junction'
    $null = New-Item -ItemType Junction -Path $junction -Target $other
    Invoke-Static $complete @($install, $true, $roaming, $cache, $clear)
    Assert-Equal (Test-Path -LiteralPath $install) $false 'Full uninstall removes the installation root'
    Assert-Equal (Test-Path -LiteralPath $roaming) $false 'Full uninstall removes the app roaming root'
    Assert-Equal (Test-Path -LiteralPath $cache) $false 'Full uninstall removes the per-install core cache'
    Assert-Equal (Test-Path -LiteralPath (Join-Path $other 'untouched.txt')) $true 'Uninstall never follows a junction'
    Write-Output 'PASS full uninstall removes the install, roaming and cache directories'

    $id = [Guid]::NewGuid()
    $helperPath = Join-Path ([IO.Path]::GetTempPath()) ('DT-Uninstall-' + $id.ToString('N') + '.exe')
    $lock = [IO.File]::Open($helperPath, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
    try {
        Invoke-Static ($uninstaller.GetMethod('ScheduleHelperDeletion', $flags)) @($id)
        Start-Sleep -Milliseconds 300
        Assert-Equal (Test-Path -LiteralPath $helperPath) $true 'The worker is still in use'
    } finally { $lock.Dispose() }
    $until = [DateTime]::UtcNow.AddSeconds(10)
    while ((Test-Path -LiteralPath $helperPath) -and [DateTime]::UtcNow -lt $until) { Start-Sleep -Milliseconds 200 }
    Assert-Equal (Test-Path -LiteralPath $helperPath) $false 'The temporary worker is removed after it closes'
    Write-Output 'PASS detached worker cleanup waits for the executable to be released'
} finally {
    if ($key) {
        $key.Dispose()
        [Microsoft.Win32.Registry]::CurrentUser.DeleteSubKeyTree($registryName, $false)
    }
    if ($helperPath) { [IO.File]::Delete($helperPath) }
    if ($maintenance) {
        try {
            $cleanup = [Action]{ Invoke-Static ($maintenance.GetMethod('DeleteTree', $flags)) @($testDir) }
            Invoke-Static ($maintenance.GetMethod('RetryFileOperation', $flags)) @($cleanup)
        } catch {
            Write-Warning "Fixture cleanup failed for $testDir. $($_.Exception.Message)"
        }
    }
}
