using System;
using System.Diagnostics;
using System.IO;
using System.Windows.Forms;
using Microsoft.Win32;

[assembly: System.Reflection.AssemblyVersion("3.1.1.0")]
[assembly: System.Reflection.AssemblyFileVersion("3.1.1.0")]

namespace BitFPManager
{
    static class UninstallerProgram
    {
        private const string Uninstaller = "Uninstall.exe";
        private const string HelperPrefix = "DT-Uninstall-";

        [STAThread]
        static void Main(string[] args)
        {
            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);
            AppContext.SetSwitch("Switch.System.IO.UseLegacyPathHandling", false);
            AppContext.SetSwitch("Switch.System.IO.BlockLongPaths", false);

            try
            {
                if (args.Length == 1 && args[0] == "--finish")
                {
                    FinishUninstall();
                    return;
                }

                string root = InstallMaintenance.SafeInstallRoot(AppDomain.CurrentDomain.BaseDirectory);
                if (!InstallMaintenance.IsExistingInstall(root) &&
                    !InstallMaintenance.SamePath(InstallMaintenance.RegisteredInstall(), root))
                    throw new IOException("此目录中没有找到可卸载的 DT 指纹浏览器。");

                DialogResult choice = MessageBox.Show(
                    "卸载 DT 指纹浏览器？\n\n安装目录：" + root +
                    "\n\n【是】卸载并删除当前 Windows 账户的 DT 应用数据（含环境、Cookie 和书签）" +
                    "\n【否】卸载程序并保留应用数据\n【取消】返回",
                    "DT 指纹浏览器卸载", MessageBoxButtons.YesNoCancel, MessageBoxIcon.Question,
                    MessageBoxDefaultButton.Button3);
                if (choice == DialogResult.Cancel) return;
                StartCleanup(root, choice == DialogResult.Yes);
            }
            catch (Exception ex)
            {
                MessageBox.Show("卸载未完成。\n\n" + ex.Message, "DT 指纹浏览器卸载",
                    MessageBoxButtons.OK, MessageBoxIcon.Error);
                Environment.ExitCode = 1;
            }
        }

        private static void StartCleanup(string root, bool deleteData)
        {
            string temp = Path.GetFullPath(Path.GetTempPath()).TrimEnd('\\');
            if (InstallMaintenance.SamePath(root, temp) || InstallMaintenance.Below(root, temp))
                throw new IOException("Windows 临时目录必须位于安装目录之外。");

            string helper = Path.Combine(temp, HelperPrefix + Guid.NewGuid().ToString("N") + ".exe");
            File.Copy(Path.Combine(root, Uninstaller), helper);
            try
            {
                var info = new ProcessStartInfo(helper, "--finish")
                {
                    UseShellExecute = false,
                    WorkingDirectory = temp
                };
                info.EnvironmentVariables["DT_UNINSTALL_ROOT"] = root;
                info.EnvironmentVariables["DT_UNINSTALL_PARENT"] = Process.GetCurrentProcess().Id.ToString();
                info.EnvironmentVariables["DT_UNINSTALL_DATA"] = deleteData ? "delete" : "keep";
                using (Process process = Process.Start(info))
                    if (process == null) throw new IOException("无法启动卸载清理程序。");
            }
            catch
            {
                File.Delete(helper);
                throw;
            }
        }

        private static void FinishUninstall()
        {
            string helper = Application.ExecutablePath;
            string name = Path.GetFileNameWithoutExtension(helper);
            Guid helperId;
            if (!InstallMaintenance.SamePath(Path.GetDirectoryName(helper), Path.GetTempPath()) ||
                !name.StartsWith(HelperPrefix, StringComparison.Ordinal) ||
                !Guid.TryParseExact(name.Substring(HelperPrefix.Length), "N", out helperId))
                throw new IOException("无效的卸载清理程序。");

            try
            {
                string root = InstallMaintenance.SafeInstallRoot(Environment.GetEnvironmentVariable("DT_UNINSTALL_ROOT"));
                string uninstall = Path.Combine(root, Uninstaller);
                if (!File.Exists(uninstall)) throw new FileNotFoundException("找不到安装目录中的卸载程序。", uninstall);
                string mode = Environment.GetEnvironmentVariable("DT_UNINSTALL_DATA");
                int parentId;
                if ((mode != "delete" && mode != "keep") ||
                    !Int32.TryParse(Environment.GetEnvironmentVariable("DT_UNINSTALL_PARENT"), out parentId))
                    throw new IOException("无效的卸载参数。");

                try
                {
                    using (Process parent = Process.GetProcessById(parentId))
                        if (!parent.WaitForExit(15000))
                            throw new IOException("卸载向导尚未退出，请关闭后重试。");
                }
                catch (ArgumentException) { /* The original uninstaller has already exited. */ }

                bool deleteData = mode == "delete";
                string roaming = Path.GetDirectoryName(InstallMaintenance.RoamingData());
                bool ownsRoaming = InstallMaintenance.SamePath(InstallMaintenance.RegisteredInstall(), root) ||
                    File.Exists(Path.Combine(root, InstallMaintenance.RoamingMarker));
                string cache = InstallMaintenance.RuntimeCache(root);
                CompleteUninstall(root, deleteData, ownsRoaming ? roaming : null, cache, () => ClearIntegration(root));
                MessageBox.Show(deleteData ? "程序及本地应用数据已删除。" : "程序已卸载，应用数据已保留。",
                    "DT 指纹浏览器卸载完成", MessageBoxButtons.OK, MessageBoxIcon.Information);
            }
            finally
            {
                ScheduleHelperDeletion(helperId);
            }
        }

        internal static void CompleteUninstall(string root, bool deleteData, string roaming, string cache, Action clearIntegration)
        {
            InstallMaintenance.StopInstalledProcesses(root, cache, deleteData);
            if (deleteData && roaming != null && Directory.Exists(roaming) &&
                !InstallMaintenance.Below(roaming, root) && !InstallMaintenance.SamePath(roaming, root))
            {
                InstallMaintenance.EnsureNoLinks(roaming);
                InstallMaintenance.RetryFileOperation(() => InstallMaintenance.DeleteTree(roaming));
            }
            if (Directory.Exists(cache))
            {
                InstallMaintenance.EnsureNoLinks(Path.GetDirectoryName(cache));
                InstallMaintenance.RetryFileOperation(() => InstallMaintenance.DeleteTree(cache));
                InstallMaintenance.DeleteEmptyDirectory(Path.GetDirectoryName(cache));
                InstallMaintenance.DeleteEmptyDirectory(Path.GetDirectoryName(Path.GetDirectoryName(cache)));
            }
            InstallMaintenance.RetryFileOperation(() => DeleteAppFiles(root, deleteData));
            clearIntegration();
            InstallMaintenance.RetryFileOperation(() =>
            {
                File.Delete(Path.Combine(root, Uninstaller));
                if (deleteData) Directory.Delete(root);
                else InstallMaintenance.DeleteEmptyDirectory(root);
            });
        }

        internal static void DeleteAppFiles(string root, bool deleteData)
        {
            InstallMaintenance.SafeInstallRoot(root);
            foreach (string entry in Directory.GetFileSystemEntries(root))
            {
                string name = Path.GetFileName(entry);
                if (String.Equals(name, Uninstaller, StringComparison.OrdinalIgnoreCase)) continue;
                if (!deleteData && (String.Equals(name, "data", StringComparison.OrdinalIgnoreCase) ||
                    String.Equals(name, InstallMaintenance.RoamingMarker, StringComparison.OrdinalIgnoreCase))) continue;
                InstallMaintenance.DeleteTree(entry);
            }
        }

        private static void ClearIntegration(string root)
        {
            using (RegistryKey key = Registry.CurrentUser.OpenSubKey("Environment", true))
                if (key != null) InstallMaintenance.ConfigureEnvironment(key, root, false);
            InstallMaintenance.BroadcastEnvironmentChange();
            using (RegistryKey key = Registry.CurrentUser.OpenSubKey(InstallMaintenance.RunKey, true))
                if (key != null) InstallMaintenance.ClearOwnedAutoStart(key, root);

            InstallMaintenance.ClearOwnedShortcuts(root, Environment.GetFolderPath(Environment.SpecialFolder.DesktopDirectory),
                Environment.GetFolderPath(Environment.SpecialFolder.Programs));
            bool owned;
            using (RegistryKey key = Registry.CurrentUser.OpenSubKey(InstallMaintenance.UninstallKey))
                owned = key != null && InstallMaintenance.SamePath(key.GetValue("InstallLocation") as string, root);
            if (owned) Registry.CurrentUser.DeleteSubKeyTree(InstallMaintenance.UninstallKey, false);
        }

        internal static void ScheduleHelperDeletion(Guid id)
        {
            // Only delete the generated executable in the worker's temp directory after it exits.
            string name = HelperPrefix + id.ToString("N") + ".exe";
            var info = new ProcessStartInfo(Path.Combine(Environment.SystemDirectory, "cmd.exe"),
                "/d /v:off /c for /l %i in (1,1,15) do @if exist " + name +
                " (del /f /q " + name + " >nul 2>&1 & if exist " + name + " ping.exe -n 2 127.0.0.1 >nul)")
            {
                WorkingDirectory = Path.GetTempPath(),
                UseShellExecute = false,
                CreateNoWindow = true
            };
            info.EnvironmentVariables["PATH"] = Environment.SystemDirectory;
            using (Process process = Process.Start(info)) {}
        }
    }
}
