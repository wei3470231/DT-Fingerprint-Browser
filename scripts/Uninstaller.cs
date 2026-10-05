using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Windows.Forms;
using Microsoft.Win32;

namespace BitFPManager
{
    static class UninstallerProgram
    {
        [STAThread]
        static void Main()
        {
            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);

            string installDir = AppDomain.CurrentDomain.BaseDirectory.TrimEnd('\\');

            DialogResult confirm = MessageBox.Show(
                "您确定要从当前计算机中彻底卸载 DT - 指纹浏览器 吗？",
                "DT - 指纹浏览器 卸载向导",
                MessageBoxButtons.YesNo,
                MessageBoxIcon.Question);

            if (confirm != DialogResult.Yes) return;

            try
            {
                // 1. 尝试关闭所有正在运行的实例
                try
                {
                    Process[] procs = Process.GetProcessesByName("DT - 指纹浏览器");
                    foreach (var p in procs) { try { p.Kill(); } catch {} }
                    Process[] enProcs = Process.GetProcessesByName("DT-Fingerprint-Browser");
                    foreach (var p in enProcs) { try { p.Kill(); } catch {} }
                    Process[] cliProcs = Process.GetProcessesByName("DT-CLI");
                    foreach (var p in cliProcs) { try { p.Kill(); } catch {} }
                }
                catch {}

                // 2. 移除快捷方式
                string desktop = Environment.GetFolderPath(Environment.SpecialFolder.DesktopDirectory);
                string desktopLnk = Path.Combine(desktop, "DT - 指纹浏览器.lnk");
                if (File.Exists(desktopLnk))
                {
                    try { File.Delete(desktopLnk); } catch {}
                }
                string desktopEnLnk = Path.Combine(desktop, "DT-Fingerprint-Browser.lnk");
                if (File.Exists(desktopEnLnk))
                {
                    try { File.Delete(desktopEnLnk); } catch {}
                }

                string startMenu = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.Programs), "DT - 指纹浏览器");
                if (Directory.Exists(startMenu))
                {
                    try { Directory.Delete(startMenu, true); } catch {}
                }

                // 3. 从系统用户 PATH 环境变量中移除 (统一使用 CMD / reg.exe 核心规范)
                try
                {
                    string currentPath = Environment.GetEnvironmentVariable("Path", EnvironmentVariableTarget.User) ?? "";
                    string[] parts = currentPath.Split(new char[] { ';' }, StringSplitOptions.RemoveEmptyEntries);
                    List<string> remaining = new List<string>();
                    string normInstall = (installDir ?? "").Trim().TrimEnd('\\');
                    foreach (string part in parts)
                    {
                        if (!string.Equals(part.Trim().TrimEnd('\\'), normInstall, StringComparison.OrdinalIgnoreCase))
                        {
                            remaining.Add(part.Trim());
                        }
                    }
                    string remainingPath = string.Join(";", remaining.ToArray());
                    try { Environment.SetEnvironmentVariable("Path", remainingPath, EnvironmentVariableTarget.User); } catch {}
                    try
                    {
                        ProcessStartInfo regPsi = new ProcessStartInfo("reg.exe", "add \"HKCU\\Environment\" /v Path /t REG_EXPAND_SZ /d \"" + remainingPath + "\" /f");
                        regPsi.CreateNoWindow = true;
                        regPsi.UseShellExecute = false;
                        using (Process p = Process.Start(regPsi)) { if (p != null) p.WaitForExit(3000); }
                    }
                    catch {}
                    try
                    {
                        ProcessStartInfo psi1 = new ProcessStartInfo("reg.exe", "delete \"HKCU\\Environment\" /v DT_BROWSER_DIR /f");
                        psi1.CreateNoWindow = true;
                        psi1.UseShellExecute = false;
                        using (Process p = Process.Start(psi1)) { if (p != null) p.WaitForExit(3000); }
                    }
                    catch {}
                    try
                    {
                        ProcessStartInfo psi2 = new ProcessStartInfo("reg.exe", "delete \"HKCU\\Environment\" /v DT_CLI_PATH /f");
                        psi2.CreateNoWindow = true;
                        psi2.UseShellExecute = false;
                        using (Process p = Process.Start(psi2)) { if (p != null) p.WaitForExit(3000); }
                    }
                    catch {}
                }
                catch {}

                // 4. 从注册表移除开机自启
                try
                {
                    using (RegistryKey key = Registry.CurrentUser.OpenSubKey(@"Software\Microsoft\Windows\CurrentVersion\Run", true))
                    {
                        if (key != null)
                        {
                            if (key.GetValue("DTFingerprintBrowser") != null)
                                key.DeleteValue("DTFingerprintBrowser", false);
                            if (key.GetValue("electron.app.Electron") != null)
                                key.DeleteValue("electron.app.Electron", false);
                        }
                    }
                }
                catch {}

                // 5. 移除控制面板卸载项
                try
                {
                    Registry.CurrentUser.DeleteSubKeyTree(@"Software\Microsoft\Windows\CurrentVersion\Uninstall\DT-Fingerprint-Browser", false);
                }
                catch {}

                // 6. 询问是否删除用户数据目录 (data/)
                bool deleteUserData = true;
                string dataDir = Path.Combine(installDir, "data");
                if (Directory.Exists(dataDir))
                {
                    DialogResult resData = MessageBox.Show(
                        "是否同时删除保存的环境配置及 Cookie 缓存数据？\n\n- 点击【是】：彻底清除全部本地数据\n- 点击【否】：保留 data 目录数据，以便日后重新安装时恢复使用",
                        "清理用户数据",
                        MessageBoxButtons.YesNo,
                        MessageBoxIcon.Question);
                    deleteUserData = (resData == DialogResult.Yes);
                }

                // 7. 调度自删除命令并退出
                string cmdArgs;
                if (deleteUserData)
                {
                    cmdArgs = string.Format("/c timeout /t 1 /nobreak >nul & rd /s /q \"{0}\"", installDir);
                }
                else
                {
                    // 仅删除除 data 以外的文件
                    cmdArgs = string.Format("/c timeout /t 1 /nobreak >nul & for /d %i in (\"{0}\\*\") do (if /i not \"%~nxi\"==\"data\" rd /s /q \"%i\") & for %i in (\"{0}\\*\") do (del /f /q \"%i\")", installDir);
                }

                ProcessStartInfo psi = new ProcessStartInfo("cmd.exe", cmdArgs)
                {
                    CreateNoWindow = true,
                    UseShellExecute = false
                };
                Process.Start(psi);

                MessageBox.Show(
                    "DT - 指纹浏览器 已成功从您的计算机卸载！",
                    "卸载完成",
                    MessageBoxButtons.OK,
                    MessageBoxIcon.Information);
            }
            catch (Exception ex)
            {
                MessageBox.Show("卸载过程中发生错误: " + ex.Message, "错误", MessageBoxButtons.OK, MessageBoxIcon.Error);
            }
        }
    }
}
