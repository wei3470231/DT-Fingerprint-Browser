'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const net = require('node:net');
const { generateFingerprint } = require('../../fp-sdk');
const { parseProxyString } = require('./proxy-parser');

function parseAndBuildProxyConfig(proxyInput) {
  const result = {
    enabled: false,
    type: 'socks5',
    host: '',
    port: '',
    username: '',
    password: '',
    rawString: '',
    scope: 'all',
    rules: '',
    bypass: '<local>;localhost;127.0.0.1'
  };

  if (!proxyInput) return result;

  if (typeof proxyInput === 'string') {
    const parsed = parseProxyString(proxyInput);
    if (parsed) {
      result.enabled = true;
      result.type = parsed.type;
      result.host = parsed.host;
      result.port = parsed.port;
      result.username = parsed.username;
      result.password = parsed.password;
      result.rawString = proxyInput;
    }
    return result;
  }

  // 对象格式
  result.enabled = Boolean(proxyInput.enabled);
  result.type = proxyInput.type || 'socks5';
  result.host = proxyInput.host || '';
  result.port = proxyInput.port ? String(proxyInput.port) : '';
  result.username = proxyInput.username || '';
  result.password = proxyInput.password || '';
  result.rawString = proxyInput.rawString || '';
  result.scope = proxyInput.scope || 'all';
  result.rules = proxyInput.rules || '';
  result.bypass = proxyInput.bypass || '<local>;localhost;127.0.0.1';

  // 如果提供了 rawString，优先以解析结果更新
  if (result.rawString) {
    const parsed = parseProxyString(result.rawString);
    if (parsed) {
      result.type = parsed.type;
      result.host = parsed.host;
      result.port = parsed.port;
      result.username = parsed.username;
      result.password = parsed.password;
    }
  }

  return result;
}

function resolveRootDir() {
  if (process.env.DT_APP_ROOT && fs.existsSync(process.env.DT_APP_ROOT)) {
    return path.resolve(process.env.DT_APP_ROOT);
  }
  const asarIdx = __dirname.indexOf('app.asar');
  if (asarIdx !== -1) {
    const beforeAsar = __dirname.substring(0, asarIdx);
    const candidate = path.resolve(beforeAsar, '..', '..');
    if (fs.existsSync(candidate)) return candidate;
  }
  return path.resolve(__dirname, '../../');
}

const ROOT_DIR = resolveRootDir();

function resolveDataDir(root) {
  const defaultData = path.join(root, 'data');
  let writable = false;
  try {
    if (!fs.existsSync(defaultData)) fs.mkdirSync(defaultData, { recursive: true });
    const testFile = path.join(defaultData, '.wtest_' + process.pid + '_' + Date.now() + '.tmp');
    fs.writeFileSync(testFile, '1', 'utf8');
    fs.unlinkSync(testFile);
    writable = true;
  } catch (_) {
    writable = false;
  }

  if (writable) return defaultData;

  // 若默认目录无写权限 (如安装在 C:\Program Files)，自动回退到 AppData/Roaming 目录
  const appData = process.env.APPDATA || (process.env.USERPROFILE ? path.join(process.env.USERPROFILE, 'AppData', 'Roaming') : null);
  if (appData) {
    const fallbackDir = path.join(appData, 'DT-Fingerprint-Browser', 'data');
    try {
      if (!fs.existsSync(fallbackDir)) {
        fs.mkdirSync(fallbackDir, { recursive: true });
        const envJson = path.join(defaultData, 'environments.json');
        const setJson = path.join(defaultData, 'settings.json');
        if (fs.existsSync(envJson) && !fs.existsSync(path.join(fallbackDir, 'environments.json'))) {
          fs.copyFileSync(envJson, path.join(fallbackDir, 'environments.json'));
        }
        if (fs.existsSync(setJson) && !fs.existsSync(path.join(fallbackDir, 'settings.json'))) {
          fs.copyFileSync(setJson, path.join(fallbackDir, 'settings.json'));
        }
      }
      return fallbackDir;
    } catch (_) {}
  }
  return defaultData;
}

const DATA_DIR = resolveDataDir(ROOT_DIR);
const CONFIG_FILE = path.join(DATA_DIR, 'environments.json');
const SETTINGS_FILE = path.join(DATA_DIR, 'settings.json');
const BOOKMARKS_FILE = path.join(DATA_DIR, 'bookmarks.json');
const PROFILES_DIR = path.join(DATA_DIR, 'profiles');

function resolveFontsDir() {
  const candidates = [
    path.join(ROOT_DIR, 'Fonts'),
    path.join(ROOT_DIR, 'fonts'),
    path.join(DATA_DIR, 'Fonts'),
    path.join(DATA_DIR, 'fonts')
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  const defaultDir = path.join(ROOT_DIR, 'Fonts');
  try {
    fs.mkdirSync(defaultDir, { recursive: true });
  } catch (_) {}
  return defaultDir;
}

const FONTS_DIR = resolveFontsDir();

function getAvailableFonts() {
  const fonts = [
    {
      id: 'system-default',
      name: '系统默认字体 (System Default)',
      fileName: '',
      filePath: '',
      fileUrl: '',
      family: 'system-default',
      type: 'system',
      format: ''
    }
  ];

  try {
    const fontsDir = resolveFontsDir();
    if (fs.existsSync(fontsDir)) {
      const files = fs.readdirSync(fontsDir);
      for (const f of files) {
        const ext = path.extname(f).toLowerCase();
        if (['.ttf', '.otf', '.woff', '.woff2'].includes(ext)) {
          const baseName = path.basename(f, ext);
          const fullPath = path.join(fontsDir, f);
          let format = 'truetype';
          if (ext === '.otf') format = 'opentype';
          else if (ext === '.woff') format = 'woff';
          else if (ext === '.woff2') format = 'woff2';

          fonts.push({
            id: f,
            name: baseName,
            fileName: f,
            filePath: fullPath,
            fileUrl: 'file:///' + fullPath.replace(/\\/g, '/'),
            family: 'DT-Custom-Font',
            type: 'custom',
            format
          });
        }
      }
    }
  } catch (err) {
    console.warn('[Fonts Read Error]', err.message);
  }

  return fonts;
}

function getActiveFontInfo() {
  const settings = getSettings();
  const available = getAvailableFonts();
  const fontKey = settings.fontFamily || settings.font;

  if (fontKey) {
    const matched = available.find(f => f.id === fontKey || f.name === fontKey || f.fileName === fontKey);
    if (matched) return matched;
  }

  // 默认启动时读取字体目录的字体：若存在自定义字体，优先采用第一个有效字体 (解决精简系统缺少字体问题)
  if (available.length > 1) {
    return available[1];
  }

  return available[0];
}

const DEFAULT_SETTINGS = {
  managerTheme: 'dark',
  browserTheme: 'dark',
  fontFamily: '',
  groups: ['默认分组']
};

function ensureDirs() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(PROFILES_DIR)) fs.mkdirSync(PROFILES_DIR, { recursive: true });
  if (!fs.existsSync(FONTS_DIR)) {
    try { fs.mkdirSync(FONTS_DIR, { recursive: true }); } catch (_) {}
  }
}

function normalizeRecord(env) {
  if (!env) return env;
  if (!env.userDataDir || path.isAbsolute(env.userDataDir)) {
    const norm = (env.userDataDir || '').replace(/\\/g, '/');
    const idx = norm.indexOf('data/profiles');
    if (idx !== -1) {
      env.userDataDir = norm.slice(idx).replace(/\//g, path.sep);
    } else {
      env.userDataDir = path.join('data', 'profiles', env.id);
    }
  }
  if (env.extensions) {
    const exts = env.extensions.split(/[;\r\n]+/).map(p => p.trim()).filter(Boolean);
    const cleaned = exts.map(p => {
      const norm = p.replace(/\\/g, '/');
      const idx = norm.indexOf('chrome');
      if (norm.includes('fingerprint-electron-main') && idx !== -1) {
        return norm.slice(idx).replace(/\//g, path.sep);
      }
      return p;
    });
    env.extensions = cleaned.join(';');
  }
  if (!env.timezone) {
    env.timezone = env.fp?.timezone || 'America/New_York';
  }
  if (!env.url) {
    env.url = 'dt://fingerprint-test';
  }
  return env;
}

function loadAll() {
  ensureDirs();
  let list = [];
  let loaded = false;

  if (fs.existsSync(CONFIG_FILE)) {
    try {
      const content = fs.readFileSync(CONFIG_FILE, 'utf8').trim();
      if (content) {
        const parsed = JSON.parse(content);
        if (Array.isArray(parsed) && parsed.length > 0) {
          list = parsed;
          loaded = true;
        }
      }
    } catch (e) {
      console.error('读取配置文件失败:', e);
    }
  }

  // 1. 如果主配置文件为空（或曾被覆盖安装误置空），尝试从备份中自动恢复
  if (!loaded || list.length === 0) {
    const backupCandidates = [
      path.join(DATA_DIR, 'environments.bak.json'),
      path.join(DATA_DIR, 'environments_backup_pre_update.json')
    ];
    try {
      if (fs.existsSync(DATA_DIR)) {
        const files = fs.readdirSync(DATA_DIR);
        for (const f of files) {
          if (f.startsWith('environments_backup_') && f.endsWith('.json')) {
            backupCandidates.push(path.join(DATA_DIR, f));
          }
        }
      }
    } catch (_) {}

    for (const bkp of backupCandidates) {
      if (fs.existsSync(bkp)) {
        try {
          const bContent = fs.readFileSync(bkp, 'utf8').trim();
          if (bContent) {
            const bParsed = JSON.parse(bContent);
            if (Array.isArray(bParsed) && bParsed.length > 0) {
              console.log(`[Store] 成功从备份 ${path.basename(bkp)} 自动恢复 ${bParsed.length} 个配置！`);
              list = bParsed;
              loaded = true;
              saveAll(list);
              break;
            }
          }
        } catch (_) {}
      }
    }
  }

  // 2. 核心智能救援：如果配置仍为空，但 profiles 目录中存在已有的历史环境缓存目录，自动重建关联恢复环境！
  if (!loaded || list.length === 0) {
    try {
      if (fs.existsSync(PROFILES_DIR)) {
        const entries = fs.readdirSync(PROFILES_DIR, { withFileTypes: true });
        const existingDirs = entries.filter(d => d.isDirectory() && (d.name.startsWith('env-') || d.name.length >= 4)).map(d => d.name);
        if (existingDirs.length > 0) {
          console.log(`[Store] 检测到 ${existingDirs.length} 个历史 Profile 缓存目录，正在自动恢复环境列表...`);
          let portOffset = 0;
          for (const dirName of existingDirs) {
            const rec = createRecord({
              id: dirName,
              name: `已恢复环境-${dirName.slice(-6)}`,
              group: '已恢复环境',
              userDataDir: path.join('data', 'profiles', dirName),
              remotePort: 9222 + portOffset
            });
            portOffset++;
            list.push(rec);
          }
          saveAll(list);
          loaded = true;
        }
      }
    } catch (e) {
      console.warn('[Store] 自动恢复 profiles 失败:', e.message);
    }
  }

  // 3. 若确实没有任何历史数据（真正的崭新首次安装），创建默认的测试环境
  if (!loaded || list.length === 0) {
    const defaultList = [
      createRecord({
        name: '环境 1 · 纽约',
        group: '默认分组',
        remotePortEnabled: true,
        remotePort: 9222,
        language: 'en-US',
        timezone: 'America/New_York',
        url: 'dt://fingerprint-test',
      }),
      createRecord({
        name: '环境 2 · 伦敦',
        group: '默认分组',
        remotePortEnabled: true,
        remotePort: 9223,
        language: 'en-GB',
        timezone: 'America/New_York',
        url: 'dt://fingerprint-test',
      })
    ];
    saveAll(defaultList);
    return defaultList;
  }

  // 规范化所有环境记录
  let dirty = false;
  const normalized = list.map(env => {
    const originalUserData = env.userDataDir;
    const originalExt = env.extensions;
    const norm = normalizeRecord(env);
    if (norm.userDataDir !== originalUserData || norm.extensions !== originalExt) {
      dirty = true;
    }
    return norm;
  });
  if (dirty) {
    saveAll(normalized);
  }
  return normalized;
}

function safeWriteJsonSync(targetFile, data) {
  ensureDirs();
  const content = JSON.stringify(data, null, 2);
  try {
    fs.writeFileSync(targetFile, content, 'utf8');
  } catch (err) {
    const tmp = targetFile + '.' + process.pid + '.' + Date.now() + '.tmp';
    try {
      fs.writeFileSync(tmp, content, 'utf8');
      fs.copyFileSync(tmp, targetFile);
      try { fs.unlinkSync(tmp); } catch (_) {}
    } catch (_) {
      try { fs.renameSync(tmp, targetFile); } catch (e) { throw e; }
    }
  }
}

function saveAll(list) {
  safeWriteJsonSync(CONFIG_FILE, list);
  if (Array.isArray(list) && list.length > 0) {
    try {
      safeWriteJsonSync(path.join(DATA_DIR, 'environments.bak.json'), list);
    } catch (_) {}
  }
}

function getRandomFp(options = {}) {
  const language = options.language || 'en-US';
  const timezone = options.timezone || 'America/New_York';
  return generateFingerprint({ language, timezone });
}

function createRecord(data = {}) {
  const id = data.id || 'env-' + crypto.randomBytes(4).toString('hex');
  const language = data.language || 'en-US';
  const timezone = data.timezone || 'America/New_York';
  let userDataDir = data.userDataDir;
  if (!userDataDir || path.isAbsolute(userDataDir)) {
    userDataDir = path.join('data', 'profiles', id);
  }

  const fp = data.fp || generateFingerprint({ language, timezone });

  return {
    id,
    name: data.name || `新建环境-${Date.now().toString().slice(-4)}`,
    group: data.group || '默认分组',
    notes: data.notes || '',
    url: data.url || 'dt://fingerprint-test',
    remotePortEnabled: data.remotePortEnabled !== false,
    remotePort: data.remotePort ? Number(data.remotePort) : getNextAvailablePortSync(),
    customArgs: data.customArgs || '',
    language,
    timezone,
    proxy: parseAndBuildProxyConfig(data.proxy),
    extensions: data.extensions || '',
    userDataDir,
    fp,
    createdAt: data.createdAt || new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
}

// 检测端口是否当前被系统其他程序监听占用
function isPortAvailable(port) {
  return new Promise(resolve => {
    if (!port || port <= 0 || port > 65535) return resolve(false);
    let resolved = false;
    const finish = (result) => {
      if (!resolved) {
        resolved = true;
        resolve(result);
      }
    };
    const timer = setTimeout(() => finish(false), 500);

    const server = net.createServer();
    server.unref();
    server.once('error', () => {
      clearTimeout(timer);
      finish(false);
    });
    server.once('listening', () => {
      server.close(() => {
        clearTimeout(timer);
        finish(true);
      });
    });
    try {
      server.listen(port, '127.0.0.1');
    } catch (_) {
      clearTimeout(timer);
      finish(false);
    }
  });
}

// 异步获取下一个真正独立、未被占用且可用的端口
async function getNextAvailablePort(excludeEnvId = null) {
  const list = loadAll();
  const configuredPorts = new Set();
  for (const env of list) {
    if (excludeEnvId && env.id === excludeEnvId) continue;
    if (env.remotePortEnabled && env.remotePort) {
      configuredPorts.add(Number(env.remotePort));
    }
  }

  let port = 9222;
  let iterations = 0;
  while (iterations < 60) {
    iterations++;
    // 1. 检查未被任何已知环境配置使用
    if (!configuredPorts.has(port)) {
      // 2. 检查操作系统层面未被任何程序监听占用
      const free = await isPortAvailable(port);
      if (free) {
        return port;
      }
    }
    port++;
  }
  return getNextAvailablePortSync(excludeEnvId);
}

// 同步获取下一个未在配置文件中重复的端口（基础保底）
function getNextAvailablePortSync(excludeEnvId = null) {
  const list = loadAll();
  const configuredPorts = new Set();
  for (const env of list) {
    if (excludeEnvId && env.id === excludeEnvId) continue;
    if (env.remotePortEnabled && env.remotePort) {
      configuredPorts.add(Number(env.remotePort));
    }
  }

  let port = 9222;
  while (configuredPorts.has(port)) {
    port++;
  }
  return port;
}

function getEnvironment(idOrName) {
  const list = loadAll();
  return list.find(item => item.id === idOrName || item.name === idOrName) || null;
}

function addEnvironment(input) {
  const list = loadAll();
  // 检查名称重复
  if (list.some(item => item.name === input.name)) {
    throw new Error(`已存在名为 "${input.name}" 的环境`);
  }
  const env = createRecord(input);
  list.push(env);
  saveAll(list);
  return env;
}

function updateEnvironment(id, updates) {
  const list = loadAll();
  const index = list.findIndex(item => item.id === id);
  if (index === -1) throw new Error(`未找到环境 ID: ${id}`);
  
  if (updates.name && updates.name !== list[index].name) {
    if (list.some(item => item.id !== id && item.name === updates.name)) {
      throw new Error(`已存在同名环境: ${updates.name}`);
    }
  }

  // 语言或时区变更时同步调整 fp.navigator.languages
  if (updates.language && updates.language !== list[index].language && list[index].fp) {
    const lang = updates.language;
    list[index].fp.navigator.languages = lang === 'en-US' ? ['en-US', 'en'] : [lang, lang.split('-')[0]];
  }

  if (updates.proxy !== undefined) {
    updates.proxy = parseAndBuildProxyConfig(updates.proxy);
  }

  list[index] = {
    ...list[index],
    ...updates,
    updatedAt: new Date().toISOString()
  };
  saveAll(list);
  return list[index];
}

function deleteEnvironment(id) {
  let list = loadAll();
  const target = list.find(item => item.id === id);
  if (!target) return false;
  list = list.filter(item => item.id !== id);
  saveAll(list);
  return true;
}

function clearEnvironmentCache(id) {
  const env = getEnvironment(id);
  if (!env) throw new Error(`未找到环境 ID: ${id}`);
  const sub = env.userDataDir ? path.basename(env.userDataDir) : env.id;
  const targetDir = (env.userDataDir && path.isAbsolute(env.userDataDir)) ? env.userDataDir : path.join(PROFILES_DIR, sub);
  if (fs.existsSync(targetDir)) {
    try {
      fs.rmSync(targetDir, { recursive: true, force: true });
    } catch (e) {
      // 若某些文件暂时被系统锁定，尝试清空子目录
      console.warn(`[Clear Cache Warn] rmSync 异常，尝试清空内容: ${e.message}`);
      const files = fs.readdirSync(targetDir);
      for (const file of files) {
        try {
          fs.rmSync(path.join(targetDir, file), { recursive: true, force: true });
        } catch (_) {}
      }
    }
    if (!fs.existsSync(targetDir)) {
      fs.mkdirSync(targetDir, { recursive: true });
    }
  } else {
    fs.mkdirSync(targetDir, { recursive: true });
  }
  return { success: true, message: `已彻底清空 "${env.name}" 的独立缓存与数据目录！` };
}

function cloneEnvironment(id, newName) {
  const list = loadAll();
  const original = list.find(item => item.id === id);
  if (!original) throw new Error(`未找到要复制的环境 ID: ${id}`);

  const name = newName || `${original.name} (复制)`;
  if (list.some(item => item.name === name)) {
    throw new Error(`环境名称已存在: ${name}`);
  }

  const cloned = createRecord({
    ...JSON.parse(JSON.stringify(original)),
    id: undefined,
    name,
    remotePort: getNextAvailablePortSync(),
    userDataDir: undefined, // 自动生成新目录
    // 复制时自动重新随机指纹
    fp: generateFingerprint({ language: original.language, timezone: original.timezone })
  });

  list.push(cloned);
  saveAll(list);
  return cloned;
}

function regenerateFp(id, customTimezone) {
  const list = loadAll();
  const index = list.findIndex(item => item.id === id);
  if (index === -1) throw new Error(`未找到环境 ID: ${id}`);
  const env = list[index];
  const tz = customTimezone || env.timezone || 'America/New_York';
  env.timezone = tz;
  const newFp = generateFingerprint({ language: env.language, timezone: tz });
  env.fp = newFp;
  env.updatedAt = new Date().toISOString();
  saveAll(list);
  return env;
}

function getSettings() {
  ensureDirs();
  if (!fs.existsSync(SETTINGS_FILE)) {
    return { ...DEFAULT_SETTINGS };
  }
  try {
    const raw = fs.readFileSync(SETTINGS_FILE, 'utf8');
    return { ...DEFAULT_SETTINGS, ...JSON.parse(raw) };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

function updateSettings(patch = {}) {
  ensureDirs();
  const current = getSettings();
  const updated = { ...current, ...patch };
  safeWriteJsonSync(SETTINGS_FILE, updated);
  return updated;
}

function getGroups() {
  const settings = getSettings();
  const configured = Array.isArray(settings.groups) ? settings.groups : ['默认分组'];
  // 从现有环境中提取已用分组，防漏
  const envList = loadAll();
  const envGroups = envList.map(e => e.group).filter(Boolean);
  
  const merged = Array.from(new Set(['默认分组', ...configured, ...envGroups]));
  return merged;
}

function addGroup(name) {
  if (!name || typeof name !== 'string') {
    throw new Error('分组名称不能为空');
  }
  const trimmed = name.trim();
  if (!trimmed) {
    throw new Error('分组名称不能为空');
  }
  if (trimmed === '全部' || trimmed === '所有') {
    throw new Error('该名称为系统保留关键字，不能作为分组名');
  }
  const currentGroups = getGroups();
  if (currentGroups.includes(trimmed)) {
    return { success: true, name: trimmed, groups: currentGroups, alreadyExists: true };
  }
  currentGroups.push(trimmed);
  updateSettings({ groups: currentGroups });
  return { success: true, name: trimmed, groups: currentGroups, alreadyExists: false };
}

function deleteGroup(name) {
  if (!name || name === '默认分组') {
    throw new Error('“默认分组”为系统保留分组，无法删除');
  }
  const currentGroups = getGroups();
  const filtered = currentGroups.filter(g => g !== name);
  if (!filtered.includes('默认分组')) filtered.unshift('默认分组');
  
  // 将原先属于被删除分组的环境，自动转移到默认分组
  const envList = loadAll();
  let migratedCount = 0;
  envList.forEach(env => {
    if (env.group === name) {
      env.group = '默认分组';
      migratedCount++;
    }
  });
  if (migratedCount > 0) {
    saveAll(envList);
  }
  updateSettings({ groups: filtered });
  return { success: true, deletedGroup: name, migratedCount, groups: filtered };
}

function renameGroup(oldName, newName) {
  if (!oldName || !newName) throw new Error('参数不完整');
  const trimmedNew = newName.trim();
  if (!trimmedNew) throw new Error('新分组名称不能为空');
  if (oldName === '默认分组') throw new Error('“默认分组”为系统保留分组，无法重命名');
  if (oldName === trimmedNew) return { success: true, oldName, newName: trimmedNew, migratedCount: 0, groups: getGroups() };

  const currentGroups = getGroups();
  if (currentGroups.includes(trimmedNew)) {
    throw new Error(`已存在名为 "${trimmedNew}" 的分组`);
  }

  const updatedGroups = currentGroups.map(g => g === oldName ? trimmedNew : g);
  
  // 更新环境中对应的 group
  const envList = loadAll();
  let migratedCount = 0;
  envList.forEach(env => {
    if (env.group === oldName) {
      env.group = trimmedNew;
      migratedCount++;
    }
  });
  if (migratedCount > 0) {
    saveAll(envList);
  }
  updateSettings({ groups: updatedGroups });
  return { success: true, oldName, newName: trimmedNew, migratedCount, groups: updatedGroups };
}

function batchSetGroup(ids, groupName) {
  if (!Array.isArray(ids) || ids.length === 0) return 0;
  const targetGroup = (groupName || '默认分组').trim();
  addGroup(targetGroup);
  
  const envList = loadAll();
  let count = 0;
  envList.forEach(env => {
    if (ids.includes(env.id)) {
      env.group = targetGroup;
      count++;
    }
  });
  if (count > 0) {
    saveAll(envList);
  }
  return count;
}

const DEFAULT_BOOKMARKS = [
  { id: 'bm-0', title: '本地指纹自测', url: 'dt://fingerprint-test' },
  { id: 'bm-1', title: 'BrowserScan 指纹检测', url: 'https://www.browserscan.net/' },
  { id: 'bm-2', title: 'IPinfo IP归属查询', url: 'https://ipinfo.io/' },
  { id: 'bm-3', title: 'Whoer 匿名度检测', url: 'https://whoer.net/' }
];

function loadBookmarks() {
  try {
    if (fs.existsSync(BOOKMARKS_FILE)) {
      const data = fs.readFileSync(BOOKMARKS_FILE, 'utf8');
      const parsed = JSON.parse(data);
      if (Array.isArray(parsed)) {
        return parsed;
      }
    }
  } catch (err) {
    console.error('读取书签失败:', err.message);
  }
  try {
    if (!fs.existsSync(DATA_DIR)) {
      fs.mkdirSync(DATA_DIR, { recursive: true });
    }
    fs.writeFileSync(BOOKMARKS_FILE, JSON.stringify(DEFAULT_BOOKMARKS, null, 2), 'utf8');
  } catch (_) {}
  return [...DEFAULT_BOOKMARKS];
}

function saveBookmarks(bookmarks) {
  try {
    if (!fs.existsSync(DATA_DIR)) {
      fs.mkdirSync(DATA_DIR, { recursive: true });
    }
    const cleanList = (Array.isArray(bookmarks) ? bookmarks : []).map(b => ({
      id: b.id || ('bm-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6)),
      title: String(b.title || '未命名书签').trim(),
      url: String(b.url || 'https://www.browserscan.net/').trim(),
      createdAt: b.createdAt || Date.now()
    }));
    fs.writeFileSync(BOOKMARKS_FILE, JSON.stringify(cleanList, null, 2), 'utf8');
    return cleanList;
  } catch (err) {
    console.error('保存书签失败:', err.message);
    return [];
  }
}

module.exports = {
  ROOT_DIR,
  DATA_DIR,
  PROFILES_DIR,
  BOOKMARKS_FILE,
  resolveRootDir,
  getRandomFp,
  loadAll,
  saveAll,
  getEnvironment,
  addEnvironment,
  updateEnvironment,
  deleteEnvironment,
  clearEnvironmentCache,
  cloneEnvironment,
  regenerateFp,
  getSettings,
  updateSettings,
  getGroups,
  addGroup,
  deleteGroup,
  renameGroup,
  batchSetGroup,
  isPortAvailable,
  getNextAvailablePort,
  getNextAvailablePortSync,
  FONTS_DIR,
  getAvailableFonts,
  getActiveFontInfo,
  loadBookmarks,
  saveBookmarks
};
