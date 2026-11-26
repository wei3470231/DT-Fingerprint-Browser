# DT 指纹浏览器 v3.1.1

## 自建云同步

- 在 Windows 或 Linux 上运行 Python 3.10+ 服务。服务默认监听 `0.0.0.0:55550`，无需安装第三方 Python 依赖。
- 管理页支持创建团队密钥、按密钥查看环境及历史备份，并直接下载原始 `.dt-sync.gz`。每个密钥的备份独立保存。
- 客户端可单选、多选、全选或按分组上传。打开云端下拉框时刷新备份列表。同步所选环境时，同名环境经确认覆盖，新环境直接添加。
- 同步环境设置、指纹、UA、Cookie、浏览历史和 Chromium 标签页。可手动导出本地备份，也可从旧版整套备份中恢复指定环境。
- 升级已有同步服务时沿用原 `sync-data` 目录。部署、管理和恢复步骤见 [自建服务说明](sync-server/README.md)。

## CLI 和升级

- `start` 按环境保存的 Electron 或 Chromium 内核启动，`--core` 可覆盖单次启动。`--json` 返回实际内核、PID 和 CDP 地址。
- 修复 `autostart --silent` 被解析成启动管理器的问题。更新源码目录的 Windows 命令包装器及 [CLI 调用示例](README.md#4-命令行-cli-原生调用详解-dt-cli)。
- Windows 安装包支持覆盖升级，保留已安装环境的数据。升级前请从托盘退出旧版管理器，并关闭浏览器窗口和 CLI。

## 下载

| 文件 | 内核 | 使用方式 |
|---|---|---|
| `DT-Fingerprint-Browser-v3.1.1-Full-Setup.exe` | Electron、Chromium | 双内核离线安装 |
| `DT-Fingerprint-Browser-v3.1.1-Setup.exe` | Electron | 标准安装，Chromium 按需准备 |
| `DT-Fingerprint-Browser-v3.1.1-Portable.zip` | Electron | 解压运行，Chromium 按需准备 |
