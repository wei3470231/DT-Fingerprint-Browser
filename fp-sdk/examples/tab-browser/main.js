'use strict';
// 多标签 + 自定义指纹浏览器样例。
// 每个“身份”是一份 Profile（稳定 id + 完整指纹），对应一个持久化 Session；
// 同一身份可以打开任意多个标签页，每个标签页是 createFingerprintView 返回的 WebContentsView。
const { app, BaseWindow, WebContentsView, Menu, ipcMain, session, clipboard } = require('electron');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const crypto = require('node:crypto');
const { createFingerprintView, generateFingerprint } = require('../..');
const { OPTIONS, formFromFingerprint, buildFingerprint, summarize } = require('./fingerprint-form');

const TAB_BAR = 40, TOOLBAR = 44, CHROME_HEIGHT = TAB_BAR + TOOLBAR, DRAWER_WIDTH = 380;
const PARTITION_PREFIX = 'fpb-';
const NEWTAB = 'fpb://newtab';
const COLORS = ['#2563eb', '#16a34a', '#db2777', '#ea580c', '#7c3aed', '#0891b2', '#ca8a04', '#dc2626'];
const SELF_TEST = process.env.FPB_SELF_TEST === '1';

// 独立的 userData，不与工作台或其他示例共用浏览器数据。
app.setPath('userData', SELF_TEST
  ? fs.mkdtempSync(path.join(app.getPath('temp'), 'fp-tab-browser-test-'))
  : path.join(app.getPath('appData'), 'fp-sdk-tab-browser'));

let win = null, ui = null, localOrigin = null, profiles = [], tabs = [], activeId = null, tabSeq = 0, saveTimer = null;
let drawer = { open: false, profileId: null };

// ---------- 持久化 ----------
const store = {
  file: name => path.join(app.getPath('userData'), name),
  read(name, fallback) {
    try { return JSON.parse(fs.readFileSync(this.file(name), 'utf8')); }
    catch (error) {
      if (error.code === 'ENOENT') return fallback;
      throw new Error(`${name} 无法读取，已保留原文件：${error.message}`);
    }
  },
  write(name, value) {
    const file = this.file(name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file + '.tmp', JSON.stringify(value, null, 2));
    fs.renameSync(file + '.tmp', file);
  },
};

function newProfile({ name, language, timezone }) {
  const used = new Set(profiles.map(p => p.color));
  return {
    id: 'p-' + crypto.randomBytes(4).toString('hex'),
    name: name || `身份 ${profiles.length + 1}`,
    color: COLORS.find(color => !used.has(color)) || COLORS[profiles.length % COLORS.length],
    proxy: '',
    fp: generateFingerprint({ language, timezone }), // 只在新建时生成，之后永久保存
  };
}
function loadProfiles() {
  const list = store.read('profiles.json', []);
  if (!list.length) {
    profiles = [];
    for (const preset of [
      { name: '身份 A · 上海', language: 'zh-CN', timezone: 'Asia/Shanghai' },
      { name: '身份 B · 纽约', language: 'en-US', timezone: 'America/New_York' },
    ]) profiles.push(newProfile(preset));
    saveProfiles();
    return profiles;
  }
  // 内核升级后 UA 版本必须跟随真实 Chromium 版本，其余字段（含 seed）保持不变。
  for (const profile of list) {
    const old = profile.fp.ua.fullVersion, now = process.versions.chrome;
    if (old !== now) {
      profile.fp.ua.fullVersion = now;
      profile.fp.uaString = profile.fp.uaString.replace(`Chrome/${old}`, `Chrome/${now}`);
    }
  }
  profiles = list;
  saveProfiles();
  return profiles;
}
function saveProfiles() { store.write('profiles.json', profiles); }
function getProfile(id) {
  const profile = profiles.find(p => p.id === id);
  if (!profile) throw new Error('身份不存在。');
  return profile;
}
function saveSession() {
  if (SELF_TEST || !tabs.length) return;
  store.write('tabs.json', {
    active: tabs.findIndex(tab => tab.id === activeId),
    tabs: tabs.map(tab => ({ profileId: tab.profileId, url: currentURL(tab) })),
  });
}
function saveSessionSoon() { clearTimeout(saveTimer); saveTimer = setTimeout(saveSession, 500); }

// ---------- 新标签页：本地服务，在各身份自己的 Session 中打开，页面显示实际读到的指纹 ----------
function startNewTabServer() {
  const root = path.join(__dirname, 'newtab');
  const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' };
  const server = http.createServer((request, response) => {
    const pathname = new URL(request.url, 'http://localhost').pathname;
    const name = pathname === '/' ? 'index.html' : path.basename(pathname);
    if (!types[path.extname(name)]) { response.writeHead(404); response.end(); return; }
    fs.readFile(path.join(root, name), (error, content) => {
      if (error) { response.writeHead(404); response.end(); return; }
      response.writeHead(200, { 'Content-Type': types[path.extname(name)], 'Cache-Control': 'no-store',
        'Content-Security-Policy': "default-src 'self'; img-src 'self' data:; object-src 'none'" });
      response.end(content);
    });
  });
  // 优先固定端口，让新标签页的 origin（以及 localStorage 演示数据）在重启后保持不变。
  const listen = port => new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => { server.removeListener('error', reject); resolve(); });
  });
  return listen(SELF_TEST ? 0 : 17380).catch(() => listen(0))
    .then(() => `http://127.0.0.1:${server.address().port}`);
}
const isNewTabURL = url => typeof url === 'string' && url.startsWith(localOrigin + '/');
const displayURL = url => (isNewTabURL(url) ? NEWTAB : url);

function resolveInput(input) {
  const value = String(input ?? '').trim();
  if (!value || value === NEWTAB) return localOrigin + '/';
  if (/^https?:\/\//i.test(value)) return new URL(value).href;
  if (/^[a-z][\w+.-]*:\/\//i.test(value)) throw new Error('只支持 http:// 与 https:// 网址。');
  if (/^localhost(:\d+)?(\/|$)/i.test(value) || /^\d+\.\d+\.\d+\.\d+(:\d+)?(\/|$)/.test(value)) return new URL('http://' + value).href;
  if (!/\s/.test(value) && /^[^/]+\.[a-z]{2,}(:\d+)?(\/.*)?$/i.test(value)) return new URL('https://' + value).href;
  return 'https://www.bing.com/search?q=' + encodeURIComponent(value);
}

// ---------- 标签页 ----------
const activeTab = () => tabs.find(tab => tab.id === activeId) || null;
const liveContents = tab => (tab.view && !tab.view.webContents.isDestroyed() ? tab.view.webContents : null);
const currentURL = tab => displayURL(liveContents(tab)?.getURL() || tab.url);

async function openTab(profileId, input = NEWTAB, { activate: focus = true, after = null } = {}) {
  getProfile(profileId);
  const tab = { id: ++tabSeq, profileId, url: resolveInput(input), title: '', favicon: null, loading: true, error: null, view: null };
  const index = after && tabs.includes(after) ? tabs.indexOf(after) + 1 : tabs.length;
  tabs.splice(index, 0, tab);
  pushState();
  await mountView(tab);
  if (focus || !activeTab()) activate(tab.id); else layout();
  saveSessionSoon();
  return tab;
}

// 为标签页创建（或重建）指纹视图。同一身份的所有标签页共享同一个 Session 分区。
async function mountView(tab) {
  const view = await createFingerprintView({ profile: getProfile(tab.profileId), partitionPrefix: PARTITION_PREFIX });
  if (!win || !tabs.includes(tab)) { view.webContents.close(); return; }
  tab.view = view;
  view.setBackgroundColor('#ffffff');
  view.setVisible(false);
  win.contentView.addChildView(view);
  const wc = view.webContents;
  const update = patch => { Object.assign(tab, patch); pushState(); };
  wc.on('page-title-updated', (_event, title) => update({ title }));
  wc.on('page-favicon-updated', (_event, icons) => update({ favicon: icons.find(url => /^(https?|data):/.test(url)) || null }));
  wc.on('did-start-loading', () => update({ loading: true, error: null }));
  wc.on('did-stop-loading', () => update({ loading: false }));
  wc.on('did-navigate', (_event, url) => { update({ url, favicon: null }); saveSessionSoon(); });
  wc.on('did-navigate-in-page', (_event, url, isMainFrame) => { if (isMainFrame) { update({ url }); saveSessionSoon(); } });
  wc.on('did-fail-load', (_event, code, description, url, isMainFrame) => {
    if (isMainFrame && code !== -3) update({ error: `${description} (${code})：${url}` });
  });
  wc.on('render-process-gone', (_event, details) => update({ loading: false, error: `页面进程已退出（${details.reason}），按 F5 重新加载。` }));
  wc.on('before-input-event', (event, input) => { if (handleShortcut(input)) event.preventDefault(); });
  wc.on('context-menu', (_event, params) => pageMenu(tab, params));
  // 页面新窗口（target=_blank / window.open）在同一身份的新标签页中打开。
  wc.setWindowOpenHandler(({ url, disposition }) => {
    if (/^https?:/i.test(url)) openTab(tab.profileId, url, { activate: disposition !== 'background-tab', after: tab }).catch(report);
    return { action: 'deny' };
  });
  wc.loadURL(tab.url).catch(() => {}); // 失败由 did-fail-load 显示
}

function destroyView(tab) {
  const view = tab.view;
  tab.view = null;
  if (!view) return;
  if (win && !win.isDestroyed()) win.contentView.removeChildView(view);
  if (!view.webContents.isDestroyed()) view.webContents.close();
}

function activate(id) {
  const tab = tabs.find(item => item.id === id);
  if (!tab) return;
  activeId = id;
  layout();
  const wc = liveContents(tab);
  if (wc && !isNewTabURL(wc.getURL() || tab.url)) wc.focus();
  else focusAddress();
  saveSessionSoon();
}

function closeTab(id) {
  const index = tabs.findIndex(tab => tab.id === id);
  if (index === -1) return;
  const [tab] = tabs.splice(index, 1);
  destroyView(tab);
  if (!tabs.length) { openTab(tab.profileId).catch(report); return; } // 始终保留一个标签页
  if (activeId === id) activate(tabs[Math.min(index, tabs.length - 1)].id);
  else layout();
  saveSessionSoon();
}

function navigate(id, input) {
  const tab = tabs.find(item => item.id === id), wc = tab && liveContents(tab);
  if (!wc) throw new Error('标签页尚未就绪。');
  tab.url = resolveInput(input);
  tab.error = null;
  wc.loadURL(tab.url).catch(() => {});
  if (!isNewTabURL(tab.url)) wc.focus();
}

function tabAction(id, action) {
  const tab = tabs.find(item => item.id === id), wc = tab && liveContents(tab);
  if (!wc) return;
  if (action === 'back' && wc.navigationHistory.canGoBack()) wc.navigationHistory.goBack();
  else if (action === 'forward' && wc.navigationHistory.canGoForward()) wc.navigationHistory.goForward();
  else if (action === 'reload') wc.reload();
  else if (action === 'stop') wc.stop();
}

// 指纹配置在渲染进程启动时下发（见 fp-kernel/specs/fp_00_config_electron.md），
// 所以修改身份后要关闭该身份全部标签页、等旧渲染进程退出，再用新配置重建视图。
async function restartProfileTabs(profileId) {
  const affected = tabs.filter(tab => tab.profileId === profileId && tab.view);
  const pids = new Set();
  for (const tab of affected) {
    const wc = liveContents(tab);
    if (wc) {
      for (const frame of wc.mainFrame.framesInSubtree) pids.add(frame.osProcessId);
      tab.url = wc.getURL() || tab.url;
    }
    Object.assign(tab, { loading: true, error: null, favicon: null });
    destroyView(tab);
  }
  pushState();
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline && app.getAppMetrics().some(metric => pids.has(metric.pid))) {
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  await Promise.all(affected.map(tab => mountView(tab)));
  if (affected.some(tab => tab.id === activeId)) activate(activeId); else layout();
  return affected.length;
}

// ---------- 身份管理 ----------
async function createProfile() {
  const profile = newProfile({});
  profiles.push(profile);
  saveProfiles();
  drawer = { open: true, profileId: profile.id };
  await openTab(profile.id);
  return profile.id;
}

function normalizeProxy(value) {
  const proxy = String(value ?? '').trim();
  if (proxy && !/^(?:(?:https?|socks[45]?):\/\/)?[\w.-]+:\d{1,5}$/i.test(proxy)) {
    throw new Error('代理格式：http://主机:端口 或 socks5://主机:端口，留空为直连。');
  }
  return proxy;
}

async function saveProfile(input) {
  const profile = getProfile(input?.id);
  const name = String(input.name ?? '').trim().slice(0, 40) || profile.name;
  const color = COLORS.includes(input.color) ? input.color : profile.color;
  const proxy = normalizeProxy(input.proxy);
  const fp = buildFingerprint(profile.fp, input.form || {});
  const changed = JSON.stringify(fp) !== JSON.stringify(profile.fp) || proxy !== (profile.proxy || '');
  Object.assign(profile, { name, color, proxy, fp });
  saveProfiles();
  const restarted = changed ? await restartProfileTabs(profile.id) : 0;
  pushState();
  return { restarted };
}

function randomForm({ language, timezone } = {}) {
  return formFromFingerprint(generateFingerprint({ language, timezone }));
}

async function deleteProfile(id) {
  const profile = getProfile(id);
  if (profiles.length === 1) throw new Error('至少需要保留一个身份。');
  for (const tab of tabs.filter(item => item.profileId === id)) destroyView(tab);
  tabs = tabs.filter(tab => tab.profileId !== id);
  profiles = profiles.filter(item => item !== profile);
  saveProfiles();
  drawer.profileId = profiles[0].id;
  // 删除身份时一并清除该分区的 Cookie、缓存和存储。
  const ses = session.fromPartition(`persist:${PARTITION_PREFIX}${id}`);
  await Promise.all([ses.clearStorageData(), ses.clearCache()]);
  if (!tabs.length) await openTab(profiles[0].id);
  else if (!activeTab()) activate(tabs[0].id);
  else layout();
  saveSessionSoon();
}

// ---------- 菜单与快捷键 ----------
function popup(template, x, y) {
  if (!win) return;
  Menu.buildFromTemplate(template).popup({ window: win, ...(Number.isFinite(x) ? { x: Math.round(x), y: Math.round(y) } : {}) });
}
const otherProfiles = profileId => profiles.filter(profile => profile.id !== profileId);

function tabMenu(id, x, y) {
  const tab = tabs.find(item => item.id === id);
  if (!tab) return;
  const url = currentURL(tab), others = otherProfiles(tab.profileId);
  popup([
    { label: '重新加载', click: () => tabAction(id, 'reload') },
    { label: '复制标签页', click: () => openTab(tab.profileId, url, { after: tab }).catch(report) },
    ...(others.length ? [{ label: '在其他身份中打开', submenu: others.map(p => ({ label: p.name, click: () => openTab(p.id, url, { after: tab }).catch(report) })) }] : []),
    { type: 'separator' },
    { label: '关闭标签页', accelerator: 'Ctrl+W', click: () => closeTab(id) },
    { label: '关闭其他标签页', enabled: tabs.length > 1, click: () => tabs.filter(t => t !== tab).forEach(t => closeTab(t.id)) },
  ], x, y);
}

function newTabMenu(x, y) {
  popup([
    ...profiles.map(profile => ({ label: `在「${profile.name}」中新建标签页`, click: () => openTab(profile.id).catch(report) })),
    { type: 'separator' },
    { label: '新建身份…', click: () => createProfile().catch(report) },
  ], x, y);
}

function pageMenu(tab, params) {
  const wc = liveContents(tab);
  if (!wc) return;
  const items = [];
  if (/^https?:/i.test(params.linkURL)) {
    const others = otherProfiles(tab.profileId);
    items.push(
      { label: '在新标签页中打开链接', click: () => openTab(tab.profileId, params.linkURL, { activate: false, after: tab }).catch(report) },
      ...(others.length ? [{ label: '在其他身份中打开链接', submenu: others.map(p => ({ label: p.name, click: () => openTab(p.id, params.linkURL, { after: tab }).catch(report) })) }] : []),
      { label: '复制链接地址', click: () => clipboard.writeText(params.linkURL) },
      { type: 'separator' });
  }
  if (params.isEditable) items.push({ label: '剪切', click: () => wc.cut() }, { label: '复制', click: () => wc.copy() }, { label: '粘贴', click: () => wc.paste() }, { type: 'separator' });
  else if (params.selectionText) items.push({ label: '复制', click: () => wc.copy() }, { type: 'separator' });
  items.push(
    { label: '后退', enabled: wc.navigationHistory.canGoBack(), click: () => tabAction(tab.id, 'back') },
    { label: '前进', enabled: wc.navigationHistory.canGoForward(), click: () => tabAction(tab.id, 'forward') },
    { label: '重新加载', click: () => wc.reload() },
    { type: 'separator' },
    { label: '检查', click: () => wc.inspectElement(params.x, params.y) });
  popup(items);
}

function focusAddress() {
  if (!ui || ui.webContents.isDestroyed()) return;
  ui.webContents.focus();
  ui.webContents.send('focus-address');
}

function handleShortcut(input) {
  if (input.type !== 'keyDown') return false;
  const ctrl = input.control || input.meta, key = input.key.toLowerCase(), tab = activeTab();
  const cycle = step => {
    if (!tab || tabs.length < 2) return;
    activate(tabs[(tabs.indexOf(tab) + step + tabs.length) % tabs.length].id);
  };
  if (ctrl && key === 't') openTab(tab?.profileId || profiles[0].id).catch(report);
  else if (ctrl && key === 'w') { if (tab) closeTab(tab.id); }
  else if (ctrl && key === 'tab') cycle(input.shift ? -1 : 1);
  else if ((ctrl && key === 'l') || key === 'f6') focusAddress();
  else if (key === 'f5' || (ctrl && key === 'r')) { if (tab) tabAction(tab.id, 'reload'); }
  else if (input.alt && key === 'arrowleft') { if (tab) tabAction(tab.id, 'back'); }
  else if (input.alt && key === 'arrowright') { if (tab) tabAction(tab.id, 'forward'); }
  else if (key === 'f12') liveContents(tab || {})?.toggleDevTools();
  else return false;
  return true;
}

// ---------- 窗口、布局与界面状态 ----------
function layout() {
  if (!win || win.isDestroyed()) return;
  const [width, height] = win.getContentSize();
  ui.setBounds({ x: 0, y: 0, width, height });
  const bounds = { x: 0, y: CHROME_HEIGHT, width: Math.max(1, width - (drawer.open ? DRAWER_WIDTH : 0)), height: Math.max(1, height - CHROME_HEIGHT) };
  for (const tab of tabs) {
    if (!tab.view) continue;
    tab.view.setVisible(tab.id === activeId);
    if (tab.id === activeId) tab.view.setBounds(bounds);
  }
  pushState();
}

function getState() {
  return {
    activeId, drawer, options: OPTIONS, colors: COLORS, layout: { chromeHeight: CHROME_HEIGHT, drawerWidth: DRAWER_WIDTH },
    versions: { electron: process.versions.electron, chrome: process.versions.chrome, fpkernel: process.versions.fpkernel || null },
    tabs: tabs.map(tab => {
      const wc = liveContents(tab), url = currentURL(tab);
      return {
        id: tab.id, profileId: tab.profileId, url, favicon: tab.favicon, loading: tab.loading || !tab.view, error: tab.error,
        title: url === NEWTAB ? '新标签页' : (tab.title || url),
        canGoBack: wc?.navigationHistory.canGoBack() ?? false, canGoForward: wc?.navigationHistory.canGoForward() ?? false,
      };
    }),
    profiles: profiles.map(profile => ({
      id: profile.id, name: profile.name, color: profile.color, proxy: profile.proxy || '',
      summary: summarize(profile.fp), form: formFromFingerprint(profile.fp),
      tabCount: tabs.filter(tab => tab.profileId === profile.id).length,
    })),
  };
}
function pushState() {
  if (!win || win.isDestroyed()) return;
  const state = getState(), tab = state.tabs.find(item => item.id === activeId);
  win.setTitle(tab ? `${tab.title} - FP 多标签指纹浏览器` : 'FP 多标签指纹浏览器');
  if (ui && !ui.webContents.isDestroyed()) ui.webContents.send('state', state);
}
function report(error) {
  console.error(error);
  if (ui && !ui.webContents.isDestroyed()) ui.webContents.send('toast', error.message || String(error));
}

// 只接受来自浏览器界面自身的调用；网页内容没有 preload，不能访问这些接口。
function handle(channel, fn) {
  ipcMain.handle(channel, async (event, payload) => {
    if (!ui || event.sender !== ui.webContents || event.senderFrame !== ui.webContents.mainFrame) throw new Error('拒绝的调用来源。');
    return fn(payload ?? {});
  });
}
handle('state', () => getState());
handle('tab:new', ({ profileId }) => openTab(profileId || activeTab()?.profileId || profiles[0].id).then(() => true));
handle('tab:activate', ({ id }) => activate(id));
handle('tab:close', ({ id }) => closeTab(id));
handle('tab:navigate', ({ id, input }) => navigate(id, input));
handle('tab:action', ({ id, action }) => tabAction(id, action));
handle('tab:menu', ({ id, x, y }) => tabMenu(id, x, y));
handle('tab:new-menu', ({ x, y }) => newTabMenu(x, y));
handle('drawer', ({ open, profileId }) => {
  drawer = { open: !!open, profileId: profiles.some(p => p.id === profileId) ? profileId : (activeTab()?.profileId || profiles[0].id) };
  layout();
});
handle('profile:create', () => createProfile());
handle('profile:save', input => saveProfile(input));
handle('profile:random', input => randomForm(input));
handle('profile:delete', ({ id }) => deleteProfile(id));

async function createWindow() {
  win = new BaseWindow({ width: 1360, height: 860, minWidth: 800, minHeight: 500, title: 'FP 多标签指纹浏览器', backgroundColor: '#eef0f3' });
  ui = new WebContentsView({ webPreferences: { preload: path.join(__dirname, 'preload.js'), sandbox: true, contextIsolation: true, nodeIntegration: false } });
  win.contentView.addChildView(ui);
  ui.webContents.on('before-input-event', (event, input) => { if (handleShortcut(input)) event.preventDefault(); });
  ui.webContents.on('will-navigate', event => event.preventDefault());
  ui.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  await ui.webContents.loadFile(path.join(__dirname, 'ui', 'index.html'));
  win.on('resize', layout);
  win.on('close', () => { clearTimeout(saveTimer); saveSession(); });
  win.on('closed', () => {
    for (const tab of tabs) if (tab.view && !tab.view.webContents.isDestroyed()) tab.view.webContents.close();
    if (!ui.webContents.isDestroyed()) ui.webContents.close();
    win = null;
  });
  layout();
}

if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => { if (win) { if (win.isMinimized()) win.restore(); win.focus(); } });
  app.whenReady().then(async () => {
    Menu.setApplicationMenu(null);
    localOrigin = await startNewTabServer();
    loadProfiles();
    await createWindow();
    const saved = store.read('tabs.json', null);
    const restore = (saved?.tabs || []).filter(tab => profiles.some(p => p.id === tab.profileId));
    if (restore.length) {
      for (const tab of restore) await openTab(tab.profileId, tab.url, { activate: false });
      activate(tabs[Math.max(0, Math.min(saved.active, tabs.length - 1))].id);
    } else {
      for (const profile of profiles) await openTab(profile.id, NEWTAB, { activate: profile === profiles[0] });
    }
    if (SELF_TEST) {
      const code = await require('./self-test').run({
        get profiles() { return profiles; }, get tabs() { return tabs; }, get ui() { return ui; },
        openTab, closeTab, activate, saveProfile, formFromFingerprint,
      });
      app.exit(code);
    }
  }).catch(error => { console.error(error); app.exit(1); });
  app.on('window-all-closed', () => app.quit());
}
