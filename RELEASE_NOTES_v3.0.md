# DT 指纹浏览器 v3.0

## 双内核

管理器顶部的 **新建环境内核** 默认为 Chromium。创建环境时保存该内核，列表分别以紫色和青绿色显示 Electron、Chromium，每次启动按该环境保存的内核打开。旧配置首次升级时优先按已有浏览器资料补齐。两个内核为同一环境分别保存 Cookie、站点数据和浏览历史。

v3.0 安装包和便携包内置 Electron。全新安装后可直接打开管理器，CLI 也可离线启动。管理器会按需准备 Chromium，顶部显示下载、校验和解压进度。程序可复用现有 Chromium 或软件目录里的 `runtime_chromium.zip`。需要联网时，从 GitHub 取得 ZIP 并校验，再解压至 `runtime/cores/`。安装目录无法写入时，普通用户会使用 `%LOCALAPPDATA%\DT-Fingerprint-Browser\runtime-cache` 下的内核缓存。正式包的内核准备和环境启动使用内置工具，并支持长路径解压。 [内核发布页](https://github.com/wei3470231/DT-Fingerprint-Browser/releases/tag/core)

覆盖安装时会备份旧运行时中的应用包，确保启动器加载 v3.0 界面。Chromium 浏览器窗口和任务栏使用 DT 图标。指纹检测页封装在应用中，首次打开时从内部资源生成。

## 指纹切换

- **Electron**：重建运行中的标签页渲染进程，保留导航历史、浏览器进程和会话数据。
- **Chromium**：从环境配置应用种子、CPU 核数、语言、时区和 UA。修改指纹后重启该环境，复用原来的 Chromium 用户目录。Chromium 自行决定设备内存、屏幕和 Windows 显卡型号。内核自带的 Canvas 读取在这个 Windows 构建中可能卡住。DT 用随应用提供的兼容层为普通网页和内置检测页的 Canvas 2D 读值和导出应用种子。编辑环境可查看或指定 0 到 4294967295 的 32 位 Chromium 种子，一键随机会生成新的种子。 [Chromium 内核文档](https://github.com/wei3470231/fingerprint-chromium)
- 两种内核随机指纹时都保留环境当前的 UA。Chromium 的 Client Hints 继续报告其真实内核版本。
- Chromium 支持无密码的 HTTP 代理与带或不带账号密码的 SOCKS5 代理，可全局使用或按目标域名分流。分流时白名单优先，其余命中目标的请求走代理，未命中则直连。命中目标的流量在代理故障时会报错。两种内核的分流均按主机名匹配，粘贴完整网址时取其主机名。代理目标规则用于选择路由。轮换代理、HTTP 认证代理、DT 弹窗屏蔽、Cookie 管理、窗口排列与键鼠同步使用 Electron。

## CLI 调用

在 [README 的原有 CLI 手册](README.md#4-命令行-cli-原生调用详解-dt-cli) 中查看 Chromium 创建、启动、CDP 连接、指纹重启与代理分流的命令示例。旧版不带子命令的直通入口使用 Electron。

GUI 和 CLI 可以并行启动不同环境。同一环境同时收到启动请求时，只启动一个浏览器进程，后续请求返回该进程。各进程通过 Windows 锁协调运行状态写入。

## 覆盖升级和卸载

- 先从系统托盘退出 DT 管理器，并关闭该安装启动的浏览器窗口和 CLI。安装器检测到 Windows 已登记的旧版后，沿用原目录，保留环境、设置、书签、备份和浏览器资料。旧版环境没有内核记录且尚未启动时沿用 Electron。
- 安装器更新当前 Windows 用户的 PATH、DT CLI 环境变量、快捷方式和卸载信息。卸载时可以保留数据，也可以清除程序、当前用户的 DT 应用数据及对应的内核缓存。

## 构建和验证

- `node scripts/build-installer.js` 生成安装包、便携包和 `dist/payload-v3.0/`。
- `node scripts/build-installer.js --full` 生成可离线使用 Electron 和 Chromium 的双内核安装包。
- `powershell -NoProfile -File scripts/test-installer.ps1` 使用本地 v2.7 安装包和 v3.0 双内核安装包验证覆盖升级、数据和卸载。可通过 `-Setup` 指定标准安装包。
- `node scripts/test-portable.js` 在清空 PATH 的隔离目录验收内置 Electron、首次准备 Chromium、环境并发启动和 CLI。设置 `DT_TEST_CORE_ARCHIVES` 可用本地 Chromium ZIP 验收，设置 `DT_TEST_WINDOW_ICON=1` 可检查 Chromium 窗口和任务栏图标。
- `node scripts/test-v30.js` 启动两个实际内核，在本地网页上校验指纹更新、UA 保留及切回 Electron。
- `node scripts/test-chromium-proxy.js` 使用本地服务验证 Chromium 代理路由、白名单和故障处理。
