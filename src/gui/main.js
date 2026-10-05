// 0. 主进程调度防护：若携带浏览器参数启动（如点击【启动环境】拉起新进程），直接转发至浏览器主模块
// 当作为 app.asar 发行时，所有拉起 electron.exe 的子进程都会默认加载主入口。
// 必须在最前置进行拦截分流，杜绝误触管理器的全局互斥锁导致浏览器子进程秒退！
const isBrowserProcess = process.argv.some(a => 
  a.startsWith('--env-id=') || 
  a === '--browser-mode' || 
  a.startsWith('--browser-mode=') ||
  a.includes('src/browser/main.js') ||
  a.includes('src\\browser\\main.js') ||
  a.startsWith('--remote-debugging-port=')
);

if (isBrowserProcess) {
  require('../browser/main.js');
} else {
  runManager();
}

function runManager() {
  const { app, BrowserWindow, ipcMain, shell, Menu, Tray, nativeImage } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const store = require('../manager/store');
const processManager = require('../manager/process-manager');
const systemSettings = require('../manager/system-settings');

// 核心修复：彻底根除 Chromium 在 Windows 双屏跨屏移动、高刷新率/DPI差异、睡眠唤醒下的 UI 偶发黑屏
app.disableHardwareAcceleration();
app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');
app.commandLine.appendSwitch('disable-direct-composition');
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');
app.commandLine.appendSwitch('disable-gpu-process-crash-limit');
app.commandLine.appendSwitch('high-dpi-support', '1');

// 1. 管理器单例互斥锁：严格禁止多开
const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  console.log('[DT Manager] 检测到管理器已有实例正在运行，禁止多开，当前进程自动退出。');
  app.quit();
  process.exit(0);
}

let mainWindow = null;
let tray = null;
let isQuitting = false;
let hasShownTrayBalloon = false;

// 多级可靠图标解析：确保在开发模式、asar打包模式、安装后的不同工作目录下，任务栏与托盘图标永不丢失
function getAppIcon() {
  const candidates = [
    path.resolve(__dirname, '../../app.ico'),
    path.resolve(__dirname, '../../../app.ico'),
    path.resolve(__dirname, '../../../../app.ico'),
    path.join(process.resourcesPath || '', '../app.ico'),
    path.join(process.resourcesPath || '', 'app.ico'),
    path.join(process.env.DT_APP_ROOT || '', 'app.ico'),
    path.resolve(process.cwd(), 'app.ico')
  ];

  for (const c of candidates) {
    if (c && fs.existsSync(c)) {
      try {
        const img = nativeImage.createFromPath(c);
        if (!img.isEmpty()) return { path: c, native: img };
      } catch (_) {}
    }
  }

  // 兜底内存 16x16 图标，杜绝空图标导致托盘或任务栏隐形
  const fallbackPng = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAAAXNSR0IArs4c6QAAAERlWElmTU0AKgAAAAgAAYdpAAQAAAABAAAAGgAAAAAAA6ABAAMAAAABAAEAAKACAAQAAAABAAAAIKADAAQAAAABAAAAIAAAAACcA80OAAABeUlEQVRYCe2WvUoDQRRGz8xsks0mZqNEETsVFCx9C618CF/C1s7S0lcQLAQVLCwsxCL4A8VSsBBBSLJZ/mYmmw2bxISksuAOd1jOPfdw586Zmd3t7S2pX6fVag07nU71Y2K/3295nndjPvf+u5eXlzf7/b78t1sJ4L/b/t0rADqgAw6k+77v7/f7cRrf399vFovFU3n9+vqq3W6347i3+Xw+L6+D4TDuO44zF3sURf8iAJ8vFovv+/1e5y5QADjA3gE4jmM7jsM2x3Hc27ZtO46D74eG4zje7Xa7T6fT6fN2u73t+/7rYDDYltdhGG66rvuIomg7n8/v2u12x3VdjuOwv7u9AeA3n8+v9/v9/vV6/Wzb9kH34/HYDgaDjeM4vM+8915eXn57v99713XvjuN89Xq9G/V3Op13wQv/6wXgVb7vN9vt9sVxnP1+v3+3bXt7fn5e11vP8zqe5+Xf8+jDfwF4VbPZnHa73afjOLvFYnFnXqfT4TjOdZIk+6b/h/Y3aA5o7bU1+fAAAAAASUVORK5CYII=';
  const img = nativeImage.createFromDataURL(fallbackPng);
  return { path: null, native: img };
}

function showMainWindow() {
  if (!mainWindow) {
    createWindow();
    return;
  }
  if (mainWindow.isMinimized()) mainWindow.restore();
  if (!mainWindow.isVisible()) mainWindow.show();
  mainWindow.focus();
}

app.on('second-instance', () => {
  showMainWindow();
});

function createWindow() {
  const isStartMinimized = process.argv.includes('--minimized') || process.argv.includes('--hidden');
  const appIcon = getAppIcon();

  mainWindow = new BrowserWindow({
    width: 1380,
    height: 880,
    minWidth: 1000,
    minHeight: 600,
    show: !isStartMinimized,
    title: 'DT - 指纹浏览器',
    icon: appIcon.native || appIcon.path || undefined,
    backgroundColor: '#0f172a',
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
      backgroundThrottling: false,
      spellcheck: false
    }
  });

  if (appIcon.native) {
    mainWindow.setIcon(appIcon.native);
  }

  // 双屏支持与最小化/唤醒黑屏自愈
  mainWindow.on('minimize', () => {
    // 确保最小化时在对应显示器的任务栏保持图标可见
    mainWindow.setSkipTaskbar(false);
  });

  mainWindow.on('restore', () => {
    mainWindow.setSkipTaskbar(false);
    mainWindow.show();
    mainWindow.focus();
    // 关键：强制 Chromium 表面重绘合成，杜绝双屏最小化恢复后的黑屏
    mainWindow.webContents.invalidate();
  });

  mainWindow.on('show', () => {
    mainWindow.setSkipTaskbar(false);
    mainWindow.webContents.invalidate();
  });

  mainWindow.on('focus', () => {
    mainWindow.webContents.invalidate();
  });

  mainWindow.on('moved', () => {
    // 跨屏移动后强制重绘
    mainWindow.webContents.invalidate();
  });

  // 渲染进程崩溃与黑屏自愈机制
  mainWindow.webContents.on('render-process-gone', (_e, details) => {
    console.warn('[DT Manager] 渲染进程异常，自动恢复重载:', details.reason);
    if (details.reason !== 'clean-exit' && mainWindow && !mainWindow.isDestroyed()) {
      setTimeout(() => {
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.reload();
        }
      }, 300);
    }
  });

  mainWindow.webContents.on('unresponsive', () => {
    console.warn('[DT Manager] 界面无响应，正在自动刷新恢复...');
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.reload();
    }
  });

  Menu.setApplicationMenu(null);
  mainWindow.setMenu(null);
  mainWindow.setMenuBarVisibility(false);

  // 启用右键菜单（复制、粘贴、剪切、全选）
  mainWindow.webContents.on('context-menu', (_e, params) => {
    const template = [];
    if (params.isEditable) {
      template.push({ label: '剪切 (Cut)', role: 'cut', enabled: params.editFlags.canCut });
      template.push({ label: '复制 (Copy)', role: 'copy', enabled: params.editFlags.canCopy });
      template.push({ label: '粘贴 (Paste)', role: 'paste', enabled: params.editFlags.canPaste });
      template.push({ type: 'separator' });
      template.push({ label: '全选 (Select All)', role: 'selectAll', enabled: params.editFlags.canSelectAll });
    } else if (params.selectionText && params.selectionText.trim()) {
      template.push({ label: '复制 (Copy)', role: 'copy' });
    } else {
      template.push({ label: '重新加载页面', click: () => mainWindow.webContents.reload() });
      template.push({ label: '检查元素', click: () => mainWindow.webContents.openDevTools({ mode: 'detach' }) });
    }
    if (template.length > 0) {
      Menu.buildFromTemplate(template).popup({ window: mainWindow });
    }
  });

  mainWindow.loadFile(path.join(__dirname, 'ui/index.html'));

  if (process.argv.includes('--take-screenshots')) {
    mainWindow.webContents.once('did-finish-load', async () => {
      const screenshotsDir = path.resolve(__dirname, '../../assets/screenshots');
      if (!fs.existsSync(screenshotsDir)) fs.mkdirSync(screenshotsDir, { recursive: true });
      await new Promise(r => setTimeout(r, 2500));

      // 1. Capture Manager Main Window
      const imgMain = await mainWindow.webContents.capturePage();
      fs.writeFileSync(path.join(screenshotsDir, 'manager-main.png'), imgMain.toPNG());
      console.log('✅ Captured manager-main.png');

      // 2. Open theme modal
      await mainWindow.webContents.executeJavaScript(`
        if (typeof openThemeModal === 'function') openThemeModal();
        else document.getElementById('themeModal').style.display = 'flex';
      `);
      await new Promise(r => setTimeout(r, 1200));
      const imgTheme = await mainWindow.webContents.capturePage();
      fs.writeFileSync(path.join(screenshotsDir, 'manager-settings.png'), imgTheme.toPNG());
      console.log('✅ Captured manager-settings.png');

      // 3. Open env modal
      await mainWindow.webContents.executeJavaScript(`
        document.getElementById('themeModal').style.display = 'none';
        if (typeof openEditModal === 'function') openEditModal(allEnvironments && allEnvironments[0]);
        else document.getElementById('envModal').style.display = 'flex';
      `);
      await new Promise(r => setTimeout(r, 1200));
      const imgEnv = await mainWindow.webContents.capturePage();
      fs.writeFileSync(path.join(screenshotsDir, 'manager-env-config.png'), imgEnv.toPNG());
      console.log('✅ Captured manager-env-config.png');

      // 4. Open fingerprint probe window
      const testWin = new BrowserWindow({
        width: 1280,
        height: 850,
        show: true,
        backgroundColor: '#0f172a',
        webPreferences: {
          nodeIntegration: false,
          contextIsolation: true
        }
      });
      testWin.loadFile(path.resolve(__dirname, '../browser/testing/index.html'));
      await new Promise(r => setTimeout(r, 2500));
      const imgProbe = await testWin.webContents.capturePage();
      fs.writeFileSync(path.join(screenshotsDir, 'fingerprint-probe.png'), imgProbe.toPNG());
      console.log('✅ Captured fingerprint-probe.png');
      testWin.destroy();

      isQuitting = true;
      app.quit();
      process.exit(0);
    });
  }

  // 关键：拦截 UI 上的关闭操作（点击右上角X或Alt+F4），阻止销毁，强制最小化/隐藏到系统托盘
  mainWindow.on('close', (event) => {
    if (!isQuitting) {
      event.preventDefault();
      mainWindow.hide();

      // 首次隐藏到托盘时，显示 Windows 右下角通知气泡提示
      if (tray && process.platform === 'win32' && !hasShownTrayBalloon) {
        hasShownTrayBalloon = true;
        try {
          tray.displayBalloon({
            iconType: 'info',
            title: 'DT - 指纹浏览器',
            content: '管理器已最小化至任务图标栏。如需彻底关闭，请在右下角图标右键选择【退出管理器】。'
          });
        } catch (_) {}
      }
    }
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

// 创建系统托盘（任务图标栏）
function createTray() {
  if (tray) return;

  const appIcon = getAppIcon();
  tray = new Tray(appIcon.native || appIcon.path);
  tray.setToolTip('DT - 指纹浏览器 (后台运行中)');

  const updateTrayMenu = () => {
    const runningStatus = processManager.getRunningStatus();
    const runningCount = Object.keys(runningStatus).length;

    const contextMenu = Menu.buildFromTemplate([
      {
        label: '显示主界面',
        click: () => showMainWindow()
      },
      {
        label: `当前运行中: ${runningCount} 个浏览器`,
        enabled: false
      },
      {
        label: '停止所有运行中的浏览器',
        enabled: runningCount > 0,
        click: async () => {
          await processManager.stopAll();
          broadcastState(true);
        }
      },
      { type: 'separator' },
      {
        label: '退出管理器',
        click: () => {
          isQuitting = true;
          app.quit();
        }
      }
    ]);

    tray.setContextMenu(contextMenu);
  };

  updateTrayMenu();
  tray.setToolTip('DT - 指纹浏览器 (后台运行中)');

  // 单击托盘图标：唤起并置顶主界面
  tray.on('click', () => {
    showMainWindow();
  });

  // 双击托盘图标：唤起并置顶主界面
  tray.on('double-click', () => {
    showMainWindow();
  });

  // 弹出右键菜单前动态更新当前运行环境数量
  tray.on('right-click', () => {
    updateTrayMenu();
  });
}

// 统一数据与状态
function getFullState() {
  const environments = store.loadAll();
  const running = processManager.getRunningStatus();
  const settings = store.getSettings();
  const activeFont = store.getActiveFontInfo();
  return { environments, running, settings, activeFont };
}

let lastStateStr = '';
function broadcastState(force = false) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    const fullState = getFullState();
    const str = JSON.stringify(fullState);
    if (force || str !== lastStateStr) {
      lastStateStr = str;
      mainWindow.webContents.send('state-updated', fullState);
    }
  }
}

app.whenReady().then(() => {
  createWindow();
  createTray();

  // IPC 接口
  ipcMain.handle('get-state', () => getFullState());
  ipcMain.handle('get-settings', () => store.getSettings());
  ipcMain.handle('update-settings', (_e, patch) => {
    const updated = store.updateSettings(patch);
    broadcastState(true);
    return updated;
  });
  ipcMain.handle('get-autostart', () => systemSettings.getAutoStart(app));
  ipcMain.handle('set-autostart', (_e, { enabled, silent }) => systemSettings.setAutoStart(app, enabled, silent));
  ipcMain.handle('get-path-status', () => systemSettings.getPathStatus());
  ipcMain.handle('set-path-env', (_e, { enabled }) => systemSettings.setPathEnvironment(enabled));
  ipcMain.handle('get-random-fp', (_e, { language, timezone } = {}) => store.getRandomFp({ language, timezone }));

  // 字体管理 IPC
  ipcMain.handle('get-fonts', () => ({
    fonts: store.getAvailableFonts(),
    current: store.getActiveFontInfo()
  }));
  ipcMain.handle('set-font', (_e, fontId) => {
    store.updateSettings({ fontFamily: fontId });
    const active = store.getActiveFontInfo();
    broadcastState(true);
    return { success: true, active };
  });
  ipcMain.handle('open-fonts-dir', () => {
    shell.openPath(store.FONTS_DIR);
  });
  ipcMain.handle('open-external', (_e, url) => {
    if (url && (url.startsWith('https://') || url.startsWith('http://'))) {
      shell.openExternal(url);
    }
  });

  ipcMain.handle('get-groups', () => store.getGroups());
  ipcMain.handle('add-group', (_e, name) => {
    const res = store.addGroup(name);
    broadcastState();
    return res;
  });
  ipcMain.handle('delete-group', (_e, name) => {
    const res = store.deleteGroup(name);
    broadcastState();
    return res;
  });
  ipcMain.handle('rename-group', (_e, { oldName, newName }) => {
    const res = store.renameGroup(oldName, newName);
    broadcastState();
    return res;
  });
  ipcMain.handle('batch-set-group', (_e, payload) => {
    const ids = (payload && payload.ids) || [];
    const targetGroup = (payload && (payload.group || payload.groupName)) || '默认分组';
    const count = store.batchSetGroup(ids, targetGroup);
    broadcastState();
    return { success: true, count };
  });

  ipcMain.handle('create-env', (_e, data) => {
    const created = store.addEnvironment(data);
    broadcastState();
    return created;
  });

  ipcMain.handle('update-env', (_e, { id, updates }) => {
    const updated = store.updateEnvironment(id, updates);
    broadcastState();
    return updated;
  });

  ipcMain.handle('delete-env', async (_e, id) => {
    if (processManager.isRunning(id)) {
      await processManager.stop(id);
    }
    const res = store.deleteEnvironment(id);
    broadcastState();
    return res;
  });

  ipcMain.handle('clear-env-cache', async (_e, id) => {
    if (processManager.isRunning(id)) {
      throw new Error('当前环境正在运行中，清理缓存前请先停止该环境！');
    }
    const res = store.clearEnvironmentCache(id);
    broadcastState();
    return res;
  });

  ipcMain.handle('clone-env', (_e, { id, newName }) => {
    const cloned = store.cloneEnvironment(id, newName);
    broadcastState();
    return cloned;
  });

  ipcMain.handle('random-fp', (_e, id) => {
    const updated = store.regenerateFp(id);
    broadcastState();
    return updated;
  });

  ipcMain.handle('launch-env', async (_e, id) => {
    const res = await processManager.launch(id);
    broadcastState();
    return res;
  });

  ipcMain.handle('stop-env', async (_e, id) => {
    const res = await processManager.stop(id);
    broadcastState();
    return res;
  });

  ipcMain.handle('stop-all', async () => {
    const res = await processManager.stopAll();
    broadcastState();
    return res;
  });

  ipcMain.handle('open-path', (_e, targetPath) => {
    if (!targetPath) return;
    let absPath = targetPath;
    if (!path.isAbsolute(targetPath)) {
      const sub = path.basename(targetPath);
      absPath = path.join(store.PROFILES_DIR, sub);
    }
    if (!fs.existsSync(absPath)) {
      try { fs.mkdirSync(absPath, { recursive: true }); } catch (_) {}
    }
    shell.openPath(absPath);
  });

  const { testProxy } = require('../manager/proxy-tester');
  const { parseProxyString } = require('../manager/proxy-parser');

  ipcMain.handle('parse-proxy', (_e, raw) => parseProxyString(raw));
  ipcMain.handle('test-proxy', (_e, proxyConfig) => testProxy(proxyConfig));
  ipcMain.handle('get-next-port', async () => await store.getNextAvailablePort());
  ipcMain.handle('check-port-available', async (_e, port) => await store.isPortAvailable(port));

  // 定时向前端推送运行状态更新
  setInterval(() => {
    broadcastState();
  }, 1500);
});

app.on('before-quit', () => {
  isQuitting = true;
});

app.on('will-quit', () => {
  if (tray && !tray.isDestroyed()) {
    try {
      tray.destroy();
    } catch (_) {}
    tray = null;
  }
});

app.on('window-all-closed', () => {
  // UI 无法真正关闭管理器，仅在从托盘右键退出时才退出程序
  if (isQuitting) {
    app.quit();
  }
});
}
