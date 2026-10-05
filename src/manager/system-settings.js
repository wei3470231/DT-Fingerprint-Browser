'use strict';

const path = require('node:path');
const fs = require('node:fs');
const cp = require('node:child_process');
const store = require('./store');

const ROOT_DIR = store.ROOT_DIR || process.env.DT_APP_ROOT || path.resolve(__dirname, '../../');

function normalizePath(p) {
  if (!p) return '';
  return path.resolve(p).toLowerCase().replace(/[\\/]+$/, '');
}

/**
 * 获取开机自启状态
 */
function getAutoStart(app) {
  const settings = store.getSettings();
  let enabled = Boolean(settings.autoStart);
  let silent = Boolean(settings.autoStartSilent);

  if (app && typeof app.getLoginItemSettings === 'function') {
    try {
      const loginItem = app.getLoginItemSettings();
      if (loginItem && typeof loginItem.openAtLogin === 'boolean') {
        enabled = loginItem.openAtLogin;
      }
    } catch (_) {}
  }

  // Windows 注册表校验
  if (process.platform === 'win32') {
    try {
      const output = cp.execSync('reg query "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run" /v "DTFingerprintBrowser"', {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore']
      });
      if (output && output.includes('DTFingerprintBrowser')) {
        enabled = true;
        if (output.includes('--minimized') || output.includes('--hidden')) {
          silent = true;
        }
      }
    } catch (_) {
      // 注册表不存在该键值说明未开启
      if (settings.autoStart === undefined) {
        enabled = false;
      }
    }
  }

  return { enabled, silent };
}

/**
 * 设置开机自启 (必须严格绑定 DT - 指纹浏览器.exe，严禁直接启动 Chromium/chrome.exe)
 */
function setAutoStart(app, enabled, silent = false) {
  const baseDir = store.ROOT_DIR || process.env.DT_APP_ROOT || path.resolve(__dirname, '../../');
  const targetExe = fs.existsSync(path.resolve(baseDir, 'DT-Fingerprint-Browser.exe'))
    ? path.resolve(baseDir, 'DT-Fingerprint-Browser.exe')
    : path.resolve(baseDir, 'DT - 指纹浏览器.exe');
  const isEnabled = Boolean(enabled);
  const isSilent = Boolean(silent);

  // 1. Electron API
  if (app && typeof app.setLoginItemSettings === 'function') {
    try {
      app.setLoginItemSettings({
        openAtLogin: isEnabled,
        openAsHidden: isSilent,
        path: targetExe,
        args: isSilent ? ['--minimized'] : []
      });
    } catch (err) {
      console.warn('[AutoStart] app.setLoginItemSettings error:', err.message);
    }
  }

  // 2. Windows 注册表直写 (保证双击原生 EXE 或便携版绝对生效，清理历史遗留冗余键)
  if (process.platform === 'win32') {
    try {
      if (isEnabled) {
        const cmdVal = isSilent ? `"${targetExe}" --minimized` : `"${targetExe}"`;
        cp.execFileSync('reg.exe', ['add', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run', '/v', 'DTFingerprintBrowser', '/t', 'REG_SZ', '/d', cmdVal, '/f'], {
          stdio: 'ignore'
        });
      } else {
        cp.execFileSync('reg.exe', ['delete', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run', '/v', 'DTFingerprintBrowser', '/f'], {
          stdio: 'ignore'
        });
      }
      // 清理可能遗留的旧 electron.app.Electron 注册表键
      try {
        cp.execFileSync('reg.exe', ['delete', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run', '/v', 'electron.app.Electron', '/f'], {
          stdio: 'ignore'
        });
      } catch (_) {}
    } catch (err) {
      console.warn('[AutoStart] Registry error:', err.message);
    }
  }

  // 3. 持久化到 settings.json
  store.updateSettings({
    autoStart: isEnabled,
    autoStartSilent: isSilent
  });

  return { success: true, enabled: isEnabled, silent: isSilent };
}

/**
 * 获取当前用户 PATH 及是否包含本项目根目录 (统一使用原生 CMD / reg.exe，兼容精简版系统与无 PowerShell 环境)
 */
function getPathStatus() {
  if (process.platform !== 'win32') {
    return { inPath: false, rootDir: ROOT_DIR, currentPath: '' };
  }

  let currentPath = '';
  try {
    const regOut = cp.execFileSync('reg.exe', ['query', 'HKCU\\Environment', '/v', 'Path'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore']
    });
    const match = regOut.match(/Path\s+REG_(?:EXPAND_)?SZ\s*(.*)/i);
    if (match) currentPath = (match[1] || '').trim();
  } catch (_) {
    // 注册表 HKCU\Environment 中无 Path 项或读取失败
    currentPath = '';
  }

  const normRoot = normalizePath(ROOT_DIR);
  const segments = currentPath.split(';').map(s => s.trim()).filter(Boolean);
  const inPath = segments.some(s => normalizePath(s) === normRoot);

  return {
    inPath,
    rootDir: ROOT_DIR,
    cliPath: path.resolve(ROOT_DIR, 'DT-CLI.exe'),
    currentPath
  };
}

/**
 * 添加或移除用户环境变量 PATH / DT_BROWSER_DIR / DT_CLI_PATH
 * 统一采用 Windows CMD / reg.exe 核心工具链，彻底摆脱 PowerShell 依赖
 */
function setPathEnvironment(enabled) {
  if (process.platform !== 'win32') {
    throw new Error('环境变量自动配置仅支持 Windows 操作系统');
  }

  const { currentPath, inPath } = getPathStatus();
  const normRoot = normalizePath(ROOT_DIR);
  const segments = currentPath.split(';').map(s => s.trim()).filter(Boolean);

  let newSegments = [];
  if (enabled) {
    if (!inPath) {
      newSegments = [...segments, ROOT_DIR];
    } else {
      newSegments = segments;
    }
  } else {
    newSegments = segments.filter(s => normalizePath(s) !== normRoot);
  }

  const newPathStr = newSegments.join(';');
  const cliPath = path.resolve(ROOT_DIR, 'DT-CLI.exe');

  // 1. 核心持久化：使用 reg.exe 写入注册表 HKCU\Environment\Path (支持超长路径，无 1024 字符截断缺陷)
  if (newPathStr) {
    cp.execFileSync('reg.exe', ['add', 'HKCU\\Environment', '/v', 'Path', '/t', 'REG_EXPAND_SZ', '/d', newPathStr, '/f'], {
      stdio: 'ignore'
    });
  } else {
    try {
      cp.execFileSync('reg.exe', ['delete', 'HKCU\\Environment', '/v', 'Path', '/f'], { stdio: 'ignore' });
    } catch (_) {}
  }

  // 2. 写入或清除辅助环境变量 DT_BROWSER_DIR 与 DT_CLI_PATH
  if (enabled) {
    cp.execFileSync('reg.exe', ['add', 'HKCU\\Environment', '/v', 'DT_BROWSER_DIR', '/t', 'REG_SZ', '/d', ROOT_DIR, '/f'], {
      stdio: 'ignore'
    });
    cp.execFileSync('reg.exe', ['add', 'HKCU\\Environment', '/v', 'DT_CLI_PATH', '/t', 'REG_SZ', '/d', cliPath, '/f'], {
      stdio: 'ignore'
    });
  } else {
    try {
      cp.execFileSync('reg.exe', ['delete', 'HKCU\\Environment', '/v', 'DT_BROWSER_DIR', '/f'], { stdio: 'ignore' });
    } catch (_) {}
    try {
      cp.execFileSync('reg.exe', ['delete', 'HKCU\\Environment', '/v', 'DT_CLI_PATH', '/f'], { stdio: 'ignore' });
    } catch (_) {}
  }

  // 3. 通过 CMD 原生 setx 触发系统全局 WM_SETTINGCHANGE 广播通知 (无需 PowerShell 参与)
  try {
    cp.execSync('cmd.exe /c setx DT_ENV_BROADCAST 1 >nul 2>&1 & reg delete HKCU\\Environment /v DT_ENV_BROADCAST /f >nul 2>&1', {
      stdio: 'ignore'
    });
  } catch (_) {}

  return { success: true, inPath: Boolean(enabled), rootDir: ROOT_DIR };
}

module.exports = {
  ROOT_DIR,
  getAutoStart,
  setAutoStart,
  getPathStatus,
  setPathEnvironment
};
