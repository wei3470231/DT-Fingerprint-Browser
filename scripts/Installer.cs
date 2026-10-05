using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.IO.Compression;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Threading;
using System.Windows.Forms;
using Microsoft.Win32;

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

        public InstallerForm()
        {
            InitializeComponent();
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

            // 安装路径选择
            Label lblPathTitle = new Label
            {
                Text = "📁 请选择目标安装路径:",
                Location = new Point(4, 8),
                AutoSize = true,
                Font = new Font("Microsoft YaHei UI", 9F, FontStyle.Bold, GraphicsUnit.Point),
                ForeColor = Color.FromArgb(30, 41, 59)
            };

            string defaultPath = Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                "Programs",
                "DT-Fingerprint-Browser"
            );

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

            finalInstallDir = Path.GetFullPath(installPath);

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

            Thread worker = new Thread(() =>
            {
                try
                {
                    DoInstall(finalInstallDir, optAddPath, optShortcut, optAutoStart);
                    this.Invoke(new Action(() =>
                    {
                        pnlConfig.Visible = false;
                        pnlComplete.Visible = true;
                    }));
                }
                catch (Exception ex)
                {
                    this.Invoke(new Action(() =>
                    {
                        MessageBox.Show("安装失败: " + ex.Message, "错误", MessageBoxButtons.OK, MessageBoxIcon.Error);
                        txtInstallPath.Enabled = true;
                        btnBrowse.Enabled = true;
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

        private void DoInstall(string installDir, bool addPath, bool createShortcut, bool autoStart)
        {
            // 0. 安装前尝试关闭已在运行的实例，避免文件占用导致解压失败
            try
            {
                Process[] procs = Process.GetProcessesByName("DT - 指纹浏览器");
                foreach (var p in procs) { try { p.Kill(); p.WaitForExit(1000); } catch {} }
                Process[] cliProcs = Process.GetProcessesByName("DT-CLI");
                foreach (var p in cliProcs) { try { p.Kill(); p.WaitForExit(1000); } catch {} }

                // 关闭属于当前安装目录下的 electron 浏览器进程，防止 runtime/electron.exe 被独占锁定
                Process[] elecs = Process.GetProcessesByName("electron");
                foreach (var ep in elecs)
                {
                    try
                    {
                        string pPath = ep.MainModule.FileName;
                        if (!string.IsNullOrEmpty(pPath) && pPath.StartsWith(installDir, StringComparison.OrdinalIgnoreCase))
                        {
                            ep.Kill();
                            ep.WaitForExit(1000);
                        }
                    }
                    catch {}
                }
            }
            catch {}

            // 1. 创建目标目录
            Directory.CreateDirectory(installDir);

            // 1.1 覆盖安装核心数据保护与自动快照备份
            string dataDir = Path.Combine(installDir, "data");
            if (Directory.Exists(dataDir))
            {
                try
                {
                    string envJson = Path.Combine(dataDir, "environments.json");
                    if (File.Exists(envJson))
                    {
                        string bkp = Path.Combine(dataDir, "environments_backup_" + DateTime.Now.ToString("yyyyMMdd_HHmmss") + ".json");
                        File.Copy(envJson, bkp, true);
                        File.Copy(envJson, Path.Combine(dataDir, "environments.bak.json"), true);
                    }
                    string setJson = Path.Combine(dataDir, "settings.json");
                    if (File.Exists(setJson))
                    {
                        File.Copy(setJson, Path.Combine(dataDir, "settings.bak.json"), true);
                    }
                    string bmkJson = Path.Combine(dataDir, "bookmarks.json");
                    if (File.Exists(bmkJson))
                    {
                        File.Copy(bmkJson, Path.Combine(dataDir, "bookmarks.bak.json"), true);
                    }
                }
                catch {}
            }

            // 2. 从嵌入的资源中提取并释放 payload.zip
            Assembly asm = Assembly.GetExecutingAssembly();
            using (Stream resStream = asm.GetManifestResourceStream("payload.zip"))
            {
                if (resStream == null)
                {
                    throw new InvalidOperationException("安装包完整性校验失败：未找到内嵌程序资源 (payload.zip)。");
                }

                using (ZipArchive archive = new ZipArchive(resStream, ZipArchiveMode.Read))
                {
                    int total = archive.Entries.Count;
                    int count = 0;

                    foreach (ZipArchiveEntry entry in archive.Entries)
                    {
                        count++;
                        string outPath = Path.GetFullPath(Path.Combine(installDir, entry.FullName));

                        // 安全防护：防止 Zip Slip 跨目录攻击
                        if (!outPath.StartsWith(installDir, StringComparison.OrdinalIgnoreCase))
                        {
                            continue;
                        }

                        // 关键保护：如果是覆盖安装，凡是 data/ 目录下的已有文件（如 environments.json、settings.json、profiles 缓存），绝对不覆盖！
                        string relNorm = entry.FullName.Replace('\\', '/').TrimStart('/');
                        if (relNorm.StartsWith("data/", StringComparison.OrdinalIgnoreCase))
                        {
                            if (File.Exists(outPath))
                            {
                                // 用户本地已有数据，直接跳过解压，完整保留！
                                continue;
                            }
                        }

                        if (string.IsNullOrEmpty(entry.Name))
                        {
                            Directory.CreateDirectory(outPath);
                        }
                        else
                        {
                            string dir = Path.GetDirectoryName(outPath);
                            if (!Directory.Exists(dir)) Directory.CreateDirectory(dir);

                            entry.ExtractToFile(outPath, true);
                        }

                        int pct = (int)((count / (float)total) * 80);
                        this.Invoke(new Action(() =>
                        {
                            progressBar.Value = Math.Min(pct, 80);
                            lblStatus.Text = string.Format("正在解压核心组件 ({0}/{1}): {2}", count, total, entry.Name);
                        }));
                    }
                }
            }

            // 授予 data 目录对所有本地用户的完全控制权限（防止安装在 Program Files 时普通用户无写权限）
            try
            {
                string dataFolder = Path.Combine(installDir, "data");
                if (Directory.Exists(dataFolder))
                {
                    System.Security.AccessControl.DirectorySecurity sec = Directory.GetAccessControl(dataFolder);
                    sec.AddAccessRule(new System.Security.AccessControl.FileSystemAccessRule(
                        new System.Security.Principal.SecurityIdentifier(System.Security.Principal.WellKnownSidType.BuiltinUsersSid, null),
                        System.Security.AccessControl.FileSystemRights.FullControl,
                        System.Security.AccessControl.InheritanceFlags.ContainerInherit | System.Security.AccessControl.InheritanceFlags.ObjectInherit,
                        System.Security.AccessControl.PropagationFlags.None,
                        System.Security.AccessControl.AccessControlType.Allow));
                    Directory.SetAccessControl(dataFolder, sec);
                }
            }
            catch {}

            this.Invoke(new Action(() =>
            {
                progressBar.Value = 85;
                lblStatus.Text = "正在配置系统环境与快捷方式...";
            }));

            // 3. 自动配置用户 PATH 环境变量 (统一采用 CMD / reg.exe 核心工具链，兼容精简版系统与无 PowerShell 环境)
            if (addPath)
            {
                try
                {
                    string currentPath = Environment.GetEnvironmentVariable("Path", EnvironmentVariableTarget.User) ?? "";
                    string[] parts = currentPath.Split(new char[] { ';' }, StringSplitOptions.RemoveEmptyEntries);
                    bool alreadyExists = false;
                    foreach (string p in parts)
                    {
                        if (string.Equals(p.Trim().TrimEnd('\\'), installDir.TrimEnd('\\'), StringComparison.OrdinalIgnoreCase))
                        {
                            alreadyExists = true;
                            break;
                        }
                    }
                    string newPath = currentPath;
                    if (!alreadyExists)
                    {
                        newPath = (currentPath.TrimEnd(';') + ";" + installDir).Trim(';');
                        try { Environment.SetEnvironmentVariable("Path", newPath, EnvironmentVariableTarget.User); } catch {}
                    }

                    // CMD 原生 reg.exe 双重保障
                    try
                    {
                        ProcessStartInfo psi = new ProcessStartInfo("reg.exe", "add \"HKCU\\Environment\" /v Path /t REG_EXPAND_SZ /d \"" + newPath + "\" /f");
                        psi.CreateNoWindow = true;
                        psi.UseShellExecute = false;
                        using (Process p = Process.Start(psi)) { if (p != null) p.WaitForExit(3000); }
                    }
                    catch {}

                    try
                    {
                        ProcessStartInfo psiDir = new ProcessStartInfo("reg.exe", "add \"HKCU\\Environment\" /v DT_BROWSER_DIR /t REG_SZ /d \"" + installDir + "\" /f");
                        psiDir.CreateNoWindow = true;
                        psiDir.UseShellExecute = false;
                        using (Process p = Process.Start(psiDir)) { if (p != null) p.WaitForExit(3000); }
                    }
                    catch {}

                    try
                    {
                        string cliExe = Path.Combine(installDir, "DT-CLI.exe");
                        ProcessStartInfo psiCli = new ProcessStartInfo("reg.exe", "add \"HKCU\\Environment\" /v DT_CLI_PATH /t REG_SZ /d \"" + cliExe + "\" /f");
                        psiCli.CreateNoWindow = true;
                        psiCli.UseShellExecute = false;
                        using (Process p = Process.Start(psiCli)) { if (p != null) p.WaitForExit(3000); }
                    }
                    catch {}

                    try
                    {
                        ProcessStartInfo psiBrd = new ProcessStartInfo("cmd.exe", "/c setx DT_ENV_BROADCAST 1 >nul 2>&1 & reg delete HKCU\\Environment /v DT_ENV_BROADCAST /f >nul 2>&1");
                        psiBrd.CreateNoWindow = true;
                        psiBrd.UseShellExecute = false;
                        using (Process p = Process.Start(psiBrd)) { if (p != null) p.WaitForExit(3000); }
                    }
                    catch {}
                }
                catch {}
            }

            // 4. 创建桌面与开始菜单快捷方式
            if (createShortcut)
            {
                try
                {
                    string targetExe = File.Exists(Path.Combine(installDir, "DT-Fingerprint-Browser.exe"))
                        ? Path.Combine(installDir, "DT-Fingerprint-Browser.exe")
                        : Path.Combine(installDir, "DT - 指纹浏览器.exe");
                    string iconPath = Path.Combine(installDir, "app.ico");

                    // 桌面快捷方式
                    string desktop = Environment.GetFolderPath(Environment.SpecialFolder.DesktopDirectory);
                    CreateShortcut(Path.Combine(desktop, "DT - 指纹浏览器.lnk"), targetExe, installDir, iconPath, "DT - 指纹浏览器");
                    CreateShortcut(Path.Combine(desktop, "DT-Fingerprint-Browser.lnk"), targetExe, installDir, iconPath, "DT - 指纹浏览器");

                    // 开始菜单快捷方式
                    string startMenu = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.Programs), "DT - 指纹浏览器");
                    if (!Directory.Exists(startMenu)) Directory.CreateDirectory(startMenu);
                    CreateShortcut(Path.Combine(startMenu, "DT - 指纹浏览器.lnk"), targetExe, installDir, iconPath, "DT - 指纹浏览器");
                    CreateShortcut(Path.Combine(startMenu, "卸载 DT - 指纹浏览器.lnk"), Path.Combine(installDir, "Uninstall.exe"), installDir, iconPath, "卸载 DT - 指纹浏览器");
                }
                catch {}
            }

            // 5. 开机自动启动设置
            if (autoStart)
            {
                try
                {
                    using (RegistryKey key = Registry.CurrentUser.OpenSubKey(@"Software\Microsoft\Windows\CurrentVersion\Run", true))
                    {
                        if (key != null)
                        {
                            string targetExe = File.Exists(Path.Combine(installDir, "DT-Fingerprint-Browser.exe"))
                                ? Path.Combine(installDir, "DT-Fingerprint-Browser.exe")
                                : Path.Combine(installDir, "DT - 指纹浏览器.exe");
                            key.SetValue("DTFingerprintBrowser", "\"" + targetExe + "\" --minimized");
                        }
                    }
                }
                catch {}
            }

            // 6. 注册控制面板应用卸载信息
            try
            {
                string uninstallKey = @"Software\Microsoft\Windows\CurrentVersion\Uninstall\DT-Fingerprint-Browser";
                using (RegistryKey key = Registry.CurrentUser.CreateSubKey(uninstallKey))
                {
                    if (key != null)
                    {
                        key.SetValue("DisplayName", "DT - 指纹浏览器");
                        key.SetValue("DisplayVersion", "2.1.0");
                        key.SetValue("Publisher", "DT Studio");
                        key.SetValue("DisplayIcon", Path.Combine(installDir, "app.ico"));
                        key.SetValue("InstallLocation", installDir);
                        key.SetValue("UninstallString", "\"" + Path.Combine(installDir, "Uninstall.exe") + "\"");
                        key.SetValue("NoModify", 1);
                        key.SetValue("NoRepair", 1);
                    }
                }
            }
            catch {}

            this.Invoke(new Action(() =>
            {
                progressBar.Value = 100;
                lblStatus.Text = "安装成功！";
            }));

            Thread.Sleep(300);
        }

        private void CreateShortcut(string shortcutPath, string targetPath, string workingDir, string iconPath, string desc)
        {
            try
            {
                Type shellType = Type.GetTypeFromProgID("WScript.Shell");
                if (shellType == null) return;
                dynamic shell = Activator.CreateInstance(shellType);
                dynamic shortcut = shell.CreateShortcut(shortcutPath);
                shortcut.TargetPath = targetPath;
                shortcut.WorkingDirectory = workingDir;
                if (File.Exists(iconPath)) shortcut.IconLocation = iconPath;
                shortcut.Description = desc;
                shortcut.Save();
            }
            catch {}
        }

        [STAThread]
        static void Main()
        {
            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);
            Application.Run(new InstallerForm());
        }
    }
}
