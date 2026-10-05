# 多标签指纹浏览器样例

基于 `@fp-lab/electron-sdk` 的最小可用浏览器：一个窗口内管理多个**身份**，每个身份拥有可编辑的自定义指纹和独立 Session，同一身份可打开任意多个标签页。适合作为指纹浏览器二次开发的起点；比 [双账号嵌入示例](../embedded.js) 多了标签页、指纹编辑和会话恢复。

![多标签指纹浏览器：左侧为新标签页读取到的实际指纹，右侧为身份抽屉](../../../docs/assets/tab-browser.png)


## 启动

需要先按 [构建迁移与发布](../../../docs/构建迁移与发布.md) 安装定制运行时，普通 npm Electron 无法运行。

- 双击项目根目录 `启动多标签浏览器.cmd`（不需要 Node.js）；或
- 在项目根目录执行 `node fp-sdk/examples/tab-browser/start.js`。

首次启动创建「身份 A · 上海」「身份 B · 纽约」两个身份，各打开一个新标签页。新标签页会显示当前页面实际读到的 UA、平台、核心数、内存、语言、时区、屏幕、WebGL、Canvas 哈希，用于核对配置是否生效。

## 功能

| 功能 | 操作 |
| --- | --- |
| 新建标签页 | `+`（当前身份）、`▾` 选择身份、`Ctrl+T` |
| 在其他身份中打开 | 右键标签页或页面链接 →「在其他身份中打开」 |
| 编辑指纹 | 点击地址栏左侧身份标签或右上角「身份与指纹」 |
| 自定义字段 | 系统版本、语言、时区、CPU 核心、内存、分辨率、DPR、WebGL 厂商/渲染器、Canvas/Audio/Rects 噪声、seed、代理 |
| 随机生成 | 保留语言与时区，重新随机其余字段；点击「保存并应用」后生效 |
| 删除身份 | 关闭其标签页并清除该分区的 Cookie、缓存与网站存储 |
| 快捷键 | `Ctrl+W` 关闭、`Ctrl+Tab` 切换、`Ctrl+L` 地址栏、`F5` 刷新、`Alt+←/→` 前进后退、`F12` 开发者工具 |

标签页的身份以颜色区分。关闭窗口时保存打开的标签页，下次启动恢复。数据位于 `%APPDATA%\fp-sdk-tab-browser`：`profiles.json` 保存身份与完整指纹，`tabs.json` 保存标签页，`Partitions/fpb-<身份 ID>` 为浏览器数据。

## 实现要点

| 文件 | 内容 |
| --- | --- |
| `main.js` | 身份与标签页模型、视图布局、菜单快捷键、IPC |
| `fingerprint-form.js` | 表单字段 ↔ `FingerprintConfig` 转换与校验 |
| `preload.js` / `ui/` | 浏览器界面（标签栏、工具栏、身份抽屉），只有界面拥有 preload |
| `newtab/` | 本地新标签页，在各身份自己的 Session 中运行 |
| `self-test.js` | 端到端自检 |

1. **一个身份 = 一个 Profile = 一个分区。** 每个标签页调用 `createFingerprintView({ profile, partitionPrefix: 'fpb-' })`，同一身份的标签页得到同一个 `persist:fpb-<id>` Session，因此共享 Cookie 与登录状态，不同身份互相隔离。
2. **指纹只在新建身份时生成一次**，之后由用户编辑并持久化。UA 中的 Chromium 版本始终跟随当前内核，内核升级后启动时自动修正。
3. **修改指纹后重启该身份的标签页。** 内核在渲染进程启动时下发配置，已运行的页面不会变化。保存时关闭该身份全部标签页，等待其渲染进程退出，再用新配置重建并加载原网址；Cookie 与存储保留，其他身份的标签页不受影响。
4. 页面的 `target=_blank` / `window.open` 在同一身份的新标签页中打开（不保留 `window.opener`）。
5. 网页标签页沿用 SDK 默认安全设置：sandbox、contextIsolation、无 Node、默认拒绝权限请求、WebRTC 仅走代理。IPC 只接受浏览器界面主框架的调用。

## 自检

```powershell
node fp-sdk/examples/tab-browser/start.js --self-test
```

使用临时 userData，自动完成：自定义身份 A 并保存 → 开 3 个标签页（A×2、B×1）→ 逐页读取实际指纹与配置比对 → 验证同身份共享、跨身份隔离 Cookie/localStorage → 修改身份 B 后验证新值生效、存储保留、A 的标签页未被重建 → 界面状态与截图。当前运行时（Electron 44.4.5 / Chromium 152.0.7977.130）结果 42/42 通过。

## 边界

这是样例而非完整浏览器：没有下载管理、权限询问界面、书签/历史、标签拖拽排序、代理认证编辑，也未集成 `AutomationManager` 的脚本与扩展（它对每个身份只绑定一个视图，多标签需宿主另行设计）。系统模板仅含 Windows 10/11，与内核字体策略一致。页面指纹检测结果以 [公开检测报告](../../../fp-kernel/reports/phase5/REPORT.md) 为准。
