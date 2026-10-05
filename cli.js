#!/usr/bin/env node
'use strict';

const path = require('node:path');
const store = require('./src/manager/store');
const processManager = require('./src/manager/process-manager');
const { electronPath } = require('./scripts/runtime-path');

const KNOWN_COMMANDS = new Set([
  'list', 'start', 'open', 'stop', 'close', 'status',
  'get', 'info', 'update', 'edit',
  'random-fp', 'set-proxy', 'set-ext', 'test-proxy',
  'create', 'clone', 'delete', 'clear-cache', 'clean-cache',
  'group', 'set-group',
  'bookmark', 'bookmarks',
  'font', 'fonts',
  'theme', 'themes',
  'settings', 'setting',
  'batch-set-group', 'batch-delete', 'batch-random-fp',
  'cdp-url',
  'env', 'autostart',
  'compile', 'build-exe',
  'gui', 'start-gui', 'manager',
  'help', '--help', '-h'
]);

function printUsage() {
  console.log(`
================================================================================
   DT - 指纹浏览器：企业级控制台与自动化命令行管理工具 (DT-FP CLI)
================================================================================

常用管理命令 (支持 --json 结构化输出供自动化脚本解析):
  [环境启动与控制]
    dt-cli start --name "环境名" [--url 网址] [--headless] [--json] 启动浏览器并等待CDP就绪
    dt-cli start --id "env-xxxx" [--url 网址] [--json]              按环境ID启动
    dt-cli start --group "分组名" [--headless] [--json]             批量启动指定分组下的所有环境
    dt-cli start --names "A,B,C" [--headless] [--json]              批量启动指定名称或ID的环境
    dt-cli stop --name "环境名" [--json]                            停止指定浏览器环境
    dt-cli stop --group "分组名" [--json]                           停止指定业务分组下的所有环境
    dt-cli stop --all [--json]                                      一键停止全部正在运行的环境
    dt-cli status --name "环境名" [--json]                          查询环境运行状态、PID及CDP地址
    dt-cli cdp-url --name "环境名" [--ws] [--http] [--port]         直接获取并输出环境 CDP WebSocket 地址

  [环境配置与 CRUD]
    dt-cli list [--group 组名] [--search 关键词] [--running] [--json] 列出环境配置及其实时运行状态
    dt-cli get --name "环境名" [--json]                             查看环境完整配置与指纹详情 (别名: info)
    dt-cli create --name "新环境" [--group 组名] [--proxy 代理] [--proxy-scope all|rules] [--proxy-rules 规则] [--port 9222] [--url 网址] [--ext 插件] [--lang en-US] 创建新环境
    dt-cli update --name "环境名" [--new-name 新名] [--url 网址] [--group 组] [--port 端口] [--proxy 代理] [--proxy-scope 范围] [--proxy-rules 规则] [--ext 插件] 修改环境配置
    dt-cli clone --name "已有环境" [--new-name "新名"] [--json]     快速克隆环境 (继承设置并分配新端口与新指纹)
    dt-cli delete --name "环境名" [--json]                          删除环境配置
    dt-cli clear-cache [--name "环境名"|--group 组|--names A,B|--all] [--json] 深度清理环境用户缓存数据 (Cookies/Cache/LevelDB)

  [指纹与代理专项控制]
    dt-cli random-fp --name "环境名" [--json]                       一键随机重置硬件指纹 (运行中1秒内热生效)
    dt-cli set-proxy --name "环境名" --proxy "代理串" [--json]      设置代理 (自动识别4种主流代理格式)
    dt-cli set-proxy --name "环境名" --clear [--json]               清除代理 (切换为直连模式)
    dt-cli test-proxy --proxy "代理串" [--json]                     独立测试代理服务器连通性与网络延迟
    dt-cli test-proxy --name "环境名" [--json]                      测试已配置环境的代理连通性
    dt-cli set-ext --name "环境名" --ext "插件路径" [--json]        设置加载扩展插件 (支持多路径分号分割)

  [分组管理与批量操作]
    dt-cli group list [--json]                                      列出所有分组及各组环境统计
    dt-cli group add --name "分组名" [--json]                       新建业务分类分组
    dt-cli group delete --name "旧分组" [--json]                    删除分组 (安全防丢保护：自动归入默认分组)
    dt-cli group rename --name "A" --new-name "B" [--json]          重命名分组
    dt-cli set-group --name "环境名" --group "目标组" [--json]      移动环境至目标分组
    dt-cli batch-set-group --names "A,B,C" --group "组名" [--json]  批量移动环境至指定分组
    dt-cli batch-delete --names "A,B,C" [--json]                    批量删除多个环境 (安全跳过运行中环境)
    dt-cli batch-random-fp [--group 组名|--all|--names A,B] [--json] 批量重置多个环境的硬件指纹

  [书签/收藏夹管理 (横向收藏栏联动)]
    dt-cli bookmark list [--json]                                   查看当前浏览器横向书签列表
    dt-cli bookmark add --title "标题" --url "网址" [--json]        添加新网页书签至收藏夹
    dt-cli bookmark delete --id "bm-xxx" [--json]                   按ID或网址删除书签
    dt-cli bookmark clear [--json]                                  清空所有书签

  [字体与主题外观管理]
    dt-cli font list [--json]                                       列出 Fonts/ 目录中所有内置与本地字体
    dt-cli font status [--json]                                     查看当前系统界面所应用的字体
    dt-cli font set --name "字体文件名/family" [--json]             切换全局统一界面字体 (支持本地扩展)
    dt-cli theme list [--json]                                      列出全部 16 款主题皮肤配色代号
    dt-cli theme status [--json]                                    查看当前管理器与浏览器默认皮肤
    dt-cli theme set --browser "themeKey" [--manager "key"] [--json] 更改浏览器或管理器的默认主题外观

  [系统设置与构建工具]
    dt-cli settings [get] [--json]                                  查看系统全局配置信息
    dt-cli settings set [--browser-theme 皮肤] [--font 字体] [--json] 修改全局配置
    dt-cli env [--add] [--remove] [--status] [--json]               配置当前目录至系统用户 PATH 环境变量
    dt-cli autostart [--enable] [--disable] [--silent] [--json]     设置 Windows 开机自动启动与静默托盘
    dt-cli gui [--minimized]                                        启动可视化桌面管理器 (可选静默托盘模式)
    dt-cli compile [--json]                                         一键编译原生可执行文件 (无需安装开发工具)

  [Chrome 原生无感替代模式 (Drop-in Chrome Mode)]
    dt-cli --version                                                输出兼容的 Chrome 内核版本号
    dt-cli --remote-debugging-port=9222 [URL]                       直接作为独立 Chromium 运行 (支持自动化框架直连)
    dt-cli https://example.com                                      直接作为浏览器打开网页 (自动注入指纹)
`);
}

function parseArgs() {
  const rawArgs = process.argv.slice(2);
  const command = rawArgs[0];
  const options = {};
  const positional = [];

  for (let i = 1; i < rawArgs.length; i++) {
    const arg = rawArgs[i];
    if (arg.startsWith('--')) {
      const key = arg.slice(2);
      const eqIdx = key.indexOf('=');
      if (eqIdx !== -1) {
        options[key.slice(0, eqIdx)] = key.slice(eqIdx + 1).replace(/^["']|["']$/g, '');
      } else {
        const next = rawArgs[i + 1];
        if (next && !next.startsWith('--')) {
          options[key] = next;
          i++;
        } else {
          options[key] = true;
        }
      }
    } else if (arg.startsWith('-')) {
      options[arg.slice(1)] = true;
    } else {
      positional.push(arg);
    }
  }
  return { rawArgs, command, options, positional };
}

async function main() {
  const { rawArgs, command, options, positional } = parseArgs();

  // 1. Chrome 兼容版本探测 (供 Selenium / Chromedriver / Playwright 检测)
  if (rawArgs.includes('--version') || rawArgs.includes('-v') || rawArgs.includes('-V')) {
    console.log('Google Chrome 152.0.7977.130');
    return;
  }
  if (rawArgs.includes('--product-version')) {
    console.log('152.0.7977.130');
    return;
  }

  // 2. 帮助提示
  if (!command || command === 'help' || command === '--help' || command === '-h') {
    printUsage();
    return;
  }

  // 2.5 管理器 GUI 启动分支 (显式请求启动图形界面)
  if (command === 'gui' || command === 'start-gui' || command === 'manager' || rawArgs.includes('--gui') || rawArgs.includes('--minimized') || rawArgs.includes('--silent')) {
    const cp = require('node:child_process');
    const isAsar = __filename.includes('app.asar');
    const envVars = { ...process.env };
    delete envVars.ELECTRON_RUN_AS_NODE;

    const guiArgs = isAsar ? rawArgs : [path.resolve(__dirname, 'src/gui/main.js'), ...rawArgs];
    const child = cp.spawn(electronPath(), guiArgs, {
      detached: true,
      stdio: 'ignore',
      env: envVars
    });
    child.unref();
    console.log('已启动 DT - 指纹浏览器图形管理器');
    return;
  }

  // 3. Chrome 原生调用直通模式 (Direct Chrome Invocation Mode)
  // 严格要求：仅当外部自动化框架 (Playwright, Puppeteer, Selenium) 显式传递浏览器参数或 URL 时才启动直通浏览器
  const isDirectChromeInvocation = rawArgs.some(a => 
    a.startsWith('--remote-debugging-port') || 
    a.startsWith('--remote-debugging-pipe') || 
    a.startsWith('--user-data-dir') || 
    a.startsWith('--headless') || 
    a === '--browser-mode' ||
    a.startsWith('--browser-mode=') ||
    /^https?:\/\//i.test(a) ||
    /^file:\/\//i.test(a) ||
    a === 'about:blank'
  );

  if (!KNOWN_COMMANDS.has(command)) {
    if (isDirectChromeInvocation) {
      const cp = require('node:child_process');
      const browserEntry = path.resolve(__dirname, 'src/browser/main.js');
      const envVars = { ...process.env };
      delete envVars.ELECTRON_RUN_AS_NODE;

      const child = cp.spawn(electronPath(), ['--browser-mode', browserEntry, ...rawArgs], {
        stdio: 'inherit',
        env: envVars
      });
      child.on('exit', (code) => process.exit(code ?? 0));
      return;
    }

    console.error(`未知命令或参数: "${command}"\n输入 "dt-cli --help" 查看完整帮助说明。`);
    process.exit(1);
    return;
  }

  const nameOrId = options.name || options.id;
  const isJson = Boolean(options.json);

  switch (command) {
    case 'list': {
      let list = store.loadAll();
      if (options.group) {
        list = list.filter(env => (env.group || '默认分组') === options.group);
      }
      if (options.search) {
        const kw = String(options.search).toLowerCase();
        list = list.filter(env => 
          env.name.toLowerCase().includes(kw) || 
          env.id.toLowerCase().includes(kw) || 
          (env.url && env.url.toLowerCase().includes(kw)) || 
          (env.notes && env.notes.toLowerCase().includes(kw)) ||
          (env.proxy?.host && env.proxy.host.toLowerCase().includes(kw))
        );
      }
      const statusMap = processManager.getRunningStatus();
      if (options.running) {
        list = list.filter(env => Boolean(statusMap[env.id]));
      } else if (options.stopped) {
        list = list.filter(env => !statusMap[env.id]);
      }

      if (isJson) {
        const data = list.map(env => ({
          ...env,
          group: env.group || '默认分组',
          running: Boolean(statusMap[env.id]),
          runningInfo: statusMap[env.id] || null
        }));
        console.log(JSON.stringify({ code: 0, success: true, count: data.length, data }, null, 2));
        return;
      }

      console.log(`\n==== DT - 指纹环境列表 (共 ${list.length} 个${options.group ? `，筛选分组: ${options.group}` : ''}${options.search ? `，搜索: "${options.search}"` : ''}${options.running ? '，仅运行中' : ''}${options.stopped ? '，仅已停止' : ''}) ====`);
      list.forEach((env, index) => {
        const running = statusMap[env.id];
        const statusStr = running ? `🟢 运行中 [PID: ${running.pid} | CDP端口: ${running.port || '无'}]` : '⚪ 已停止';
        const fp = env.fp || {};
        const hwStr = `${fp.navigator?.hardwareConcurrency || '?'}核 / ${fp.navigator?.deviceMemory || '?'}G / ${fp.webgl?.renderer ? fp.webgl.renderer.slice(0, 30) + '...' : '默认显卡'}`;
        const proxyStr = env.proxy?.enabled ? `${env.proxy.type.toUpperCase()}://${env.proxy.host}:${env.proxy.port}` : '直连';

        console.log(`\n[${index + 1}] ${env.name} (ID: ${env.id}) [分组: ${env.group || '默认分组'}]`);
        console.log(`    状态: ${statusStr}`);
        console.log(`    调试端口: ${env.remotePortEnabled ? env.remotePort : '关闭'} | 语言: ${env.language}`);
        console.log(`    硬件指纹: ${hwStr}`);
        console.log(`    代理: ${proxyStr}`);
        console.log(`    插件: ${env.extensions || '未配置'}`);
        console.log(`    目标网址: ${env.url}`);
        console.log(`    数据目录: ${env.userDataDir}`);
      });
      console.log('\n');
      break;
    }

    case 'info':
    case 'get': {
      if (!nameOrId) {
        const msg = '请提供 --name 或 --id 参数指定环境';
        if (isJson) console.log(JSON.stringify({ code: 1, success: false, message: msg }));
        else console.error(`【错误】${msg}`);
        process.exit(1);
      }
      const env = store.getEnvironment(nameOrId);
      if (!env) {
        const msg = `未找到环境: ${nameOrId}`;
        if (isJson) console.log(JSON.stringify({ code: 1, success: false, message: msg }));
        else console.error(`❌ ${msg}`);
        process.exit(1);
      }
      const statusMap = processManager.getRunningStatus();
      const runningInfo = statusMap[env.id] || null;

      if (isJson) {
        console.log(JSON.stringify({
          code: 0,
          success: true,
          data: {
            ...env,
            running: Boolean(runningInfo),
            runningInfo
          }
        }, null, 2));
        return;
      }

      console.log(`\n==== 环境详细信息: "${env.name}" (ID: ${env.id}) ====`);
      console.log(`  所属分组: ${env.group || '默认分组'}`);
      console.log(`  运行状态: ${runningInfo ? `🟢 运行中 [PID: ${runningInfo.pid} | CDP端口: ${runningInfo.port || '无'}]` : '⚪ 已停止'}`);
      console.log(`  调试端口: ${env.remotePortEnabled ? env.remotePort : '关闭'}`);
      console.log(`  目标网址: ${env.url}`);
      console.log(`  语言/时区: ${env.language} / ${env.timezone || '默认'}`);
      console.log(`  备注说明: ${env.notes || '(无)'}`);
      const proxyStr = env.proxy?.enabled ? `${env.proxy.type.toUpperCase()}://${env.proxy.host}:${env.proxy.port} (范围: ${env.proxy.scope === 'rules' ? '指定URL' : '全局'})` : '直连 (未启用)';
      console.log(`  代理设置: ${proxyStr}`);
      console.log(`  扩展插件: ${env.extensions || '未配置'}`);
      console.log(`  数据目录: ${env.userDataDir}`);
      if (env.customArgs) console.log(`  自定义开关: ${env.customArgs}`);
      const fp = env.fp || {};
      console.log(`  指纹种子: ${fp.seed || '-'}`);
      console.log(`  操作系统/UA: ${fp.uaString || '-'}`);
      console.log(`  CPU/内存: ${fp.navigator?.hardwareConcurrency || '?'}核 / ${fp.navigator?.deviceMemory || '?'}G`);
      console.log(`  显卡渲染器: ${fp.webgl?.renderer || '-'}`);
      console.log(`  屏幕分辨率: ${fp.screen ? `${fp.screen.width}x${fp.screen.height}` : '-'}`);
      console.log(`  创建时间: ${env.createdAt || '-'}`);
      console.log(`  更新时间: ${env.updatedAt || '-'}\n`);
      break;
    }

    case 'open':
    case 'start': {
      if (options.group) {
        const allEnvs = store.loadAll().filter(e => (e.group || '默认分组') === options.group);
        const results = [];
        for (const e of allEnvs) {
          try {
            const r = await processManager.launch(e.id, {
              url: options.url || undefined,
              headless: Boolean(options.headless),
              args: options.args || undefined
            });
            results.push({ name: e.name, id: e.id, success: true, pid: r.pid, port: r.port });
          } catch (err) {
            results.push({ name: e.name, id: e.id, success: false, error: err.message });
          }
        }
        if (isJson) {
          console.log(JSON.stringify({ code: 0, success: true, message: `已启动分组 "${options.group}" 下的环境`, count: results.filter(r => r.success).length, data: results }, null, 2));
        } else {
          console.log(`🚀 已启动分组 "${options.group}" 下 ${results.filter(r => r.success).length} 个环境`);
        }
        return;
      }

      if (options.names || options.ids) {
        const raw = options.names || options.ids;
        const list = String(raw).split(',').map(s => s.trim()).filter(Boolean);
        const allEnvs = store.loadAll().filter(e => list.includes(e.id) || list.includes(e.name));
        const results = [];
        for (const e of allEnvs) {
          try {
            const r = await processManager.launch(e.id, {
              url: options.url || undefined,
              headless: Boolean(options.headless),
              args: options.args || undefined
            });
            results.push({ name: e.name, id: e.id, success: true, pid: r.pid, port: r.port });
          } catch (err) {
            results.push({ name: e.name, id: e.id, success: false, error: err.message });
          }
        }
        if (isJson) {
          console.log(JSON.stringify({ code: 0, success: true, message: `批量启动完成`, count: results.filter(r => r.success).length, data: results }, null, 2));
        } else {
          console.log(`🚀 批量启动完成：成功启动 ${results.filter(r => r.success).length} 个环境`);
        }
        return;
      }

      if (!nameOrId) {
        const msg = '请提供 --name 或 --id 参数指定要启动的环境，或使用 --group 批量启动指定分组，或使用 --names 批量启动多个环境';
        if (isJson) {
          console.log(JSON.stringify({ code: 1, success: false, message: msg }));
        } else {
          console.error(`【错误】${msg}`);
        }
        process.exit(1);
      }
      try {
        const launchOpts = {
          url: options.url || undefined,
          headless: Boolean(options.headless),
          args: options.args || undefined
        };
        const res = await processManager.launch(nameOrId, launchOpts);

        if (isJson) {
          console.log(JSON.stringify({
            code: 0,
            success: true,
            data: {
              id: res.env.id,
              name: res.env.name,
              pid: res.pid,
              port: res.port,
              http: res.http,
              ws: res.ws,
              alreadyRunning: Boolean(res.alreadyRunning)
            }
          }, null, 2));
        } else {
          console.log(`✅ ${res.message} (PID: ${res.pid})`);
          if (res.port) {
            console.log(`🔗 远程调试端口 (CDP): http://127.0.0.1:${res.port}`);
          }
          if (res.ws) {
            console.log(`🚀 WebSocket 调试地址: ${res.ws}`);
          }
        }
      } catch (e) {
        if (isJson) {
          console.log(JSON.stringify({ code: 1, success: false, message: e.message }));
        } else {
          console.error(`❌ 启动失败: ${e.message}`);
        }
        process.exit(1);
      }
      break;
    }

    case 'close':
    case 'stop': {
      if (options.all) {
        const res = await processManager.stopAll();
        if (isJson) {
          console.log(JSON.stringify({ code: 0, success: true, message: `已停止全部 ${res.count} 个运行中的环境`, count: res.count }));
        } else {
          console.log(`⏹️ 已停止全部 ${res.count} 个运行中的环境`);
        }
        return;
      }

      if (options.group) {
        const allEnvs = store.loadAll().filter(e => (e.group || '默认分组') === options.group);
        let stopped = 0;
        for (const e of allEnvs) {
          if (processManager.isRunning(e.id)) {
            await processManager.stop(e.id);
            stopped++;
          }
        }
        if (isJson) console.log(JSON.stringify({ code: 0, success: true, message: `已停止分组 "${options.group}" 下全部 ${stopped} 个环境`, count: stopped }));
        else console.log(`⏹️ 已停止分组 "${options.group}" 下全部 ${stopped} 个运行中的环境`);
        return;
      }

      if (!nameOrId) {
        const msg = '请提供 --name 或 --id 参数指定要停止的环境，或使用 --all 停止所有，或使用 --group 停止指定分组';
        if (isJson) {
          console.log(JSON.stringify({ code: 1, success: false, message: msg }));
        } else {
          console.error(`【错误】${msg}`);
        }
        process.exit(1);
      }
      try {
        const res = await processManager.stop(nameOrId);
        if (isJson) {
          console.log(JSON.stringify({ code: 0, success: true, message: res.message }));
        } else {
          console.log(`⏹️ ${res.message}`);
        }
      } catch (e) {
        if (isJson) {
          console.log(JSON.stringify({ code: 1, success: false, message: e.message }));
        } else {
          console.error(`❌ 停止失败: ${e.message}`);
        }
        process.exit(1);
      }
      break;
    }

    case 'status': {
      if (!nameOrId) {
        const msg = '请提供 --name 或 --id 参数指定环境';
        if (isJson) {
          console.log(JSON.stringify({ code: 1, success: false, message: msg }));
        } else {
          console.error(`【错误】${msg}`);
        }
        process.exit(1);
      }
      try {
        const env = store.getEnvironment(nameOrId);
        if (!env) throw new Error(`未找到环境: ${nameOrId}`);
        const statusMap = processManager.getRunningStatus();
        const info = statusMap[env.id] || null;

        if (isJson) {
          console.log(JSON.stringify({
            code: 0,
            success: true,
            data: {
              id: env.id,
              name: env.name,
              running: Boolean(info),
              info
            }
          }, null, 2));
        } else {
          console.log(`\n环境 "${env.name}" 运行状态:`);
          if (info) {
            console.log(`  🟢 运行中 [PID: ${info.pid}]`);
            console.log(`  🔗 CDP 端口: ${info.port || '未开启'}`);
            console.log(`  ⏱️ 启动时间: ${info.startedAt}`);
          } else {
            console.log(`  ⚪ 已停止`);
          }
        }
      } catch (e) {
        if (isJson) {
          console.log(JSON.stringify({ code: 1, success: false, message: e.message }));
        } else {
          console.error(`❌ 查询失败: ${e.message}`);
        }
        process.exit(1);
      }
      break;
    }

    case 'cdp-url': {
      if (!nameOrId) {
        const msg = '请提供 --name 或 --id 参数指定环境';
        if (isJson) console.log(JSON.stringify({ code: 1, success: false, message: msg }));
        else console.error(`【错误】${msg}`);
        process.exit(1);
      }
      const env = store.getEnvironment(nameOrId);
      if (!env) {
        const msg = `未找到环境: ${nameOrId}`;
        if (isJson) console.log(JSON.stringify({ code: 1, success: false, message: msg }));
        else console.error(`❌ ${msg}`);
        process.exit(1);
      }
      const statusMap = processManager.getRunningStatus();
      const info = statusMap[env.id];
      if (!info || !info.port) {
        const msg = `环境 "${env.name}" 尚未运行或未开启 CDP 端口`;
        if (isJson) console.log(JSON.stringify({ code: 1, success: false, message: msg }));
        else console.error(`❌ ${msg}`);
        process.exit(1);
      }
      if (options.port) {
        console.log(info.port);
        return;
      }
      if (options.http) {
        console.log(`http://127.0.0.1:${info.port}`);
        return;
      }
      try {
        const res = await fetch(`http://127.0.0.1:${info.port}/json/version`);
        const ver = await res.json();
        const wsUrl = ver.webSocketDebuggerUrl;
        if (isJson) {
          console.log(JSON.stringify({ code: 0, success: true, data: { port: info.port, http: `http://127.0.0.1:${info.port}`, ws: wsUrl } }, null, 2));
        } else {
          console.log(wsUrl || `http://127.0.0.1:${info.port}`);
        }
      } catch (_) {
        if (isJson) {
          console.log(JSON.stringify({ code: 0, success: true, data: { port: info.port, http: `http://127.0.0.1:${info.port}` } }, null, 2));
        } else {
          console.log(`http://127.0.0.1:${info.port}`);
        }
      }
      break;
    }

    case 'random-fp': {
      if (!nameOrId) {
        const msg = '请提供 --name 或 --id 参数指定要修改指纹的环境';
        if (isJson) {
          console.log(JSON.stringify({ code: 1, success: false, message: msg }));
        } else {
          console.error(`【错误】${msg}`);
        }
        process.exit(1);
      }
      try {
        const env = store.getEnvironment(nameOrId);
        if (!env) throw new Error(`未找到环境: ${nameOrId}`);
        const updated = store.regenerateFp(env.id, options.timezone);
        const running = processManager.isRunning(env.id);

        if (isJson) {
          console.log(JSON.stringify({
            code: 0,
            success: true,
            data: {
              id: updated.id,
              name: updated.name,
              seed: updated.fp.seed,
              hotReloaded: running,
              fp: updated.fp
            }
          }, null, 2));
        } else {
          console.log(`🎲 已成功为 "${updated.name}" 随机重置指纹！`);
          console.log(`   新 Seed: ${updated.fp.seed}`);
          console.log(`   CPU核心: ${updated.fp.navigator.hardwareConcurrency} | 内存: ${updated.fp.navigator.deviceMemory}G`);
          console.log(`   显卡: ${updated.fp.webgl.renderer}`);
          console.log(`   分辨率: ${updated.fp.screen.width}x${updated.fp.screen.height}`);
          if (running) {
            console.log('⚡ 该窗口当前处于运行中，新指纹将在 1 秒内自动热生效并刷新页面！');
          }
        }
      } catch (e) {
        if (isJson) {
          console.log(JSON.stringify({ code: 1, success: false, message: e.message }));
        } else {
          console.error(`❌ 修改指纹失败: ${e.message}`);
        }
        process.exit(1);
      }
      break;
    }

    case 'batch-random-fp': {
      let targetEnvs = [];
      const allEnvs = store.loadAll();
      if (options.group) {
        targetEnvs = allEnvs.filter(e => (e.group || '默认分组') === options.group);
      } else if (options.all) {
        targetEnvs = allEnvs;
      } else {
        const rawTargets = options.ids || options.names || options.targets;
        if (!rawTargets) {
          const msg = '请提供 --names 或 --ids 或 --group 或 --all 指定要重置指纹的环境';
          if (isJson) console.log(JSON.stringify({ code: 1, success: false, message: msg }));
          else console.error(`【错误】${msg}`);
          process.exit(1);
        }
        const targetList = String(rawTargets).split(',').map(s => s.trim()).filter(Boolean);
        targetEnvs = allEnvs.filter(e => targetList.includes(e.id) || targetList.includes(e.name));
      }
      let count = 0;
      for (const e of targetEnvs) {
        store.regenerateFp(e.id);
        count++;
      }
      if (isJson) {
        console.log(JSON.stringify({ code: 0, success: true, message: `已为 ${count} 个环境重新生成随机硬件指纹`, count }));
      } else {
        console.log(`🎲 批量重置指纹完成：已为 ${count} 个环境成功生成全新随机硬件指纹！`);
      }
      break;
    }

    case 'set-proxy': {
      if (!nameOrId) {
        const msg = '请提供 --name 或 --id 参数指定环境';
        if (isJson) {
          console.log(JSON.stringify({ code: 1, success: false, message: msg }));
        } else {
          console.error(`【错误】${msg}`);
        }
        process.exit(1);
      }
      const env = store.getEnvironment(nameOrId);
      if (!env) {
        const msg = `未找到环境: ${nameOrId}`;
        if (isJson) console.log(JSON.stringify({ code: 1, success: false, message: msg }));
        else console.error(`❌ ${msg}`);
        process.exit(1);
      }

      if (options.clear || options.proxy === 'none' || options.proxy === 'direct' || options.proxy === '') {
        const updated = store.updateEnvironment(env.id, {
          proxy: { enabled: false, type: 'socks5', host: '', port: '', username: '', password: '', rawString: '', scope: 'all', rules: '', bypass: '<local>;localhost;127.0.0.1' }
        });
        if (isJson) console.log(JSON.stringify({ code: 0, success: true, message: `已将环境 "${updated.name}" 设为直连模式`, data: updated.proxy }, null, 2));
        else console.log(`🌐 已将环境 "${updated.name}" 设为直连模式 (已关闭代理)`);
        break;
      }

      if (!options.proxy) {
        const msg = '请提供 --proxy 参数传入代理字符串，或使用 --clear 切换为直连';
        if (isJson) {
          console.log(JSON.stringify({ code: 1, success: false, message: msg }));
        } else {
          console.error(`【错误】${msg}`);
        }
        process.exit(1);
      }
      try {
        let proxyConfig = options.proxy;
        if (options.scope || options.rules !== undefined) {
          const { parseProxyString } = require('./src/manager/proxy-parser');
          const parsed = typeof proxyConfig === 'string' ? parseProxyString(proxyConfig) : (proxyConfig || {});
          if (parsed) {
            if (options.scope) parsed.scope = options.scope;
            if (options.rules !== undefined) parsed.rules = options.rules;
            proxyConfig = parsed;
          }
        }
        const updated = store.updateEnvironment(env.id, { proxy: proxyConfig });

        if (isJson) {
          console.log(JSON.stringify({ code: 0, success: true, data: updated.proxy }, null, 2));
        } else {
          console.log(`🌐 已为 "${updated.name}" 设置代理:`);
          console.log(`   类型: ${updated.proxy.type.toUpperCase()}`);
          console.log(`   主机: ${updated.proxy.host}:${updated.proxy.port}`);
          console.log(`   账号: ${updated.proxy.username || '(无)'}`);
          console.log(`   范围: ${updated.proxy.scope === 'rules' ? '指定URL' : '全局代理'}`);
          if (updated.proxy.scope === 'rules' && updated.proxy.rules) {
            console.log(`   规则: ${updated.proxy.rules}`);
          }
        }
      } catch (e) {
        if (isJson) {
          console.log(JSON.stringify({ code: 1, success: false, message: e.message }));
        } else {
          console.error(`❌ 设置代理失败: ${e.message}`);
        }
        process.exit(1);
      }
      break;
    }

    case 'test-proxy': {
      let proxyTarget = options.proxy;
      if (!proxyTarget && nameOrId) {
        const env = store.getEnvironment(nameOrId);
        if (env && env.proxy && env.proxy.enabled) {
          proxyTarget = env.proxy;
        } else if (env) {
          const msg = `环境 "${env.name}" 当前为直连模式，未配置代理`;
          if (isJson) console.log(JSON.stringify({ code: 1, success: false, message: msg }));
          else console.error(`【提示】${msg}`);
          process.exit(1);
        }
      }
      if (!proxyTarget) {
        const msg = '请通过 --proxy 传入代理字符串，或通过 --name 指定环境测试其代理配置';
        if (isJson) console.log(JSON.stringify({ code: 1, success: false, message: msg }));
        else console.error(`【错误】${msg}`);
        process.exit(1);
      }
      try {
        const { parseProxyString } = require('./src/manager/proxy-parser');
        const { testProxy } = require('./src/manager/proxy-tester');
        const proxyConfig = typeof proxyTarget === 'string' ? parseProxyString(proxyTarget) : proxyTarget;
        if (!proxyConfig || !proxyConfig.host || !proxyConfig.port) {
          throw new Error('代理格式解析失败，请检查主机与端口格式');
        }
        if (!isJson) {
          console.log(`📡 正在测试代理服务器连通性 [${proxyConfig.type.toUpperCase()}://${proxyConfig.host}:${proxyConfig.port}]...`);
        }
        const result = await testProxy(proxyConfig);
        if (isJson) {
          console.log(JSON.stringify({
            code: result.success ? 0 : 1,
            success: result.success,
            latency: result.latency || null,
            message: result.message,
            proxy: {
              type: proxyConfig.type,
              host: proxyConfig.host,
              port: proxyConfig.port,
              username: proxyConfig.username || ''
            }
          }, null, 2));
        } else {
          if (result.success) {
            console.log(`✅ 代理连通成功！延迟: ${result.latency}ms`);
            console.log(`   ${result.message}`);
          } else {
            console.error(`❌ 代理连接失败: ${result.message}`);
          }
        }
        if (!result.success) process.exit(1);
      } catch (e) {
        if (isJson) console.log(JSON.stringify({ code: 1, success: false, message: e.message }));
        else console.error(`❌ 测试代理出错: ${e.message}`);
        process.exit(1);
      }
      break;
    }

    case 'set-ext': {
      if (!nameOrId) {
        const msg = '请提供 --name 或 --id 参数指定环境';
        if (isJson) {
          console.log(JSON.stringify({ code: 1, success: false, message: msg }));
        } else {
          console.error(`【错误】${msg}`);
        }
        process.exit(1);
      }
      const extVal = options.ext || options.extensions;
      if (!extVal && !options.clear) {
        const msg = '请提供 --ext 或 --extensions 参数传入插件路径，或使用 --clear 清空插件';
        if (isJson) {
          console.log(JSON.stringify({ code: 1, success: false, message: msg }));
        } else {
          console.error(`【错误】${msg}`);
        }
        process.exit(1);
      }
      try {
        const env = store.getEnvironment(nameOrId);
        if (!env) throw new Error(`未找到环境: ${nameOrId}`);
        const updated = store.updateEnvironment(env.id, { extensions: options.clear ? '' : extVal });

        if (isJson) {
          console.log(JSON.stringify({ code: 0, success: true, data: { extensions: updated.extensions } }, null, 2));
        } else {
          console.log(`🧩 已为 "${updated.name}" 设置扩展插件路径:`);
          console.log(`   ${updated.extensions || '(已清空)'}`);
        }
      } catch (e) {
        if (isJson) {
          console.log(JSON.stringify({ code: 1, success: false, message: e.message }));
        } else {
          console.error(`❌ 设置插件失败: ${e.message}`);
        }
        process.exit(1);
      }
      break;
    }

    case 'create': {
      if (!options.name) {
        const msg = '请提供 --name 指定新环境名称';
        if (isJson) {
          console.log(JSON.stringify({ code: 1, success: false, message: msg }));
        } else {
          console.error(`【错误】${msg}`);
        }
        process.exit(1);
      }
      try {
        const extVal = options.ext || options.extensions;
        const portDisabled = Boolean(options['no-port'] || options['disable-port']);
        let proxyConfig = options.proxy || undefined;
        if (proxyConfig && (options['proxy-scope'] || options['proxy-rules'] !== undefined)) {
          const { parseProxyString } = require('./src/manager/proxy-parser');
          const parsed = typeof proxyConfig === 'string' ? parseProxyString(proxyConfig) : proxyConfig;
          if (parsed) {
            if (options['proxy-scope']) parsed.scope = options['proxy-scope'];
            if (options['proxy-rules'] !== undefined) parsed.rules = options['proxy-rules'];
            proxyConfig = parsed;
          }
        }
        const created = store.addEnvironment({
          name: options.name,
          group: options.group || '默认分组',
          notes: options.notes || undefined,
          remotePortEnabled: !portDisabled,
          remotePort: portDisabled ? null : options.port,
          url: options.url || 'dt://fingerprint-test',
          language: options.lang || 'en-US',
          timezone: options.timezone || 'America/New_York',
          proxy: proxyConfig,
          extensions: extVal || undefined,
          customArgs: options.args || undefined
        });

        if (isJson) {
          console.log(JSON.stringify({ code: 0, success: true, data: created }, null, 2));
        } else {
          console.log(`✅ 成功创建新环境: "${created.name}" (ID: ${created.id}, 端口: ${created.remotePort}, 分组: ${created.group || '默认分组'})`);
          if (created.proxy && created.proxy.enabled) {
            console.log(`   代理已自动识别配置: ${created.proxy.type.toUpperCase()}://${created.proxy.host}:${created.proxy.port}`);
            if (created.proxy.scope === 'rules' && created.proxy.rules) {
              console.log(`   代理生效规则: ${created.proxy.rules}`);
            }
          }
          if (created.extensions) {
            console.log(`   扩展插件: ${created.extensions}`);
          }
        }
      } catch (e) {
        if (isJson) {
          console.log(JSON.stringify({ code: 1, success: false, message: e.message }));
        } else {
          console.error(`❌ 创建失败: ${e.message}`);
        }
        process.exit(1);
      }
      break;
    }

    case 'edit':
    case 'update': {
      if (!nameOrId) {
        const msg = '请提供 --name 或 --id 参数指定要修改的环境';
        if (isJson) console.log(JSON.stringify({ code: 1, success: false, message: msg }));
        else console.error(`【错误】${msg}`);
        process.exit(1);
      }
      try {
        const env = store.getEnvironment(nameOrId);
        if (!env) throw new Error(`未找到环境: ${nameOrId}`);

        const updates = {};
        if (options['new-name']) updates.name = options['new-name'];
        if (options.url) updates.url = options.url;
        if (options.group) updates.group = options.group;
        if (options.notes !== undefined) updates.notes = options.notes;
        if (options.lang) updates.language = options.lang;
        if (options.timezone) updates.timezone = options.timezone;
        if (options.port) {
          updates.remotePort = Number(options.port);
          updates.remotePortEnabled = true;
        }
        if (options['no-port'] || options['disable-port']) {
          updates.remotePortEnabled = false;
        }
        if (options.args !== undefined) updates.customArgs = options.args;
        if (options['clear-ext']) updates.extensions = '';
        else if (options.ext || options.extensions) updates.extensions = options.ext || options.extensions;

        if (options['clear-proxy'] || options.proxy === 'none' || options.proxy === 'direct' || options.proxy === '') {
          updates.proxy = { enabled: false, type: 'socks5', host: '', port: '', username: '', password: '', rawString: '', scope: 'all', rules: '', bypass: '<local>;localhost;127.0.0.1' };
        } else if (options.proxy) {
          let p = options.proxy;
          if (options['proxy-scope'] || options['proxy-rules'] !== undefined) {
            const { parseProxyString } = require('./src/manager/proxy-parser');
            const parsed = typeof p === 'string' ? parseProxyString(p) : p;
            if (parsed) {
              if (options['proxy-scope']) parsed.scope = options['proxy-scope'];
              if (options['proxy-rules'] !== undefined) parsed.rules = options['proxy-rules'];
              p = parsed;
            }
          }
          updates.proxy = p;
        } else if (options['proxy-scope'] || options['proxy-rules'] !== undefined) {
          const curProxy = env.proxy ? { ...env.proxy } : {};
          if (options['proxy-scope']) curProxy.scope = options['proxy-scope'];
          if (options['proxy-rules'] !== undefined) curProxy.rules = options['proxy-rules'];
          updates.proxy = curProxy;
        }

        const updated = store.updateEnvironment(env.id, updates);
        if (isJson) {
          console.log(JSON.stringify({ code: 0, success: true, message: `成功更新环境: "${updated.name}"`, data: updated }, null, 2));
        } else {
          console.log(`✅ 成功更新环境 "${updated.name}" 配置！`);
        }
      } catch (e) {
        if (isJson) console.log(JSON.stringify({ code: 1, success: false, message: e.message }));
        else console.error(`❌ 更新失败: ${e.message}`);
        process.exit(1);
      }
      break;
    }

    case 'clone': {
      if (!nameOrId) {
        const msg = '请提供 --name 或 --id 指定要复制的环境';
        if (isJson) {
          console.log(JSON.stringify({ code: 1, success: false, message: msg }));
        } else {
          console.error(`【错误】${msg}`);
        }
        process.exit(1);
      }
      try {
        const env = store.getEnvironment(nameOrId);
        if (!env) throw new Error(`未找到环境: ${nameOrId}`);
        const cloned = store.cloneEnvironment(env.id, options['new-name']);

        if (isJson) {
          console.log(JSON.stringify({ code: 0, success: true, data: cloned }, null, 2));
        } else {
          console.log(`📋 成功克隆环境: "${cloned.name}" (新端口: ${cloned.remotePort})`);
        }
      } catch (e) {
        if (isJson) {
          console.log(JSON.stringify({ code: 1, success: false, message: e.message }));
        } else {
          console.error(`❌ 复制失败: ${e.message}`);
        }
        process.exit(1);
      }
      break;
    }

    case 'delete': {
      if (!nameOrId) {
        const msg = '请提供 --name 或 --id 指定要删除的环境';
        if (isJson) {
          console.log(JSON.stringify({ code: 1, success: false, message: msg }));
        } else {
          console.error(`【错误】${msg}`);
        }
        process.exit(1);
      }
      try {
        const env = store.getEnvironment(nameOrId);
        if (!env) throw new Error(`未找到环境: ${nameOrId}`);
        if (processManager.isRunning(env.id)) {
          throw new Error(`环境 "${env.name}" 正在运行中，为保障数据安全禁止删除，请先停止运行！`);
        }
        store.deleteEnvironment(env.id);

        if (isJson) {
          console.log(JSON.stringify({ code: 0, success: true, message: `成功删除环境: "${env.name}"` }));
        } else {
          console.log(`🗑️ 成功删除环境: "${env.name}"`);
        }
      } catch (e) {
        if (isJson) {
          console.log(JSON.stringify({ code: 1, success: false, message: e.message }));
        } else {
          console.error(`❌ 删除失败: ${e.message}`);
        }
        process.exit(1);
      }
      break;
    }

    case 'clean-cache':
    case 'clear-cache': {
      if (options.all) {
        const allEnvs = store.loadAll();
        let cleaned = 0;
        for (const e of allEnvs) {
          if (!processManager.isRunning(e.id)) {
            store.clearEnvironmentCache(e.id);
            cleaned++;
          }
        }
        if (isJson) console.log(JSON.stringify({ code: 0, success: true, message: `已清理 ${cleaned} 个离线环境的缓存数据`, cleanedCount: cleaned }));
        else console.log(`🧹 已成功清理 ${cleaned} 个离线环境的用户缓存！`);
        return;
      }

      if (options.group) {
        const allEnvs = store.loadAll().filter(e => (e.group || '默认分组') === options.group);
        let cleaned = 0;
        let skipped = 0;
        for (const e of allEnvs) {
          if (!processManager.isRunning(e.id)) {
            store.clearEnvironmentCache(e.id);
            cleaned++;
          } else {
            skipped++;
          }
        }
        if (isJson) console.log(JSON.stringify({ code: 0, success: true, message: `已清理分组 "${options.group}" 下 ${cleaned} 个离线环境的缓存数据`, cleanedCount: cleaned, skippedCount: skipped }));
        else console.log(`🧹 已成功清理分组 "${options.group}" 下 ${cleaned} 个环境缓存${skipped ? ` (跳过 ${skipped} 个运行中环境)` : ''}！`);
        return;
      }

      if (options.names || options.ids) {
        const raw = options.names || options.ids;
        const list = String(raw).split(',').map(s => s.trim()).filter(Boolean);
        const allEnvs = store.loadAll().filter(e => list.includes(e.id) || list.includes(e.name));
        let cleaned = 0;
        let skipped = 0;
        for (const e of allEnvs) {
          if (!processManager.isRunning(e.id)) {
            store.clearEnvironmentCache(e.id);
            cleaned++;
          } else {
            skipped++;
          }
        }
        if (isJson) console.log(JSON.stringify({ code: 0, success: true, message: `已清理 ${cleaned} 个环境缓存`, cleanedCount: cleaned, skippedCount: skipped }));
        else console.log(`🧹 批量清理完成：已清理 ${cleaned} 个环境缓存${skipped ? ` (跳过 ${skipped} 个运行中环境)` : ''}！`);
        return;
      }

      if (!nameOrId) {
        const msg = '请提供 --name 或 --id 指定要清理缓存的环境，或使用 --group 指定分组，或使用 --names 批量清理，或使用 --all 清理全部离线环境';
        if (isJson) console.log(JSON.stringify({ code: 1, success: false, message: msg }));
        else console.error(`【错误】${msg}`);
        process.exit(1);
      }
      try {
        const env = store.getEnvironment(nameOrId);
        if (!env) throw new Error(`未找到环境: ${nameOrId}`);
        if (processManager.isRunning(env.id)) {
          throw new Error(`环境 "${env.name}" 正在运行中，为防文件锁冲突，请先停止运行后再清理缓存！`);
        }
        store.clearEnvironmentCache(env.id);
        if (isJson) {
          console.log(JSON.stringify({ code: 0, success: true, message: `已成功清理环境 "${env.name}" 的独立缓存数据` }));
        } else {
          console.log(`🧹 已成功清理环境 "${env.name}" 的所有本地独立缓存数据 (Cookies/Cache/LevelDB)！`);
        }
      } catch (e) {
        if (isJson) console.log(JSON.stringify({ code: 1, success: false, message: e.message }));
        else console.error(`❌ 清理缓存失败: ${e.message}`);
        process.exit(1);
      }
      break;
    }

    case 'group': {
      const subAction = positional[0] || (options.add ? 'add' : options.delete ? 'delete' : options.rename ? 'rename' : 'list');
      const allEnvs = store.loadAll();
      const groups = store.getGroups();

      if (subAction === 'list') {
        const groupStats = groups.map(g => {
          const count = allEnvs.filter(e => (e.group || '默认分组') === g).length;
          return { name: g, count, isDefault: g === '默认分组' };
        });
        if (isJson) {
          console.log(JSON.stringify({ code: 0, success: true, count: groupStats.length, data: groupStats }, null, 2));
        } else {
          console.log(`\n==== DT - 环境分组列表 (共 ${groups.length} 个) ====`);
          groupStats.forEach((g, idx) => {
            console.log(`  [${idx + 1}] 📁 ${g.name} (${g.count} 个环境)${g.isDefault ? ' [系统默认]' : ''}`);
          });
          console.log('\n');
        }
        break;
      }

      if (subAction === 'add') {
        const groupName = options.name || positional[1];
        if (!groupName) {
          const msg = '请提供 --name 参数指定新分组名称';
          if (isJson) console.log(JSON.stringify({ code: 1, success: false, message: msg }));
          else console.error(`【错误】${msg}`);
          process.exit(1);
        }
        try {
          const res = store.addGroup(groupName);
          if (isJson) {
            console.log(JSON.stringify({ code: 0, success: true, message: `成功创建分组: ${res.name}`, data: res }, null, 2));
          } else {
            console.log(`✅ 成功建立新分组: "${res.name}"`);
          }
        } catch (e) {
          if (isJson) console.log(JSON.stringify({ code: 1, success: false, message: e.message }));
          else console.error(`❌ 添加分组失败: ${e.message}`);
          process.exit(1);
        }
        break;
      }

      if (subAction === 'delete') {
        const groupName = options.name || positional[1];
        if (!groupName) {
          const msg = '请提供 --name 参数指定要删除的分组名称';
          if (isJson) console.log(JSON.stringify({ code: 1, success: false, message: msg }));
          else console.error(`【错误】${msg}`);
          process.exit(1);
        }
        try {
          const res = store.deleteGroup(groupName);
          if (isJson) {
            console.log(JSON.stringify({ code: 0, success: true, message: `成功删除分组 "${res.deletedGroup}"，${res.migratedCount} 个环境已安全转移至默认分组`, data: res }, null, 2));
          } else {
            console.log(`🗑️ 成功删除分组: "${res.deletedGroup}" (该分组下的 ${res.migratedCount} 个环境已自动安全转移至 "默认分组")`);
          }
        } catch (e) {
          if (isJson) console.log(JSON.stringify({ code: 1, success: false, message: e.message }));
          else console.error(`❌ 删除分组失败: ${e.message}`);
          process.exit(1);
        }
        break;
      }

      if (subAction === 'rename') {
        const oldName = options.name || positional[1];
        const newName = options['new-name'] || positional[2];
        if (!oldName || !newName) {
          const msg = '请提供 --name 原分组名 和 --new-name 新分组名';
          if (isJson) console.log(JSON.stringify({ code: 1, success: false, message: msg }));
          else console.error(`【错误】${msg}`);
          process.exit(1);
        }
        try {
          const res = store.renameGroup(oldName, newName);
          if (isJson) {
            console.log(JSON.stringify({ code: 0, success: true, message: `成功将分组 "${oldName}" 重命名为 "${newName}"`, data: res }, null, 2));
          } else {
            console.log(`✏️ 成功将分组 "${oldName}" 重命名为 "${newName}" (已同步更新 ${res.migratedCount} 个环境)`);
          }
        } catch (e) {
          if (isJson) console.log(JSON.stringify({ code: 1, success: false, message: e.message }));
          else console.error(`❌ 重命名分组失败: ${e.message}`);
          process.exit(1);
        }
        break;
      }

      console.error(`未知分组子命令: ${subAction}。可用子命令: list, add, delete, rename`);
      process.exit(1);
    }

    case 'set-group': {
      if (!nameOrId) {
        const msg = '请提供 --name 或 --id 参数指定环境';
        if (isJson) console.log(JSON.stringify({ code: 1, success: false, message: msg }));
        else console.error(`【错误】${msg}`);
        process.exit(1);
      }
      const targetGroup = options.group;
      if (!targetGroup) {
        const msg = '请提供 --group 参数指定目标分组名称';
        if (isJson) console.log(JSON.stringify({ code: 1, success: false, message: msg }));
        else console.error(`【错误】${msg}`);
        process.exit(1);
      }
      try {
        const env = store.getEnvironment(nameOrId);
        if (!env) throw new Error(`未找到环境: ${nameOrId}`);
        const updated = store.updateEnvironment(env.id, { group: targetGroup });
        if (isJson) {
          console.log(JSON.stringify({ code: 0, success: true, data: { id: updated.id, name: updated.name, group: updated.group } }, null, 2));
        } else {
          console.log(`📁 已成功将环境 "${updated.name}" 移动至分组: "${updated.group}"`);
        }
      } catch (e) {
        if (isJson) console.log(JSON.stringify({ code: 1, success: false, message: e.message }));
        else console.error(`❌ 设置分组失败: ${e.message}`);
        process.exit(1);
      }
      break;
    }

    case 'batch-set-group': {
      const group = options.group;
      if (!group) {
        const msg = '请提供 --group 参数指定目标分组';
        if (isJson) console.log(JSON.stringify({ code: 1, success: false, message: msg }));
        else console.error(`【错误】${msg}`);
        process.exit(1);
      }
      const rawTargets = options.ids || options.names || options.targets;
      if (!rawTargets) {
        const msg = '请提供 --ids 或 --names 指定环境，以逗号分隔';
        if (isJson) console.log(JSON.stringify({ code: 1, success: false, message: msg }));
        else console.error(`【错误】${msg}`);
        process.exit(1);
      }
      const allEnvs = store.loadAll();
      const targetList = String(rawTargets).split(',').map(s => s.trim()).filter(Boolean);
      const matchedIds = allEnvs.filter(e => targetList.includes(e.id) || targetList.includes(e.name)).map(e => e.id);
      if (matchedIds.length === 0) {
        const msg = '未找到匹配的环境';
        if (isJson) console.log(JSON.stringify({ code: 1, success: false, message: msg }));
        else console.error(`❌ ${msg}`);
        process.exit(1);
      }
      const count = store.batchSetGroup(matchedIds, group);
      if (isJson) {
        console.log(JSON.stringify({ code: 0, success: true, message: `已成功将 ${count} 个环境移动至分组 "${group}"`, count }));
      } else {
        console.log(`📁 批量操作完成：已将 ${count} 个环境成功移动至分组 "${group}"！`);
      }
      break;
    }

    case 'batch-delete': {
      const rawTargets = options.ids || options.names || options.targets;
      if (!rawTargets) {
        const msg = '请提供 --ids 或 --names 指定要删除的环境，以逗号分隔';
        if (isJson) console.log(JSON.stringify({ code: 1, success: false, message: msg }));
        else console.error(`【错误】${msg}`);
        process.exit(1);
      }
      const allEnvs = store.loadAll();
      const targetList = String(rawTargets).split(',').map(s => s.trim()).filter(Boolean);
      const matchedEnvs = allEnvs.filter(e => targetList.includes(e.id) || targetList.includes(e.name));
      let deleted = 0;
      let skipped = 0;
      for (const e of matchedEnvs) {
        if (processManager.isRunning(e.id)) {
          skipped++;
          continue;
        }
        store.deleteEnvironment(e.id);
        deleted++;
      }
      if (isJson) {
        console.log(JSON.stringify({ code: 0, success: true, message: `已删除 ${deleted} 个环境${skipped ? ` (${skipped}个运行中跳过)` : ''}`, deletedCount: deleted, skippedCount: skipped }));
      } else {
        console.log(`🗑️ 批量删除完成：已删除 ${deleted} 个环境${skipped ? ` (跳过 ${skipped} 个正在运行中的环境)` : ''}！`);
      }
      break;
    }

    case 'bookmarks':
    case 'bookmark': {
      const subAction = positional[0] || (options.add ? 'add' : options.delete ? 'delete' : options.clear ? 'clear' : 'list');
      const curBookmarks = store.loadBookmarks();

      if (subAction === 'list') {
        if (isJson) {
          console.log(JSON.stringify({ code: 0, success: true, count: curBookmarks.length, data: curBookmarks }, null, 2));
        } else {
          console.log(`\n==== DT - 浏览器收藏夹书签列表 (共 ${curBookmarks.length} 个) ====`);
          curBookmarks.forEach((b, idx) => {
            console.log(`  [${idx + 1}] ⭐ ${b.title || '未命名'} (ID: ${b.id})`);
            console.log(`      网址: ${b.url}`);
          });
          console.log('\n');
        }
        break;
      }

      if (subAction === 'add') {
        const title = options.title || positional[1] || '新书签';
        let url = options.url || positional[2];
        if (!url) {
          const msg = '请提供 --url 参数指定书签网址';
          if (isJson) console.log(JSON.stringify({ code: 1, success: false, message: msg }));
          else console.error(`【错误】${msg}`);
          process.exit(1);
        }
        if (!/^(https?|about|chrome-extension):\/\//i.test(url)) {
          url = 'https://' + url;
        }
        const newBm = {
          id: 'bm-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6),
          title: String(title).trim(),
          url: String(url).trim(),
          createdAt: Date.now()
        };
        curBookmarks.push(newBm);
        store.saveBookmarks(curBookmarks);

        if (isJson) {
          console.log(JSON.stringify({ code: 0, success: true, message: `成功添加书签: "${newBm.title}"`, data: newBm }, null, 2));
        } else {
          console.log(`⭐ 成功添加书签: "${newBm.title}" -> ${newBm.url}`);
        }
        break;
      }

      if (subAction === 'delete' || subAction === 'del' || subAction === 'remove') {
        const target = options.id || options.url || options.title || positional[1];
        if (!target) {
          const msg = '请提供 --id 或 --url 或 --title 指定要删除的书签';
          if (isJson) console.log(JSON.stringify({ code: 1, success: false, message: msg }));
          else console.error(`【错误】${msg}`);
          process.exit(1);
        }
        const initialCount = curBookmarks.length;
        const filtered = curBookmarks.filter(b => b.id !== target && b.url !== target && b.title !== target);
        if (filtered.length === initialCount) {
          const msg = `未找到匹配书签: ${target}`;
          if (isJson) console.log(JSON.stringify({ code: 1, success: false, message: msg }));
          else console.error(`❌ ${msg}`);
          process.exit(1);
        }
        store.saveBookmarks(filtered);
        const deletedCount = initialCount - filtered.length;
        if (isJson) {
          console.log(JSON.stringify({ code: 0, success: true, message: `成功删除 ${deletedCount} 个书签`, deletedCount }));
        } else {
          console.log(`🗑️ 成功删除 ${deletedCount} 个书签！`);
        }
        break;
      }

      if (subAction === 'clear') {
        store.saveBookmarks([]);
        if (isJson) {
          console.log(JSON.stringify({ code: 0, success: true, message: '已清空所有书签' }));
        } else {
          console.log('🗑️ 已成功清空所有书签！');
        }
        break;
      }

      console.error(`未知书签子命令: ${subAction}。可用子命令: list, add, delete, clear`);
      process.exit(1);
    }

    case 'fonts':
    case 'font': {
      const subAction = positional[0] || (options.set ? 'set' : options.list ? 'list' : 'status');
      if (subAction === 'list') {
        const fonts = store.getAvailableFonts();
        const active = store.getActiveFontInfo();
        if (isJson) {
          console.log(JSON.stringify({ code: 0, success: true, activeFont: active, count: fonts.length, data: fonts }, null, 2));
        } else {
          console.log(`\n==== DT - 可用字体库列表 (共 ${fonts.length} 种) ====`);
          fonts.forEach((f, idx) => {
            const isCur = f.id === active.id;
            console.log(`  [${idx + 1}] 🔤 ${f.name} [ID: ${f.id}]${isCur ? ' 🟢 [当前使用中]' : ''}`);
            if (f.filePath) console.log(`      文件路径: ${f.filePath}`);
          });
          console.log('\n');
        }
        break;
      }

      if (subAction === 'set') {
        const fontNameOrId = options.name || options.id || positional[1];
        if (!fontNameOrId) {
          const msg = '请提供 --name 或 --id 参数指定要应用的字体 (或使用 system-default 恢复系统默认)';
          if (isJson) console.log(JSON.stringify({ code: 1, success: false, message: msg }));
          else console.error(`【错误】${msg}`);
          process.exit(1);
        }
        const fonts = store.getAvailableFonts();
        const matched = fonts.find(f => f.id === fontNameOrId || f.name === fontNameOrId || (f.fileName && f.fileName.includes(fontNameOrId)));
        if (!matched && fontNameOrId !== 'system-default') {
          const msg = `未在 Fonts/ 目录中找到匹配字体: "${fontNameOrId}"`;
          if (isJson) console.log(JSON.stringify({ code: 1, success: false, message: msg }));
          else console.error(`❌ ${msg}`);
          process.exit(1);
        }
        const targetId = matched ? matched.id : 'system-default';
        store.updateSettings({ fontFamily: targetId, font: targetId });
        const updatedInfo = store.getActiveFontInfo();
        if (isJson) {
          console.log(JSON.stringify({ code: 0, success: true, message: `成功切换全局字体为: ${updatedInfo.name}`, data: updatedInfo }, null, 2));
        } else {
          console.log(`🔤 成功切换全局字体为: "${updatedInfo.name}"！管理器与浏览器界面已同步应用。`);
        }
        break;
      }

      // status
      const active = store.getActiveFontInfo();
      if (isJson) {
        console.log(JSON.stringify({ code: 0, success: true, data: active }, null, 2));
      } else {
        console.log(`\n当前活跃字体: ${active.name} [ID: ${active.id}]`);
        if (active.filePath) console.log(`字体文件: ${active.filePath}`);
        console.log('提示: 使用 `DT-CLI.exe font list` 列出所有字体，`DT-CLI.exe font set --name "字体名"` 进行切换。\n');
      }
      break;
    }

    case 'themes':
    case 'theme': {
      const THEMES_LIST = [
        { key: 'dark', name: '经典深色 · 曜石极夜', type: 'classic' },
        { key: 'light', name: '极简浅色 · 象牙素雅', type: 'classic' },
        { key: 'red', name: '赤 · 绯霞柔粉', type: 'soft' },
        { key: 'orange', name: '暖阳杏橙', type: 'soft' },
        { key: 'yellow', name: '暖玉麦金', type: 'soft' },
        { key: 'green', name: '翠竹松影', type: 'soft' },
        { key: 'cyan', name: '碧水青瓷', type: 'soft' },
        { key: 'blue', name: '极光霁蓝', type: 'soft' },
        { key: 'purple', name: '幽夜紫罗', type: 'soft' },
        { key: 'red-dark', name: '赤 · 沉稳红木 (深)', type: 'dark' },
        { key: 'orange-dark', name: '橙 · 焦糖琥珀 (深)', type: 'dark' },
        { key: 'yellow-dark', name: '黄 · 曜石麦金 (深)', type: 'dark' },
        { key: 'green-dark', name: '绿 · 深林松柏 (深)', type: 'dark' },
        { key: 'cyan-dark', name: '青 · 黛色青瓷 (深)', type: 'dark' },
        { key: 'blue-dark', name: '蓝 · 深海群青 (深)', type: 'dark' },
        { key: 'purple-dark', name: '紫 · 幽夜紫晶 (深)', type: 'dark' }
      ];
      const subAction = positional[0] || (options.set ? 'set' : options.list ? 'list' : 'status');

      if (subAction === 'list') {
        if (isJson) {
          console.log(JSON.stringify({ code: 0, success: true, count: THEMES_LIST.length, data: THEMES_LIST }, null, 2));
        } else {
          console.log(`\n==== DT - 可用外观皮肤列表 (共 ${THEMES_LIST.length} 套) ====`);
          THEMES_LIST.forEach((t, idx) => {
            console.log(`  [${idx + 1}] 🎨 ${t.name} (Key: ${t.key})`);
          });
          console.log('\n');
        }
        break;
      }

      if (subAction === 'set') {
        const targetTheme = options.browser || options.name || options.key || positional[1];
        if (!targetTheme) {
          const msg = '请提供 --browser 或 --name 参数指定皮肤代号 (如 dark, light, blue, purple-dark)';
          if (isJson) console.log(JSON.stringify({ code: 1, success: false, message: msg }));
          else console.error(`【错误】${msg}`);
          process.exit(1);
        }
        const updates = {};
        if (targetTheme) updates.browserTheme = targetTheme;
        if (options.manager) updates.managerTheme = options.manager;
        store.updateSettings(updates);
        if (isJson) {
          console.log(JSON.stringify({ code: 0, success: true, message: `成功更新外观主题`, data: updates }, null, 2));
        } else {
          console.log(`🎨 成功设置默认主题外观: ${targetTheme}！`);
        }
        break;
      }

      const settings = store.getSettings();
      if (isJson) {
        console.log(JSON.stringify({ code: 0, success: true, data: { browserTheme: settings.browserTheme || 'dark', managerTheme: settings.managerTheme || 'dark' } }, null, 2));
      } else {
        console.log(`\n当前外观主题: 浏览器默认 = ${settings.browserTheme || 'dark'} | 管理器 = ${settings.managerTheme || 'dark'}`);
        console.log('提示: 使用 `DT-CLI.exe theme list` 列出所有主题，`DT-CLI.exe theme set --browser <key>` 更改。\n');
      }
      break;
    }

    case 'setting':
    case 'settings': {
      const subAction = positional[0] || (options.set ? 'set' : 'get');
      if (subAction === 'set') {
        const updates = {};
        if (options['browser-theme']) updates.browserTheme = options['browser-theme'];
        if (options['manager-theme']) updates.managerTheme = options['manager-theme'];
        if (options.font) {
          updates.font = options.font;
          updates.fontFamily = options.font;
        }
        if (options.url) updates.defaultUrl = options.url;
        const updated = store.updateSettings(updates);
        if (isJson) console.log(JSON.stringify({ code: 0, success: true, message: '已更新系统设置', data: updated }, null, 2));
        else console.log('⚙️ 已成功更新系统全局设置！');
        break;
      }
      const curSettings = store.getSettings();
      if (isJson) {
        console.log(JSON.stringify({ code: 0, success: true, data: curSettings }, null, 2));
      } else {
        console.log(`\n==== DT - 系统全局配置 ====`);
        console.log(`  浏览器皮肤: ${curSettings.browserTheme || 'dark'}`);
        console.log(`  管理器皮肤: ${curSettings.managerTheme || 'dark'}`);
        console.log(`  界面字体: ${curSettings.font || 'system-default'}`);
        console.log(`  默认新建网址: ${curSettings.defaultUrl || 'https://www.browserscan.net/'}\n`);
      }
      break;
    }

    case 'env': {
      const sysSettings = require('./src/manager/system-settings');
      try {
        if (options.add || options.set) {
          const res = sysSettings.setPathEnvironment(true);
          if (isJson) {
            console.log(JSON.stringify({ code: 0, success: true, message: '已成功将项目路径添加到用户 PATH 环境变量', data: res }));
          } else {
            console.log(`✅ 已成功将项目目录添加到用户 PATH 环境变量: ${res.rootDir}`);
            console.log('💡 现在您可以在任何终端中直接输入 `dt-cli` 或 `DT-CLI` 调用指纹浏览器 API！');
          }
        } else if (options.remove || options.delete || options.del) {
          const res = sysSettings.setPathEnvironment(false);
          if (isJson) {
            console.log(JSON.stringify({ code: 0, success: true, message: '已从用户 PATH 环境变量中移除项目路径', data: res }));
          } else {
            console.log(`✅ 已从用户 PATH 环境变量中移除项目路径: ${res.rootDir}`);
          }
        } else {
          const st = sysSettings.getPathStatus();
          if (isJson) {
            console.log(JSON.stringify({ code: 0, success: true, data: st }, null, 2));
          } else {
            console.log('\n==== DT - 环境变量配置状态 ====');
            console.log(`项目根目录: ${st.rootDir}`);
            console.log(`PATH 状态: ${st.inPath ? '🟢 已添加到用户 PATH 环境变量' : '⚪ 未添加到 PATH'}`);
            if (!st.inPath) {
              console.log('提示: 运行 `DT-CLI.exe env --add` 可一键配置环境变量，实现全局任意路径直接调用。');
            }
            console.log('');
          }
        }
      } catch (e) {
        if (isJson) {
          console.log(JSON.stringify({ code: 1, success: false, message: e.message }));
        } else {
          console.error(`❌ 操作环境变量失败: ${e.message}`);
        }
        process.exit(1);
      }
      break;
    }

    case 'autostart': {
      const sysSettings = require('./src/manager/system-settings');
      try {
        if (options.enable || options.on) {
          const silent = Boolean(options.silent || options.minimized || options.hidden);
          const res = sysSettings.setAutoStart(null, true, silent);
          if (isJson) {
            console.log(JSON.stringify({ code: 0, success: true, message: '已启用开机自动启动', data: res }));
          } else {
            console.log(`✅ 已成功启用开机自动启动${silent ? ' (静默最小化到托盘)' : ''}`);
          }
        } else if (options.disable || options.off) {
          const res = sysSettings.setAutoStart(null, false, false);
          if (isJson) {
            console.log(JSON.stringify({ code: 0, success: true, message: '已关闭开机自动启动', data: res }));
          } else {
            console.log('✅ 已关闭开机自动启动');
          }
        } else {
          const st = sysSettings.getAutoStart(null);
          if (isJson) {
            console.log(JSON.stringify({ code: 0, success: true, data: st }, null, 2));
          } else {
            console.log('\n==== DT - 开机启动配置状态 ====');
            console.log(`开机自启: ${st.enabled ? '🟢 已启用' : '⚪ 未启用'}`);
            if (st.enabled) {
              console.log(`启动模式: ${st.silent ? '静默最小化到任务托盘' : '正常显示主界面'}`);
            }
            console.log('提示: 使用 `DT-CLI.exe autostart --enable [--silent]` 开启自启，`--disable` 关闭。');
            console.log('');
          }
        }
      } catch (e) {
        if (isJson) {
          console.log(JSON.stringify({ code: 1, success: false, message: e.message }));
        } else {
          console.error(`❌ 操作开机自启失败: ${e.message}`);
        }
        process.exit(1);
      }
      break;
    }

    case 'compile':
    case 'build-exe': {
      try {
        const buildExe = require('./scripts/build-exe');
        const results = buildExe.compileAll({ silent: isJson });
        if (isJson) {
          console.log(JSON.stringify({
            code: 0,
            success: true,
            message: '编译原生可执行文件成功',
            data: results
          }, null, 2));
        }
      } catch (e) {
        if (isJson) {
          console.log(JSON.stringify({ code: 1, success: false, message: e.message }));
        } else {
          console.error(`❌ 编译失败: ${e.message}`);
        }
        process.exit(1);
      }
      break;
    }

    default:
      console.error(`未知命令: ${command}`);
      printUsage();
      process.exit(1);
  }
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
