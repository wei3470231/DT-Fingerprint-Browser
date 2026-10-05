'use strict';

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { getEnvironment, loadAll, getSettings, DATA_DIR, ROOT_DIR } = require('./store');
const { electronPath } = require('../../scripts/runtime-path');

const BROWSER_ENTRY = path.resolve(__dirname, '../browser/main.js');
const ACTIVE_FILE = path.join(DATA_DIR, 'active-instances.json');

// 跨进程探活：检查 PID 是否真实存在
function isPidAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true; // 进程存在且有权限
  } catch (err) {
    return err.code === 'EPERM'; // EPERM 表示进程存在但权限受限，也是存活
  }
}

// 读取跨进程运行状态字典: { [envId]: { pid, port, startedAt, envName } }
function readActiveFile() {
  try {
    if (fs.existsSync(ACTIVE_FILE)) {
      return JSON.parse(fs.readFileSync(ACTIVE_FILE, 'utf8'));
    }
  } catch {}
  return {};
}

function writeActiveFile(data) {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(ACTIVE_FILE, JSON.stringify(data, null, 2), 'utf8');
  } catch (e) {
    console.error('写入运行状态文件失败:', e.message);
  }
}

// 获取全系统最新真实运行状态（自动清理已退出的僵尸记录）
function getRunningStatus() {
  const activeMap = readActiveFile();
  let changed = false;

  for (const [envId, record] of Object.entries(activeMap)) {
    if (!isPidAlive(record.pid)) {
      delete activeMap[envId];
      changed = true;
    }
  }

  if (changed) {
    writeActiveFile(activeMap);
  }

  return activeMap;
}

function isRunning(envId) {
  const activeMap = getRunningStatus();
  return Boolean(activeMap[envId]);
}

const http = require('node:http');

// 探测 CDP 远程调试端口就绪并获取 version 信息 (含 webSocketDebuggerUrl)
function waitForCdpReady(port, maxWaitMs = 8000) {
  return new Promise((resolve) => {
    if (!port) return resolve(null);
    const start = Date.now();

    function check() {
      const req = http.get(`http://127.0.0.1:${port}/json/version`, (res) => {
        let raw = '';
        res.on('data', chunk => raw += chunk);
        res.on('end', () => {
          try {
            const data = JSON.parse(raw);
            return resolve(data);
          } catch {
            // 继续重试
          }
        });
      });
      req.on('error', () => {
        if (Date.now() - start < maxWaitMs) {
          setTimeout(check, 100);
        } else {
          resolve(null);
        }
      });
      req.setTimeout(800, () => req.destroy());
    }

    check();
  });
}

async function launch(idOrName, options = {}) {
  const env = getEnvironment(idOrName);
  if (!env) {
    throw new Error(`未找到环境: ${idOrName}`);
  }

  const activeMap = getRunningStatus();
  if (activeMap[env.id]) {
    const existingPort = activeMap[env.id].port;
    const cdpInfo = existingPort ? await waitForCdpReady(existingPort, 2000) : null;
    return {
      success: true,
      alreadyRunning: true,
      message: `环境 "${env.name}" 当前已在运行中 (PID: ${activeMap[env.id].pid})`,
      pid: activeMap[env.id].pid,
      port: existingPort,
      ws: cdpInfo ? cdpInfo.webSocketDebuggerUrl : null,
      http: existingPort ? `http://127.0.0.1:${existingPort}` : null,
      cdp: cdpInfo,
      env
    };
  }

  const exePath = electronPath();
  const settings = getSettings();
  const browserTheme = options.theme || settings.browserTheme || 'blue';
  const args = [BROWSER_ENTRY, '--browser-mode', `--env-id=${env.id}`, `--theme=${browserTheme}`];

  if (options.url) {
    args.push(`--open-url=${options.url}`);
  }
  if (options.headless) {
    args.push('--headless');
  }
  if (options.args) {
    args.push(options.args);
  }

  const envVars = { ...process.env, DT_APP_ROOT: ROOT_DIR };
  delete envVars.ELECTRON_RUN_AS_NODE;

  const child = spawn(exePath, args, {
    cwd: ROOT_DIR,
    detached: true,
    stdio: 'ignore',
    env: envVars
  });

  const record = {
    pid: child.pid,
    port: env.remotePortEnabled ? env.remotePort : null,
    startedAt: new Date().toISOString(),
    envName: env.name
  };

  // 持久化跨进程记录
  activeMap[env.id] = record;
  writeActiveFile(activeMap);

  child.on('exit', () => {
    const current = readActiveFile();
    delete current[env.id];
    writeActiveFile(current);
  });

  child.unref();

  // 若开启了远程端口，则等待端口真正监听就绪并获取 CDP WebSocket 调试地址
  let cdpInfo = null;
  if (record.port && options.wait !== false) {
    cdpInfo = await waitForCdpReady(record.port, 8000);
  }

  return {
    success: true,
    message: `已成功启动 "${env.name}"`,
    pid: child.pid,
    port: record.port,
    ws: cdpInfo ? cdpInfo.webSocketDebuggerUrl : null,
    http: record.port ? `http://127.0.0.1:${record.port}` : null,
    cdp: cdpInfo,
    env
  };
}

async function stop(idOrName) {
  const env = getEnvironment(idOrName);
  if (!env) throw new Error(`未找到环境: ${idOrName}`);

  const activeMap = getRunningStatus();
  const record = activeMap[env.id];
  if (!record) {
    return { success: true, message: `环境 "${env.name}" 未在运行` };
  }

  try {
    process.kill(record.pid);
  } catch {}

  try {
    // Windows 彻底终结进程树释放端口及文件锁
    spawn('taskkill', ['/PID', String(record.pid), '/T', '/F'], { windowsHide: true });
  } catch {}

  delete activeMap[env.id];
  writeActiveFile(activeMap);
  return { success: true, message: `已停止 "${env.name}"` };
}

async function stopAll() {
  const activeMap = getRunningStatus();
  const ids = Object.keys(activeMap);
  for (const id of ids) {
    await stop(id);
  }
  return { success: true, count: ids.length };
}

module.exports = {
  launch,
  stop,
  stopAll,
  isRunning,
  getRunningStatus
};
