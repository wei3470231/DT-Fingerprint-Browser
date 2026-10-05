'use strict';

const { app, BaseWindow, WebContentsView, ipcMain, session, Menu } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const url = require('node:url');
const { getEnvironment, loadAll, getSettings, getActiveFontInfo, ROOT_DIR, DATA_DIR, PROFILES_DIR, loadBookmarks, saveBookmarks } = require('../manager/store');
const { applyProxy } = require('./proxy-helper');

const LOCAL_TEST_PAGE_PATH = path.join(__dirname, 'testing', 'index.html');
const LOCAL_TEST_PAGE_URL = url.pathToFileURL(LOCAL_TEST_PAGE_PATH).href;

function resolveNavUrl(rawUrl) {
  if (!rawUrl) return LOCAL_TEST_PAGE_URL;
  const s = String(rawUrl).trim();
  if (s === 'dt://fingerprint-test' || s === 'dt://test' || s === 'about:fingerprint' || s === '') {
    return LOCAL_TEST_PAGE_URL;
  }
  return s;
}

// 1. 获取传入的环境 ID 与命令行开关
function getArg(key) {
  for (const arg of process.argv) {
    if (arg.startsWith(`--${key}=`)) {
      return arg.slice(key.length + 3);
    }
  }
  return null;
}

const envId = getArg('env-id');
const themeArg = getArg('theme');
const storeSettings = typeof getSettings === 'function' ? getSettings() : null;
const initialTheme = themeArg || (storeSettings && storeSettings.browserTheme) || 'dark';
let env = null;

if (envId) {
  env = getEnvironment(envId);
  if (!env) {
    console.error(`未找到环境配置: ${envId}`);
    process.exit(1);
  }
} else {
  // 自动化脚本原生直通模式 (Chrome Direct Invocation Mode)
  // 支持直接替代 chrome.exe 由 Puppeteer / Playwright / Selenium 拉起
  const { generateFingerprint } = require('../../fp-sdk');
  const customUserData = getArg('user-data-dir') || path.join(PROFILES_DIR, 'direct-default');
  const customPort = getArg('remote-debugging-port');
  const customProxy = getArg('proxy-server');

  let targetUrl = LOCAL_TEST_PAGE_URL;
  for (const arg of process.argv.slice(2)) {
    if (!arg.startsWith('-') && (arg.startsWith('http://') || arg.startsWith('https://') || arg.startsWith('file://') || arg.startsWith('about:') || arg.startsWith('dt://'))) {
      targetUrl = resolveNavUrl(arg);
      break;
    }
  }

  const { parseProxyString } = require('../manager/proxy-parser');
  let proxyConfig = { enabled: false, type: 'socks5', host: '', port: '', username: '', password: '', rawString: '', scope: 'all', rules: '', bypass: '<local>;localhost;127.0.0.1' };
  if (customProxy) {
    const parsed = parseProxyString(customProxy);
    if (parsed) {
      proxyConfig.enabled = true;
      proxyConfig.type = parsed.type;
      proxyConfig.host = parsed.host;
      proxyConfig.port = parsed.port;
      proxyConfig.username = parsed.username;
      proxyConfig.password = parsed.password;
      proxyConfig.rawString = customProxy;
    }
  }

  env = {
    id: 'direct-default',
    name: 'Chrome 直通实例',
    group: '直通模式',
    notes: '自动化脚本原生调用',
    url: targetUrl,
    remotePortEnabled: Boolean(customPort),
    remotePort: customPort ? Number(customPort) : null,
    customArgs: '',
    language: 'en-US',
    timezone: 'America/New_York',
    proxy: proxyConfig,
    extensions: getArg('load-extension') || '',
    userDataDir: customUserData,
    fp: generateFingerprint({ language: 'en-US', timezone: 'America/New_York' }),
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
}

// 2. 配置用户数据/缓存目录与远程调试端口 (必须在 app.whenReady 之前)
const cmdUserData = getArg('user-data-dir');
let absUserData;
if (cmdUserData) {
  absUserData = path.isAbsolute(cmdUserData) ? cmdUserData : path.resolve(ROOT_DIR, cmdUserData);
} else if (env.userDataDir && path.isAbsolute(env.userDataDir)) {
  absUserData = env.userDataDir;
} else {
  // 统一存放在可写的 PROFILES_DIR (支持回退至 AppData，防 Program Files 权限拦截)
  const profileSub = env.userDataDir ? path.basename(env.userDataDir) : env.id;
  absUserData = path.join(PROFILES_DIR, profileSub);
}
fs.mkdirSync(absUserData, { recursive: true });
app.setPath('userData', absUserData);

const cmdPort = getArg('remote-debugging-port');
const effectivePort = cmdPort ? Number(cmdPort) : (env.remotePortEnabled && env.remotePort ? Number(env.remotePort) : null);
if (effectivePort) {
  if (!app.commandLine.hasSwitch('remote-debugging-port')) {
    app.commandLine.appendSwitch('remote-debugging-port', String(effectivePort));
  }
}

// 健壮的命令行参数分词器：支持多参数、带空格引号包裹的字符串、--key=val、-flag 等
function tokenizeCommandLineArgs(input) {
  if (!input || !input.trim()) return [];
  const tokens = [];
  let current = '';
  let inQuotes = false;
  let quoteChar = '';

  for (let i = 0; i < input.length; i++) {
    const char = input[i];

    if ((char === '"' || char === "'") && (!inQuotes || char === quoteChar)) {
      inQuotes = !inQuotes;
      quoteChar = inQuotes ? char : '';
      continue;
    }

    if (char === ' ' && !inQuotes) {
      if (current.trim()) {
        tokens.push(current.trim());
        current = '';
      }
    } else {
      current += char;
    }
  }

  if (current.trim()) {
    tokens.push(current.trim());
  }

  return tokens;
}

// 注入用户自定义命令行参数（支持多参数、引号及多种格式）
if (env.customArgs) {
  const customParts = tokenizeCommandLineArgs(env.customArgs);
  for (const part of customParts) {
    if (part.startsWith('--')) {
      const stripped = part.slice(2);
      const eqIdx = stripped.indexOf('=');
      if (eqIdx !== -1) {
        const key = stripped.slice(0, eqIdx);
        const val = stripped.slice(eqIdx + 1).replace(/^["']|["']$/g, '');
        app.commandLine.appendSwitch(key, val);
      } else {
        app.commandLine.appendSwitch(stripped);
      }
    } else if (part.startsWith('-')) {
      const stripped = part.slice(1);
      const eqIdx = stripped.indexOf('=');
      if (eqIdx !== -1) {
        const key = stripped.slice(0, eqIdx);
        const val = stripped.slice(eqIdx + 1).replace(/^["']|["']$/g, '');
        app.commandLine.appendSwitch(key, val);
      } else {
        app.commandLine.appendSwitch(stripped);
      }
    } else {
      app.commandLine.appendArgument(part);
    }
  }
}

// 3. 多标签状态与窗口模型
const SHELL_HEIGHT = 106;
let mainWindow = null;
let shellView = null;
let tabs = [];
let activeTabId = null;
let currentEnv = env;
let loadedExtensions = [];
let cachedBookmarks = null;

function getBookmarks() {
  if (!cachedBookmarks) {
    cachedBookmarks = loadBookmarks();
  }
  return cachedBookmarks;
}

function updateBookmarks(newBookmarks) {
  cachedBookmarks = saveBookmarks(newBookmarks);
  notifyShell();
}

function urlsMatch(u1, u2) {
  if (!u1 || !u2) return false;
  if (u1 === u2) return true;
  const clean = s => s.replace(/^https?:\/\//i, '').replace(/^www\./i, '').replace(/\/+$/, '').toLowerCase();
  return clean(u1) === clean(u2);
}

// 递归与子树全框架加载完成检测：防止网页内有多重嵌套/动态 iframe 时提前误判加载完成
async function checkTabFramesComplete(tab) {
  if (!tab || !tabs.includes(tab) || !tab.view || !tab.view.webContents || tab.view.webContents.isDestroyed()) return false;
  const wc = tab.view.webContents;
  if (wc.isLoading()) return false;

  const main = wc.mainFrame;
  if (!main) return false;

  // 1. 检查主文档 DOM 就绪状态以及同源内嵌框架就绪状态
  try {
    const domReady = await wc.executeJavaScript(`
      (() => {
        if (document.readyState !== 'complete') return false;
        const iframes = Array.from(document.querySelectorAll('iframe, frame'));
        for (const ifr of iframes) {
          try {
            if (ifr.contentDocument && ifr.contentDocument.readyState !== 'complete') {
              return false;
            }
          } catch (_) {}
        }
        return true;
      })()
    `, true);
    if (!domReady) return false;
  } catch (_) {
    return false;
  }

  // 2. 检查跨域及所有进程子树框架 (WebFrameMain.framesInSubtree)
  const frames = main.framesInSubtree || [];
  for (const f of frames) {
    if (f.detached || (typeof f.isDestroyed === 'function' && f.isDestroyed())) continue;
    try {
      const rs = await f.executeJavaScript('document.readyState', true);
      if (rs !== 'complete') return false;
    } catch (_) {
      // 框架如果正在跳转、加载或未准备就绪，则判定为尚未完成
      return false;
    }
  }

  return true;
}

function markTabLoading(tab, pendingUrl = null) {
  if (!tab) return;
  const wasLoading = tab.isLoading;
  tab.isLoading = true;
  if (pendingUrl) {
    tab.pendingNavUrl = pendingUrl;
  }
  if (tab.checkTimer) {
    clearTimeout(tab.checkTimer);
    tab.checkTimer = null;
  }
  // 安全保护超时：若页面内存在死链或挂起的第三方跟踪 iframe，防止状态永久卡在加载中 (25秒兜底)
  if (tab.safetyTimer) clearTimeout(tab.safetyTimer);
  tab.safetyTimer = setTimeout(() => {
    if (tab && tab.isLoading) {
      tab.isLoading = false;
      tab.pendingNavUrl = null;
      notifyShell();
    }
  }, 25000);

  if (!wasLoading) {
    notifyShell();
  }
}

function scheduleTabLoadingCheck(tab) {
  if (!tab || !tabs.includes(tab) || !tab.view || !tab.view.webContents || tab.view.webContents.isDestroyed()) return;
  if (tab.checkTimer) clearTimeout(tab.checkTimer);
  tab.checkTimer = setTimeout(async () => {
    tab.checkTimer = null;
    const isComplete = await checkTabFramesComplete(tab);
    if (isComplete) {
      if (tab.safetyTimer) {
        clearTimeout(tab.safetyTimer);
        tab.safetyTimer = null;
      }
      tab.isLoading = false;
      tab.pendingNavUrl = null;
      tab.checkCount = 0;
      notifyShell();
    } else {
      tab.checkCount = (tab.checkCount || 0) + 1;
      // 页面中仍有部分子框架尚未完全加载完毕，持续轮询 (上限30次约5秒，防止第三方死循环iframe消耗CPU)
      if (tab.isLoading && tab.checkCount < 30) {
        scheduleTabLoadingCheck(tab);
      } else if (tab.checkCount >= 30) {
        if (tab.safetyTimer) {
          clearTimeout(tab.safetyTimer);
          tab.safetyTimer = null;
        }
        tab.isLoading = false;
        tab.pendingNavUrl = null;
        notifyShell();
      }
    }
  }, 160);
}

function notifyShell() {
  if (!shellView || shellView.webContents.isDestroyed()) return;
  const isLocalTest = (u) => Boolean(u && (u === LOCAL_TEST_PAGE_URL || (u.startsWith('file:') && u.includes('testing/index.html'))));

  const tabStates = tabs.map(t => {
    const curUrl = t.view.webContents.getURL() || t.initialUrl;
    const effectiveUrl = t.pendingNavUrl || curUrl;
    const displayUrl = isLocalTest(effectiveUrl) ? 'dt://fingerprint-test' : effectiveUrl;
    const displayActual = isLocalTest(curUrl) ? 'dt://fingerprint-test' : curUrl;
    return {
      id: t.id,
      url: displayUrl,
      actualUrl: displayActual,
      pendingUrl: t.pendingNavUrl ? (isLocalTest(t.pendingNavUrl) ? 'dt://fingerprint-test' : t.pendingNavUrl) : null,
      title: t.view.webContents.getTitle() || (isLocalTest(curUrl) ? '本地指纹检测 · 实际读数' : '新标签页'),
      canGoBack: t.view.webContents.navigationHistory?.canGoBack?.() || false,
      canGoForward: t.view.webContents.navigationHistory?.canGoForward?.() || false,
      isLoading: Boolean(t.isLoading)
    };
  });

  const fontInfo = typeof getActiveFontInfo === 'function' ? getActiveFontInfo() : null;
  shellView.webContents.send('update-state', {
    env: currentEnv,
    tabs: tabStates,
    activeId: activeTabId,
    port: currentEnv.remotePortEnabled ? currentEnv.remotePort : null,
    extensions: loadedExtensions,
    isMaximized: mainWindow && !mainWindow.isDestroyed() ? mainWindow.isMaximized() : false,
    defaultTheme: initialTheme,
    fontInfo,
    bookmarks: getBookmarks()
  });
}

function resizeViews() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const [width, height] = mainWindow.getContentSize();
  if (shellView) {
    shellView.setBounds({ x: 0, y: 0, width, height: SHELL_HEIGHT });
  }

  const contentHeight = Math.max(1, height - SHELL_HEIGHT);
  for (const tab of tabs) {
    if (tab.id === activeTabId) {
      tab.view.setVisible(true);
      tab.view.setBounds({ x: 0, y: SHELL_HEIGHT, width, height: contentHeight });
    } else {
      tab.view.setVisible(false);
    }
  }
}

// 4. 为标签页配置快捷键、右键菜单、真实物理点击及加载事件监听
function setupTabListeners(tabItem) {
  const { view, id: tabId } = tabItem;

  // 网页快捷键支持 (Ctrl+T, Ctrl+W, Ctrl+R, F5, F12 等)
  view.webContents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown') return;
    const isCtrl = input.control || input.meta;
    if (isCtrl && input.key.toLowerCase() === 't') {
      event.preventDefault();
      createTab(LOCAL_TEST_PAGE_URL);
    } else if (isCtrl && input.key.toLowerCase() === 'w') {
      event.preventDefault();
      closeTab(tabId);
    } else if (isCtrl && input.key.toLowerCase() === 'r') {
      event.preventDefault();
      markTabLoading(tabItem);
      view.webContents.reload();
    } else if (input.key === 'F5') {
      event.preventDefault();
      markTabLoading(tabItem);
      view.webContents.reload();
    } else if (input.key === 'F12') {
      event.preventDefault();
      view.webContents.isDevToolsOpened() ? view.webContents.closeDevTools() : view.webContents.openDevTools({ mode: 'detach' });
    } else if (isCtrl && input.key.toLowerCase() === 'd') {
      event.preventDefault();
      if (shellView && !shellView.webContents.isDestroyed()) {
        shellView.webContents.send('trigger-bookmark-current');
      }
    }
  });

  // 网页内链接在新窗口打开时自动以新标签打开
  view.webContents.setWindowOpenHandler(({ url }) => {
    createTab(url);
    return { action: 'deny' };
  });

  // 网页内右键菜单支持：复制、剪切、粘贴、在新标签打开、全选、检查元素
  view.webContents.on('context-menu', (_event, params) => {
    const menuTemplate = [];

    // 选中文本
    if (params.selectionText && params.selectionText.trim()) {
      menuTemplate.push({
        label: '复制 (Copy)',
        role: 'copy',
        accelerator: 'CmdOrCtrl+C'
      });
      const query = params.selectionText.trim();
      const displayQuery = query.length > 15 ? query.slice(0, 15) + '...' : query;
      menuTemplate.push({
        label: `搜索 "${displayQuery}"`,
        click: () => createTab(`https://www.google.com/search?q=${encodeURIComponent(query)}`)
      });
      menuTemplate.push({ type: 'separator' });
    }

    // 点击链接
    if (params.linkURL) {
      menuTemplate.push({
        label: '在新建标签页中打开链接',
        click: () => createTab(params.linkURL)
      });
      menuTemplate.push({
        label: '复制链接地址',
        click: () => {
          const { clipboard } = require('electron');
          clipboard.writeText(params.linkURL);
        }
      });
      menuTemplate.push({ type: 'separator' });
    }

    // 点击图片
    if (params.hasImageContents && params.srcURL) {
      menuTemplate.push({
        label: '在新建标签页中打开图片',
        click: () => createTab(params.srcURL)
      });
      menuTemplate.push({
        label: '复制图片地址',
        click: () => {
          const { clipboard } = require('electron');
          clipboard.writeText(params.srcURL);
        }
      });
      menuTemplate.push({ type: 'separator' });
    }

    // 可编辑输入框
    if (params.isEditable) {
      menuTemplate.push({
        label: '剪切 (Cut)',
        role: 'cut',
        enabled: params.editFlags.canCut,
        accelerator: 'CmdOrCtrl+X'
      });
      menuTemplate.push({
        label: '复制 (Copy)',
        role: 'copy',
        enabled: params.editFlags.canCopy,
        accelerator: 'CmdOrCtrl+C'
      });
      menuTemplate.push({
        label: '粘贴 (Paste)',
        role: 'paste',
        enabled: params.editFlags.canPaste,
        accelerator: 'CmdOrCtrl+V'
      });
      menuTemplate.push({ type: 'separator' });
      menuTemplate.push({
        label: '全选 (Select All)',
        role: 'selectAll',
        enabled: params.editFlags.canSelectAll,
        accelerator: 'CmdOrCtrl+A'
      });
      menuTemplate.push({ type: 'separator' });
    }

    // 基础导航
    menuTemplate.push({
      label: '后退',
      enabled: view.webContents.navigationHistory.canGoBack(),
      click: () => view.webContents.navigationHistory.back()
    });
    menuTemplate.push({
      label: '前进',
      enabled: view.webContents.navigationHistory.canGoForward(),
      click: () => view.webContents.navigationHistory.forward()
    });
    menuTemplate.push({
      label: '重新加载 (Reload)',
      accelerator: 'F5',
      click: () => {
        markTabLoading(tabItem);
        view.webContents.reload();
      }
    });
    menuTemplate.push({ type: 'separator' });

    // 检查元素
    menuTemplate.push({
      label: '检查元素 (Inspect Element)',
      click: () => {
        view.webContents.inspectElement(params.x, params.y);
        if (!view.webContents.isDevToolsOpened()) {
          view.webContents.openDevTools({ mode: 'detach' });
        }
      }
    });

    const menu = Menu.buildFromTemplate(menuTemplate);
    menu.popup({ window: mainWindow });
  });

let lastNativeClickTime = 0;
// 派发底层硬件级真实鼠标事件 (isTrusted: true，完全绕过 chrome.debugger 权限缺失)
async function dispatchNativePhysicalClick(wc, x, y) {
  if (!wc || wc.isDestroyed()) return;
  const now = Date.now();
  if (now - lastNativeClickTime < 1500) {
    return; // 防抖节流，避免多个扩展或并发重复轰炸点击
  }
  lastNativeClickTime = now;
  const clickX = Math.round(x);
  const clickY = Math.round(y);

  // 优先策略 1: 使用 Electron 内置 Debugger 协议派发底层 Input.dispatchMouseEvent (天然支持跨域 OOPIF Iframe 穿透，isTrusted: true)
  try {
    if (!wc.debugger.isAttached()) {
      try {
        wc.debugger.attach('1.3');
      } catch (attErr) {}
    }
    if (wc.debugger.isAttached()) {
      await wc.debugger.sendCommand('Input.dispatchMouseEvent', { type: 'mouseMoved', x: clickX, y: clickY });
      await new Promise(r => setTimeout(r, 35));
      await wc.debugger.sendCommand('Input.dispatchMouseEvent', {
        type: 'mousePressed',
        x: clickX,
        y: clickY,
        button: 'left',
        clickCount: 1
      });
      await new Promise(r => setTimeout(r, 70 + Math.floor(Math.random() * 40)));
      await wc.debugger.sendCommand('Input.dispatchMouseEvent', {
        type: 'mouseReleased',
        x: clickX,
        y: clickY,
        button: 'left',
        clickCount: 1
      });
      console.log(`[Turnstile Auto] 宿主 CDP 级真实物理点击已成功勾选 @ (${clickX}, ${clickY})`);
      return;
    }
  } catch (cdpErr) {
    console.warn('[CDP Dispatch Fallback]', cdpErr.message);
  }

  // 备用策略 2: sendInputEvent 模拟输入
  try {
    wc.sendInputEvent({ type: 'mouseMove', x: clickX, y: clickY });
    await new Promise(r => setTimeout(r, 35));
    wc.sendInputEvent({
      type: 'mouseDown',
      x: clickX,
      y: clickY,
      button: 'left',
      clickCount: 1
    });
    await new Promise(r => setTimeout(r, 80));
    wc.sendInputEvent({
      type: 'mouseUp',
      x: clickX,
      y: clickY,
      button: 'left',
      clickCount: 1
    });
    console.log(`[Turnstile Auto] 宿主 sendInputEvent 物理点击已派发 @ (${clickX}, ${clickY})`);
  } catch (err) {
    console.warn(`[Turnstile Click Error] 派发失败: ${err.message}`);
  }
}

  // 监听来自扩展插件的底层真实点击请求（全参数安全扫描）
  view.webContents.on('console-message', (...args) => {
    let rawMsg = '';
    for (const a of args) {
      if (typeof a === 'string' && a.startsWith('__DT_PHYSICAL_CLICK__:')) {
        rawMsg = a;
        break;
      }
      if (a && typeof a === 'object' && typeof a.message === 'string' && a.message.startsWith('__DT_PHYSICAL_CLICK__:')) {
        rawMsg = a.message;
        break;
      }
    }

    if (rawMsg && rawMsg.startsWith('__DT_PHYSICAL_CLICK__:')) {
      try {
        const payload = JSON.parse(rawMsg.slice('__DT_PHYSICAL_CLICK__:'.length));
        if (typeof payload.x === 'number' && typeof payload.y === 'number') {
          dispatchNativePhysicalClick(view.webContents, payload.x, payload.y);
        }
      } catch (err) {
        console.warn('[DT Click Error]', err.message);
      }
    }
  });

  // 监听导航和加载事件：支持多框架递归彻底完成检测
  view.webContents.on('did-start-loading', () => {
    markTabLoading(tabItem);
  });
  view.webContents.on('did-start-navigation', () => {
    markTabLoading(tabItem);
  });
  view.webContents.on('did-stop-loading', () => {
    scheduleTabLoadingCheck(tabItem);
  });
  view.webContents.on('did-finish-load', () => {
    scheduleTabLoadingCheck(tabItem);
  });
  view.webContents.on('did-frame-finish-load', () => {
    scheduleTabLoadingCheck(tabItem);
  });
  view.webContents.on('did-fail-load', (_event, errorCode) => {
    if (errorCode === -3) {
      return; // ERR_ABORTED: 正常被 stop() 中止，绝不误清除新导航的 pendingNavUrl
    }
    scheduleTabLoadingCheck(tabItem);
  });
  view.webContents.on('did-navigate', (_event, navUrl) => {
    if (tabItem.pendingNavUrl && urlsMatch(navUrl, tabItem.pendingNavUrl)) {
      tabItem.pendingNavUrl = null;
    }
    notifyShell();
    scheduleTabLoadingCheck(tabItem);
  });
  view.webContents.on('did-navigate-in-page', (_event, navUrl) => {
    if (tabItem.pendingNavUrl && urlsMatch(navUrl, tabItem.pendingNavUrl)) {
      tabItem.pendingNavUrl = null;
    }
    notifyShell();
    scheduleTabLoadingCheck(tabItem);
  });
  view.webContents.on('page-title-updated', () => {
    notifyShell();
  });
}

// 5. 创建新标签页 (优先创建 Target 0 确保自动化脚本精准操控)
async function createTab(targetUrl) {
  const tabId = 'tab-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6);
  const resolvedTarget = resolveNavUrl(targetUrl);

  const view = new WebContentsView({
    webPreferences: {
      session: getEnvSession(),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false
    }
  });

  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.contentView.addChildView(view);
  }

  const tabItem = {
    id: tabId,
    view,
    initialUrl: targetUrl,
    isLoading: true,
    pendingNavUrl: targetUrl,
    navSeq: 1,
    checkTimer: null,
    safetyTimer: null,
    checkCount: 0
  };

  setupTabListeners(tabItem);
  tabs.push(tabItem);
  switchTab(tabId);
  markTabLoading(tabItem, targetUrl);

  const thisSeq = tabItem.navSeq;
  // 关键优化：异步非阻塞导航，绝不卡死主线程事件循环，确保窗口与插件瞬间可点击
  view.webContents.loadURL(resolvedTarget).catch(err => {
    if (tabItem.navSeq !== thisSeq) {
      return; // 已被新导航替代，忽略上一导航中断，绝不清除新 pendingNavUrl
    }
    console.error('加载页面出错:', err.message);
    tabItem.pendingNavUrl = null;
    if (tabs.includes(tabItem) && tabItem.view && tabItem.view.webContents && !tabItem.view.webContents.isDestroyed()) {
      scheduleTabLoadingCheck(tabItem);
    }
  });
  return tabItem;
}

function switchTab(tabId) {
  activeTabId = tabId;
  resizeViews();
  notifyShell();
}

function closeTab(tabId) {
  const index = tabs.findIndex(t => t.id === tabId);
  if (index === -1) return;
  const tab = tabs[index];
  if (tab.checkTimer) clearTimeout(tab.checkTimer);
  if (tab.safetyTimer) clearTimeout(tab.safetyTimer);
  mainWindow.contentView.removeChildView(tab.view);
  if (tab.view && tab.view.webContents && !tab.view.webContents.isDestroyed()) {
    tab.view.webContents.close();
  }
  tabs.splice(index, 1);

  if (tabs.length === 0) {
    // 若标签全被关闭，则关闭整个窗口
    mainWindow.close();
    return;
  }

  if (activeTabId === tabId) {
    const nextTab = tabs[Math.max(0, index - 1)];
    switchTab(nextTab.id);
  } else {
    notifyShell();
  }
}

let proxyBridge = null;

// 统一采用环境专属持久化 Session 分区隔离 (确保存储、Cookie 与指纹时区内核完全生效)
let envSession = null;
function getEnvSession() {
  if (!envSession) {
    const partitionName = `persist:${currentEnv.id || 'default'}`;
    envSession = session.fromPartition(partitionName);
  }
  return envSession;
}

// 5. 应用指纹与代理到 Session
async function configureSession(ses, config) {
  if (typeof ses.setFingerprintConfig !== 'function') {
    throw new Error('当前内核未提供 setFingerprintConfig，必须使用定制 electron.exe 启动！');
  }

  // 配置代理 (自动识别4种格式，SOCKS5认证自动使用本地透明中转)
  if (!proxyBridge) {
    proxyBridge = await applyProxy(ses, config.proxy);
  } else {
    await applyProxy(ses, config.proxy);
  }

  // 配置 UA 与语言
  const languages = config.fp?.navigator?.languages || ['en-US', 'en'];
  ses.setUserAgent(config.fp.uaString, languages.join(','));

  // 注入指纹内核核心配置 (含 timezone 地区时区，触发内核 SetTimeZoneOverride)
  ses.setFingerprintConfig(JSON.stringify(config.fp));

  // WebRTC 策略安全化
  ses.setPermissionCheckHandler(() => false);
}

// 6. 热更新指纹
async function applyHotFingerprint(newFp) {
  currentEnv.fp = newFp;
  for (const s of [session.defaultSession, getEnvSession()]) {
    const languages = newFp.navigator?.languages || ['en-US', 'en'];
    s.setUserAgent(newFp.uaString, languages.join(','));
    s.setFingerprintConfig(JSON.stringify(newFp));
  }

  // 刷新所有已打开的页面使新指纹即刻生效
  for (const tab of tabs) {
    if (tab.view && tab.view.webContents && !tab.view.webContents.isDestroyed()) {
      tab.view.webContents.reload();
    }
  }
  notifyShell();
  console.log(`[Hot Update] 窗口已热加载新指纹: ${newFp.seed}`);
}

app.whenReady().then(async () => {
  await configureSession(session.defaultSession, currentEnv);
  await configureSession(getEnvSession(), currentEnv);

  // 代理用户名密码认证
  app.on('login', (event, webContents, request, authInfo, callback) => {
    if (authInfo.isProxy && currentEnv.proxy && currentEnv.proxy.username) {
      event.preventDefault();
      callback(currentEnv.proxy.username, currentEnv.proxy.password || '');
    }
  });

// 插件兼容性安全预处理 (解决部分 Chrome 插件因包含 Electron 不支持的权限导致 Chromium C++ FATAL DCHECK 崩溃)
function prepareExtensionDir(extDir) {
  try {
    const manifestFile = path.join(extDir, 'manifest.json');
    if (!fs.existsSync(manifestFile)) return;
    const content = fs.readFileSync(manifestFile, 'utf8');
    const manifest = JSON.parse(content);
    let changed = false;

    // 1. 过滤导致 Electron 内核 crash 的危险权限 (例如 management)
    if (Array.isArray(manifest.permissions)) {
      const dangerous = ['management'];
      const filtered = manifest.permissions.filter(p => !dangerous.includes(p));
      if (filtered.length !== manifest.permissions.length) {
        manifest.permissions = filtered;
        changed = true;
      }
    }

    if (changed) {
      if (!fs.existsSync(manifestFile + '.orig')) {
        fs.writeFileSync(manifestFile + '.orig', content, 'utf8');
      }
      fs.writeFileSync(manifestFile, JSON.stringify(manifest, null, 2), 'utf8');
      console.log(`[Extension Safe] 已自动优化插件 manifest.json 兼容性: ${extDir}`);
    }

    // 2. 检查 service worker 或 background 脚本，注入 contextMenus/management 防崩垫片
    const bgList = [];
    if (typeof manifest.background?.service_worker === 'string') bgList.push(manifest.background.service_worker);
    if (Array.isArray(manifest.background?.scripts)) bgList.push(...manifest.background.scripts);
    bgList.push('background.js');

    const polyfill = `/* Electron Compatibility Polyfill */
if (typeof chrome !== 'undefined') {
  if (!chrome.contextMenus) {
    chrome.contextMenus = {
      removeAll: function(cb) { if (typeof cb === 'function') cb(); },
      create: function() {},
      remove: function() {},
      onClicked: { addListener: function() {}, removeListener: function() {} }
    };
  }
  if (!chrome.management) {
    chrome.management = {
      getAll: function(cb) { if (typeof cb === 'function') cb([]); }
    };
  }
}
`;

    for (const bgRel of bgList) {
      const bgPath = path.join(extDir, bgRel);
      if (fs.existsSync(bgPath)) {
        const bgCode = fs.readFileSync(bgPath, 'utf8');
        if (!bgCode.includes('/* Electron Compatibility Polyfill */')) {
          fs.writeFileSync(bgPath, polyfill + bgCode, 'utf8');
          console.log(`[Extension Safe] 已自动为 ${bgRel} 注入 API 兼容垫片`);
        }
      }
    }
  } catch (e) {
    console.warn(`[Extension Prepare Error] ${extDir}: ${e.message}`);
  }
}

  // 加载扩展插件 (支持多个，分号或换行分隔)
  if (currentEnv.extensions) {
    const extPaths = currentEnv.extensions.split(/[;\r\n]+/).map(p => p.trim()).filter(Boolean);
    for (const rawExt of extPaths) {
      const extDir = path.isAbsolute(rawExt) ? rawExt : path.resolve(ROOT_DIR, rawExt);
      if (fs.existsSync(extDir)) {
        try {
          prepareExtensionDir(extDir);
          let ext = null;
          try {
            ext = await getEnvSession().extensions.loadExtension(extDir, { allowFileAccess: true });
          } catch (_) {
            ext = await session.defaultSession.extensions.loadExtension(extDir, { allowFileAccess: true });
          }
          const optPage = ext.manifest?.options_ui?.page || ext.manifest?.options_page || null;
          const popPage = ext.manifest?.action?.default_popup || ext.manifest?.browser_action?.default_popup || null;
          loadedExtensions.push({
            id: ext.id,
            name: ext.name,
            version: ext.version,
            url: ext.url,
            path: extDir,
            optionsUrl: optPage ? `chrome-extension://${ext.id}/${optPage}` : null,
            popupUrl: popPage ? `chrome-extension://${ext.id}/${popPage}` : null
          });
          console.log(`[Extension Loaded] 插件已加载: ${ext.name} (${ext.id})`);
        } catch (err) {
          console.warn(`[Extension Failed] 加载插件失败: ${extDir}, ${err.message}`);
        }
      } else {
        console.warn(`[Extension Not Found] 插件目录不存在: ${extDir}`);
      }
    }
  }

  // 彻底移除顶部系统默认菜单栏 (File, Edit, View, Window 等)
  Menu.setApplicationMenu(null);

  const openUrlOverride = getArg('open-url');
  const isHeadless = process.argv.some(a => a === '--headless' || a.startsWith('--headless='));

  // 创建外层宿主窗口 (现代一体化无边框设计，彻底去掉原生白色/系统强调色丑陋外框)
  const candidateIcons = [
    path.resolve(ROOT_DIR, 'app.ico'),
    path.resolve(__dirname, '../../app.ico'),
    path.join(process.resourcesPath || '', '../app.ico'),
    path.join(process.resourcesPath || '', 'app.ico')
  ];
  let iconPath = undefined;
  for (const p of candidateIcons) {
    if (fs.existsSync(p)) {
      iconPath = p;
      break;
    }
  }
  mainWindow = new BaseWindow({
    width: 1360,
    height: 860,
    minWidth: 800,
    minHeight: 500,
    frame: false, // 彻底移除系统默认边框与双层标题栏，实现现代沉浸式无边框外观
    title: `${currentEnv.name} - DT 指纹浏览器`,
    icon: (iconPath && fs.existsSync(iconPath)) ? iconPath : undefined,
    show: !isHeadless
  });

  if (typeof mainWindow.setMenu === 'function') mainWindow.setMenu(null);
  if (typeof mainWindow.setMenuBarVisibility === 'function') mainWindow.setMenuBarVisibility(false);

  // 1. 优先注册并即时绑定 Shell IPC 操作 (确保在任何标签页或 Shell 就绪前立刻可用)
  ipcMain.on('action-new-tab', () => createTab(LOCAL_TEST_PAGE_URL));
  ipcMain.on('action-new-tab-url', (_event, u) => createTab(resolveNavUrl(u)));
  ipcMain.on('action-close-tab', (_event, tabId) => closeTab(tabId));
  ipcMain.on('action-switch-tab', (_event, tabId) => switchTab(tabId));
  ipcMain.on('action-navigate', (_event, rawUrl) => {
    const activeTab = tabs.find(t => t.id === activeTabId);
    if (activeTab && activeTab.view && activeTab.view.webContents && !activeTab.view.webContents.isDestroyed()) {
      const url = resolveNavUrl(rawUrl);
      activeTab.navSeq = (activeTab.navSeq || 0) + 1;
      const currentSeq = activeTab.navSeq;
      activeTab.pendingNavUrl = url;
      activeTab.checkCount = 0;

      // 关键：立即彻底中止 A 网址及其所有子框架、挂起网络流与多媒体，释放连接全力加载 B 网址
      try {
        activeTab.view.webContents.stop();
      } catch (_) {}
      try {
        activeTab.view.webContents.executeJavaScript('window.stop();', true).catch(() => {});
      } catch (_) {}

      if (activeTab.checkTimer) {
        clearTimeout(activeTab.checkTimer);
        activeTab.checkTimer = null;
      }
      if (activeTab.safetyTimer) {
        clearTimeout(activeTab.safetyTimer);
        activeTab.safetyTimer = null;
      }

      markTabLoading(activeTab, url);
      notifyShell();
      activeTab.view.webContents.loadURL(url).catch(err => {
        if (activeTab.navSeq !== currentSeq) {
          return; // 已被新导航替代，忽略上一导航中断
        }
        console.error('加载页面出错:', err.message);
        activeTab.pendingNavUrl = null;
        scheduleTabLoadingCheck(activeTab);
      });
    }
  });
  ipcMain.on('action-nav-back', () => {
    const activeTab = tabs.find(t => t.id === activeTabId);
    if (activeTab && activeTab.view && activeTab.view.webContents && !activeTab.view.webContents.isDestroyed()) {
      if (activeTab.view.webContents.navigationHistory?.canGoBack()) {
        markTabLoading(activeTab);
        activeTab.view.webContents.navigationHistory.back();
      }
    }
  });
  ipcMain.on('action-nav-forward', () => {
    const activeTab = tabs.find(t => t.id === activeTabId);
    if (activeTab && activeTab.view && activeTab.view.webContents && !activeTab.view.webContents.isDestroyed()) {
      if (activeTab.view.webContents.navigationHistory?.canGoForward()) {
        markTabLoading(activeTab);
        activeTab.view.webContents.navigationHistory.forward();
      }
    }
  });
  ipcMain.on('action-nav-reload', () => {
    const activeTab = tabs.find(t => t.id === activeTabId);
    if (activeTab && activeTab.view && activeTab.view.webContents && !activeTab.view.webContents.isDestroyed()) {
      markTabLoading(activeTab);
      activeTab.view.webContents.reload();
    }
  });
  ipcMain.on('action-nav-stop', () => {
    const activeTab = tabs.find(t => t.id === activeTabId);
    if (activeTab) {
      activeTab.navSeq = (activeTab.navSeq || 0) + 1;
      if (activeTab.checkTimer) clearTimeout(activeTab.checkTimer);
      if (activeTab.safetyTimer) clearTimeout(activeTab.safetyTimer);
      activeTab.isLoading = false;
      activeTab.pendingNavUrl = null;
      if (activeTab.view && activeTab.view.webContents && !activeTab.view.webContents.isDestroyed()) {
        try { activeTab.view.webContents.stop(); } catch (_) {}
        try { activeTab.view.webContents.executeJavaScript('window.stop();', true).catch(() => {}); } catch (_) {}
      }
      notifyShell();
    }
  });
  ipcMain.on('action-toggle-devtools', () => {
    const activeTab = tabs.find(t => t.id === activeTabId);
    if (activeTab) {
      const wc = activeTab.view.webContents;
      wc.isDevToolsOpened() ? wc.closeDevTools() : wc.openDevTools({ mode: 'detach' });
    }
  });

  // 窗口无边框控制 (最小化、最大化/向下还原、关闭)
  ipcMain.on('action-window-minimize', () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.minimize();
    }
  });
  ipcMain.on('action-window-maximize', () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      if (mainWindow.isMaximized()) {
        mainWindow.unmaximize();
      } else {
        mainWindow.maximize();
      }
    }
  });
  ipcMain.on('action-window-close', () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.close();
    }
  });

  ipcMain.on('action-open-extension-page', (_event, targetUrl) => {
    if (targetUrl) createTab(targetUrl);
  });
  ipcMain.on('action-new-tab-url', (_event, targetUrl) => {
    if (targetUrl) createTab(targetUrl);
  });
  ipcMain.on('action-save-bookmarks', (_event, bookmarks) => {
    if (Array.isArray(bookmarks)) {
      updateBookmarks(bookmarks);
    }
  });
  ipcMain.on('action-bookmark-context-menu', (_event, { index, bookmark }) => {
    if (!bookmark) return;
    const menu = Menu.buildFromTemplate([
      {
        label: '在新标签页中打开',
        click: () => {
          if (bookmark.url) createTab(bookmark.url);
        }
      },
      {
        label: '在当前标签页中打开',
        click: () => {
          const activeTab = tabs.find(t => t.id === activeTabId);
          if (activeTab && bookmark.url && activeTab.view && activeTab.view.webContents && !activeTab.view.webContents.isDestroyed()) {
            activeTab.navSeq = (activeTab.navSeq || 0) + 1;
            activeTab.pendingNavUrl = bookmark.url;
            activeTab.checkCount = 0;
            try { activeTab.view.webContents.stop(); } catch (_) {}
            try { activeTab.view.webContents.executeJavaScript('window.stop();', true).catch(() => {}); } catch (_) {}
            if (activeTab.checkTimer) clearTimeout(activeTab.checkTimer);
            if (activeTab.safetyTimer) clearTimeout(activeTab.safetyTimer);
            markTabLoading(activeTab, bookmark.url);
            notifyShell();
            activeTab.view.webContents.loadURL(bookmark.url).catch(() => {});
          }
        }
      },
      { type: 'separator' },
      {
        label: '编辑书签...',
        click: () => {
          if (shellView && !shellView.webContents.isDestroyed()) {
            shellView.webContents.send('action-edit-bookmark', { index, bookmark });
          }
        }
      },
      {
        label: '复制网址链接',
        click: () => {
          const { clipboard } = require('electron');
          if (bookmark.url) clipboard.writeText(bookmark.url);
        }
      },
      { type: 'separator' },
      {
        label: '删除书签',
        click: () => {
          if (shellView && !shellView.webContents.isDestroyed()) {
            shellView.webContents.send('action-delete-bookmark', { index, bookmark });
          }
        }
      }
    ]);
    menu.popup({ window: mainWindow });
  });
  ipcMain.on('action-bookmarks-bar-context-menu', () => {
    const activeTab = tabs.find(t => t.id === activeTabId);
    const curUrl = activeTab ? (activeTab.pendingNavUrl || activeTab.view.webContents.getURL() || activeTab.initialUrl) : '';
    const menu = Menu.buildFromTemplate([
      {
        label: '收藏当前网页到此栏',
        enabled: Boolean(curUrl && !curUrl.startsWith('about:')),
        click: () => {
          if (shellView && !shellView.webContents.isDestroyed()) {
            shellView.webContents.send('trigger-bookmark-current');
          }
        }
      },
      {
        label: '添加新书签...',
        click: () => {
          if (shellView && !shellView.webContents.isDestroyed()) {
            shellView.webContents.send('action-add-new-bookmark');
          }
        }
      }
    ]);
    menu.popup({ window: mainWindow });
  });
  ipcMain.on('action-show-extensions-menu', () => {
    if (loadedExtensions.length === 0) {
      const menu = Menu.buildFromTemplate([
        { label: '🧩 当前环境未加载任何扩展插件', enabled: false },
        { type: 'separator' },
        { label: '提示：请在管理器编辑配置中设置插件解压目录', enabled: false }
      ]);
      menu.popup({ window: mainWindow });
      return;
    }

    const template = [
      { label: `🧩 已加载扩展插件 (${loadedExtensions.length} 个)`, enabled: false },
      { type: 'separator' }
    ];

    for (const ext of loadedExtensions) {
      const subItems = [];
      if (ext.optionsUrl) {
        subItems.push({
          label: '⚙️ 打开插件设置 (Options)',
          click: () => createTab(ext.optionsUrl)
        });
      }
      if (ext.popupUrl) {
        subItems.push({
          label: '🚀 打开扩展弹窗 (Popup)',
          click: () => createTab(ext.popupUrl)
        });
      }
      subItems.push({
        label: '🌐 打开扩展根页面',
        click: () => createTab(ext.url)
      });
      subItems.push({ type: 'separator' });
      subItems.push({
        label: `ID: ${ext.id}`,
        enabled: false
      });
      subItems.push({
        label: `目录: ${ext.path}`,
        enabled: false
      });

      template.push({
        label: `${ext.name} (v${ext.version})`,
        submenu: subItems
      });
    }

    const menu = Menu.buildFromTemplate(template);
    menu.popup({ window: mainWindow });
  });

  // 2. 创建顶部控制器 Shell View
  shellView = new WebContentsView({
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
      devTools: false
    }
  });
  if (typeof shellView.webContents.setInspectable === 'function') {
    shellView.webContents.setInspectable(false);
  }
  mainWindow.contentView.addChildView(shellView);

  // 关键防护：拦截 Shell View 被非预期导航，并确保始终恢复本地 UI
  shellView.webContents.on('will-navigate', (event, targetUrl) => {
    event.preventDefault();
    const activeTab = tabs.find(t => t.id === activeTabId);
    if (activeTab && activeTab.view && activeTab.view.webContents && !activeTab.view.webContents.isDestroyed()) {
      activeTab.navSeq = (activeTab.navSeq || 0) + 1;
      activeTab.pendingNavUrl = targetUrl;
      activeTab.checkCount = 0;
      try { activeTab.view.webContents.stop(); } catch (_) {}
      try { activeTab.view.webContents.executeJavaScript('window.stop();', true).catch(() => {}); } catch (_) {}
      if (activeTab.checkTimer) clearTimeout(activeTab.checkTimer);
      if (activeTab.safetyTimer) clearTimeout(activeTab.safetyTimer);
      markTabLoading(activeTab, targetUrl);
      notifyShell();
      activeTab.view.webContents.loadURL(targetUrl).catch(() => {});
    } else {
      createTab(targetUrl);
    }
  });

  shellView.webContents.on('did-finish-load', () => {
    const cur = shellView.webContents.getURL();
    if (cur && !cur.includes('ui/index.html')) {
      // 若被外部意外导航，延时异步重载恢复 Shell UI，杜绝 Chromium NavigationRequest 内部崩溃
      setTimeout(() => {
        if (shellView && !shellView.webContents.isDestroyed()) {
          shellView.webContents.loadFile(path.join(__dirname, 'ui/index.html')).catch(() => {});
        }
      }, 50);
    }
  });

  // 顶部 Shell View 地址栏右键菜单
  shellView.webContents.on('context-menu', (_e, params) => {
    if (params.isEditable) {
      const template = [
        { label: '剪切 (Cut)', role: 'cut', enabled: params.editFlags.canCut },
        { label: '复制 (Copy)', role: 'copy', enabled: params.editFlags.canCopy },
        { label: '粘贴 (Paste)', role: 'paste', enabled: params.editFlags.canPaste },
        { type: 'separator' },
        { label: '全选 (Select All)', role: 'selectAll', enabled: params.editFlags.canSelectAll }
      ];
      Menu.buildFromTemplate(template).popup({ window: mainWindow });
    }
  });

  // 顶部 Shell View 快捷键支持
  shellView.webContents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown') return;
    const isCtrl = input.control || input.meta;
    if (isCtrl && input.key.toLowerCase() === 't') {
      event.preventDefault();
      createTab(LOCAL_TEST_PAGE_URL);
    } else if (isCtrl && input.key.toLowerCase() === 'w') {
      event.preventDefault();
      if (activeTabId) closeTab(activeTabId);
    } else if (isCtrl && input.key.toLowerCase() === 'r') {
      event.preventDefault();
      const activeTab = tabs.find(t => t.id === activeTabId);
      if (activeTab) {
        markTabLoading(activeTab);
        activeTab.view.webContents.reload();
      }
    } else if (input.key === 'F5') {
      event.preventDefault();
      const activeTab = tabs.find(t => t.id === activeTabId);
      if (activeTab) {
        markTabLoading(activeTab);
        activeTab.view.webContents.reload();
      }
    } else if (input.key === 'F12') {
      event.preventDefault();
      const activeTab = tabs.find(t => t.id === activeTabId);
      if (activeTab) {
        const wc = activeTab.view.webContents;
        wc.isDevToolsOpened() ? wc.closeDevTools() : wc.openDevTools({ mode: 'detach' });
      }
    } else if (isCtrl && input.key.toLowerCase() === 'd') {
      event.preventDefault();
      shellView.webContents.send('trigger-bookmark-current');
    }
  });

  await shellView.webContents.loadFile(path.join(__dirname, 'ui/index.html'));

  // 3. 创建内容网页标签 (后创建确保成为 LIFO 顶层 Target 0)
  const defaultCandidate = openUrlOverride || currentEnv.url;
  const startUrl = resolveNavUrl(defaultCandidate);
  await createTab(startUrl);

  // 4. 监听外部 CDP 创建的新页面 (如 Python 调用 context.new_page() / browser.newPage())
  // 自动接入浏览器多标签管理体系，显示在下方内容区，并在顶栏标签栏显示
  app.on('web-contents-created', (_event, contents) => {
    if (contents.getType() !== 'window') return;
    setImmediate(() => {
      if (!mainWindow || mainWindow.isDestroyed()) return;
      if (shellView && shellView.webContents === contents) return;
      if (tabs.some(t => t.view && t.view.webContents && !t.view.webContents.isDestroyed() && t.view.webContents === contents)) return;

      try {
        const tabId = 'tab-cdp-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6);
        const view = new WebContentsView({ webContents: contents });
        mainWindow.contentView.addChildView(view);
        const currentUrl = contents.getURL() || 'about:blank';
        const tabItem = {
          id: tabId,
          view,
          initialUrl: currentUrl,
          isLoading: contents.isLoading(),
          pendingNavUrl: null,
          navSeq: 1,
          checkTimer: null,
          safetyTimer: null,
          checkCount: 0
        };
        setupTabListeners(tabItem);
        tabs.push(tabItem);
        switchTab(tabId);
        notifyShell();
      } catch (err) {
        console.warn('[CDP Tab Attach Error]', err.message);
      }
    });
  });

  mainWindow.on('resize', resizeViews);
  mainWindow.on('maximize', notifyShell);
  mainWindow.on('unmaximize', notifyShell);
  mainWindow.on('closed', () => {
    if (proxyBridge && proxyBridge.server) {
      try { proxyBridge.server.close(); } catch {}
    }
    app.quit();
  });

  // 5. 初始同步 Shell 状态与布局
  resizeViews();
  notifyShell();

  // 6. 热更新检查优化：通过 mtimeMs 避免无意义的高频磁盘读取
  const { CONFIG_FILE } = require('../manager/store');
  let lastMtime = 0;
  let lastSeed = currentEnv.fp?.seed;
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      lastMtime = fs.statSync(CONFIG_FILE).mtimeMs;
    }
  } catch (_) {}

  setInterval(() => {
    try {
      if (!fs.existsSync(CONFIG_FILE)) return;
      const mtime = fs.statSync(CONFIG_FILE).mtimeMs;
      if (mtime <= lastMtime) return;
      lastMtime = mtime;

      const latestList = loadAll();
      const latestEnv = latestList.find(i => i.id === currentEnv.id);
      if (latestEnv && latestEnv.fp && latestEnv.fp.seed !== lastSeed) {
        lastSeed = latestEnv.fp.seed;
        applyHotFingerprint(latestEnv.fp);
      }
    } catch {}
  }, 1000);

  console.log(`[Window Started] ${currentEnv.name} | Port: ${currentEnv.remotePort} | Profile: ${absUserData}`);
}).catch(err => {
  console.error('启动窗口发生异常:', err);
  app.exit(1);
});
