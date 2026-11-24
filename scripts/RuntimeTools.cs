using System;
using System.ComponentModel;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Web.Script.Serialization;

internal static class RuntimeTools
{
    public sealed class Launch
    {
        public string executable { get; set; }
        public string[] args { get; set; }
        public string cwd { get; set; }
        public Branding branding { get; set; }
    }

    public sealed class Branding
    {
        public string icon { get; set; }
        public string appId { get; set; }
        public string[] relaunch { get; set; }
        public string displayName { get; set; }
    }

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

    private static int Start(string executable, string[] args, string cwd)
    {
        var startup = new StartupInfo { size = Marshal.SizeOf(typeof(StartupInfo)) };
        ProcessInfo process;
        const uint detached = 0x00000008;
        const uint newProcessGroup = 0x00000200;
        // Keep the CLI's redirected pipes out of the long-lived browser process.
        if (!CreateProcess(executable, BuildCommand(executable, args), IntPtr.Zero, IntPtr.Zero, false,
            detached | newProcessGroup, IntPtr.Zero, cwd, ref startup, out process))
        {
            int error = Marshal.GetLastWin32Error();
            throw new Win32Exception(error, "Cannot start " + Path.GetFileName(executable) +
                ": " + new Win32Exception(error).Message);
        }
        CloseHandle(process.thread);
        CloseHandle(process.process);
        return process.pid;
    }

    private static int SpawnBrowser(Launch launch)
    {
        int pid = Start(launch.executable, launch.args, launch.cwd);
        if (launch.branding != null)
        {
            try
            {
                var branding = launch.branding;
                string helper = Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "ChromiumWindowIcon.exe");
                string relaunch = "";
                if (branding.relaunch != null && branding.relaunch.Length > 0)
                {
                    string[] args = new string[branding.relaunch.Length - 1];
                    Array.Copy(branding.relaunch, 1, args, 0, args.Length);
                    relaunch = BuildCommand(branding.relaunch[0], args).ToString();
                }
                Start(helper, new[] { pid.ToString(), branding.icon, branding.appId, relaunch, branding.displayName }, launch.cwd);
            }
            catch (Win32Exception error) { Console.Error.WriteLine(error.Message); }
        }
        return pid;
    }

    public static int Main(string[] args)
    {
        Console.InputEncoding = new UTF8Encoding(false);
        Console.OutputEncoding = new UTF8Encoding(false);
        try
        {
            if (args.Length == 1 && args[0] == "spawn")
            {
                Console.WriteLine(SpawnBrowser(new JavaScriptSerializer().Deserialize<Launch>(Console.In.ReadToEnd())));
            }
            else if (args.Length == 3 && args[0] == "install")
            {
                Console.WriteLine(RuntimeCoreInstaller.Install(args[1], args[2]));
            }
            else if (args.Length == 2 && args[0] == "close")
            {
                using (Process process = Process.GetProcessById(Int32.Parse(args[1]))) process.CloseMainWindow();
            }
            else return 2;
            return 0;
        }
        catch (Exception error)
        {
            Console.Error.WriteLine(error.Message);
            return 1;
        }
    }
}
