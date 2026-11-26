'use strict';

const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const https = require('node:https');
const { randomUUID, createHash } = require('node:crypto');
const { Transform } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const { isIP } = require('node:net');
const store = require('./store');
const processManager = require('./process-manager');
const { withProcessLock } = require('./process-lock');
const { ensureCore } = require('../../scripts/runtime-path');
const { chromiumProfile } = require('./chromium');
const { electronCookies, chromiumCookies, isCurrent } = require('./cloud-cookies');
const { CONFIG, MANAGED, HISTORY_FILES, safeComponent, pack, unpack, copyProfile, copyTree,
  copyChromiumTabs, stageChromiumTabs, copyCookieProfile, makeBackup, applyStaged } = require('./cloud-files');

const CLOUD_API = '/api/v1/snapshots';
const ENVIRONMENT_API = '/api/v2/environments';
const MAX_BUNDLE = 2 * 1024 ** 3;
const TRANSFER_TIMEOUT = 15 * 60 * 1000;
const REVISION = /^[0-9a-f]{32}$/;
const BACKUP_ID = /^\d{4}-\d\d-\d\dT\d\d-\d\d-\d\d-\d{3}Z-[0-9a-f]{8}$/;
const DEVICE_SETTINGS = ['cloudSync', 'autoStart', 'autoStartSilent'];
const backupDirectory = path.join(store.DATA_DIR, 'cloud-backups');

function normalizeConnection({ address = '', key = '' } = {}) {
  address = String(address).trim();
  key = String(key).trim();
  if (key && (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(key) || /^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/.test(key))) {
    throw new Error('请输入有效的同步密钥（小写字母、数字、短横线或下划线）。');
  }
  if (!address) return { address, key };
  if (isIP(address) === 6) address = '[' + address + ']';
  const suppliedProtocol = /^https?:\/\//i.test(address);
  let parsed;
  try { parsed = new URL(suppliedProtocol ? address : 'http://' + address); }
  catch { throw new Error('请输入服务器 IP 或 HTTP(S) 地址。'); }
  if (parsed.username || parsed.password || parsed.pathname !== '/' || parsed.search || parsed.hash ||
      !['http:', 'https:'].includes(parsed.protocol)) throw new Error('服务地址只能包含协议、主机和端口。');
  const hasPort = /(?:\]|[^:]):\d+\/?$/.test(address);
  if (!hasPort && parsed.protocol === 'http:') parsed.port = '55550';
  return { address: parsed.origin, key };
}

function settings() {
  return normalizeConnection(store.getSettings().cloudSync);
}

async function request(config, options = {}, route = CLOUD_API) {
  if (!config.address || !config.key) throw new Error('请先填写服务器地址和同步密钥。');
  let response;
  try {
    response = await fetch(config.address + route, {
      redirect: 'error',
      signal: AbortSignal.timeout(options.body ? TRANSFER_TIMEOUT : (route === ENVIRONMENT_API ? 60000 : 15000)),
      ...options,
      headers: { 'X-DT-Sync-Key': config.key, ...options.headers },
    });
  } catch (error) {
    throw new Error('连接云同步服务失败，请检查地址、端口和网络。', { cause: error });
  }
  if (!response.ok) {
    if (route === ENVIRONMENT_API && response.status === 404) {
      await response.body?.cancel();
      throw new Error('服务端需要更新到支持按环境同步的版本。');
    }
    const body = await response.json().catch(() => ({}));
    throw new Error(body.error || '云同步请求失败（HTTP ' + response.status + '）。');
  }
  return response;
}

async function snapshotHttpError(response) {
  let size = 0;
  const chunks = [];
  try {
    for await (const chunk of response) {
      size += chunk.length;
      if (size > 64 * 1024) break;
      chunks.push(chunk);
    }
    if (response.complete && size <= 64 * 1024) {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (typeof body?.error === 'string' && body.error) return new Error(body.error);
    }
  } catch {
    // An intermediary may return HTML or close before delivering the error body.
  }
  return new Error('云同步请求失败（HTTP ' + response.statusCode + '）。');
}

async function receiveSnapshot(config, snapshot, destination) {
  if (!config.address || !config.key) throw new Error('请先填写服务器地址和同步密钥。');
  const url = new URL(config.address + CLOUD_API + '/' + snapshot.revision);
  const transport = url.protocol === 'https:' ? https : http;
  // The bundled Undici can throw from its socket end handler while its body stream is paused.
  const response = await new Promise((resolve, reject) => {
    const download = transport.get(url, {
      agent: false,
      signal: AbortSignal.timeout(TRANSFER_TIMEOUT),
      headers: { 'X-DT-Sync-Key': config.key, 'Accept-Encoding': 'identity' },
    }, resolve);
    download.once('error', reject);
  }).catch(error => {
    throw new Error('连接云同步服务失败，请检查地址、端口和网络。', { cause: error });
  });

  try {
    if (response.statusCode !== 200) throw await snapshotHttpError(response);
    const length = response.headers['content-length'];
    if (length !== undefined && Number(length) !== snapshot.size) {
      throw new Error('云端包大小与已确认版本不符。');
    }
    const encoding = response.headers['content-encoding'];
    if (encoding && encoding.toLowerCase() !== 'identity') {
      throw new Error('服务端返回了不支持的备份传输编码。');
    }

    const hash = createHash('sha256');
    let size = 0;
    const meter = new Transform({
      transform(chunk, _encoding, callback) {
        size += chunk.length;
        if (size > snapshot.size) return callback(new Error('云端包大小与已确认版本不符。'));
        hash.update(chunk);
        callback(null, chunk);
      },
    });
    try {
      await pipeline(response, meter, fs.createWriteStream(destination, { flags: 'wx' }));
    } catch (error) {
      if (['ECONNRESET', 'ERR_STREAM_PREMATURE_CLOSE', 'ABORT_ERR'].includes(error.code)) {
        throw new Error('云同步下载连接中断，请重试。', { cause: error });
      }
      throw error;
    }
    if (!response.complete || size !== snapshot.size || hash.digest('hex') !== snapshot.sha256) {
      throw new Error('云端包校验失败。');
    }
  } finally {
    response.destroy();
  }
}

function validateSnapshot(item) {
  if (!item || !REVISION.test(item.revision) || !/^[0-9a-f]{64}$/.test(item.sha256) ||
      !Number.isSafeInteger(item.size) || item.size < 1 || item.size > MAX_BUNDLE ||
      !Number.isSafeInteger(item.environmentCount) || item.environmentCount < 0 ||
      !Number.isFinite(Date.parse(item.createdAt)) || typeof item.websiteData !== 'boolean') {
    throw new Error('服务端快照信息格式无效。');
  }
  return item;
}

async function query(config) {
  const payload = await (await request(config)).json();
  if (!Array.isArray(payload.snapshots) || payload.snapshots.length > 4 ||
      !Number.isSafeInteger(payload.maxBytes) || payload.maxBytes < 1) throw new Error('服务端快照列表格式无效。');
  return { snapshots: payload.snapshots.map(validateSnapshot), maxBytes: Math.min(payload.maxBytes, MAX_BUNDLE) };
}

function listBackups() {
  if (!fs.existsSync(backupDirectory)) return [];
  return fs.readdirSync(backupDirectory, { withFileTypes: true })
    .filter(item => item.isDirectory() && BACKUP_ID.test(item.name))
    .map(item => item.name).sort().reverse();
}

function jsonFile(root, name) {
  return JSON.parse(fs.readFileSync(path.join(root, name), 'utf8'));
}

function writeJson(root, name, content) {
  fs.writeFileSync(path.join(root, name), JSON.stringify(content, null, 2), 'utf8');
}

function profilesOf(root, environments) {
  if (!Array.isArray(environments)) throw new Error('同步包的环境列表无效。');
  const ids = new Set();
  const folders = new Set();
  return environments.flatMap(env => {
    if (!env || !safeComponent(env.id) || typeof env.name !== 'string' || !env.name ||
        !['electron', 'chromium'].includes(env.browserCore) || ids.has(env.id.toLowerCase()) ||
        (env.group != null && typeof env.group !== 'string') ||
        (env.extensions != null && typeof env.extensions !== 'string') ||
        (env.userDataDir != null && typeof env.userDataDir !== 'string')) throw new Error('存在不兼容的环境记录。');
    const electron = path.basename(env.userDataDir || env.id);
    if (!safeComponent(electron) || folders.has(electron.toLowerCase())) {
      throw new Error('存在无效或共用的 Electron 资料目录。');
    }
    ids.add(env.id.toLowerCase());
    folders.add(electron.toLowerCase());
    return [
      { core: 'electron', id: env.id, relative: 'profiles/' + electron },
      { core: 'chromium', id: env.id, relative: 'chromium-profiles/' + path.basename(chromiumProfile(root, env.id)) },
    ];
  });
}

async function withOfflineWorkspace(operation, requireAllStopped = true) {
  return withProcessLock(store.DATA_DIR, 'workspace-browser', () => store.withStoreWrite(async () => {
    if (requireAllStopped && Object.keys(processManager.getRunningStatus()).length) {
      throw new Error('云同步前请关闭所有运行中的 DT 浏览器环境。');
    }
    const work = path.join(store.DATA_DIR, '.cloud-work-' + randomUUID());
    fs.mkdirSync(work);
    try { return await operation(work); }
    finally {
      if (!fs.existsSync(path.join(store.DATA_DIR, '.cloud-apply.json'))) {
        try {
          await fs.promises.rm(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
        } catch (error) {
          console.warn('云同步临时目录清理失败：' + error.code);
        }
      }
    }
  }));
}

function requireStopped(environments) {
  const running = processManager.getRunningStatus();
  const active = environments.find(env => running[env.id]);
  if (active) throw new Error('请先关闭正在运行的环境「' + active.name + '」。');
}

async function digest(file) {
  const hash = createHash('sha256');
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

async function cookieJob(profile, directory, work, cookies) {
  const executable = await ensureCore(profile.core, store.ROOT_DIR);
  return profile.core === 'electron'
    ? electronCookies(executable, directory, profile.id, work, cookies)
    : chromiumCookies(executable, directory, cookies);
}

function cookieKey(cookie) {
  const partition = cookie.partitionKey;
  return JSON.stringify([cookie.domain, cookie.path, cookie.name, partition?.topLevelSite, partition?.hasCrossSiteAncestor]);
}

function cookieIdentity(cookie) {
  return JSON.stringify([cookieKey(cookie), cookie.value, Boolean(cookie.httpOnly), Boolean(cookie.secure)]);
}

function countMissingPaths(environments) {
  let count = 0;
  for (const env of environments) {
    const files = typeof env.extensions === 'string' ? env.extensions.split(/[;\r\n]+/) : [];
    if (env.rotatingProxy?.enabled && typeof env.rotatingProxy.filePath === 'string') files.push(env.rotatingProxy.filePath);
    for (const file of files) {
      if (file.trim() && !fs.existsSync(path.resolve(store.ROOT_DIR, file.trim()))) count++;
    }
  }
  return count;
}

function profileDirectory(root, relative) {
  const parent = fs.lstatSync(path.join(root, path.dirname(relative)), { throwIfNoEntry: false });
  const directory = path.join(root, relative);
  const info = fs.lstatSync(directory, { throwIfNoEntry: false });
  for (const entry of [parent, info]) {
    if (entry && (!entry.isDirectory() || entry.isSymbolicLink())) throw new Error('环境资料目录无效。');
  }
  return info ? directory : null;
}

async function collectProfiles(staging, environments, work, websiteData) {
  for (const profile of profilesOf(store.DATA_DIR, environments)) {
    const original = profileDirectory(store.DATA_DIR, profile.relative);
    if (!original) continue;
    const destination = path.join(staging, profile.relative);
    fs.mkdirSync(destination, { recursive: true });
    const clone = fs.mkdtempSync(path.join(work, 'cookie-'));
    copyCookieProfile(original, clone, profile.core);
    const cookies = fs.readdirSync(clone).some(name => name !== 'Local State')
      ? await cookieJob(profile, clone, work) : [];
    const merged = new Map();
    const add = cookie => merged.set(cookieKey(cookie), cookie);
    if (fs.existsSync(path.join(original, 'cloud-session-cookies.json'))) {
      jsonFile(original, 'cloud-session-cookies.json').forEach(add);
    }
    cookies.forEach(add);
    if (profile.core === 'electron' && fs.existsSync(path.join(original, 'pending_cookies.json'))) {
      for (const cookie of jsonFile(original, 'pending_cookies.json')) {
        add({ ...cookie, session: !cookie.expirationDate, hostOnly: !cookie.domain?.startsWith('.') });
      }
    }
    writeJson(destination, 'cloud-cookies.json', [...merged.values()]);
    copyProfile(original, destination, profile.core, websiteData);
  }
}

async function restoreCookies(profile, source, destination, work, clearExisting = false) {
  if (!fs.existsSync(path.join(source, 'cloud-cookies.json'))) return;
  const cookies = jsonFile(source, 'cloud-cookies.json');
  if (!Array.isArray(cookies) || cookies.some(cookie => !cookie || typeof cookie.name !== 'string' ||
      typeof cookie.domain !== 'string' || typeof cookie.value !== 'string')) throw new Error('云端 Cookie 数据格式无效。');
  const current = cookies.filter(isCurrent);
  const persistent = current.filter(cookie => !cookie.session);
  const actual = persistent.length || clearExisting ? await cookieJob(profile, destination, work, persistent) : [];
  const imported = new Set(actual.map(cookieIdentity));
  if (persistent.some(cookie => !imported.has(cookieIdentity(cookie)))) {
    throw new Error('有 Cookie 无法恢复，已保留原本地资料。');
  }
  const pending = path.join(destination, 'cloud-session-cookies.json');
  fs.rmSync(pending, { force: true });
  fs.rmSync(path.join(destination, 'pending_cookies.json'), { force: true });
  const session = current.filter(cookie => cookie.session);
  if (session.length) writeJson(destination, 'cloud-session-cookies.json', session);
}

async function upload(config, expectedRevision, websiteData, maxBytes, approvePrepared) {
  return withOfflineWorkspace(async work => {
    const staging = path.join(work, 'outgoing');
    fs.mkdirSync(staging);
    const environments = store.loadAll();
    const preferences = store.getSettings();
    for (const key of DEVICE_SETTINGS) delete preferences[key];
    writeJson(staging, 'environments.json', environments);
    writeJson(staging, 'settings.json', preferences);
    writeJson(staging, 'bookmarks.json', store.loadBookmarks());
    await collectProfiles(staging, environments, work, websiteData);
    const file = path.join(work, 'upload.dt-sync.gz');
    await pack(staging, file, { websiteData, environmentCount: environments.length });
    const size = fs.statSync(file).size;
    if (size > maxBytes) throw new Error('同步包超过服务端允许的大小。');
    if (approvePrepared && !await approvePrepared({ size, environmentCount: environments.length })) return null;
    const checksum = await digest(file);
    const body = fs.createReadStream(file);
    try {
      const reply = await request(config, {
        method: 'PUT',
        body,
        duplex: 'half',
        headers: {
          'Content-Type': 'application/octet-stream',
          'Content-Length': String(size),
          'X-DT-Expected-Revision': expectedRevision,
          'X-DT-SHA256': checksum,
          'X-DT-Environment-Count': String(environments.length),
          'X-DT-Website-Data': websiteData ? '1' : '0',
        },
      });
      return validateSnapshot((await reply.json()).snapshot);
    } finally { body.destroy(); }
  });
}

async function download(config, selected) {
  const snapshot = validateSnapshot(selected);
  return withOfflineWorkspace(async work => {
    store.loadAll();
    const backup = makeBackup(store.DATA_DIR);
    try {
      const incoming = path.join(work, 'incoming');
      const archive = path.join(work, 'download.dt-sync.gz');
      fs.mkdirSync(incoming);
      await receiveSnapshot(config, snapshot, archive);
      const manifest = await unpack(archive, incoming);
      const environments = jsonFile(incoming, CONFIG[0]);
      const remoteSettings = jsonFile(incoming, CONFIG[1]);
      if (!remoteSettings || typeof remoteSettings !== 'object' || Array.isArray(remoteSettings) ||
          !Array.isArray(jsonFile(incoming, CONFIG[2]))) throw new Error('云端设置或书签无效。');
      if (!Array.isArray(environments) || environments.length !== snapshot.environmentCount ||
          manifest.environmentCount !== snapshot.environmentCount || manifest.websiteData !== snapshot.websiteData) {
        throw new Error('云端包摘要与下载内容不一致。');
      }
      const profiles = profilesOf(store.DATA_DIR, environments);
      const missingPaths = countMissingPaths(environments);
      const expectedFiles = new Set(profiles.map(profile => profile.relative));
      for (const entry of manifest.files) {
        const parts = entry.name.split('/');
        if (parts.length > 1 && !expectedFiles.has(parts.slice(0, 2).join('/'))) throw new Error('云端包含有不属于环境列表的资料。');
      }
      for (const profile of profiles) {
        const destination = path.join(incoming, profile.relative);
        const cookieFile = path.join(destination, 'cloud-cookies.json');
        if (!fs.existsSync(cookieFile)) continue;
        if (profile.core === 'chromium') stageChromiumTabs(destination, destination);
        await restoreCookies(profile, destination, destination, work, profile.core === 'chromium');
        fs.unlinkSync(cookieFile);
      }
      const localSettings = store.getSettings();
      for (const key of DEVICE_SETTINGS) {
        delete remoteSettings[key];
        if (Object.hasOwn(localSettings, key)) remoteSettings[key] = localSettings[key];
      }
      writeJson(incoming, 'settings.json', remoteSettings);
      for (const name of CONFIG) fs.copyFileSync(path.join(incoming, name), path.join(incoming, name.replace('.json', '.bak.json')));
      applyStaged(store.DATA_DIR, work);
      return { backup, snapshot, missingPaths };
    } catch (error) {
      throw new Error(error.message + '\n已保留本地备份：' + backup, { cause: error });
    }
  });
}

async function restoreBackup(id) {
  if (!BACKUP_ID.test(id) || !listBackups().includes(id)) throw new Error('没有找到选中的本地备份。');
  return withOfflineWorkspace(async work => {
    store.loadAll();
    const source = path.join(backupDirectory, id);
    if (!fs.lstatSync(source).isDirectory() || fs.lstatSync(source).isSymbolicLink()) throw new Error('备份目录无效。');
    const backup = makeBackup(store.DATA_DIR);
    const incoming = path.join(work, 'incoming');
    fs.mkdirSync(incoming);
    for (const name of MANAGED) copyTree(path.join(source, name), path.join(incoming, name));
    profilesOf(store.DATA_DIR, jsonFile(incoming, 'environments.json'));
    applyStaged(store.DATA_DIR, work);
    return { backup };
  });
}

function environmentSummary(env) {
  return { id: env.id, name: env.name, group: env.group || '', browserCore: env.browserCore };
}

function localEnvironments() {
  return store.loadAll().map(environmentSummary);
}

async function listEnvironments(config) {
  const payload = await (await request(config, {}, ENVIRONMENT_API)).json();
  if (!Array.isArray(payload.environments) || !Number.isSafeInteger(payload.maxBytes) || payload.maxBytes < 1 ||
      !Number.isSafeInteger(payload.unreadableBackups) || payload.unreadableBackups < 0) {
    throw new Error('服务端环境列表格式无效。');
  }
  const environments = payload.environments.map(env => {
    if (!env || !safeComponent(env.id) || typeof env.name !== 'string' || !env.name ||
        typeof env.group !== 'string' || !['electron', 'chromium'].includes(env.browserCore)) {
      throw new Error('服务端环境信息格式无效。');
    }
    return { ...environmentSummary(env), snapshot: validateSnapshot(env.snapshot) };
  });
  return { environments, unreadableBackups: payload.unreadableBackups, maxBytes: Math.min(payload.maxBytes, MAX_BUNDLE) };
}

function selectedEnvironments({ ids, group } = {}) {
  const environments = store.loadAll();
  let selected;
  if (typeof group === 'string') {
    selected = environments.filter(env => (env.group || '') === group);
  } else if (Array.isArray(ids) && new Set(ids).size === ids.length) {
    selected = environments.filter(env => ids.includes(env.id));
    if (selected.length !== ids.length) throw new Error('有环境已变更，请重新选择。');
  }
  if (!selected?.length) throw new Error('请选择要上传的环境。');
  return selected;
}

async function prepareArchive(work, environments, file) {
  const staging = fs.mkdtempSync(path.join(work, 'outgoing-'));
  writeJson(staging, CONFIG[0], environments);
  writeJson(staging, CONFIG[1], {});
  writeJson(staging, CONFIG[2], []);
  await collectProfiles(staging, environments, work, false);
  await pack(staging, file, { websiteData: false, environmentCount: environments.length });
}

async function uploadSelection(config, selection) {
  const { maxBytes } = await listEnvironments(config);
  return withOfflineWorkspace(async work => {
    const selected = selectedEnvironments(selection);
    requireStopped(selected);
    const uploaded = [];
    for (const env of selected) {
      const job = fs.mkdtempSync(path.join(work, 'upload-'));
      const file = path.join(job, 'upload.dt-sync.gz');
      try {
        await prepareArchive(job, [env], file);
        const size = fs.statSync(file).size;
        if (size > maxBytes) throw new Error('同步包超过服务端允许的大小。');
        const checksum = await digest(file);
        const body = fs.createReadStream(file);
        try {
          const reply = await request(config, {
            method: 'PUT', body, duplex: 'half',
            headers: {
              'Content-Type': 'application/octet-stream', 'Content-Length': String(size),
              'X-DT-SHA256': checksum, 'X-DT-Environment-Count': '1', 'X-DT-Website-Data': '0',
            },
          }, ENVIRONMENT_API);
          validateSnapshot((await reply.json()).snapshot);
          uploaded.push(env.name);
        } finally { body.destroy(); }
      } catch (error) {
        throw new Error('已上传 ' + uploaded.length + ' 个环境。上传「' + env.name + '」失败。' + error.message, { cause: error });
      } finally {
        await fs.promises.rm(job, { recursive: true, force: true, maxRetries: 2, retryDelay: 100 })
          .catch(error => console.warn('上传临时目录清理失败：' + error.code));
      }
    }
    return { uploaded };
  }, false);
}

async function readArchive(file, destination) {
  fs.mkdirSync(destination);
  const manifest = await unpack(file, destination);
  const environments = jsonFile(destination, CONFIG[0]);
  const profiles = profilesOf(store.DATA_DIR, environments);
  if (manifest.environmentCount !== environments.length) throw new Error('备份包环境数量不一致。');
  const expected = new Set(profiles.map(profile => profile.relative));
  for (const entry of manifest.files) {
    const parts = entry.name.split('/');
    if (parts.length > 1 && !expected.has(parts.slice(0, 2).join('/'))) {
      throw new Error('备份包包含不属于环境列表的资料。');
    }
  }
  return { manifest, environments };
}

async function approveEnvironment(name, approveOverwrite) {
  const existing = store.loadAll().find(env => env.name === name);
  if (!existing) return true;
  requireStopped([existing]);
  return approveOverwrite(environmentSummary(existing));
}

async function mergeEnvironment(work, extracted, remote) {
  const all = store.loadAll();
  const existing = all.find(env => env.name === remote.name);
  const idTaken = id => all.some(env => env.id.toLowerCase() === id.toLowerCase() ||
    path.basename(env.userDataDir || env.id).toLowerCase() === id.toLowerCase()) ||
    profilesOf(store.DATA_DIR, [{ ...remote, id, userDataDir: id }])
      .some(profile => profileDirectory(store.DATA_DIR, profile.relative));
  const id = existing?.id || (idTaken(remote.id) ? 'env-' + randomUUID() : remote.id);
  const record = { ...remote, id, userDataDir: existing?.userDataDir || path.join('data', 'profiles', id) };
  let adjustedPort = null;
  if (record.remotePortEnabled) {
    const port = Number(record.remotePort);
    const inUse = all.some(env => env.id !== id && env.remotePortEnabled && Number(env.remotePort) === port);
    if (inUse || !Number.isInteger(port) || port < 1 || port > 65535 || !await store.isPortAvailable(port)) {
      adjustedPort = record.remotePort = await store.getNextAvailablePort(existing?.id);
    }
  }
  const incoming = path.join(work, 'incoming');
  fs.mkdirSync(incoming);
  const origins = profilesOf(store.DATA_DIR, [remote]);
  const targets = profilesOf(store.DATA_DIR, [record]);
  const changed = [];
  for (const [index, profile] of targets.entries()) {
    const source = profileDirectory(extracted, origins[index].relative);
    if (!source) continue;
    const live = profileDirectory(store.DATA_DIR, profile.relative);
    const target = path.join(incoming, profile.relative);
    fs.mkdirSync(target, { recursive: true });
    if (live) copyTree(live, target, true);
    // Chromium ignores --restore-last-session for an uninitialized profile.
    await restoreCookies(profile, source, target, work, Boolean(live) || profile.core === 'chromium');
    if (profile.core === 'chromium') {
      const remoteDefault = path.join(source, 'Default');
      const targetDefault = path.join(target, 'Default');
      const remoteHistory = fs.existsSync(path.join(remoteDefault, 'History'));
      if (remoteHistory) {
        for (const name of [...HISTORY_FILES, 'History-shm']) fs.rmSync(path.join(targetDefault, name), { force: true });
        for (const name of HISTORY_FILES) copyTree(path.join(remoteDefault, name), path.join(targetDefault, name));
      }
      if (live) copyChromiumTabs(live, target, true);
      stageChromiumTabs(source, target);
    } else {
      const history = path.join(source, 'cloud-history.jsonl');
      if (fs.existsSync(history)) {
        fs.rmSync(path.join(target, 'cloud-history.jsonl'), { force: true });
        copyTree(history, path.join(target, 'cloud-history.jsonl'));
      }
    }
    changed.push(profile.relative);
  }
  const merged = existing ? all.map(env => env.id === id ? record : env) : [...all, record];
  profilesOf(store.DATA_DIR, merged);
  writeJson(incoming, CONFIG[0], merged);
  writeJson(incoming, 'environments.bak.json', merged);
  applyStaged(store.DATA_DIR, work, [...changed, CONFIG[0], 'environments.bak.json']);
  return { name: record.name, replaced: Boolean(existing), adjustedPort, missingPaths: countMissingPaths([record]) };
}

async function syncEnvironment(config, { id, revision }, approveOverwrite) {
  const { environments } = await listEnvironments(config);
  const item = environments.find(env => env.id === id && env.snapshot.revision === revision);
  if (!item) throw new Error('找不到所选备份，请重新打开云端列表。');
  return withOfflineWorkspace(async work => {
    if (!await approveEnvironment(item.name, approveOverwrite)) return null;
    const file = path.join(work, 'download.dt-sync.gz');
    const extracted = path.join(work, 'extracted');
    await receiveSnapshot(config, item.snapshot, file);
    const archive = await readArchive(file, extracted);
    const remote = archive.environments.find(env => env.id === id);
    if (!remote || remote.name !== item.name || (remote.group || '') !== item.group || remote.browserCore !== item.browserCore ||
        archive.manifest.environmentCount !== item.snapshot.environmentCount ||
        archive.manifest.websiteData !== item.snapshot.websiteData) throw new Error('云端列表与备份内容不一致。');
    return mergeEnvironment(work, extracted, remote);
  }, false);
}

async function exportFile(file) {
  return withOfflineWorkspace(async work => {
    const environments = store.loadAll();
    if (!environments.length) throw new Error('暂无可备份的环境。');
    requireStopped(environments);
    const temporary = path.join(path.dirname(file), '.dt-sync-' + randomUUID() + '.tmp');
    const archive = path.join(work, 'local.dt-sync.gz');
    await prepareArchive(work, environments, archive);
    try {
      fs.copyFileSync(archive, temporary, fs.constants.COPYFILE_EXCL);
      fs.renameSync(temporary, file);
    } finally { fs.rmSync(temporary, { force: true }); }
    return { count: environments.length };
  }, false);
}

async function withLocalFile(file, operation) {
  return withOfflineWorkspace(async work => {
    const extracted = path.join(work, 'extracted');
    const archive = await readArchive(file, extracted);
    return operation(work, extracted, archive.environments);
  }, false);
}

function inspectFile(file) {
  return withLocalFile(file, (_work, _extracted, environments) => environments.map(environmentSummary));
}

function restoreFile(file, id, approveOverwrite) {
  return withLocalFile(file, async (work, extracted, environments) => {
    const remote = environments.find(env => env.id === id);
    if (!remote) throw new Error('备份包里没有选中的环境。');
    if (!await approveEnvironment(remote.name, approveOverwrite)) return null;
    return mergeEnvironment(work, extracted, remote);
  });
}

module.exports = { normalizeConnection, settings, query, upload, download, restoreBackup, listBackups, backupDirectory,
  localEnvironments, listEnvironments, uploadSelection, syncEnvironment, exportFile, inspectFile, restoreFile };
