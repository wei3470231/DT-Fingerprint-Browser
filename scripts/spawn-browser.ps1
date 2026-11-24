$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = [Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$launch = [Console]::In.ReadToEnd() | ConvertFrom-Json

# A detached Windows browser must not inherit the native CLI's redirected output handles.
Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Text;

public static class BrowserProcess
{
    [StructLayout(LayoutKind.Sequential)]
    private struct StartupInfo
    {
        public int size;
        public IntPtr reserved, desktop, title;
        public int x, y, width, height, columns, rows, fill, flags;
        public short show, reservedSize;
        public IntPtr reservedData, stdin, stdout, stderr;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct ProcessInfo
    {
        public IntPtr process, thread;
        public int pid, threadId;
    }

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool CreateProcess(string executable, StringBuilder commandLine,
        IntPtr processAttributes, IntPtr threadAttributes, bool inheritHandles, uint flags,
        IntPtr environment, string cwd, ref StartupInfo startup, out ProcessInfo process);

    [DllImport("kernel32.dll")]
    private static extern bool CloseHandle(IntPtr handle);

    private static void AppendQuoted(StringBuilder command, string argument)
    {
        command.Append('"');
        int backslashes = 0;
        foreach (char ch in argument)
        {
            if (ch == '\\')
            {
                backslashes++;
                continue;
            }
            command.Append('\\', ch == '"' ? backslashes * 2 + 1 : backslashes);
            command.Append(ch);
            backslashes = 0;
        }
        command.Append('\\', backslashes * 2).Append('"');
    }

    private static StringBuilder BuildCommand(string executable, string[] args)
    {
        var command = new StringBuilder();
        AppendQuoted(command, executable);
        foreach (string arg in args)
        {
            command.Append(' ');
            AppendQuoted(command, arg);
        }
        return command;
    }

    public static string FormatCommand(string executable, string[] args)
    {
        return BuildCommand(executable, args).ToString();
    }

    public static int Start(string executable, string[] args, string cwd)
    {
        var command = BuildCommand(executable, args);
        var startup = new StartupInfo { size = Marshal.SizeOf(typeof(StartupInfo)) };
        ProcessInfo process;
        const uint detached = 0x00000008;
        const uint newProcessGroup = 0x00000200;
        if (!CreateProcess(executable, command, IntPtr.Zero, IntPtr.Zero, false,
            detached | newProcessGroup, IntPtr.Zero, cwd, ref startup, out process))
        {
            throw new Win32Exception(Marshal.GetLastWin32Error());
        }
        CloseHandle(process.thread);
        CloseHandle(process.process);
        return process.pid;
    }
}
'@

$browserPid = [BrowserProcess]::Start($launch.executable, [string[]]$launch.args, $launch.cwd)
if ($launch.branding) {
    try {
        $brand = $launch.branding
        $relaunch = ''
        if ($brand.relaunch) {
            $relaunch = [BrowserProcess]::FormatCommand($brand.relaunch[0], [string[]]$brand.relaunch[1..($brand.relaunch.Count - 1)])
        }
        $iconArgs = [string[]]@($browserPid, $brand.icon, $brand.appId, $relaunch, $brand.displayName)
        $helper = Join-Path $PSScriptRoot 'ChromiumWindowIcon.exe'
        if ([IO.File]::Exists($helper)) {
            [void][BrowserProcess]::Start($helper, $iconArgs, $launch.cwd)
        } else {
            $watch = Join-Path $PSScriptRoot 'watch-chromium-icon.ps1'
            if ([IO.File]::Exists($watch)) {
                $watchArgs = @('-NoProfile', '-NonInteractive', '-Sta', '-ExecutionPolicy', 'Bypass', '-File', $watch) + $iconArgs
                [void][BrowserProcess]::Start((Join-Path $PSHOME 'powershell.exe'), [string[]]$watchArgs, $launch.cwd)
            }
        }
    } catch {
        [Console]::Error.WriteLine($_.Exception.Message)
    }
}
[Console]::WriteLine($browserPid)
