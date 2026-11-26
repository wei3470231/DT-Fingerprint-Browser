using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.IO.Compression;
using System.Reflection;
using System.Security.Cryptography;
using System.Threading;
using System.Windows.Forms;
using Microsoft.Win32;

[assembly: AssemblyVersion("3.1.1.0")]
[assembly: AssemblyFileVersion("3.1.1.0")]

namespace BitFPManager
{
    public class InstallerForm : Form
    {
        private TextBox txtInstallPath;
        private Button btnBrowse;
        private CheckBox chkAddPath;
        private CheckBox chkDesktopShortcut;
        private CheckBox chkAutoStart;
        private Button btnInstall;
        private ProgressBar progressBar;
        private Label lblStatus;
        private Panel pnlHeader;
        private Panel pnlConfig;
        private Panel pnlComplete;
        private CheckBox chkLaunchNow;
        private Button btnFinish;

        private string finalInstallDir = "";
        private bool installing;

        private string registeredInstall;
        public InstallerForm()
        {
            InitializeComponent();
            FormClosing += (sender, args) => { if (installing) args.Cancel = true; };
        }

        private void InitializeComponent()
        {
            this.Text = "DT - 指纹浏览器 (商业独立版) - 安装向导";
            this.Size = new Size(560, 450);
            this.StartPosition = FormStartPosition.CenterScreen;
            this.FormBorderStyle = FormBorderStyle.FixedDialog;
            this.MaximizeBox = false;
            this.BackColor = Color.FromArgb(248, 250, 252);
            this.Font = new Font("Microsoft YaHei UI", 9F, FontStyle.Regular, GraphicsUnit.Point);

            try
            {
                this.Icon = Icon.ExtractAssociatedIcon(Assembly.GetExecutingAssembly().Location);
            }
            catch {}

            // 1. 顶部深色横幅 (Header Panel)
            pnlHeader = new Panel
            {
                Dock = DockStyle.Top,
                Height = 82,
                BackColor = Color.FromArgb(15, 23, 42) // 深邃科技石青色
            };

            Label lblTitle = new Label
            {
                Text = "DT - 指纹浏览器",
                ForeColor = Color.FromArgb(241, 245, 249),
                Font = new Font("Microsoft YaHei UI", 14F, FontStyle.Bold, GraphicsUnit.Point),
                Location = new Point(24, 16),
                AutoSize = true
            };

            Label lblSubtitle = new Label
            {
                Text = "商业独立标准版 · 独立指纹环境多开系统 (集成运行内核 · 无需额外依赖)",
                ForeColor = Color.FromArgb(148, 163, 184),
                Font = new Font("Microsoft YaHei UI", 9F, FontStyle.Regular, GraphicsUnit.Point),
                Location = new Point(25, 48),
                AutoSize = true
            };

            pnlHeader.Controls.Add(lblTitle);
            pnlHeader.Controls.Add(lblSubtitle);
            this.Controls.Add(pnlHeader);

            // 2. 主配置面板 (Config Panel)
            pnlConfig = new Panel
            {
                Location = new Point(20, 96),
                Size = new Size(504, 305)
            };

            registeredInstall = InstallMaintenance.RegisteredInstall();
            string defaultPath = registeredInstall ?? Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                "Programs", InstallMaintenance.Product);
            bool isUpgrade = registeredInstall != null;
            Label lblPathTitle = new Label
            {
                Text = isUpgrade 
                    ? "检测到旧版，将覆盖安装到原目录并保留用户数据"
                    : "📁 请选择目标安装路径:",
                Location = new Point(4, 8),
                AutoSize = true,
                Font = new Font("Microsoft YaHei UI", 9F, FontStyle.Bold, GraphicsUnit.Point),
                ForeColor = isUpgrade ? Color.FromArgb(5, 150, 105) : Color.FromArgb(30, 41, 59)
            };

            txtInstallPath = new TextBox
            {
                Text = defaultPath,
                Location = new Point(6, 32),
                Size = new Size(396, 26),
                Font = new Font("Microsoft YaHei UI", 9F)
            };

            btnBrowse = new Button
            {
                Text = "浏览...",
                Location = new Point(410, 30),
                Size = new Size(88, 28),
                BackColor = Color.FromArgb(226, 232, 240),
                FlatStyle = FlatStyle.Flat
            };
            btnBrowse.FlatAppearance.BorderColor = Color.FromArgb(203, 213, 225);
            btnBrowse.Click += (s, e) =>
            {
                using (FolderBrowserDialog fbd = new FolderBrowserDialog())
                {
                    fbd.Description = "请选择 DT - 指纹浏览器的安装目录:";
                    fbd.SelectedPath = txtInstallPath.Text;
                    if (fbd.ShowDialog() == DialogResult.OK)
                    {
                        txtInstallPath.Text = fbd.SelectedPath;
                    }
                }
            };

            // 功能选项组
            GroupBox grpOptions = new GroupBox
            {
                Text = "⚙️ 安装选项设置",
                Location = new Point(6, 76),
                Size = new Size(492, 126),
                ForeColor = Color.FromArgb(51, 65, 85)
            };

            chkAddPath = new CheckBox
            {
                Text = "自动添加安装目录到用户 PATH 环境变量 (在任意终端中可直接输入 dt-cli 调用)",
                Checked = true,
                Location = new Point(16, 26),
                Size = new Size(464, 24),
                ForeColor = Color.FromArgb(15, 23, 42)
            };

            chkDesktopShortcut = new CheckBox
            {
                Text = "创建桌面快捷方式与开始菜单项",
                Checked = true,
                Location = new Point(16, 56),
                Size = new Size(464, 24),
                ForeColor = Color.FromArgb(15, 23, 42)
            };

            chkAutoStart = new CheckBox
            {
                Text = "随 Windows 开机自动启动 (静默最小化到右下角托盘待命，不打扰屏幕)",
                Checked = false,
                Location = new Point(16, 86),
                Size = new Size(464, 24),
                ForeColor = Color.FromArgb(15, 23, 42)
            };

            if (isUpgrade)
            {
                txtInstallPath.ReadOnly = true;
                btnBrowse.Enabled = false;
                using (RegistryKey run = Registry.CurrentUser.OpenSubKey(InstallMaintenance.RunKey))
                    chkAutoStart.Checked = run != null &&
                        (InstallMaintenance.IsAppCommand(run.GetValue("DTFingerprintBrowser") as string, registeredInstall) ||
                         InstallMaintenance.IsAppCommand(run.GetValue("electron.app.Electron") as string, registeredInstall));
            }

            grpOptions.Controls.Add(chkAddPath);
            grpOptions.Controls.Add(chkDesktopShortcut);
            grpOptions.Controls.Add(chkAutoStart);

            // 进度条与状态文字
            lblStatus = new Label
            {
                Text = "准备就绪",
                Location = new Point(8, 212),
                Size = new Size(488, 20),
                ForeColor = Color.FromArgb(100, 116, 139),
                Visible = false
            };

            progressBar = new ProgressBar
            {
                Location = new Point(8, 236),
                Size = new Size(490, 18),
                Visible = false,
                Style = ProgressBarStyle.Continuous
            };

            // 底部立即安装按钮
            btnInstall = new Button
            {
                Text = "🚀 立即安装",
                Location = new Point(340, 260),
                Size = new Size(158, 38),
                BackColor = Color.FromArgb(37, 99, 235), // 现代化活力蓝
                ForeColor = Color.White,
                Font = new Font("Microsoft YaHei UI", 10F, FontStyle.Bold, GraphicsUnit.Point),
                FlatStyle = FlatStyle.Flat,
                Cursor = Cursors.Hand
            };
            btnInstall.FlatAppearance.BorderSize = 0;
            btnInstall.Click += BtnInstall_Click;

            pnlConfig.Controls.Add(lblPathTitle);
            pnlConfig.Controls.Add(txtInstallPath);
            pnlConfig.Controls.Add(btnBrowse);
            pnlConfig.Controls.Add(grpOptions);
            pnlConfig.Controls.Add(lblStatus);
            pnlConfig.Controls.Add(progressBar);
            pnlConfig.Controls.Add(btnInstall);

            this.Controls.Add(pnlConfig);

            // 3. 完成面板 (Complete Panel)
            pnlComplete = new Panel
            {
                Location = new Point(20, 96),
                Size = new Size(504, 305),
                Visible = false
            };

            Label lblDoneIcon = new Label
            {
                Text = "🎉",
                Font = new Font("Segoe UI Emoji", 36F, FontStyle.Regular),
                Location = new Point(210, 20),
                Size = new Size(80, 70),
                TextAlign = ContentAlignment.MiddleCenter
            };

            Label lblDoneTitle = new Label
            {
                Text = "安装已顺利完成！",
                Font = new Font("Microsoft YaHei UI", 14F, FontStyle.Bold),
                ForeColor = Color.FromArgb(15, 23, 42),
                Location = new Point(130, 96),
                Size = new Size(240, 32),
                TextAlign = ContentAlignment.MiddleCenter
            };

            Label lblDoneDesc = new Label
            {
                Text = "DT - 指纹浏览器 与 DT-CLI 命令行工具已成功就绪。\n所有运行环境与独立数据均已完成初始化配置。",
                Font = new Font("Microsoft YaHei UI", 9.5F),
                ForeColor = Color.FromArgb(100, 116, 139),
                Location = new Point(50, 136),
                Size = new Size(404, 46),
                TextAlign = ContentAlignment.MiddleCenter
            };

            chkLaunchNow = new CheckBox
            {
                Text = "立即启动 DT - 指纹浏览器",
                Checked = true,
                Location = new Point(170, 196),
                Size = new Size(200, 26),
                Font = new Font("Microsoft YaHei UI", 9.5F, FontStyle.Bold),
                ForeColor = Color.FromArgb(37, 99, 235)
            };

            btnFinish = new Button
            {
                Text = "完成",
                Location = new Point(182, 240),
                Size = new Size(140, 36),
                BackColor = Color.FromArgb(37, 99, 235),
                ForeColor = Color.White,
                Font = new Font("Microsoft YaHei UI", 9.5F, FontStyle.Bold),
                FlatStyle = FlatStyle.Flat,
                Cursor = Cursors.Hand
            };
            btnFinish.FlatAppearance.BorderSize = 0;
            btnFinish.Click += (s, e) =>
            {
                if (chkLaunchNow.Checked && !string.IsNullOrEmpty(finalInstallDir))
                {
                    string exePath = Path.Combine(finalInstallDir, "DT-Fingerprint-Browser.exe");
                    if (!File.Exists(exePath)) exePath = Path.Combine(finalInstallDir, "DT - 指纹浏览器.exe");
                    if (File.Exists(exePath))
                    {
                        Process.Start(new ProcessStartInfo(exePath) { WorkingDirectory = finalInstallDir });
                    }
                }
                this.Close();
            };

            pnlComplete.Controls.Add(lblDoneIcon);
            pnlComplete.Controls.Add(lblDoneTitle);
            pnlComplete.Controls.Add(lblDoneDesc);
            pnlComplete.Controls.Add(chkLaunchNow);
            pnlComplete.Controls.Add(btnFinish);

            this.Controls.Add(pnlComplete);
        }

        private void BtnInstall_Click(object sender, EventArgs e)
        {
            string installPath = txtInstallPath.Text.Trim();
            if (string.IsNullOrEmpty(installPath))
            {
                MessageBox.Show("请指定安装目标路径！", "提示", MessageBoxButtons.OK, MessageBoxIcon.Warning);
                return;
            }

            try
            {
                string root = InstallMaintenance.SafeInstallRoot(registeredInstall ?? installPath);
                if (registeredInstall == null && Directory.Exists(root) &&
                    Directory.GetFileSystemEntries(root).Length != 0 && !InstallMaintenance.IsExistingInstall(root) &&
                    !IsDataOnlyDirectory(root))
                {
                    root = InstallMaintenance.SafeInstallRoot(Path.Combine(root, InstallMaintenance.Product));
                    if (Directory.Exists(root) && Directory.GetFileSystemEntries(root).Length != 0 &&
                        !InstallMaintenance.IsExistingInstall(root) && !IsDataOnlyDirectory(root))
                        throw new IOException("所选目录已包含其他文件。请指定专用安装目录。");
                }
                finalInstallDir = root;
                txtInstallPath.Text = root;
                if (chkAddPath.Checked && root.IndexOf(';') >= 0)
                    throw new IOException("Windows PATH 使用分号分隔目录。请取消添加到 PATH，再继续安装。");
            }
            catch (Exception ex)
            {
                MessageBox.Show(ex.Message, "安装目录", MessageBoxButtons.OK, MessageBoxIcon.Warning);
                return;
            }
            // 禁用表单
            txtInstallPath.Enabled = false;
            btnBrowse.Enabled = false;
            chkAddPath.Enabled = false;
            chkDesktopShortcut.Enabled = false;
            chkAutoStart.Enabled = false;
            btnInstall.Enabled = false;
            btnInstall.Visible = false;

            lblStatus.Visible = true;
            progressBar.Visible = true;
            lblStatus.Text = "正在准备安装环境...";

            bool optAddPath = chkAddPath.Checked;
            bool optShortcut = chkDesktopShortcut.Checked;
            bool optAutoStart = chkAutoStart.Checked;
            installing = true;

            Thread worker = new Thread(() =>
            {
                try
                {
                    DoInstall(finalInstallDir, optAddPath, optShortcut, optAutoStart);
                    this.Invoke(new Action(() =>
                    {
                        installing = false;
                        pnlConfig.Visible = false;
                        pnlComplete.Visible = true;
                    }));
                }
                catch (Exception ex)
                {
                    this.Invoke(new Action(() =>
                    {
                        installing = false;
                        MessageBox.Show("安装失败: " + ex.Message, "错误", MessageBoxButtons.OK, MessageBoxIcon.Error);
                        txtInstallPath.Enabled = true;
                        btnBrowse.Enabled = registeredInstall == null;
                        chkAddPath.Enabled = true;
                        chkDesktopShortcut.Enabled = true;
                        chkAutoStart.Enabled = true;
                        btnInstall.Enabled = true;
                        btnInstall.Visible = true;
                        lblStatus.Visible = false;
                        progressBar.Visible = false;
                    }));
                }
            });
            worker.IsBackground = true;
            worker.Start();
        }

        internal static bool IsDataOnlyDirectory(string root)
        {
            if (!Directory.Exists(Path.Combine(root, "data"))) return false;
            foreach (string entry in Directory.GetFileSystemEntries(root))
                if (!InstallMaintenance.SamePath(entry, Path.Combine(root, "data")) &&
                    !InstallMaintenance.SamePath(entry, Path.Combine(root, InstallMaintenance.RoamingMarker)))
                    return false;
            return true;
        }

        internal static void ExtractPayload(ZipArchive archive, string root, Action<int, int, string> progress)
        {
            int count = 0;
            foreach (ZipArchiveEntry entry in archive.Entries)
            {
                count++;
                string target = Path.GetFullPath(Path.Combine(root, entry.FullName));
                if (InstallMaintenance.SamePath(root, target)) continue;
                if (!InstallMaintenance.Below(root, target))
                    throw new InvalidDataException("安装资源包含越界路径：" + entry.FullName);
                string data = Path.Combine(root, "data");
                if (InstallMaintenance.SamePath(data, target) || InstallMaintenance.Below(data, target))
                    continue;

                InstallMaintenance.EnsureNoLinks(target);
                if (entry.FullName.EndsWith("/") || entry.FullName.EndsWith("\\"))
                {
                    Directory.CreateDirectory(target);
                }
                else
                {
                    string parent = Path.GetDirectoryName(target);
                    Directory.CreateDirectory(parent);
                    string staged = Path.Combine(parent, ".dt-install-" + Guid.NewGuid().ToString("N"));
                    try
                    {
                        entry.ExtractToFile(staged);
                        if (File.Exists(target)) File.Replace(staged, target, null);
                        else File.Move(staged, target);
                    }
                    finally
                    {
                        File.Delete(staged);
                    }
                }
                progress(count, archive.Entries.Count, entry.Name);
            }
        }

        private void DoInstall(string installDir, bool addPath, bool createShortcut, bool autoStart)
        {
            InstallMaintenance.StopInstalledProcesses(installDir, InstallMaintenance.RuntimeCache(installDir), false);
            Directory.CreateDirectory(installDir);
            string data = Path.Combine(installDir, "data");
            InstallMaintenance.EnsureNoLinks(data);
            bool createData = !Directory.Exists(data);
            string roaming = InstallMaintenance.RoamingData();
            if (InstallMaintenance.UsesRoamingData(installDir, roaming, registeredInstall != null))
            {
                string marker = Path.Combine(installDir, InstallMaintenance.RoamingMarker);
                InstallMaintenance.EnsureNoLinks(marker);
                using (File.Open(marker, FileMode.OpenOrCreate, FileAccess.Write)) {}
            }

            using (Stream resource = Assembly.GetExecutingAssembly().GetManifestResourceStream("payload.zip"))
            {
                if (resource == null) throw new InvalidDataException("安装包缺少程序资源。");
                using (var archive = new ZipArchive(resource, ZipArchiveMode.Read))
                    ExtractPayload(archive, installDir, (count, total, name) => this.Invoke(new Action(() =>
                    {
                        progressBar.Value = count * 80 / total;
                        lblStatus.Text = string.Format("正在解压核心组件 ({0}/{1})：{2}", count, total, name);
                    })));
            }

            PreserveEmbeddedAppOnUpgrade(installDir);
            RemoveLegacyDiagnosticAssets(installDir);
            string profiles = Path.Combine(data, "profiles");
            if (!Directory.Exists(profiles))
            {
                InstallMaintenance.EnsureNoLinks(profiles);
                Directory.CreateDirectory(profiles);
            }
            // Set access for a newly created data directory without changing existing data ACLs.
            if (createData)
            {
                try
                {
                    System.Security.AccessControl.DirectorySecurity sec = Directory.GetAccessControl(data);
                    sec.AddAccessRule(new System.Security.AccessControl.FileSystemAccessRule(
                        System.Security.Principal.WindowsIdentity.GetCurrent().User,
                        System.Security.AccessControl.FileSystemRights.Modify,
                        System.Security.AccessControl.InheritanceFlags.ContainerInherit | System.Security.AccessControl.InheritanceFlags.ObjectInherit,
                        System.Security.AccessControl.PropagationFlags.None,
                        System.Security.AccessControl.AccessControlType.Allow));
                    Directory.SetAccessControl(data, sec);
                }
                catch (UnauthorizedAccessException) {}
            }

            this.Invoke(new Action(() =>
            {
                progressBar.Value = 85;
                lblStatus.Text = "正在配置系统环境与快捷方式...";
            }));

            string desktop = Environment.GetFolderPath(Environment.SpecialFolder.DesktopDirectory);
            string programs = Environment.GetFolderPath(Environment.SpecialFolder.Programs);
            string startMenu = Path.Combine(programs, "DT - 指纹浏览器");
            string targetExe = Path.Combine(installDir, InstallMaintenance.Launcher);
            string uninstaller = Path.Combine(installDir, "Uninstall.exe");
            string iconPath = Path.Combine(installDir, "app.ico");

            if (createShortcut)
            {
                Directory.CreateDirectory(startMenu);
                CreateShortcut(Path.Combine(desktop, "DT - 指纹浏览器.lnk"), targetExe, installDir, iconPath, "DT - 指纹浏览器");
                CreateShortcut(Path.Combine(desktop, "DT-Fingerprint-Browser.lnk"), targetExe, installDir, iconPath, "DT - 指纹浏览器");
                CreateShortcut(Path.Combine(startMenu, "DT - 指纹浏览器.lnk"), targetExe, installDir, iconPath, "DT - 指纹浏览器");
                CreateShortcut(Path.Combine(startMenu, "卸载 DT - 指纹浏览器.lnk"), uninstaller, installDir, iconPath, "卸载 DT - 指纹浏览器");
            }
            else
            {
                InstallMaintenance.ClearOwnedShortcuts(installDir, desktop, programs);
            }

            using (RegistryKey key = Registry.CurrentUser.CreateSubKey(InstallMaintenance.RunKey))
            {
                string oldCommand = key.GetValue("DTFingerprintBrowser") as string;
                if (!InstallMaintenance.IsAppCommand(oldCommand, installDir))
                    oldCommand = key.GetValue("electron.app.Electron") as string;
                bool hadAutoStart = InstallMaintenance.IsAppCommand(oldCommand, installDir);
                InstallMaintenance.ClearOwnedAutoStart(key, installDir);
                if (autoStart)
                {
                    bool minimized = !hadAutoStart ||
                        oldCommand.IndexOf("--minimized", StringComparison.OrdinalIgnoreCase) >= 0 ||
                        oldCommand.IndexOf("--hidden", StringComparison.OrdinalIgnoreCase) >= 0;
                    key.SetValue("DTFingerprintBrowser", "\"" + targetExe + "\"" + (minimized ? " --minimized" : ""));
                }
            }

            using (RegistryKey key = Registry.CurrentUser.CreateSubKey("Environment"))
                InstallMaintenance.ConfigureEnvironment(key, installDir, addPath);
            InstallMaintenance.BroadcastEnvironmentChange();

            using (RegistryKey key = Registry.CurrentUser.CreateSubKey(InstallMaintenance.UninstallKey))
            {
                key.SetValue("DisplayName", "DT - 指纹浏览器");
                key.SetValue("DisplayVersion", "3.1.1");
                key.SetValue("Publisher", "DT Studio");
                key.SetValue("DisplayIcon", iconPath);
                key.SetValue("InstallLocation", installDir);
                key.SetValue("UninstallString", "\"" + uninstaller + "\"");
                key.SetValue("NoModify", 1);
                key.SetValue("NoRepair", 1);
            }
            this.Invoke(new Action(() =>
            {
                progressBar.Value = 100;
                lblStatus.Text = "安装成功！";
            }));

            Thread.Sleep(300);
        }

        private static void RemoveLegacyDiagnosticAssets(string installDir)
        {
            string folder = Path.Combine(installDir, "fingerprint-test");
            var shipped = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase)
            {
                { "fingerprint-probe.js", "42F5EC110DEA8B903281186A88465686A39EB3D81FADD3E0C819DAFA5AABFB97" },
                { "index.html", "346C038B22C3F08FB7537E7A765AD0E5B3D41A8F104D867BE96D406B48E35207" },
                { "page.js", "15D9383FE4317090B30F4FADD57B6354C0B237F2222D9D657E53CCC00B6EFE18" },
                { "styles.css", "819CC3521E2B75358D63C216C9CA0352C316BD69A450A9040E478C129CFE526C" }
            };
            try
            {
                if (!Directory.Exists(folder) || (File.GetAttributes(folder) & FileAttributes.ReparsePoint) != 0) return;
                string[] entries = Directory.GetFileSystemEntries(folder);
                if (entries.Length != shipped.Count) return;

                // Only remove the exact diagnostic assets shipped by the previous v3.0 package.
                using (SHA256 sha = SHA256.Create())
                {
                    foreach (string entry in entries)
                    {
                        string expected;
                        if (!shipped.TryGetValue(Path.GetFileName(entry), out expected) ||
                            (File.GetAttributes(entry) & (FileAttributes.Directory | FileAttributes.ReparsePoint)) != 0) return;
                        using (FileStream file = File.OpenRead(entry))
                        {
                            if (BitConverter.ToString(sha.ComputeHash(file)).Replace("-", "") != expected) return;
                        }
                    }
                }

                foreach (string entry in entries) File.Delete(entry);
                Directory.Delete(folder);
            }
            catch (IOException) { }
            catch (UnauthorizedAccessException) { }
        }

        private static void PreserveEmbeddedAppOnUpgrade(string installDir)
        {
            if (!File.Exists(Path.Combine(installDir, "app.asar"))) return;

            string resources = Path.Combine(installDir, "runtime", "resources");
            string suffix = ".before-v3-" + Guid.NewGuid().ToString("N");
            string bundledArchive = Path.Combine(resources, "app.asar");
            string bundledDirectory = Path.Combine(resources, "app");

            // Electron loads an embedded app ahead of a root archive passed on the command line.
            try
            {
                InstallMaintenance.EnsureNoLinks(resources);
                if (File.Exists(bundledArchive)) File.Move(bundledArchive, bundledArchive + suffix);
                if (Directory.Exists(bundledDirectory)) Directory.Move(bundledDirectory, bundledDirectory + suffix);
            }
            catch (IOException) { /* The launcher can use a clean core if a previous process holds a file lock. */ }
            catch (UnauthorizedAccessException) { /* Leave the embedded app intact and let the launcher choose a clean core. */ }
        }

        private void CreateShortcut(string shortcutPath, string targetPath, string workingDir, string iconPath, string desc)
        {
            Type shellType = Type.GetTypeFromProgID("WScript.Shell");
            if (shellType == null) throw new InvalidOperationException("无法创建快捷方式：" + shortcutPath);
            dynamic shell = Activator.CreateInstance(shellType);
            dynamic shortcut = shell.CreateShortcut(shortcutPath);
            shortcut.TargetPath = targetPath;
            shortcut.WorkingDirectory = workingDir;
            if (File.Exists(iconPath)) shortcut.IconLocation = iconPath;
            shortcut.Description = desc;
            shortcut.Save();
        }

        [STAThread]
        static void Main()
        {
            AppContext.SetSwitch("Switch.System.IO.UseLegacyPathHandling", false);
            AppContext.SetSwitch("Switch.System.IO.BlockLongPaths", false);
            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);
            Application.Run(new InstallerForm());
        }
    }
}
