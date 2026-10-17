using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Runtime.InteropServices;
using System.Windows.Forms;
using Microsoft.Win32;

namespace BitFPManager
{
    static class UninstallerProgram
    {
        [DllImport("user32.dll", SetLastError = true, CharSet = CharSet.Auto)]
        private static extern IntPtr SendMessageTimeout(
            IntPtr hWnd,
            uint Msg,
            UIntPtr wParam,
            string lParam,
            uint fuFlags,
            uint uTimeout,
            out UIntPtr lpdwResult);

        private const int HWND_BROADCAST = 0xffff;
        private const uint WM_SETTINGCHANGE = 0x001A;
        private const uint SMTO_ABORTIFHUNG = 0x0002;

        private static void BroadcastEnvironmentChange()
        {
            try
            {
                UIntPtr result;
                SendMessageTimeout((IntPtr)HWND_BROADCAST, WM_SETTINGCHANGE, UIntPtr.Zero, "Environment", SMTO_ABORTIFHUNG, 3000, out result);
            }
            catch {}
        }
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

                // 3. 从系统用户 PATH 环境变量中移除 (采用原生注册表安全操作，杜绝命令行转义缺陷)
                try
                {
                    string normInstall = (installDir ?? "").Trim().TrimEnd('\\');
                    using (RegistryKey envKey = Registry.CurrentUser.OpenSubKey("Environment", true))
                    {
                        if (envKey != null)
                        {
                            object rawPathObj = envKey.GetValue("Path", "", RegistryValueOptions.DoNotExpandEnvironmentNames);
                            string currentPath = (rawPathObj != null) ? rawPathObj.ToString() : "";
                            string[] parts = currentPath.Split(new char[] { ';' }, StringSplitOptions.RemoveEmptyEntries);
                            List<string> remaining = new List<string>();
                            foreach (string part in parts)
                            {
                                if (!string.Equals(part.Trim().TrimEnd('\\'), normInstall, StringComparison.OrdinalIgnoreCase))
                                {
                                    remaining.Add(part.Trim());
                                }
                            }
                            string remainingPath = string.Join(";", remaining.ToArray());
                            envKey.SetValue("Path", remainingPath, RegistryValueKind.ExpandString);

                            if (envKey.GetValue("DT_BROWSER_DIR") != null) envKey.DeleteValue("DT_BROWSER_DIR", false);
                            if (envKey.GetValue("DT_CLI_PATH") != null) envKey.DeleteValue("DT_CLI_PATH", false);
                        }
                    }
                    BroadcastEnvironmentChange();
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

                // 7. 调度自删除命令并退出 (附带系统根目录与系统保护目录绝对防线熔断机制)
                string fullNorm = Path.GetFullPath(installDir).TrimEnd('\\');
                string rootNorm = Path.GetPathRoot(fullNorm).TrimEnd('\\');

                // 绝对防线：严禁对盘符根目录、Windows、System32 等执行 rd /s /q
                bool isRootOrSys = string.Equals(fullNorm, rootNorm, StringComparison.OrdinalIgnoreCase) ||
                                   fullNorm.Length <= 3 ||
                                   fullNorm.IndexOf("Windows", StringComparison.OrdinalIgnoreCase) >= 0 ||
                                   fullNorm.IndexOf("System32", StringComparison.OrdinalIgnoreCase) >= 0;

                if (!isRootOrSys && File.Exists(Path.Combine(installDir, "Uninstall.exe")))
                {
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
                }

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
