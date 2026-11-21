'use strict';

// Run with runtime/electron.exe scripts/test-v27.js.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { app, BrowserWindow, ipcMain, session } = require('electron');
const { applyProxy, closeCurrentBridge, stopRotatingProxy } = require('../src/browser/proxy-helper');
const { generateFingerprint } = require('../fp-sdk');

const profileRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dt-v27-regression-'));
app.setPath('userData', profileRoot);
app.commandLine.appendSwitch('disable-background-networking');
app.commandLine.appendSwitch('host-resolver-rules', 'MAP audit.test 127.0.0.1');

const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
const fetchLocal = (ses, url) => ses.fetch(url, { signal: AbortSignal.timeout(6000) });

async function checkBlocked(ses, url) {
  let timer;
  try {
    const response = await Promise.race([
      ses.fetch(url).catch(() => null),
      new Promise(resolve => { timer = setTimeout(() => resolve(null), 4000); })
    ]);
    assert.ok(!response?.ok, 'proxy failure must block the request');
  } finally {
    clearTimeout(timer);
  }
}

async function checkProxy() {
  let originHits = 0;
  let upstreamHits = 0;
  const origin = http.createServer((_req, res) => {
    originHits++;
    res.end('direct');
  });
  const upstream = http.createServer();
  upstream.on('connect', (_req, socket) => {
    upstreamHits++;
    socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
    socket.once('data', () => socket.end('HTTP/1.1 200 OK\r\nContent-Length: 5\r\nConnection: close\r\n\r\nproxy'));
  });
  let upstreamClosed = false;
  try {
    const originPort = await listen(origin);
    const upstreamPort = await listen(upstream);
    const url = `http://audit.test:${originPort}/`;
    const first = session.fromPartition('proxy-default');
    const second = session.fromPartition('proxy-content');
    const rotating = { enabled: true, rawText: `http://127.0.0.1:${upstreamPort}`, rules: 'audit.test' };

    await applyProxy(first, null, rotating);
    await applyProxy(second, null, rotating);
    assert.equal(await (await fetchLocal(second, url)).text(), 'proxy');
    assert.equal(await (await fetchLocal(first, url)).text(), 'proxy');
    assert.equal(upstreamHits, 2);

    await new Promise(resolve => upstream.close(resolve));
    upstreamClosed = true;
    await second.closeAllConnections();
    await checkBlocked(second, url);
    assert.equal(originHits, 0, 'rotation failures must not send requests directly');
    console.log('PASS failed rotation did not reach the origin');

    const fixed = { enabled: true, host: '127.0.0.1', port: upstreamPort, type: 'http', scope: 'rules', rules: 'audit.test' };
    const ruleSession = session.fromPartition('proxy-rule');
    await applyProxy(ruleSession, fixed);
    await checkBlocked(ruleSession, url);
    assert.equal(originHits, 0, 'rule proxy failures must not send requests directly');

    const invalidSession = session.fromPartition('proxy-invalid');
    await applyProxy(invalidSession, null, { ...rotating, rawText: '' });
    await checkBlocked(invalidSession, url);
    assert.equal(originHits, 0, 'an invalid pool must block matching requests');

    await applyProxy(ruleSession, null);
    await ruleSession.closeAllConnections();
    assert.equal(await (await fetchLocal(ruleSession, url)).text(), 'direct');
    console.log('PASS working rotation across two sessions, proxy failures and explicit direct mode');
  } finally {
    closeCurrentBridge();
    stopRotatingProxy();
    origin.closeAllConnections();
    origin.close();
    if (!upstreamClosed) upstream.close();
  }
}

async function checkLayout() {
  ipcMain.handle('get-settings', () => ({}));
  ipcMain.handle('get-groups', () => []);
  ipcMain.handle('get-fonts', () => ({ fonts: [] }));
  ipcMain.handle('get-state', () => ({ envs: [], active: {} }));
  const manager = new BrowserWindow({ width: 1366, height: 873, show: false, webPreferences: { nodeIntegration: true, contextIsolation: false } });
  try {
    await manager.loadFile(path.join(__dirname, '../src/gui/ui/index.html'));
    for (const [width, height] of [[1366, 873], [1080, 735], [1060, 600]]) {
      manager.setSize(width, height);
      await new Promise(resolve => setTimeout(resolve, 100));
      const fits = await manager.webContents.executeJavaScript(`
        (() => {
          const {clientWidth, clientHeight, scrollWidth} = document.documentElement;
          const footer = document.querySelector('.app-footer').getBoundingClientRect();
          const search = document.querySelector('#searchKeyword').getBoundingClientRect();
          const table = document.querySelector('.table-scroll').getBoundingClientRect();
          return scrollWidth === clientWidth && footer.bottom <= clientHeight &&
            search.right <= clientWidth && table.bottom <= footer.top && table.height > 0;
        })()
      `);
      assert.equal(fits, true, `manager layout at ${width}x${height}`);
    }
    console.log('PASS manager footer, controls and independently scrolling table');
  } finally {
    manager.destroy();
  }
}

const deadline = setTimeout(() => {
  console.error('Browser regression test exceeded its deadline');
  app.exit(1);
}, 45000);
app.whenReady().then(async () => {
  const original = generateFingerprint();
  const replacement = generateFingerprint({ randomizeUa: true, previousUa: original.uaString });
  assert.notEqual(replacement.uaString, original.uaString);
  assert.equal(replacement.ua.fullVersion, original.ua.fullVersion);
  assert.equal(generateFingerprint({ randomizeUa: true, previousUa: replacement.uaString }).uaString, original.uaString);
  console.log('PASS random UA changes format while retaining the runtime version');
  await checkProxy();
  await checkLayout();
  clearTimeout(deadline);
  app.exit(0);
}).catch(error => {
  clearTimeout(deadline);
  console.error(error);
  app.exit(1);
});
