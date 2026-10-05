# SDK 与扩展兼容性验收

日期：2026-09-27 UTC。工作台 `0.3.0`、SDK `0.1.0`。实际运行 `D:\e\src\out\Testing\electron.exe`，版本 Electron `44.4.5` / Chromium `152.0.7977.130` / FP Kernel `0.1.0`。

## 结果与证据

| 验收 | 结果 | 原始证据 |
| --- | --- | --- |
| SDK、脚本、扩展与管理 UI，首次进程 | 33/33 通过 | [bootstrap.json](test-results/2026-09-27T04-02-49-196Z/bootstrap.json) |
| 独立第二进程，复用同一测试数据与 origin | 12/12 通过 | [restart.json](test-results/2026-09-27T04-02-49-196Z/restart.json) |
| SDK 总计 | **45/45 通过** | [summary.json](test-results/2026-09-27T04-02-49-196Z/summary.json) |
| 工作台回归，含管理窗口入口 | **58/58 通过** | [工作台报告](../fp-demo/test-results/tester-2026-09-27T03-59-19-250Z/summary.json) |
| 三账号存储、指纹及跨进程回归 | **91/91 通过** | [三账号报告](../fp-demo/test-results/2026-09-27T04-02-54-345Z/summary.json) |
| TypeScript 消费端编译检查 | 通过，strict/noEmit | `tests/types.ts`，使用本机 Electron 源码中的类型声明及 TypeScript |

截图：[脚本编辑与执行](test-results/2026-09-27T04-02-49-196Z/management.png)、[扩展管理](test-results/2026-09-27T04-02-49-196Z/extensions.png)。

全部自动测试使用独立临时 userData 和 loopback 页面，没有登录真实业务账号，也没有导入用户的商业扩展。日志和测试数据位置记录在 summary 中。

## 本机逐能力结果

| 能力 | MV2 测试扩展 | MV3 测试扩展 |
| --- | --- | --- |
| 从解压目录导入到两个独立 Session | 通过 | 通过 |
| 声明式 content_scripts 修改页面 DOM | 通过 | 通过 |
| 内容脚本通过 runtime.sendMessage 获取后台回复 | 通过，常驻 background page | 通过，service worker |
| default_popup 页面加载 | 通过，browser_action | 通过，action |
| popup 中 chrome.storage.local 写入和读取 | 通过 | 通过 |
| 同一扩展在两实例存储不同值，重启后仍各自保留 | 通过 | 通过 |
| 只停用实例 2，刷新后无该扩展注入，实例 1 保持加载 | 通过 | 通过 |
| 重新启用并在第二个进程恢复加载 | 通过 | 通过 |

另有 MV2 副本验证全局卸载后重启不再登记、停用状态跨进程保留、扩展文件丢失仅影响该实例的加载状态。卸载保留源文件与托管副本，并有断言检查。

首次测试发现 MV2 的 `loadExtension()` 返回时常驻后台尚未执行，内容脚本第一条消息报接收端不存在。SDK 已在首次导航前等待常驻后台页完成加载，并重新实测回复成功；仅靠“加载成功”判断兼容性的方式没有用于本报告。

## 脚本与宿主集成范围

- JS 导入、语法错误不覆盖旧脚本、启停、删除、实例范围和 URL 范围检查。
- 手动执行的返回值与 console 输出，错误日志、等待超时、重叠执行保护及导航恢复。
- 页面加载后执行，重启恢复，目标实例外不产生 DOM 修改。
- 真正的管理页面经 preload/IPC 保存并执行脚本，扩展页和日志页正常渲染。
- 带相同 preload 的外部窗口仍无法读取管理状态或创建自动执行脚本。
- 独立 Session、页面无 Node globals；工作台和旧三账号隔离测试继续通过。

## 结论边界

**可用于二次开发的通用基础链路已经实现并实测通过。** 用户未指定实际插件，因此本次使用自建 MV2/MV3 夹具覆盖基础功能，不宣称任意商店插件可用。

| 场景 | 当前结论 |
| --- | --- |
| 两个自建测试扩展上述功能 | 当前定制构建已通过 |
| 用户脚本的 GM_* / userscript 元数据 | 脚本管理器未实现 |
| Chrome 商店一键安装、直接 .crx 导入、自动更新 | 未实现 |
| Chrome 工具栏/标签页完整语义、浏览器账号同步 | 未实现 |
| popup 发起外部登录、独立 OAuth 窗口 | 当前 popup 禁止外部跳转，需宿主开发 |
| 任意商业插件、特定广告拦截规则、原生消息宿主、扩展云同步 | 未验收，不能从夹具通过推断 |
| MV2 非常驻事件页、MV3 长期休眠唤醒/复杂 worker 生命周期 | 本次未覆盖 |
| `chrome.storage.sync` / `managed` | Electron 官方文档不支持 |
| 跨机器运行、扩展目录迁移、安装包 | 尚未验收；登记中包含绝对托管路径 |
| 第三方指纹检测全部通过 | 不能作此结论；此前 CreepJS Rects/Audio 共 4 lies 仍为已知问题 |

官方边界见 [Electron Chrome Extension Support](https://www.electronjs.org/docs/latest/api/extensions)。本机成功运行 MV3 后台是当前构建的实测结果；升级 Electron/Chromium 后仍需重跑，不能把版本特定结果当作永久保证。

## 复现

```powershell
node 'D:\project\webtt\fp-sdk\tests\run.js'
node 'D:\project\webtt\fp-demo\tests\run-tester.js'
node 'D:\project\webtt\fp-demo\tests\run-acceptance.js'
```

`FP_DEMO_ELECTRON` 可指向其他定制内核。每次 SDK 测试先启动首次进程，成功后才进入第二进程；两阶段都通过时顶层 passed 才为 true，失败返回非零退出码。测试保留证据而不写入日常工作台数据。
