using System;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;

namespace BitFPManager
{
    class Program
    {
        [DllImport("kernel32.dll")]
        static extern bool AttachConsole(int dwProcessId);
        private const int ATTACH_PARENT_PROCESS = -1;

        [DllImport("user32.dll", SetLastError = true)]
        static extern IntPtr FindWindow(string lpClassName, string lpWindowName);

        [DllImport("user32.dll")]
        [return: MarshalAs(UnmanagedType.Bool)]
        static extern bool SetForegroundWindow(IntPtr hWnd);

        [DllImport("user32.dll")]
        [return: MarshalAs(UnmanagedType.Bool)]
        static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
        private const int SW_SHOW = 5;
        private const int SW_RESTORE = 9;

        static void Main(string[] args)
        {
            string rootDir = AppDomain.CurrentDomain.BaseDirectory;
            string electronExe = Path.Combine(rootDir, "runtime", "electron.exe");
            string asarPath = Path.Combine(rootDir, "runtime", "resources", "app.asar");
            string guiScript = Path.Combine(rootDir, "src", "gui", "main.js");
            string cliScript = Path.Combine(rootDir, "cli.js");

            bool isAsarMode = File.Exists(asarPath) && !File.Exists(guiScript);

            if (!File.Exists(electronExe))
            {
                AttachConsole(ATTACH_PARENT_PROCESS);
                Console.WriteLine("【错误】未找到定制内核: " + electronExe);
                return;
            }

            // 格式化命令行参数
            string formattedArgs = "";
            foreach (string a in args)
            {
                if (a.Contains(" ") || a.Contains(";"))
                {
                    formattedArgs += " \"" + a.Replace("\"", "\\\"") + "\"";
                }
                else
                {
                    formattedArgs += " " + a;
                }
            }

            // 获取当前可执行文件名 (例如 DT - 指纹浏览器.exe 或 DT-CLI.exe)
            string exeName = "";
            try
            {
                exeName = Path.GetFileName(Process.GetCurrentProcess().MainModule.FileName);
            }
            catch
            {
                exeName = AppDomain.CurrentDomain.FriendlyName;
            }

            // 1. 若当前可执行程序名称明确包含 "CLI" (如 DT-CLI.exe, dt-cli.exe)，则作为 CLI 模式运行
            bool isCliExe = !string.IsNullOrEmpty(exeName) && 
                exeName.IndexOf("CLI", StringComparison.OrdinalIgnoreCase) >= 0;

            // 2. 检查是否传入显式 GUI 管理器开关 (如开机自启传入的 --minimized, --silent, --hidden, --autostart, --gui)
            bool isExplicitGuiFlag = false;
            foreach (string a in args)
            {
                string lower = a.ToLowerInvariant();
                if (lower == "--minimized" || lower == "--silent" || lower == "--hidden" || 
                    lower == "--autostart" || lower == "--gui" || lower == "gui" || lower == "manager")
                {
                    isExplicitGuiFlag = true;
                    break;
                }
            }

            // 3. 检查首个参数是否明确为已知 CLI 命令
            string firstArg = args.Length > 0 ? args[0].ToLowerInvariant() : "";
            bool isKnownCliCommand = firstArg == "list" || firstArg == "start" || firstArg == "open" ||
                firstArg == "stop" || firstArg == "close" || firstArg == "status" ||
                firstArg == "cdp-url" || firstArg == "random-fp" || firstArg == "batch-random-fp" ||
                firstArg == "set-proxy" || firstArg == "test-proxy" || firstArg == "set-ext" ||
                firstArg == "create" || firstArg == "update" || firstArg == "edit" ||
                firstArg == "get" || firstArg == "info" || firstArg == "clone" || firstArg == "delete" ||
                firstArg == "clear-cache" || firstArg == "clean-cache" ||
                firstArg == "group" || firstArg == "set-group" ||
                firstArg == "batch-set-group" || firstArg == "batch-delete" ||
                firstArg == "bookmark" || firstArg == "bookmarks" ||
                firstArg == "font" || firstArg == "fonts" ||
                firstArg == "theme" || firstArg == "themes" ||
                firstArg == "settings" || firstArg == "setting" ||
                firstArg == "env" || firstArg == "autostart" || firstArg == "compile" || firstArg == "build-exe" ||
                firstArg.StartsWith("--remote-debugging-port") ||
                firstArg == "help" || firstArg == "--help" || firstArg == "-h" ||
                firstArg == "--version" || firstArg == "-v";

            // 判断模式：
            // - 凡携带 --minimized 等 GUI 开关，绝不可进入 CLI，强制执行 GUI 管理器；
            // - 否则若是 CLI 程序或者首参数为明确的 CLI 命令，进入 CLI 模式；
            // - 其余情况 (无参数、或常规双击运行) 均启动 GUI 管理器。
            bool isCli = !isExplicitGuiFlag && (isCliExe || isKnownCliCommand);

            if (isCli)
            {
                if (AttachConsole(ATTACH_PARENT_PROCESS))
                {
                    try
                    {
                        Console.OutputEncoding = System.Text.Encoding.UTF8;
                        var stdOut = new StreamWriter(Console.OpenStandardOutput(), System.Text.Encoding.UTF8) { AutoFlush = true };
                        Console.SetOut(stdOut);
                        var stdErr = new StreamWriter(Console.OpenStandardError(), System.Text.Encoding.UTF8) { AutoFlush = true };
                        Console.SetError(stdErr);
                    }
                    catch {}
                }
                else
                {
                    try { Console.OutputEncoding = System.Text.Encoding.UTF8; } catch {}
                }

                // 运行 CLI 模式，通过 node 或 electron 运行 cli.js
                string targetScript = isAsarMode ? Path.Combine(asarPath, "cli.js") : cliScript;

                ProcessStartInfo cliPsi = new ProcessStartInfo();
                cliPsi.WorkingDirectory = rootDir;
                cliPsi.UseShellExecute = false;
                cliPsi.RedirectStandardOutput = true;
                cliPsi.RedirectStandardError = true;
                cliPsi.StandardOutputEncoding = System.Text.Encoding.UTF8;
                cliPsi.StandardErrorEncoding = System.Text.Encoding.UTF8;
                cliPsi.EnvironmentVariables["DT_APP_ROOT"] = rootDir;

                if (!isAsarMode)
                {
                    // 开发模式：优先尝试系统 node.exe
                    cliPsi.FileName = "node.exe";
                    cliPsi.Arguments = "\"" + targetScript + "\"" + formattedArgs;
                    try
                    {
                        using (Process proc = Process.Start(cliPsi))
                        {
                            proc.OutputDataReceived += (s, e) => { if (e.Data != null) Console.WriteLine(e.Data); };
                            proc.ErrorDataReceived += (s, e) => { if (e.Data != null) Console.Error.WriteLine(e.Data); };
                            proc.BeginOutputReadLine();
                            proc.BeginErrorReadLine();
                            proc.WaitForExit();
                            Environment.ExitCode = proc.ExitCode;
                            return;
                        }
                    }
                    catch (Exception)
                    {
                        // 回退到 electron
                    }
                }

                // 发行模式或无系统 node：使用定制 electron 的 Node 模式
                cliPsi.FileName = electronExe;
                cliPsi.EnvironmentVariables["ELECTRON_RUN_AS_NODE"] = "1";
                cliPsi.Arguments = "\"" + targetScript + "\"" + formattedArgs;

                try
                {
                    using (Process proc = Process.Start(cliPsi))
                    {
                        proc.OutputDataReceived += (s, e) => { if (e.Data != null) Console.WriteLine(e.Data); };
                        proc.ErrorDataReceived += (s, e) => { if (e.Data != null) Console.Error.WriteLine(e.Data); };
                        proc.BeginOutputReadLine();
                        proc.BeginErrorReadLine();
                        proc.WaitForExit();
                        Environment.ExitCode = proc.ExitCode;
                    }
                }
                catch (Exception ex)
                {
                    Console.Error.WriteLine("CLI 启动失败: " + ex.Message);
                    Environment.ExitCode = 1;
                }
            }
            else
            {
                // GUI 模式单例互斥：若已有管理器窗口打开，直接置顶并退出，不允许多开
                IntPtr existingWnd = FindWindow(null, "DT - 指纹浏览器");
                if (existingWnd != IntPtr.Zero)
                {
                    ShowWindow(existingWnd, SW_SHOW);
                    ShowWindow(existingWnd, SW_RESTORE);
                    SetForegroundWindow(existingWnd);
                    return;
                }

                ProcessStartInfo psi = new ProcessStartInfo();
                psi.FileName = electronExe;
                psi.WorkingDirectory = rootDir;
                psi.EnvironmentVariables.Remove("ELECTRON_RUN_AS_NODE");
                psi.EnvironmentVariables["DT_APP_ROOT"] = rootDir;
                psi.UseShellExecute = false;
                psi.CreateNoWindow = true;

                // GUI 模式：无黑框后台拉起管理器
                if (isAsarMode)
                {
                    // 在发行版中：electron 启动时自动载入 runtime/resources/app.asar
                    // 传递命令行参数 (例如 --minimized)，以便 Electron / src/gui/main.js 能读取到参数！
                    psi.Arguments = formattedArgs.TrimStart();
                }
                else
                {
                    // 在开发环境中：直接载入 src/gui/main.js，并追加命令行参数
                    psi.Arguments = "\"" + guiScript + "\"" + formattedArgs;
                }

                Process.Start(psi);
            }
        }
    }
}
