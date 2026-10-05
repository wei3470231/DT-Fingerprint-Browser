'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const { BrowserWindow, webContents } = require('electron');

const copy = value => JSON.parse(JSON.stringify(value));
const errorText = error => String(error?.message || error);
const MAX_CODE = 1024 * 1024;
function matchesURL(url, patterns) {
  if (!/^https?:\/\//i.test(url)) return false;
  return patterns.some(pattern => new RegExp('^' + pattern.split('*').map(piece => piece.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$', 'i').test(url));
}

class AutomationManager extends EventEmitter {
  constructor({ storageDir, getProfileIds, timeoutMs = 10000 }) {
    super();
    if (!path.isAbsolute(storageDir)) throw new Error('storageDir 必须为绝对路径。');
    this.root = storageDir; this.file = path.join(storageDir, 'automation.json');
    this.logFile = path.join(storageDir, 'automation-logs.jsonl');
    this.getProfileIds = getProfileIds; this.timeoutMs = timeoutMs;
    this.views = new Map(); this.bindings = new Map(); this.loaded = new Map(); this.busy = new Map();
    this.popups = new Map(); this.queues = new Map(); this.closed = false;
    fs.mkdirSync(storageDir, { recursive: true });
    this.data = { schemaVersion: 1, scripts: [], extensions: [] };
    if (fs.existsSync(this.file)) {
      const stored = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (stored.schemaVersion !== 1 || !Array.isArray(stored.scripts) || !Array.isArray(stored.extensions)) throw new Error('automation.json 格式无效，原文件已保留。');
      this.data = stored;
    }
    this.logs = [];
    if (fs.existsSync(this.logFile)) {
      for (const line of fs.readFileSync(this.logFile, 'utf8').split('\n').filter(Boolean).slice(-200)) {
        try { this.logs.push(JSON.parse(line)); } catch { /* Ignore an incomplete final log line after a crash. */ }
      }
    }
  }
  save() {
    const temp = this.file + '.tmp';
    fs.writeFileSync(temp, JSON.stringify(this.data, null, 2), 'utf8'); fs.renameSync(temp, this.file);
    this.changed();
  }
  changed() { if (!this.closed) this.emit('changed'); }
  log(entry) {
    const record = { id: crypto.randomUUID(), at: new Date().toISOString(), ...entry };
    this.logs.push(record); this.logs = this.logs.slice(-200);
    // Bounded retained history; a second file preserves the previous rotation.
    if (fs.existsSync(this.logFile) && fs.statSync(this.logFile).size > 2 * 1024 * 1024) {
      const previous = this.logFile + '.previous';
      fs.copyFileSync(this.logFile, previous); fs.writeFileSync(this.logFile, '');
    }
    fs.appendFileSync(this.logFile, JSON.stringify(record) + '\n'); this.changed(); return record;
  }
  profileIds(ids) {
    if (!Array.isArray(ids) || ids.some(id => typeof id !== 'string' || !this.getProfileIds().includes(id))) throw new Error('请选择有效的目标实例。');
    return [...new Set(ids)];
  }
  state() {
    return copy({ scripts: this.data.scripts, extensions: this.data.extensions.map(ext => ({ ...ext,
      profiles: this.getProfileIds().map(profileId => ({ profileId, enabled: ext.profileIds.includes(profileId), ...(this.loaded.get(`${ext.id}:${profileId}`) || { status: 'disabled' }) })) })), logs: this.logs });
  }
  saveScript(input) {
    if (!input || typeof input.code !== 'string' || Buffer.byteLength(input.code) > MAX_CODE) throw new Error('JS 脚本必须小于 1 MB。');
    // Compile only; never execute user code in the privileged main process.
    new vm.Script(`(async function(console) {\n${input.code}\n})`);
    if (!['manual', 'page-loaded'].includes(input.trigger)) throw new Error('脚本触发方式无效。');
    const patterns = input.matches || ['http://*/*', 'https://*/*'];
    if (!Array.isArray(patterns) || !patterns.length || patterns.length > 50 || patterns.some(item => typeof item !== 'string' || !item.trim() || item.length > 2048)) throw new Error('至少填写一条有效的网址匹配规则。');
    const profileIds = this.profileIds(input.profileIds);
    if (!profileIds.length) throw new Error('脚本至少需要一个目标实例。');
    const old = input.id ? this.data.scripts.find(item => item.id === input.id) : null;
    if (input.id && !old) throw new Error('脚本不存在。');
    const script = { id: old?.id || crypto.randomUUID(), name: String(input.name || '未命名脚本').trim().slice(0, 80), code: input.code,
      trigger: input.trigger, enabled: input.enabled !== false, profileIds, matches: patterns.map(value => value.trim()), updatedAt: new Date().toISOString() };
    if (old) Object.assign(old, script); else this.data.scripts.push(script);
    this.save(); return copy(script);
  }
  importScript(file, profileIds) {
    if (path.extname(file).toLowerCase() !== '.js' || fs.statSync(file).size > MAX_CODE) throw new Error('请选择小于 1 MB 的 .js 文件。');
    return this.saveScript({ name: path.basename(file), code: fs.readFileSync(file, 'utf8'), profileIds, trigger: 'manual', enabled: true });
  }
  deleteScript(id) {
    this.data.scripts = this.data.scripts.filter(item => item.id !== id); this.save();
  }
  async runScript(id, profileIds, source = 'manual') {
    const script = this.data.scripts.find(item => item.id === id);
    if (!script) throw new Error('脚本不存在。');
    if (!script.enabled) throw new Error('脚本已停用。');
    const targets = this.profileIds(profileIds || script.profileIds);
    if (!targets.length || targets.some(id => !script.profileIds.includes(id))) throw new Error('目标实例不在脚本授权范围。');
    return Promise.all(targets.map(profileId => this.runOne(copy(script), profileId, source)));
  }
  async runOne(script, profileId, source) {
    const wc = this.views.get(profileId)?.webContents;
    const base = { kind: 'script', scriptId: script.id, name: script.name, profileId, source, url: wc?.getURL() || '' };
    if (!wc || wc.isDestroyed()) return this.log({ ...base, status: 'error', error: '实例未运行。' });
    if (!matchesURL(base.url, script.matches)) return this.log({ ...base, status: 'skipped', error: '当前网址不匹配脚本规则。' });
    if (this.busy.has(profileId)) return this.log({ ...base, status: 'skipped', error: '该实例仍有脚本执行中；超时后可刷新页面解除。' });
    const token = {}; this.busy.set(profileId, token);
    const code = `(async () => {
      const lines = [];
      const pack = (value, limit = 16000) => { const seen = new WeakSet(); try {
        const text = JSON.stringify(value, (_key, item) => {
          if (typeof item === 'bigint') return String(item) + 'n';
          if (typeof item === 'function') return '[Function]';
          if (item instanceof Error) return {name:item.name,message:item.message,stack:item.stack};
          if (item && typeof item === 'object') { if (seen.has(item)) return '[Circular]'; seen.add(item); }
          return item;
        }); return text === undefined ? '[undefined]' : text.length > limit ? text.slice(0,limit) + '…[truncated]' : JSON.parse(text);
      } catch(error) { return '[Unserializable: ' + error.message + ']'; } };
      const console = Object.fromEntries(['log','info','warn','error','debug'].map(level => [level, (...args) => { if(lines.length < 50) lines.push({level,args:pack(args,2000)}); }]));
      try { const result = await (async function(console) {\n${script.code}\n})(console); return {ok:true,result:pack(result),console:lines}; }
      catch(error) { return {ok:false,error:String(error?.stack || error).slice(0,16000),console:lines}; }
    })()`;
    let timer;
    // World 1001 shares the DOM, but does not expose the host preload or Node.
    const execution = Promise.resolve().then(() => wc.executeJavaScriptInIsolatedWorld(1001, [{ code }]));
    execution.finally(() => { if (this.busy.get(profileId) === token) this.busy.delete(profileId); }).catch(() => {});
    try {
      const result = await Promise.race([execution, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('执行等待超时；脚本可能仍在页面中运行，请刷新页面后重试。')), this.timeoutMs); })]);
      return this.log({ ...base, status: result.ok ? 'success' : 'error', result: result.result, error: result.error, console: result.console });
    } catch (error) { return this.log({ ...base, status: /超时/.test(errorText(error)) ? 'timeout' : 'error', error: errorText(error) }); }
    finally { clearTimeout(timer); }
  }
  async attach(profileId, view) {
    this.detach(profileId); this.views.set(profileId, view);
    const wc = view.webContents;
    const navigate = (_event, _url, inPlace, mainFrame) => { if (mainFrame && !inPlace) this.busy.delete(profileId); };
    const loaded = () => { void (async () => {
      for (const script of this.data.scripts.slice()) {
        if (this.closed || wc.isDestroyed()) break;
        if (script.enabled && script.trigger === 'page-loaded' && script.profileIds.includes(profileId) && matchesURL(wc.getURL(), script.matches)) {
          try { await this.runScript(script.id, [profileId], 'page-loaded'); } catch (error) { this.log({kind:'script', profileId, scriptId:script.id, status:'error', error:errorText(error)}); }
        }
      }
    })(); };
    const destroyed = () => this.detach(profileId);
    wc.on('did-start-navigation', navigate); wc.on('did-finish-load', loaded); wc.once('destroyed', destroyed);
    this.bindings.set(profileId, { wc, navigate, loaded, destroyed });
    for (const ext of this.data.extensions) if (ext.profileIds.includes(profileId)) await this.loadExtensionFor(ext, profileId);
  }
  detach(profileId) {
    const binding = this.bindings.get(profileId);
    if (binding) {
      binding.wc.removeListener('did-start-navigation', binding.navigate); binding.wc.removeListener('did-finish-load', binding.loaded); binding.wc.removeListener('destroyed', binding.destroyed);
    }
    this.bindings.delete(profileId); this.views.delete(profileId); this.busy.delete(profileId);
    for (const [key, popup] of this.popups) if (key.endsWith(`:${profileId}`)) { if (!popup.isDestroyed()) popup.destroy(); this.popups.delete(key); }
  }
  async importExtension(directory, profileIds) {
    const targets = this.profileIds(profileIds);
    if (!targets.length) throw new Error('请选择至少一个实例。');
    const root = fs.realpathSync(directory), manifestFile = path.join(root, 'manifest.json');
    if (!fs.statSync(root).isDirectory() || fs.lstatSync(manifestFile).isSymbolicLink()) throw new Error('请选择包含 manifest.json 的解压扩展目录。');
    const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
    if (!manifest.name || !manifest.version || ![2,3].includes(manifest.manifest_version)) throw new Error('扩展 manifest 缺少有效的 name/version/manifest_version。');
    if (manifest.key && this.data.extensions.some(ext => ext.manifestKey === manifest.key)) throw new Error('此固定 ID 扩展已在扩展库中，请通过实例开关启用；更新版本需先卸载旧登记。');
    let bytes = 0, files = 0;
    const visit = folder => {
      for (const entry of fs.readdirSync(folder, { withFileTypes: true })) {
        const file = path.join(folder, entry.name), stat = fs.lstatSync(file);
        if (stat.isSymbolicLink()) throw new Error('扩展目录不可含符号链接或目录联接。');
        if (stat.isDirectory()) visit(file);
        else if (stat.isFile()) { bytes += stat.size; files++; }
        else throw new Error('扩展含不支持的文件类型。');
        if (bytes > 100 * 1024 * 1024 || files > 10000) throw new Error('扩展目录超过 100 MB 或 10000 个文件。');
      }
    };
    visit(root);
    const id = crypto.randomUUID(), managed = path.join(this.root, 'extensions', id);
    if (managed.toLowerCase().startsWith(root.toLowerCase() + path.sep)) throw new Error('扩展源目录不能包含托管扩展目录。');
    fs.mkdirSync(path.dirname(managed), { recursive: true });
    fs.cpSync(root, managed, { recursive: true, dereference: false });
    const ext = { id, name: manifest.name, version: manifest.version, manifestVersion: manifest.manifest_version,
      directory: managed, profileIds: targets, permissions: [...(manifest.permissions || []), ...(manifest.host_permissions || [])],
      manifestKey: manifest.key || undefined, importedAt: new Date().toISOString(), compatibility: '加载成功仅代表初始化完成；页面注入、后台、弹窗和存储需要分别验收。' };
    this.data.extensions.push(ext); this.save();
    for (const profileId of targets) await this.loadExtensionFor(ext, profileId);
    return this.state().extensions.find(item => item.id === id);
  }
  async loadExtensionFor(ext, profileId) {
    const key = `${ext.id}:${profileId}`, view = this.views.get(profileId);
    if (!view || view.webContents.isDestroyed()) { this.loaded.set(key, { status:'pending' }); return; }
    const ses = view.webContents.session;
    let native;
    try {
      if (this.loaded.get(key)?.status === 'loaded') return;
      native = await ses.extensions.loadExtension(ext.directory);
      // loadExtension resolves before a persistent MV2 background page executes.
      // Wait for that page before allowing the caller's first navigation/messages.
      const manifest = JSON.parse(fs.readFileSync(path.join(ext.directory, 'manifest.json'), 'utf8'));
      if (manifest.manifest_version === 2 && manifest.background && manifest.background.persistent !== false) {
        const deadline = Date.now() + 5000;
        let ready = false;
        while (!this.closed && Date.now() < deadline) {
          const background = webContents.getAllWebContents().find(wc => !wc.isDestroyed() && wc.getType() === 'backgroundPage' && wc.session === ses && wc.getURL().startsWith(`chrome-extension://${native.id}/`));
          if (background && !background.isLoadingMainFrame()) { ready = true; break; }
          await new Promise(resolve => setTimeout(resolve, 25));
        }
        if (!ready && !this.closed) throw new Error('MV2 常驻后台页未在 5 秒内完成加载，请查看扩展资源并重新启用。');
      }
      if (this.closed) { ses.extensions.removeExtension(native.id); return; }
      this.loaded.set(key, { status: 'loaded', runtimeId: native.id });
      this.log({kind:'extension', extensionId:ext.id, profileId, status:'loaded', name:ext.name, runtimeId:native.id});
    } catch (error) {
      if (native) ses.extensions.removeExtension(native.id);
      this.loaded.set(key, { status:'error', error:errorText(error) });
      this.log({kind:'extension', extensionId:ext.id, profileId, status:'error', error:errorText(error), name:ext.name});
    }
    this.changed();
  }
  async setExtensionEnabled(id, profileId, enabled) {
    this.profileIds([profileId]);
    const key = `${id}:${profileId}`;
    const previous = this.queues.get(key) || Promise.resolve();
    const work = previous.catch(() => {}).then(async () => {
      const ext = this.data.extensions.find(item => item.id === id); if (!ext) throw new Error('扩展不存在。');
      if (enabled) {
        if (!ext.profileIds.includes(profileId)) ext.profileIds.push(profileId);
        this.save(); await this.loadExtensionFor(ext, profileId);
      } else {
        this.unloadExtensionFor(ext, profileId);
        ext.profileIds = ext.profileIds.filter(item => item !== profileId); this.save();
      }
      return this.state();
    });
    this.queues.set(key, work); try { return await work; } finally { if (this.queues.get(key) === work) this.queues.delete(key); }
  }
  unloadExtensionFor(ext, profileId) {
    const key = `${ext.id}:${profileId}`, state = this.loaded.get(key), popup = this.popups.get(key);
    if (popup && !popup.isDestroyed()) popup.destroy(); this.popups.delete(key);
    const ses = this.views.get(profileId)?.webContents.session;
    if (state?.runtimeId && ses) ses.extensions.removeExtension(state.runtimeId);
    this.loaded.set(key, { status:'disabled' }); this.changed();
  }
  async uninstallExtension(id) {
    await Promise.all([...this.queues.entries()].filter(([key]) => key.startsWith(id + ':')).map(([, work]) => work.catch(() => {})));
    const ext = this.data.extensions.find(item => item.id === id); if (!ext) throw new Error('扩展不存在。');
    for (const profileId of this.getProfileIds()) this.unloadExtensionFor(ext, profileId);
    this.data.extensions = this.data.extensions.filter(item => item.id !== id); this.save();
    // Keep the imported files as a recoverable local copy; no caller directory is deleted.
    this.log({kind:'extension', extensionId:id, name:ext.name, status:'uninstalled', note:'已取消全部实例注册；保留导入副本与原目录。'});
  }
  async openExtensionPopup(id, profileId, { parent, show = true } = {}) {
    const ext = this.data.extensions.find(item => item.id === id), key = `${id}:${profileId}`, state = this.loaded.get(key);
    if (!ext || state?.status !== 'loaded') throw new Error('请先在目标实例启用扩展。');
    const old = this.popups.get(key); if (old && !old.isDestroyed()) { if (show) { old.show(); old.focus(); } return old; }
    const manifest = JSON.parse(fs.readFileSync(path.join(ext.directory, 'manifest.json'), 'utf8'));
    const resource = manifest.action?.default_popup || manifest.browser_action?.default_popup || manifest.page_action?.default_popup;
    if (!resource || typeof resource !== 'string') throw new Error('此扩展未声明 default_popup。');
    const url = new URL(resource, `chrome-extension://${state.runtimeId}/`);
    if (url.protocol !== 'chrome-extension:' || url.hostname !== state.runtimeId) throw new Error('扩展弹窗路径无效。');
    const popup = new BrowserWindow({ width:460, height:600, show, parent, title:`${ext.name} · ${profileId}`, autoHideMenuBar:true,
      webPreferences:{session:this.views.get(profileId).webContents.session, sandbox:true, contextIsolation:true, nodeIntegration:false} });
    popup.webContents.setWindowOpenHandler(() => ({action:'deny'}));
    popup.webContents.on('will-navigate', (event, target) => { if (!target.startsWith(`chrome-extension://${state.runtimeId}/`)) event.preventDefault(); });
    this.popups.set(key, popup); popup.on('closed', () => this.popups.delete(key));
    try { await popup.loadURL(url.href); return popup; } catch (error) { popup.destroy(); throw error; }
  }
  diagnoseExtension(id, profileId) {
    const ext = this.data.extensions.find(item => item.id === id), state = this.loaded.get(`${id}:${profileId}`);
    if (!ext) throw new Error('扩展不存在。');
    const ses = this.views.get(profileId)?.webContents.session;
    const backgroundPages = state?.runtimeId ? webContents.getAllWebContents().filter(wc => !wc.isDestroyed() && wc.session === ses && wc.getURL().startsWith(`chrome-extension://${state.runtimeId}/`)).map(wc => ({type:wc.getType(),url:wc.getURL()})) : [];
    return copy({ extension:ext, runtime:state || {status:'disabled'}, backgroundPages, serviceWorkers:ses ? ses.serviceWorkers.getAllRunning() : {},
      checks:{load:state?.status || 'disabled',contentScript:'not-tested',backgroundMessaging:'not-tested',popup:'not-tested',storage:'not-tested'},
      note:'后台列表只代表当前活动上下文；休眠的 service worker 不等于不支持。兼容性须以实际功能测试为准。' });
  }
  dispose() {
    this.closed = true;
    for (const ext of this.data.extensions) for (const profileId of this.views.keys()) this.unloadExtensionFor(ext, profileId);
    for (const profileId of [...this.views.keys()]) this.detach(profileId);
    this.removeAllListeners();
  }
}
module.exports = { AutomationManager };
