'use strict';

const { execFile } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { promisify } = require('node:util');

const run = promisify(execFile);
const pendingInstalls = new Map();

function getAppRoot() {
  if (process.env.DT_APP_ROOT && fs.existsSync(process.env.DT_APP_ROOT)) {
    return path.resolve(process.env.DT_APP_ROOT);
  }
  const archive = __dirname.match(/^(.+?[/\\]app\.asar)(?:[/\\]|$)/i)?.[1];
  if (archive) {
    const parent = path.dirname(archive);
    return path.basename(parent) === 'resources' ? path.resolve(parent, '../..') : parent;
  }
  return path.resolve(__dirname, '..');
}

function runtimeTools(root = getAppRoot()) {
  const executable = path.join(root, 'scripts', 'RuntimeTools.exe');
  return fs.existsSync(executable) ? executable : null;
}

function systemExecutable(file) {
  return path.join(process.env.SystemRoot || process.env.windir || 'C:\\Windows', 'System32', file);
}

function windowsPowerShell() {
  return systemExecutable(path.join('WindowsPowerShell', 'v1.0', 'powershell.exe'));
}

function executableFor(core, root = getAppRoot()) {
  if (core === 'chromium') {
    return path.join(root, 'runtime', 'cores', 'chromium', 'chrome.exe');
  }
  if (core !== 'electron') throw new Error('未知浏览器内核');
  const legacy = path.join(root, 'runtime', 'electron.exe');
  const configFile = path.join(root, 'runtime', 'current.json');
  const localFile = path.join(root, '.fp-local.json');
  let requested = process.env.FP_DEMO_ELECTRON;
  if (!requested && fs.existsSync(configFile)) requested = JSON.parse(fs.readFileSync(configFile, 'utf8')).executable;
  if (!requested && fs.existsSync(localFile)) requested = JSON.parse(fs.readFileSync(localFile, 'utf8')).electron;
  const resources = path.join(root, 'runtime', 'resources');
  const canLaunchRootApp = !fs.existsSync(path.join(root, 'app.asar')) ||
    (fs.existsSync(path.join(resources, 'default_app.asar')) &&
      !fs.existsSync(path.join(resources, 'app.asar')) && !fs.existsSync(path.join(resources, 'app')));
  if (requested) {
    const configured = path.resolve(root, requested);
    if (canLaunchRootApp || configured.toLowerCase() !== legacy.toLowerCase()) return configured;
  }
  return fs.existsSync(legacy) && canLaunchRootApp ? legacy : path.join(root, 'runtime', 'cores', 'electron', 'electron.exe');
}

function electronPath() {
  const executable = executableFor('electron');
  if (!fs.existsSync(executable)) throw new Error('未找到 Electron 内核，请启动管理器自动安装，或检查 FP_DEMO_ELECTRON 的路径。');
  return executable;
}

async function ensureCore(core, root = getAppRoot(), onProgress) {
  const key = path.resolve(root) + ':' + core;
  let job = pendingInstalls.get(key);
  if (!job) {
    const executable = executableFor(core, root);
    if (fs.existsSync(executable)) {
      onProgress?.({ core, phase: 'ready' });
      return executable;
    }
    if (core === 'electron' && executable !== path.join(root, 'runtime', 'cores', 'electron', 'electron.exe')) {
      throw new Error('Electron 自定义运行时路径不存在');
    }

    job = { status: { core, phase: 'checking' }, listeners: new Set() };
    const notify = status => {
      job.status = { core, ...status };
      job.listeners.forEach(listener => listener(job.status));
    };
    job.promise = installCore(core, root, executable, notify).finally(() => pendingInstalls.delete(key));
    pendingInstalls.set(key, job);
  }
  if (onProgress) {
    job.listeners.add(onProgress);
    onProgress(job.status);
  }
  try {
    return await job.promise;
  } finally {
    job.listeners.delete(onProgress);
  }
}

async function installCore(core, root, executable, notify) {
  const scripts = __dirname.includes('.asar') ? path.join(root, 'scripts') : __dirname;
  const tool = runtimeTools(root);
  const args = tool ? ['install', root, core] : [
    '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
    '-File', path.join(scripts, 'install-core.ps1'), '-Root', root, '-Core', core, '-ReportProgress',
  ];
  const operation = run(tool || windowsPowerShell(), args, { windowsHide: true });
  let buffered = '';
  operation.child.stdout.setEncoding('utf8').on('data', chunk => {
    const lines = (buffered + chunk).split(/\r?\n/);
    buffered = lines.pop();
    for (const line of lines) {
      const [, phase, bytes, total] = /^DT_CORE_PROGRESS (checking|download|extracting) (\d+) (\d+)$/.exec(line) || [];
      if (phase) notify({ phase, bytes: Number(bytes), total: Number(total) });
    }
  });
  try {
    const { stdout } = await operation;
    const installed = tool ? stdout.trim().split(/\r?\n/).at(-1) : executable;
    if (!installed || !path.isAbsolute(installed) || !fs.existsSync(installed)) {
      throw new Error('解压后缺少可执行文件');
    }
    notify({ phase: 'ready' });
    return installed;
  } catch (error) {
    const details = error.stderr?.trim();
    notify({ phase: 'error' });
    throw new Error('无法安装 ' + core + ' 内核。' + (details || error.message));
  }
}

module.exports = { getAppRoot, electronPath, executableFor, ensureCore, runtimeTools, systemExecutable, windowsPowerShell };
