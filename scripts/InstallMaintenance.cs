using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using System.Threading;
using Microsoft.Win32;

namespace BitFPManager
{
    internal static class InstallMaintenance
    {
        internal const string Product = "DT-Fingerprint-Browser";
        internal const string Launcher = "DT-Fingerprint-Browser.exe";
        internal const string LegacyLauncher = "DT - 指纹浏览器.exe";
        internal const string RoamingMarker = ".dt-roaming-data";
        internal const string UninstallKey = @"Software\Microsoft\Windows\CurrentVersion\Uninstall\DT-Fingerprint-Browser";
        internal const string RunKey = @"Software\Microsoft\Windows\CurrentVersion\Run";

        [DllImport("user32.dll", CharSet = CharSet.Unicode)]
        private static extern IntPtr SendMessageTimeout(IntPtr window, uint message, UIntPtr wParam,
            string value, uint flags, uint timeout, out UIntPtr result);

        internal static void BroadcastEnvironmentChange()
        {
            UIntPtr result;
            SendMessageTimeout((IntPtr)0xffff, 0x001a, UIntPtr.Zero, "Environment", 2, 3000, out result);
        }

        internal static string Normalize(string path)
        {
            if (String.IsNullOrWhiteSpace(path)) return null;
            path = path.Trim().Trim('"').Replace('/', '\\');
            if (path.Length < 3 || !Path.IsPathRooted(path) ||
                (path[1] == ':' && path[2] != '\\') || (path[0] == '\\' && path[1] != '\\')) return null;
            try { return Path.GetFullPath(path).TrimEnd('\\'); }
            catch (ArgumentException) { return null; }
            catch (NotSupportedException) { return null; }
        }

        internal static bool SamePath(string first, string second)
        {
            string path = Normalize(first);
            return path != null && String.Equals(path, Normalize(second), StringComparison.OrdinalIgnoreCase);
        }

        internal static bool Below(string parent, string child)
        {
            return child.StartsWith(parent.TrimEnd('\\') + "\\", StringComparison.OrdinalIgnoreCase);
        }

        internal static string SafeInstallRoot(string path)
        {
            string full = Normalize(path);
            if (full == null || full.StartsWith(@"\\", StringComparison.Ordinal) || full.Length <= 3)
                throw new IOException("请选择一个本地应用目录，不能使用驱动器根目录。");

            string windows = Environment.GetFolderPath(Environment.SpecialFolder.Windows);
            if (SamePath(full, windows) || Below(windows, full))
                throw new IOException("请选择 Windows 系统目录以外的应用目录。");

            foreach (Environment.SpecialFolder folder in new[] {
                Environment.SpecialFolder.UserProfile, Environment.SpecialFolder.DesktopDirectory,
                Environment.SpecialFolder.MyDocuments, Environment.SpecialFolder.ApplicationData,
                Environment.SpecialFolder.LocalApplicationData, Environment.SpecialFolder.CommonApplicationData,
                Environment.SpecialFolder.ProgramFiles, Environment.SpecialFolder.ProgramFilesX86 })
                if (SamePath(full, Environment.GetFolderPath(folder)))
                    throw new IOException("请在所选位置下使用专用应用目录。");

            EnsureNoLinks(full);
            return full;
        }

        internal static void EnsureNoLinks(string path)
        {
            for (string current = path; !String.IsNullOrEmpty(current); current = Path.GetDirectoryName(current))
            {
                try
                {
                    if ((File.GetAttributes(current) & FileAttributes.ReparsePoint) != 0)
                        throw new IOException("路径包含链接或挂载点：" + current);
                }
                catch (FileNotFoundException) {}
                catch (DirectoryNotFoundException) {}
            }
        }

        internal static bool IsExistingInstall(string dir)
        {
            return (File.Exists(Path.Combine(dir, Launcher)) || File.Exists(Path.Combine(dir, LegacyLauncher))) &&
                   (File.Exists(Path.Combine(dir, "Uninstall.exe")) ||
                    File.Exists(Path.Combine(dir, "app.asar")) ||
                    File.Exists(Path.Combine(dir, @"runtime\electron.exe")));
        }

        internal static string RegisteredInstall()
        {
            using (RegistryKey key = Registry.CurrentUser.OpenSubKey(UninstallKey))
            {
                string root = key == null ? null : Normalize(key.GetValue("InstallLocation") as string);
                if (root == null) return null;
                string uninstaller = Path.Combine(root, "Uninstall.exe");
                bool registeredUninstaller = SamePath(key.GetValue("UninstallString") as string, uninstaller) &&
                    File.Exists(uninstaller);
                return registeredUninstaller || IsExistingInstall(root) || Directory.Exists(Path.Combine(root, "data"))
                    ? root : null;
            }
        }

        internal static string RoamingData()
        {
            return Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), Product, "data");
        }

        private static bool HasUserData(string data)
        {
            if (!Directory.Exists(data)) return false;
            foreach (string entry in Directory.EnumerateFileSystemEntries(data))
            {
                if (String.Equals(Path.GetFileName(entry), "profiles", StringComparison.OrdinalIgnoreCase))
                {
                    if (Directory.Exists(entry) && Directory.EnumerateFileSystemEntries(entry).Any())
                        return true;
                }
                else
                {
                    return true;
                }
            }
            return false;
        }

        internal static bool UsesRoamingData(string root, string roaming, bool registered)
        {
            return File.Exists(Path.Combine(root, RoamingMarker)) ||
                (registered && !HasUserData(Path.Combine(root, "data")) && HasUserData(roaming));
        }

        internal static string RuntimeCache(string root)
        {
            string hash;
            using (SHA256 sha = SHA256.Create())
                hash = BitConverter.ToString(sha.ComputeHash(Encoding.UTF8.GetBytes(root.ToUpperInvariant())))
                    .Replace("-", "").ToLowerInvariant().Substring(0, 24);
            return Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                Product, "runtime-cache", hash);
        }

        internal static void StopInstalledProcesses(string root, string cache, bool force)
        {
            string[] binaries = { Launcher, LegacyLauncher, "DT-CLI.exe", @"runtime\electron.exe",
                @"runtime\cores\electron\electron.exe", @"runtime\cores\chromium\chrome.exe",
                @"scripts\RuntimeTools.exe", @"scripts\ChromiumWindowIcon.exe" };
            var expected = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            var names = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            foreach (string relative in binaries)
            {
                expected.Add(Path.Combine(root, relative));
                names.Add(Path.GetFileNameWithoutExtension(relative));
            }
            foreach (string name in names)
            {
                foreach (Process process in Process.GetProcessesByName(name))
                {
                    using (process)
                    {
                        string image;
                        try { image = process.MainModule.FileName; }
                        catch (Win32Exception) { continue; }
                        catch (InvalidOperationException) { continue; }
                        if (!expected.Contains(image) && !Below(cache, image)) continue;
                        try
                        {
                            if (!force)
                            {
                                if (process.WaitForExit(500)) continue;
                                throw new IOException("请从系统托盘退出 DT 指纹浏览器，并关闭该安装下的浏览器窗口和 CLI 命令后重试。");
                            }
                            process.Kill();
                            if (!process.WaitForExit(5000)) throw new IOException("无法关闭进程：" + image);
                        }
                        catch (InvalidOperationException) {}
                    }
                }
            }
        }

        internal static void ConfigureEnvironment(RegistryKey key, string root, bool enabled)
        {
            string raw = key.GetValue("Path", null, RegistryValueOptions.DoNotExpandEnvironmentNames) as string;
            RegistryValueKind kind = raw == null ? RegistryValueKind.ExpandString : key.GetValueKind("Path");
            string dir = key.GetValue("DT_BROWSER_DIR") as string;
            string cli = key.GetValue("DT_CLI_PATH") as string;
            var remaining = new List<string>();
            if (raw != null)
            {
                foreach (string entry in raw.Split(';'))
                {
                    string expanded = kind == RegistryValueKind.ExpandString
                        ? Environment.ExpandEnvironmentVariables(entry) : entry;
                    if (SamePath(entry, root) || SamePath(expanded, root) ||
                        (kind == RegistryValueKind.ExpandString &&
                         String.Equals(entry.Trim().Trim('"'), "%DT_BROWSER_DIR%", StringComparison.OrdinalIgnoreCase) &&
                         SamePath(dir, root))) continue;
                    remaining.Add(entry);
                }
            }
            if (enabled)
            {
                if (remaining.Count == 1 && remaining[0].Length == 0) remaining.Clear();
                remaining.Add(root);
                key.SetValue("DT_BROWSER_DIR", root, RegistryValueKind.String);
                key.SetValue("DT_CLI_PATH", Path.Combine(root, "DT-CLI.exe"), RegistryValueKind.String);
            }
            else
            {
                if (SamePath(dir, root)) key.DeleteValue("DT_BROWSER_DIR", false);
                if (SamePath(cli, Path.Combine(root, "DT-CLI.exe"))) key.DeleteValue("DT_CLI_PATH", false);
            }

            string updated = String.Join(";", remaining.ToArray());
            if (updated.Length == 0 && raw != null && raw.Length != 0) key.DeleteValue("Path", false);
            else if ((raw ?? "") != updated) key.SetValue("Path", updated, kind);
        }

        internal static bool IsAppCommand(string command, string root)
        {
            if (String.IsNullOrWhiteSpace(command)) return false;
            string expanded = Environment.ExpandEnvironmentVariables(command.Trim());
            foreach (string file in new[] { Launcher, LegacyLauncher, @"runtime\electron.exe", @"runtime\cores\electron\electron.exe" })
            {
                string path = Path.Combine(root, file);
                if (expanded[0] == '"')
                {
                    int close = expanded.IndexOf('"', 1);
                    if (close >= 0 && SamePath(expanded.Substring(1, close - 1), path)) return true;
                }
                else if (SamePath(expanded, path) || expanded.StartsWith(path + " ", StringComparison.OrdinalIgnoreCase))
                    return true;
            }
            return false;
        }

        internal static void ClearOwnedAutoStart(RegistryKey key, string root)
        {
            foreach (string value in new[] { "DTFingerprintBrowser", "electron.app.Electron" })
                if (IsAppCommand(key.GetValue(value) as string, root))
                    key.DeleteValue(value, false);
        }

        internal static void ClearOwnedShortcuts(string root, string desktop, string programs)
        {
            string startMenu = Path.Combine(programs, "DT - 指纹浏览器");
            string[] paths = { Path.Combine(desktop, "DT - 指纹浏览器.lnk"),
                Path.Combine(desktop, "DT-Fingerprint-Browser.lnk"), Path.Combine(startMenu, "DT - 指纹浏览器.lnk"),
                Path.Combine(startMenu, "卸载 DT - 指纹浏览器.lnk") };
            Type shellType = Type.GetTypeFromProgID("WScript.Shell");
            foreach (string link in paths)
            {
                if (!File.Exists(link)) continue;
                if (shellType == null) throw new InvalidOperationException("无法检查快捷方式：" + link);
                dynamic shell = Activator.CreateInstance(shellType);
                dynamic shortcut = shell.CreateShortcut(link);
                string target = shortcut.TargetPath;
                if (IsAppCommand(target, root) || SamePath(target, Path.Combine(root, "Uninstall.exe")))
                    File.Delete(link);
            }
            DeleteEmptyDirectory(startMenu);
        }

        internal static void DeleteEmptyDirectory(string path)
        {
            if (!Directory.Exists(path)) return;
            if ((File.GetAttributes(path) & FileAttributes.ReparsePoint) != 0) return;
            if (!Directory.EnumerateFileSystemEntries(path).Any()) Directory.Delete(path);
        }

        internal static void DeleteTree(string path)
        {
            FileAttributes attributes;
            try { attributes = File.GetAttributes(path); }
            catch (FileNotFoundException) { return; }
            catch (DirectoryNotFoundException) { return; }
            bool isLink = (attributes & FileAttributes.ReparsePoint) != 0;
            if ((attributes & FileAttributes.Directory) != 0)
            {
                if (!isLink)
                    foreach (string child in Directory.GetFileSystemEntries(path)) DeleteTree(child);
                Directory.Delete(path);
            }
            else
            {
                if (!isLink && (attributes & FileAttributes.ReadOnly) != 0)
                    File.SetAttributes(path, attributes & ~FileAttributes.ReadOnly);
                File.Delete(path);
            }
        }

        internal static void RetryFileOperation(Action operation)
        {
            for (int attempt = 0; ; attempt++)
            {
                try { operation(); return; }
                catch (IOException) { if (attempt == 39) throw; }
                catch (UnauthorizedAccessException) { if (attempt == 39) throw; }
                Thread.Sleep(250);
            }
        }
    }
}
