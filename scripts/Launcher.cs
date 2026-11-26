using System;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Windows.Forms;

[assembly: System.Reflection.AssemblyVersion("3.1.1.0")]
[assembly: System.Reflection.AssemblyFileVersion("3.1.1.0")]

namespace BitFPManager
{
    class Program
    {
        [DllImport("kernel32.dll")]
        static extern bool AttachConsole(int dwProcessId);
        private const int ATTACH_PARENT_PROCESS = -1;

        static string EnsureElectron(string rootDir, bool isCli)
        {
            string legacy = Path.Combine(rootDir, "runtime", "electron.exe");
            string resources = Path.Combine(rootDir, "runtime", "resources");
            bool canLaunchRootApp = !File.Exists(Path.Combine(rootDir, "app.asar")) ||
                (File.Exists(Path.Combine(resources, "default_app.asar")) &&
                 !File.Exists(Path.Combine(resources, "app.asar")) && !Directory.Exists(Path.Combine(resources, "app")));
            if (File.Exists(legacy) && canLaunchRootApp) return legacy;
            string installed = Path.Combine(rootDir, "runtime", "cores", "electron", "electron.exe");
            if (File.Exists(installed)) return installed;

            string helper = Path.Combine(rootDir, "scripts", "RuntimeTools.exe");
            bool hasHelper = File.Exists(helper);
            string arguments;
            if (hasHelper)
            {
                arguments = "install \"" + Path.Combine(rootDir, ".") + "\" electron";
            }
            else
            {
                string script = Path.Combine(rootDir, "scripts", "install-core.ps1");
                if (!File.Exists(script)) throw new FileNotFoundException(script);
                helper = Path.Combine(Environment.SystemDirectory, @"WindowsPowerShell\v1.0\powershell.exe");
                arguments = "-NoProfile -NonInteractive -ExecutionPolicy Bypass -File \"" + script +
                    "\" -Root \"" + Path.Combine(rootDir, ".") + "\" -Core electron";
            }
            ProcessStartInfo start = new ProcessStartInfo(helper, arguments);
            start.WorkingDirectory = rootDir;
            start.UseShellExecute = false;
            start.CreateNoWindow = true;
            start.RedirectStandardOutput = true;
            start.RedirectStandardError = true;
            start.StandardErrorEncoding = System.Text.Encoding.UTF8;
            start.StandardOutputEncoding = System.Text.Encoding.UTF8;

            using (Form progress = new Form())
            using (Process child = new Process())
            {
                child.StartInfo = start;
                var errors = new System.Text.StringBuilder();
                child.ErrorDataReceived += (sender, e) => { if (e.Data != null) errors.AppendLine(e.Data); };
                string resolved = null;
                child.OutputDataReceived += (sender, e) => { if (!String.IsNullOrEmpty(e.Data)) resolved = e.Data; };
                if (!isCli)
                {
                    progress.Text = "DT 指纹浏览器";
                    progress.Width = 400;
                    progress.Height = 120;
                    progress.StartPosition = FormStartPosition.CenterScreen;
                    progress.ControlBox = false;
                    progress.FormBorderStyle = FormBorderStyle.FixedDialog;
                    progress.Controls.Add(new ProgressBar { Dock = DockStyle.Bottom, Style = ProgressBarStyle.Marquee });
                    progress.Controls.Add(new Label { Dock = DockStyle.Fill, Padding = new Padding(16), Text = "正在准备 Electron 内核，首次下载约 191 MB。" });
                    progress.Show();
                }
                else
                {
                    Console.Error.WriteLine("正在准备 Electron 内核。");
                }
                child.Start();
                child.BeginErrorReadLine();
                child.BeginOutputReadLine();
                while (!child.WaitForExit(100)) { if (!isCli) Application.DoEvents(); }
                child.WaitForExit();
                if (hasHelper && !String.IsNullOrEmpty(resolved)) installed = resolved;
                if (child.ExitCode != 0 || !File.Exists(installed)) throw new Exception(errors.ToString().Trim());
            }
            return installed;
        }

        [STAThread]
        static void Main(string[] args)
        {
            string rootDir = AppDomain.CurrentDomain.BaseDirectory;
            string asarPath = Path.Combine(rootDir, "app.asar");
            if (!File.Exists(asarPath)) asarPath = Path.Combine(rootDir, "runtime", "resources", "app.asar");
            string guiScript = Path.Combine(rootDir, "src", "gui", "main.js");
            string cliScript = Path.Combine(rootDir, "cli.js");

            bool isAsarMode = File.Exists(asarPath) && !File.Exists(guiScript);

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

            string firstArg = args.Length > 0 ? args[0].ToLowerInvariant() : "";
            // 2. 根据首个参数识别 GUI 模式，保留 autostart --silent 等 CLI 命令的选项。
            bool isExplicitGuiFlag = firstArg == "--minimized" || firstArg == "--silent" || firstArg == "--hidden" ||
                firstArg == "--autostart" || firstArg == "--gui" || firstArg == "gui" || firstArg == "start-gui" || firstArg == "manager";

            // 3. 检查首个参数是否明确为已知 CLI 命令
            bool isKnownCliCommand = firstArg == "list" || firstArg == "start" || firstArg == "open" ||
                firstArg == "stop" || firstArg == "close" || firstArg == "status" ||
                firstArg == "cdp-url" || firstArg == "random-fp" || firstArg == "batch-random-fp" ||
                firstArg == "set-proxy" || firstArg == "test-proxy" || firstArg == "set-ext" ||
                firstArg == "set-rotating" || firstArg == "set-rotating-proxy" || firstArg == "set-dialogs" ||
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
                firstArg == "--version" || firstArg == "--product-version" || firstArg == "-v";

            // 显式 GUI 入口、CLI 入口、常规双击依次判定。
            bool isCli = !isExplicitGuiFlag && (isCliExe || isKnownCliCommand);
            string electronExe;
            try
            {
                electronExe = EnsureElectron(rootDir, isCli);
            }
            catch (Exception ex)
            {
                string message = "无法安装 Electron 内核。" + ex.Message;
                if (isCli)
                {
                    AttachConsole(ATTACH_PARENT_PROCESS);
                    Console.Error.WriteLine(message);
                }
                else
                {
                    MessageBox.Show(message, "DT 指纹浏览器", MessageBoxButtons.OK, MessageBoxIcon.Error);
                }
                Environment.ExitCode = 1;
                return;
            }

            if (isCli)
            {
                if (!Console.IsOutputRedirected && AttachConsole(ATTACH_PARENT_PROCESS))
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
                    psi.Arguments = "\"" + asarPath + "\"" + formattedArgs;
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
