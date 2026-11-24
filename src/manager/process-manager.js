'use strict';

const { execFile, spawn } = require('node:child_process');
const { setTimeout: delay } = require('node:timers/promises');
const { promisify } = require('node:util');
const { createHash, randomUUID } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { getEnvironment, getSettings, regenerateFp, isPortAvailable, DATA_DIR, ROOT_DIR } = require('./store');
const { ensureCore, runtimeTools, systemExecutable, windowsPowerShell } = require('../../scripts/runtime-path');
const { launchArgs, chromiumProfile } = require('./chromium');
const { prepareCanvasAssets } = require('./chromium-canvas');
const { withProcessLock } = require('./process-lock');
const run = promisify(execFile);

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

function getRunningStatus() {
  return Object.fromEntries(Object.entries(readActiveFile()).filter(([, record]) => isPidAlive(record?.pid)));
}

function updateActiveFile(update) {
  return withProcessLock(DATA_DIR, 'active-instances', () => {
    const current = getRunningStatus();
    update(current);
    const temporary = ACTIVE_FILE + '.' + randomUUID() + '.tmp';
    try {
      fs.writeFileSync(temporary, JSON.stringify(current, null, 2), { encoding: 'utf8', flag: 'wx' });
      fs.renameSync(temporary, ACTIVE_FILE);
    } finally {
      fs.rmSync(temporary, { force: true });
    }
  });
}

function withEnvironment(idOrName, operation) {
  const env = getEnvironment(idOrName);
  if (!env) throw new Error('未找到环境: ' + idOrName);
  return withProcessLock(DATA_DIR, 'environment:' + env.id, () => {
    const current = getEnvironment(env.id);
    if (!current) throw new Error('未找到环境: ' + env.id);
    return operation(current);
  });
}

function isRunning(envId) {
  const activeMap = getRunningStatus();
  return Boolean(activeMap[envId]);
}

async function waitForCdpReady(port, maxWaitMs = 8000) {
  if (!port) return null;
  const deadline = Date.now() + maxWaitMs;
  do {
    try {
      const response = await fetch('http://127.0.0.1:' + port + '/json/version', {
        signal: AbortSignal.timeout(800),
        redirect: 'error',
      });
      const info = await response.json();
      if (info.webSocketDebuggerUrl) return info;
    } catch {}
    await delay(100);
  } while (Date.now() < deadline);
  return null;
}

async function launch(idOrName, options = {}) {
  return withEnvironment(idOrName, env => launchEnvironment(env, options));
}

async function launchEnvironment(env, options) {
  const settings = getSettings();
  const core = options.core ?? env.browserCore;
  const activeMap = getRunningStatus();
  if (activeMap[env.id]) {
    const existingPort = activeMap[env.id].port;
    const cdpInfo = existingPort ? await waitForCdpReady(existingPort, 2000) : null;
    return {
      success: true,
      alreadyRunning: true,
      message: `环境 "${env.name}" 当前已在运行中 (PID: ${activeMap[env.id].pid})`,
      pid: activeMap[env.id].pid,
      core: activeMap[env.id].core || 'electron',
      port: existingPort,
      ws: cdpInfo ? cdpInfo.webSocketDebuggerUrl : null,
      http: existingPort ? `http://127.0.0.1:${existingPort}` : null,
      cdp: cdpInfo,
      env
    };
  }

  const args = core === 'chromium' ? launchArgs(env, options, ROOT_DIR, DATA_DIR) : electronArgs(env, options, settings);
  const executable = await ensureCore(core, ROOT_DIR);
  const port = env.remotePortEnabled ? Number(env.remotePort) || null : null;
  const start = () => startEnvironment(env, options, core, executable, args, port);
  return port ? withProcessLock(DATA_DIR, 'debug-port:' + port, start) : start();
}

async function startEnvironment(env, options, core, executable, args, port) {
  if (port && (Object.values(getRunningStatus()).some(record => Number(record.port) === port) ||
      !await isPortAvailable(port))) {
    throw new Error('调试端口已被占用：' + port);
  }
  const envVars = { ...process.env, DT_APP_ROOT: ROOT_DIR };
  delete envVars.ELECTRON_RUN_AS_NODE;

  if (core === 'chromium') prepareCanvasAssets(chromiumProfile(DATA_DIR, env.id), env.fp);
  const branding = core === 'chromium' && !args.some(arg => /^--headless(?:=|$)/.test(arg))
    ? chromiumBranding(env.id)
    : null;
  const pid = await spawnBrowser(executable, args, envVars, branding);
  const record = {
    pid,
    core,
    port,
    startedAt: new Date().toISOString(),
    envName: env.name
  };
  if (core === 'chromium') {
    record.launchOptions = {
      url: options.url,
      headless: options.headless,
      args: options.args,
      blockDialogs: options.blockDialogs,
    };
  }

  try {
    await updateActiveFile(current => { current[env.id] = record; });
  } catch (error) {
    await terminateBrowser(record);
    throw error;
  }

  const cdpInfo = record.port && options.wait !== false ? await waitForCdpReady(record.port) : null;
  if (!isPidAlive(record.pid)) {
    await removeRecord(env.id);
    throw new Error(core + ' 内核启动后退出，请检查环境配置。');
  }
  if (record.port && options.wait !== false && (!cdpInfo || !await ownsDebugPort(record))) {
    await stopEnvironment(env);
    throw new Error(core + ' 未能打开指定的调试端口：' + record.port);
  }

  return {
    success: true,
    message: '已成功启动 "' + env.name + '"',
    pid: record.pid,
    core,
    port: record.port,
    ws: cdpInfo?.webSocketDebuggerUrl || null,
    http: record.port ? 'http://127.0.0.1:' + record.port : null,
    cdp: cdpInfo,
    env
  };
}

function chromiumBranding(id) {
  const icon = path.join(ROOT_DIR, 'app.ico');
  if (!fs.existsSync(icon)) return null;
  const installation = fs.realpathSync.native(ROOT_DIR).toLowerCase();
  const key = createHash('sha256').update(installation + '\0' + id).digest('hex').slice(0, 32);
  const cli = path.join(ROOT_DIR, 'DT-CLI.exe');
  return {
    icon,
    appId: 'DTFingerprintBrowser.Chromium.' + key,
    relaunch: fs.existsSync(cli) ? [cli, 'start', '--id', id, '--core', 'chromium'] : null,
    displayName: 'DT 指纹浏览器',
  };
}

async function spawnBrowser(executable, args, env, branding) {
  const script = __dirname.includes('.asar')
    ? path.join(ROOT_DIR, 'scripts', 'spawn-browser.ps1')
    : path.resolve(__dirname, '../../scripts/spawn-browser.ps1');
  const tool = runtimeTools(ROOT_DIR);
  const command = tool ? ['spawn'] : [
    '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script,
  ];
  const start = run(tool || windowsPowerShell(), command, { env, windowsHide: true, timeout: 30000 });
  start.child.stdin.on('error', () => {});
  start.child.stdin.end(JSON.stringify({ executable, args, cwd: ROOT_DIR, branding }));
  const { stdout } = await start.catch(error => {
    throw new Error(error.stderr?.trim() || error.message);
  });
  const pid = Number(stdout.trim());
  if (!Number.isInteger(pid) || pid <= 0) throw new Error('启动浏览器后未得到有效进程 ID');
  return pid;
}

function removeRecord(id) {
  return updateActiveFile(current => { delete current[id]; });
}

function electronArgs(env, options, settings) {
  const browserTheme = options.theme || settings.browserTheme || 'blue';
  const args = [BROWSER_ENTRY, '--browser-mode', `--env-id=${env.id}`, `--theme=${browserTheme}`];

  if (options.url) {
    args.push(`--open-url=${options.url}`);
  }
  if (options.headless) {
    args.push('--headless');
  }
  if (options.rotatingFile) {
    args.push(`--rotating-file=${options.rotatingFile}`);
  }
  if (options.rotatingRules) {
    args.push(`--rotating-rules=${options.rotatingRules}`);
  }
  if (options.rotatingMode) {
    args.push(`--rotating-mode=${options.rotatingMode}`);
  }
  if (options.blockDialogs === true) {
    args.push('--block-dialogs');
  } else if (options.blockDialogs === false) {
    args.push('--no-block-dialogs');
  }
  if (options.args) {
    args.push(options.args);
  }

  return args;
}

async function stop(idOrName) {
  return withEnvironment(idOrName, stopEnvironment);
}

async function stopEnvironment(env) {
  const activeMap = getRunningStatus();
  const record = activeMap[env.id];
  if (!record) {
    return { success: true, message: `环境 "${env.name}" 未在运行` };
  }

  await terminateBrowser(record);
  await removeRecord(env.id);
  return { success: true, message: `已停止 "${env.name}"` };
}

async function terminateBrowser(record) {
  if (record.core === 'chromium') {
    await closeChromium(record);
    return;
  }

  if (record.pid) {
    try {
      process.kill(record.pid);
    } catch {}

    // Windows 彻底终结进程树释放端口及文件锁，阻塞等待进程退出
    await new Promise(resolve => {
      try {
        const killer = spawn(systemExecutable('taskkill.exe'), ['/PID', String(record.pid), '/T', '/F'], { windowsHide: true });
        killer.on('close', () => resolve());
        killer.on('error', () => resolve());
        setTimeout(resolve, 2000); // 兜底保护 2 秒
      } catch {
        resolve();
      }
    });

    // 预留短暂时间供 Windows 文件系统释放独占文件锁 (LevelDB / Cookies)
    await new Promise(resolve => setTimeout(resolve, 100));
  }
}

async function ownsDebugPort({ port, pid }) {
  if (!port) return false;
  try {
    const { stdout } = await run(systemExecutable('netstat.exe'), ['-ano', '-p', 'tcp'], { windowsHide: true, timeout: 3000 });
    return stdout.split(/\r?\n/).some(line => {
      const [protocol, local, remote, , owner] = line.trim().split(/\s+/);
      return protocol === 'TCP' && local === '127.0.0.1:' + port && remote === '0.0.0.0:0' && Number(owner) === pid;
    });
  } catch {
    return false;
  }
}

async function closeChromium(record) {
  const info = await ownsDebugPort(record) ? await waitForCdpReady(record.port, 400) : null;
  const ws = info?.webSocketDebuggerUrl;
  if (ws?.startsWith('ws://127.0.0.1:' + record.port + '/devtools/browser/') && typeof WebSocket !== 'undefined') {
    await new Promise(resolve => {
      const socket = new WebSocket(ws);
      const timeout = setTimeout(() => { socket.close(); resolve(); }, 1000);
      socket.addEventListener('open', () => socket.send(JSON.stringify({ id: 1, method: 'Browser.close' })), { once: true });
      const finish = () => { clearTimeout(timeout); resolve(); };
      socket.addEventListener('close', finish, { once: true });
      socket.addEventListener('error', finish, { once: true });
    });
  }
  if (isPidAlive(record.pid)) {
    const tool = runtimeTools(ROOT_DIR);
    const command = tool ? ['close', String(record.pid)] : [
      '-NoProfile', '-NonInteractive', '-Command',
      '(Get-Process -Id ' + Number(record.pid) + " -ErrorAction SilentlyContinue).CloseMainWindow()",
    ];
    await run(tool || windowsPowerShell(), command, { windowsHide: true, timeout: 2000 }).catch(() => {});
  }
  for (let i = 0; i < 30 && isPidAlive(record.pid); i++) await delay(100);
  if (isPidAlive(record.pid)) {
    await run(systemExecutable('taskkill.exe'), ['/PID', String(record.pid), '/T', '/F'], { windowsHide: true, timeout: 5000 }).catch(() => {});
  }
  if (isPidAlive(record.pid)) throw new Error('Chromium 窗口尚未退出，无法重新加载指纹。');
}

async function refreshChromium(id) {
  return withEnvironment(id, restartChromium);
}

async function restartChromium(env) {
  const active = getRunningStatus()[env.id];
  if (active?.core !== 'chromium') return false;
  const options = active.launchOptions || {};
  // Validate the changed configuration before closing the running window.
  const restart = { ...options, core: 'chromium', restoreSession: !options.headless };
  launchArgs(env, restart, ROOT_DIR, DATA_DIR);
  await stopEnvironment(env);
  await launchEnvironment(env, restart);
  return true;
}

async function randomizeEnvironment(id, timezone) {
  return withEnvironment(id, async current => {
    const running = getRunningStatus()[current.id];
    const env = regenerateFp(current.id, timezone);
    const restarted = running?.core === 'chromium' && await restartChromium(env);
    return { env, restarted, hotReloaded: Boolean(running && running.core !== 'chromium') };
  });
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
  refreshChromium,
  randomizeEnvironment,
  stop,
  stopAll,
  isRunning,
  getRunningStatus
};
