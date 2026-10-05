# FP Electron SDK · 二次开发指南

版本 `0.1.0`。把定制指纹内核接入自己的 Electron 应用，创建多账号内嵌视图，并统一管理实例脚本和解压扩展。现有 `fp-demo 0.3.0` 已使用此 SDK，既可作为测试工具，也可作为管理界面的参考实现。

当前验收环境是 Windows、Electron `44.4.5`、Chromium `152.0.7977.130`、FP Kernel `0.1.0`。SDK 本身没有第三方运行依赖；它必须在定制 Electron **主进程**内运行。普通 npm Electron 不包含 `session.setFingerprintConfig`，不可直接替换。

## 1. 项目结构与接入方式

```text
webtt/
  fp-kernel/       内核补丁、维护工具、内核验收
  fp-sdk/          可复用的主进程 API、类型声明、设备模板
    examples/embedded.js   独立双账号内嵌示例
    examples/tab-browser/  多标签 + 自定义指纹浏览器样例
    tests/                 真实内核与跨进程验收
  fp-demo/         工作台：实例布局、脚本编辑、扩展管理、检测
  scripts/        可迁移运行时定位（工作台与测试入口使用）
  runtime/        本机安装的定制运行时，不提交 Git
  docs/           用户使用手册
```

可以复制整个 `fp-sdk` 目录到自己的项目，通过相对路径 `require('./fp-sdk')` 使用；也可以将它打为本地 npm 包后，在自己的项目中安装该包。包名为 `@fp-lab/electron-sdk`，当前未发布到公共仓库。包内提供 `index.d.ts`；使用 TypeScript 的宿主还需匹配版本的 Electron 和 Node 类型。

SDK 不限制六个实例；六实例上限属于演示工作台。实际容量需按机器内存、页面负载和后台任务测定。

## 2. 直接运行双账号示例

先按 [迁移指南](../docs/构建迁移与发布.md) 安装定制运行时，以下命令在项目根目录执行：

```powershell
$Electron = node -p "require('./scripts/runtime-path').electronPath()"
& $Electron '.\fp-sdk\examples\embedded.js'
```

示例显示两个并排的原生 `WebContentsView`，默认打开 `https://example.com/`。可以指定自己要嵌入的站点：

```powershell
$env:FP_EXAMPLE_URL = 'https://example.com/'
$Electron = node -p "require('./scripts/runtime-path').electronPath()"
& $Electron '.\fp-sdk\examples\embedded.js'
Remove-Item Env:FP_EXAMPLE_URL
```

示例使用单独的 `%APPDATA%\fp-sdk-embedded-example`，其中 `profiles.json` 保存实例 ID 和完整指纹。再次启动复用原配置和持久化浏览器分区。它不会使用工作台的账号文件。

需要标签页、指纹编辑界面和会话恢复时，参考 [多标签指纹浏览器样例](examples/tab-browser/README.md)：

```powershell
node fp-sdk/examples/tab-browser/start.js              # 启动
node fp-sdk/examples/tab-browser/start.js --self-test  # 端到端自检
```

双账号示例只是最小嵌入容器。页面的普通 HTTP(S) 新窗口请求会在原实例中打开；需要 OAuth 独立弹窗、下载界面、权限询问、代理设置界面或标签页时，在宿主应用中实现对应流程。

## 3. 创建实例的正确顺序

完整可运行代码见 `examples/embedded.js`。接入时遵循：

1. 在 `app.whenReady()` 前确定专属 `userData`，且同一路径只允许一个应用进程使用。
2. 从文件或数据库读取已有 `Profile`；只有新账号才调用 `generateFingerprint()`。
3. `await createFingerprintView({ profile })`：设置 Session、代理、UA 和指纹，再创建页面。
4. 将 view 加入自己的 `BaseWindow.contentView`，设置位置和大小。
5. `await automation.attach(profile.id, view)`：绑定脚本触发器并恢复启用的扩展。
6. 然后调用 `view.webContents.loadURL(url)`。
7. 关闭时先 `automation.dispose()`，再关闭全部 view 的 `webContents`。

不要每次启动都重新生成 seed；不要让不同账号共用 ID 或同一分区。每个 `AutomationManager` 对一个账号只绑定一个 view。新增标签页或多窗口时，宿主需要额外设计同账号多视图与生命周期管理。

```js
const { app, BaseWindow } = require('electron');
const path = require('node:path');
const { createFingerprintView, AutomationManager } = require('./fp-sdk');

// profiles 由宿主持久化读取，每项包含稳定 id、完整 fp，可选 proxy/proxyAuth。
async function buildPanel(profiles) {
  const win = new BaseWindow({ width: 1200, height: 800 });
  const automation = new AutomationManager({
    storageDir: path.join(app.getPath('userData'), 'automation'),
    getProfileIds: () => profiles.map(profile => profile.id)
  });
  const views = [];
  for (const [index, profile] of profiles.entries()) {
    const view = await createFingerprintView({ profile });
    win.contentView.addChildView(view);
    view.setBounds({ x: index * 600, y: 0, width: 600, height: 760 });
    views.push(view);
    await automation.attach(profile.id, view);
    await view.webContents.loadURL('https://example.com/');
  }
  win.on('closed', () => {
    automation.dispose();
    for (const view of views) {
      if (!view.webContents.isDestroyed()) view.webContents.close();
    }
  });
  return { win, views, automation };
}
// 在 app.whenReady() 后调用；此片段省略宿主的配置读取与 resize 布局。
```

## 4. 指纹、会话、权限 API

| API / 参数 | 行为 |
| --- | --- |
| `generateFingerprint({language, timezone}?)` | 新建随机 16 位十六进制 seed，按设备模板生成配置，UA 使用当前实际 Chromium 版本；默认 en-US / America/New_York |
| `createFingerprintView({profile, partitionPrefix?, configureSession?})` | 返回 Promise<WebContentsView>，默认使用 `persist:acc-<profile.id>` |
| `profile.id` | 1–128 位字母、数字、下划线或短横线，必须稳定持久化 |
| `profile.fp` | 完整配置；字段见 `index.d.ts`，模板源位于 `fp-sdk/profiles` |
| `profile.proxy` | 可选 Electron `proxyRules` 字符串，例如 `http://127.0.0.1:8080`；不提供则显式直连 |
| `profile.proxyAuth` | 可选 `{username,password}`，用于代理认证；工作台不提供编辑界面 |
| `partitionPrefix` | 自定义分区前缀；改变它会切换到另一份浏览器数据 |
| `configureSession(ses)` | 在视图创建前调用，用于宿主设置明确的权限、下载或网络策略 |

默认禁用 Node 集成，开启 sandbox、contextIsolation，并拒绝页面权限；WebRTC 设置为 `disable_non_proxied_udp`。宿主应按站点和实际权限类型覆盖权限处理器。独立 Session 提供 Cookie、localStorage、IndexedDB 和扩展存储隔离；默认所有实例仍使用同一个公网出口。

指纹模板变化只影响新配置。已有配置不会自动适配更换后的 Chromium 版本，升级内核后应建立迁移规则并重新验收。

## 5. 脚本管理 API

```js
const script = automation.saveScript({
  name: '读取页面标题',
  code: "console.log(location.href); return {title: document.title};",
  trigger: 'manual',          // 或 'page-loaded'
  enabled: true,
  profileIds: ['account-1'],
  matches: ['https://example.com/*']
});
const logs = await automation.runScript(script.id, ['account-1']);
console.log(logs[0].status, logs[0].result);
```

| API | 说明 |
| --- | --- |
| `saveScript(input)` | 新建；带已有 `id` 为编辑；保存前检查语法，失败不覆盖原代码 |
| `importScript(absoluteJsPath, profileIds)` | 导入小于 1 MB 的 `.js`，默认启用、手动执行；之后可编辑范围和触发方式 |
| `runScript(id, profileIds?)` | 只运行已保存、已启用脚本；目标必须是该脚本已保存的实例范围的子集 |
| `deleteScript(id)` | 删除注册，已在网页中发生的 DOM 修改不会回滚 |
| `state().scripts / logs` | 获取脚本列表和最近执行记录 |
| `on('changed', listener)` | 保存、运行、日志或扩展状态改变时通知宿主刷新界面 |

代码作为异步函数体在主页面的隔离世界 `1001` 执行，支持顶层 `await` 和 `return`。可操作 DOM，但不能直接读取页面主世界里的框架变量，也没有 Node、`require`、宿主 preload API 或 Tampermonkey 的 `GM_*` API。导入普通 `.js` 不等于自动识别用户脚本元数据。

`matches` 是大小写不敏感的字符串通配规则，`*` 可匹配任意字符；它不是正则，也不是 Chrome 完整 match-pattern 语法。只执行于 HTTP(S) 页面；手动执行同样遵守规则。默认规则是 `http://*/*`、`https://*/*`，建议按实际站点缩小范围。

`page-loaded` 在主页面每次完整加载后触发，包括刷新；不在 hash 或 SPA 路由变化时触发，也不自动注入子 iframe。相同页面匹配多个自动脚本时按脚本库顺序执行。每个实例只允许一个脚本处于等待状态，重叠执行记为 `skipped`。

日志包括实例、时间、执行来源、URL、状态、返回值、错误，以及当前包装函数中调用的 `console.log/info/warn/error/debug`。不采集整个页面或扩展的控制台；定时器在脚本返回后产生的输出也不包含在当次记录中。返回值最长约 16000 字符，控制台最多 50 条、每条约 2000 字符，超出会截断。

默认等待超时为 10 秒，可通过构造参数 `timeoutMs` 调整。超时只结束宿主等待，**不会强制终止页面 JavaScript**；该实例继续阻止重叠脚本，直到原调用结束或主页面重新导航。刷新仍无法恢复时重启应用。状态包括 `success`、`error`、`timeout`、`skipped`。

## 6. 扩展管理 API

```js
const extension = await automation.importExtension(
  'D:\\extensions\\my-unpacked-extension', ['account-1', 'account-2']
);
// extension.profiles 分别返回 loaded / pending / error / disabled。
await automation.setExtensionEnabled(extension.id, 'account-2', false);
await automation.openExtensionPopup(extension.id, 'account-1', { parent: win });
console.log(automation.diagnoseExtension(extension.id, 'account-1'));
// await automation.uninstallExtension(extension.id);
```

| API | 行为 |
| --- | --- |
| `importExtension(directory, profileIds)` | 校验 MV2/MV3 manifest，复制到托管目录，再按实例加载；返回库 ID 和每实例状态 |
| `setExtensionEnabled(id, profileId, enabled)` | 保存启用状态并加载/移除当前 Session 的扩展；同一实例同一扩展串行执行 |
| `openExtensionPopup(id, profileId, {parent,show}?)` | 用目标实例 Session 打开 manifest 声明的 default_popup；无弹窗声明则报错 |
| `diagnoseExtension(id, profileId)` | 返回加载状态、扩展页面、Session 当前 service worker 和待验证项目；不是自动兼容性评分 |
| `uninstallExtension(id)` | 从所有实例卸载并移除注册；保留原文件、托管副本和已有浏览器存储 |
| `attach(profileId, view)` | 自动恢复该实例已启用扩展；应在首次页面导航前 await |

导入目录需包含 `manifest.json`；拒绝符号链接/目录联接、超过 100 MB 或 10000 个文件的目录。存在固定 `manifest.key` 的扩展不能重复登记同一个 key，可在同一登记下选择多个实例。不要混用 SDK 和自己调用的 `ses.extensions.loadExtension/removeExtension` 来管理同一个扩展。

库 ID 是本项目 UUID，`runtimeId` 才是 Chromium 扩展 ID。同一库扩展在各实例可能具有相同 runtimeId，存储仍由不同 Session 隔离。托管文件是导入时的快照，编辑原目录不会自动更新它。启停后刷新已有网页，避免保留旧注入产生的 DOM 状态。更新版本目前通过卸载再导入；没有商店更新机制。

MV2 常驻后台会等待后台页面完成加载，最多 5 秒，避免首次内容脚本消息丢失；超时显示该实例加载错误。MV3 worker 的存活列表可随空闲而变化，不能仅凭列表为空判断不兼容。弹窗目前只允许扩展自身页面导航，不实现扩展发起的外部登录窗口。

## 7. 数据持久化与管理界面

```text
<userData>/
  profiles.json 或 accounts.json        宿主维护，含完整指纹
  Partitions/acc-<id>/                  Chromium 网站与扩展存储
  automation/
    automation.json                    脚本、范围、扩展登记/启用状态
    automation-logs.jsonl               执行历史，超过约 2 MB 后轮换
    automation-logs.jsonl.previous      上一轮日志
    extensions/<库 ID>/                导入副本
```

界面只展示最近 200 条日志；磁盘轮换是按文件大小而非无限保存。配置格式无效时停止加载并保留原文件，不静默覆盖。

完整备份要在正常退出后复制整个 `userData`。当前扩展登记包含托管目录的绝对路径，恢复扩展时应保持该路径；跨机器或改路径迁移需单独处理扩展目录引用及 Chromium 扩展 ID，尚未提供自动迁移器。仅复制 SDK 源码不会带走登录状态。

工作台管理界面入口是顶部 **脚本与扩展**。复用 UI 时参考 `fp-demo/src/management.js` 和 `src/manage/`：IPC 同时校验所属 webContents、主 frame 和本地页面 URL。外部账号页面没有管理 preload，不能通过页面脚本调用导入或执行接口。宿主不要把整个 AutomationManager 暴露给外部网页。

## 8. 打包、验证与支持边界

需要交付的是宿主应用 + SDK + **完整定制 Electron 运行目录**。仅复制 `electron.exe` 或只安装普通 Electron 包均不足。SDK 和模板可打包进应用；导入扩展应保留在应用外可写的真实磁盘目录中。本次没有生成独立安装器，也没有验收跨机器运行。

```powershell
Set-Location 'D:\project\webtt\fp-sdk'
npm.cmd pack --pack-destination 'D:\project\webtt\dist'
# 在自己的应用内 npm.cmd install '<生成的 tgz 文件>'，然后用定制运行时启动。

node 'D:\project\webtt\fp-sdk\tests\run.js'
node 'D:\project\webtt\fp-demo\tests\run-tester.js'
node 'D:\project\webtt\fp-demo\tests\run-acceptance.js'
```

验收结果和逐能力说明见 [扩展与 SDK 验收报告](COMPATIBILITY.md)。当前“常规扩展支持”指本机测试扩展已通过页面注入、后台通信、弹窗、local storage、按实例启停和重启恢复，**不表示所有 Chrome 商店扩展可用**。

Electron 官方只承诺部分 Chrome 扩展 API，支持解压目录加载；`storage.sync/managed` 不在支持范围，tabs 相关 API 也有部分限制。参考 [Electron 扩展支持](https://www.electronjs.org/docs/latest/api/extensions) 和 [Extensions API](https://www.electronjs.org/docs/latest/api/extensions-api)。具体扩展应依据实际功能复核；本项目未实现 Chrome 商店安装、直接 CRX 导入、账号云同步或完整 Chrome 标签页/工具栏语义。

当前已经具备用于二次开发的主进程接口与参考工作台。第三方账号登录、跨机器发行、完整浏览器产品功能及具体商业扩展的兼容性，仍需在宿主产品中验收。内核此前 CreepJS 的 Rects/Audio 共 4 项 lies 仍为已知问题，本次 SDK 开发未修改内核或重新采集公开网站分数。
