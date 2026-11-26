'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { Readable } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const { createGzip, createGunzip } = require('node:zlib');
const { randomUUID } = require('node:crypto');

const CONFIG = ['environments.json', 'settings.json', 'bookmarks.json'];
const MANAGED = [...CONFIG, 'environments.bak.json', 'settings.bak.json', 'bookmarks.bak.json',
  'profiles', 'chromium-profiles'];
const WEBSITE = ['Local Storage', 'IndexedDB', 'Session Storage', 'WebStorage', 'File System'];
const CACHE = new Set(['Cache', 'Code Cache', 'GPUCache', 'DawnGraphiteCache', 'DawnWebGPUCache',
  'GrShaderCache', 'GraphiteDawnCache', 'ShaderCache', 'Crashpad', 'CacheStorage']);
const LIMIT = 8 * 1024 ** 2;
const MAX_EXTRACT = 8 * 1024 ** 3;
const JOURNAL = '.cloud-apply.json';
const CHROMIUM_TAB_MARKER = 'cloud-restore-tabs';
const CHROMIUM_SESSION = /^(?:Session|Tabs)_\d+$/;
const LEGACY_SESSIONS = ['Last Session', 'Last Tabs', 'Current Session', 'Current Tabs'];
const HISTORY_FILES = ['History', 'History-wal', 'History-journal'];

function safeComponent(name) {
  return typeof name === 'string' && name.length > 0 && !/[<>:"/\\|?*\x00-\x1f]/.test(name) &&
    !/[. ]$/.test(name) && !/^ *(?:con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(name);
}

function collectFiles(root, relative = '') {
  const files = [];
  for (const item of fs.readdirSync(path.join(root, relative), { withFileTypes: true })) {
    if (!safeComponent(item.name)) throw new Error('同步资料包含无效文件名。');
    const name = relative ? relative + '/' + item.name : item.name;
    if (item.isDirectory()) files.push(...collectFiles(root, name));
    else if (item.isFile()) files.push({ name, size: fs.statSync(path.join(root, name)).size });
    else throw new Error('同步资料包含不支持的文件类型。');
  }
  return files;
}

function isBundlePath(name, websiteData) {
  if (typeof name !== 'string') return false;
  const [collection, profile, ...inner] = name.split('/');
  if (![collection, profile, ...inner].filter(part => part !== undefined).every(safeComponent)) return false;
  if (!profile) return CONFIG.includes(collection);
  if (collection !== 'profiles' && collection !== 'chromium-profiles') return false;
  if (collection === 'chromium-profiles' && !/^[0-9a-f]{64}$/.test(profile)) return false;
  if (inner.length === 1 && inner[0] === 'cloud-cookies.json') return true;
  if (collection === 'profiles' && inner.length === 1 && inner[0] === 'cloud-history.jsonl') return true;
  if (collection === 'chromium-profiles' && inner[0] === 'Default') {
    if (inner.length === 2 && [...HISTORY_FILES, ...LEGACY_SESSIONS].includes(inner[1])) return true;
    if (inner.length === 3 && inner[1] === 'Sessions' && CHROMIUM_SESSION.test(inner[2])) return true;
  }
  if (!websiteData) return false;
  const index = collection === 'chromium-profiles' ? (inner[0] === 'Default' ? 1 : -1)
    : inner[0] === 'Partitions' ? 2 : 0;
  return WEBSITE.includes(inner[index]) && !inner.slice(index + 1).some(part => CACHE.has(part));
}

async function pack(root, output, summary) {
  const files = collectFiles(root);
  const configIndex = files.findIndex(file => file.name === CONFIG[0]);
  if (configIndex > 0) files.unshift(...files.splice(configIndex, 1));
  const manifest = Buffer.from(JSON.stringify({ schema: 1, ...summary, files }));
  if (manifest.length > LIMIT) throw new Error('同步文件数量超出限制。');
  const header = Buffer.alloc(4);
  header.writeUInt32BE(manifest.length);
  async function* contents() {
    yield header;
    yield manifest;
    for (const file of files) yield* fs.createReadStream(path.join(root, file.name));
  }
  await pipeline(Readable.from(contents()), createGzip(), fs.createWriteStream(output, { flags: 'wx' }));
}

async function unpack(bundle, destination) {
  const file = fs.createReadStream(bundle);
  const decoded = createGunzip();
  const stream = file.pipe(decoded);
  file.on('error', error => decoded.destroy(error));
  const iterator = stream[Symbol.asyncIterator]();
  let buffer = Buffer.alloc(0);
  async function read(size, consume) {
    while (size > 0) {
      if (!buffer.length) {
        const next = await iterator.next();
        if (next.done) throw new Error('同步包不完整。');
        buffer = next.value;
      }
      const count = Math.min(size, buffer.length);
      consume(buffer.subarray(0, count));
      buffer = buffer.subarray(count);
      size -= count;
    }
  }
  async function headerBytes(size) {
    const chunks = [];
    await read(size, chunk => chunks.push(chunk));
    return Buffer.concat(chunks);
  }
  try {
    const length = (await headerBytes(4)).readUInt32BE(0);
    if (length < 2 || length > LIMIT) throw new Error('同步包头无效。');
    const manifest = JSON.parse((await headerBytes(length)).toString('utf8'));
    if (manifest.schema !== 1 || !Array.isArray(manifest.files) || typeof manifest.websiteData !== 'boolean') {
      throw new Error('此版本不支持该同步包格式。');
    }
    const names = new Set();
    let total = 0;
    for (const entry of manifest.files) {
      if (!entry || !isBundlePath(entry.name, manifest.websiteData) || names.has(entry.name.toLowerCase()) ||
          !Number.isSafeInteger(entry.size) || entry.size < 0 || (total += entry.size) > MAX_EXTRACT) {
        throw new Error('同步包文件清单无效。');
      }
      names.add(entry.name.toLowerCase());
    }
    if (CONFIG.some(name => !names.has(name))) throw new Error('同步包缺少环境或设置文件。');
    for (const entry of manifest.files) {
      const destinationFile = path.join(destination, entry.name);
      fs.mkdirSync(path.dirname(destinationFile), { recursive: true });
      const descriptor = fs.openSync(destinationFile, 'wx');
      try { await read(entry.size, chunk => fs.writeFileSync(descriptor, chunk)); }
      finally { fs.closeSync(descriptor); }
    }
    if (buffer.length || !(await iterator.next()).done) throw new Error('同步包有额外内容。');
    return manifest;
  } finally {
    file.destroy();
    decoded.destroy();
  }
}

function copyTree(source, destination, includeCache = false) {
  const info = fs.lstatSync(source, { throwIfNoEntry: false });
  if (!info || (!includeCache && CACHE.has(path.basename(source)))) return;
  if (info.isSymbolicLink()) throw new Error('资料目录含有链接，无法完整备份。');
  if (info.isDirectory()) {
    fs.mkdirSync(destination, { recursive: true });
    for (const item of fs.readdirSync(source)) copyTree(path.join(source, item), path.join(destination, item), includeCache);
  } else if (info.isFile()) {
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.copyFileSync(source, destination, fs.constants.COPYFILE_EXCL);
    if (fs.statSync(destination).size !== info.size) throw new Error('备份文件大小校验失败。');
  }
}

function chromiumSessionFiles(profile) {
  const base = path.join(profile, 'Default');
  const info = fs.lstatSync(base, { throwIfNoEntry: false });
  if (!info) return [];
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Chromium 资料目录无效。');
  const folder = path.join(base, 'Sessions');
  const sessions = fs.lstatSync(folder, { throwIfNoEntry: false });
  if (sessions && (!sessions.isDirectory() || sessions.isSymbolicLink())) {
    throw new Error('Chromium 标签页目录无效。');
  }
  return [
    ...LEGACY_SESSIONS.filter(name => fs.existsSync(path.join(base, name))),
    ...(sessions ? fs.readdirSync(folder).filter(name => CHROMIUM_SESSION.test(name))
      .map(name => 'Sessions/' + name) : []),
  ];
}

function copyChromiumTabs(source, destination, replace = false) {
  const entries = chromiumSessionFiles(source);
  if (replace) {
    for (const name of chromiumSessionFiles(destination)) fs.unlinkSync(path.join(destination, 'Default', name));
  }
  for (const name of entries) {
    const file = path.join(source, 'Default', name);
    if (!fs.lstatSync(file).isFile()) throw new Error('Chromium 标签页文件无效。');
    copyTree(file, path.join(destination, 'Default', name));
  }
}

function stageChromiumTabs(source, destination) {
  if (chromiumSessionFiles(source).length) {
    copyChromiumTabs(source, path.join(destination, CHROMIUM_TAB_MARKER), true);
  }
}

function copyCookieProfile(source, destination, core) {
  const bases = core === 'chromium' ? ['Default'] : [''];
  if (core === 'electron') {
    const partitions = path.join(source, 'Partitions');
    const info = fs.lstatSync(partitions, { throwIfNoEntry: false });
    if (info?.isSymbolicLink()) throw new Error('分区目录含有链接，无法同步。');
    if (info?.isDirectory()) {
      for (const item of fs.readdirSync(partitions, { withFileTypes: true })) {
        if (item.isSymbolicLink()) throw new Error('分区目录含有链接，无法同步。');
        if (item.isDirectory()) bases.push('Partitions/' + item.name);
      }
    }
  }
  copyTree(path.join(source, 'Local State'), path.join(destination, 'Local State'));
  for (const base of bases) {
    for (const folder of [base, path.join(base, 'Network')]) {
      const directory = fs.lstatSync(path.join(source, folder), { throwIfNoEntry: false });
      if (directory?.isSymbolicLink()) throw new Error('Cookie 资料目录含有链接。');
      for (const suffix of ['', '-wal', '-shm', '-journal']) {
        const name = path.join(folder, 'Cookies' + suffix);
        copyTree(path.join(source, name), path.join(destination, name));
      }
    }
  }
}

function copyProfile(source, destination, core, websiteData) {
  if (core === 'chromium') {
    for (const name of [...HISTORY_FILES, ...(websiteData ? WEBSITE : [])]) {
      copyTree(path.join(source, 'Default', name), path.join(destination, 'Default', name));
    }
    const pending = path.join(source, CHROMIUM_TAB_MARKER);
    const info = fs.lstatSync(pending, { throwIfNoEntry: false });
    if (info && (!info.isDirectory() || info.isSymbolicLink())) throw new Error('待恢复的 Chromium 标签页目录无效。');
    copyChromiumTabs(info ? pending : source, destination);
  } else {
    copyTree(path.join(source, 'cloud-history.jsonl'), path.join(destination, 'cloud-history.jsonl'));
    if (websiteData) {
      for (const name of WEBSITE) copyTree(path.join(source, name), path.join(destination, name));
      const partitions = path.join(source, 'Partitions');
      const info = fs.lstatSync(partitions, { throwIfNoEntry: false });
      if (info?.isSymbolicLink()) throw new Error('分区目录含有链接，无法同步。');
      if (info?.isDirectory()) {
        for (const item of fs.readdirSync(partitions, { withFileTypes: true })) {
          if (item.isSymbolicLink()) throw new Error('分区目录含有链接，无法同步。');
          if (!item.isDirectory()) continue;
          for (const name of WEBSITE) copyTree(path.join(partitions, item.name, name),
            path.join(destination, 'Partitions', item.name, name));
        }
      }
    }
  }
}

function makeBackup(data) {
  const root = path.join(data, 'cloud-backups');
  fs.mkdirSync(root, { recursive: true });
  if (fs.lstatSync(root).isSymbolicLink()) throw new Error('备份目录不能指向链接。');
  const id = new Date().toISOString().replace(/[:.]/g, '-') + '-' + randomUUID().slice(0, 8);
  const pending = path.join(root, '.' + id);
  fs.mkdirSync(pending);
  try {
    for (const name of MANAGED) copyTree(path.join(data, name), path.join(pending, name));
    fs.renameSync(pending, path.join(root, id));
  } catch (error) {
    fs.rmSync(pending, { recursive: true, force: true });
    throw error;
  }
  return path.join(root, id);
}

function validateApplyTargets(targets) {
  if (!Array.isArray(targets) || !targets.length ||
      targets.some(name => typeof name !== 'string' || !(MANAGED.includes(name) ||
        (/^profiles\/[^/]+$/.test(name) && safeComponent(name.slice(9))) ||
        /^chromium-profiles\/[0-9a-f]{64}$/.test(name))) ||
      targets.some((name, index) => targets.some((other, otherIndex) =>
        otherIndex !== index && (other.toLowerCase() === name.toLowerCase() || other.startsWith(name + '/'))))) {
    throw new Error('云同步恢复记录无效。');
  }
}

function guardApplyParents(data, stage, targets) {
  for (const relative of targets) {
    if (!relative.includes('/')) continue;
    const parent = relative.split('/')[0];
    for (const root of [data, path.join(stage, 'previous'), path.join(stage, 'incoming')]) {
      const info = fs.lstatSync(path.join(root, parent), { throwIfNoEntry: false });
      if (info && (!info.isDirectory() || info.isSymbolicLink())) throw new Error('环境资料目录无效。');
    }
  }
}

function recoverInterruptedApply(data) {
  const journal = path.join(data, JOURNAL);
  if (!fs.existsSync(journal)) return;
  const { stage: name, previous, targets = MANAGED } = JSON.parse(fs.readFileSync(journal, 'utf8'));
  validateApplyTargets(targets);
  if (!/^\.cloud-work-[a-f0-9-]+$/.test(name) || !Array.isArray(previous) ||
      previous.some(item => !targets.includes(item))) throw new Error('云同步恢复记录无效。');
  const stage = path.join(data, name);
  guardApplyParents(data, stage, targets);
  for (const item of targets) {
    const oldFile = path.join(stage, 'previous', item);
    const live = path.join(data, item);
    if (fs.existsSync(oldFile)) {
      fs.rmSync(live, { recursive: true, force: true });
      fs.renameSync(oldFile, live);
    } else if (!previous.includes(item)) {
      fs.rmSync(live, { recursive: true, force: true });
    }
  }
  fs.unlinkSync(journal);
  fs.rmSync(stage, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
}

function applyStaged(data, stage, targets = MANAGED) {
  validateApplyTargets(targets);
  const journal = path.join(data, JOURNAL);
  const incoming = path.join(stage, 'incoming');
  fs.mkdirSync(path.join(stage, 'previous'));
  guardApplyParents(data, stage, targets);
  const previous = targets.filter(name => fs.existsSync(path.join(data, name)));
  const pending = path.join(stage, 'apply.json');
  fs.writeFileSync(pending, JSON.stringify({ stage: path.basename(stage), previous, targets }), { flag: 'wx', flush: true });
  fs.renameSync(pending, journal);
  try {
    for (const name of targets) {
      const live = path.join(data, name);
      if (previous.includes(name)) {
        const prior = path.join(stage, 'previous', name);
        fs.mkdirSync(path.dirname(prior), { recursive: true });
        fs.renameSync(live, prior);
      }
      const staged = path.join(incoming, name);
      if (fs.existsSync(staged)) {
        fs.mkdirSync(path.dirname(live), { recursive: true });
        fs.renameSync(staged, live);
      }
    }
    fs.unlinkSync(journal);
  } catch (error) {
    recoverInterruptedApply(data);
    throw error;
  }
}

module.exports = { CONFIG, MANAGED, CHROMIUM_TAB_MARKER, HISTORY_FILES, safeComponent, pack, unpack,
  copyProfile, copyChromiumTabs, stageChromiumTabs, copyCookieProfile, copyTree, makeBackup, applyStaged,
  recoverInterruptedApply };
