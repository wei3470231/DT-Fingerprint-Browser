'use strict';

// Run with Node.js 22+ after installing both cores in the workspace.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { setTimeout: delay } = require('node:timers/promises');
const { executableFor } = require('./runtime-path');
const { chromiumSeed, isChromiumSeed } = require('../src/shared/chromium-seed');
const { chromiumProfile } = require('../src/manager/chromium');
const { generateFingerprint } = require('../fp-sdk');

const project = path.resolve(__dirname, '..');
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'dt-v30-'));
const electron = executableFor('electron', project);
const chromium = executableFor('chromium', project);
assert.ok(fs.existsSync(electron), 'Electron core is required');
assert.ok(fs.existsSync(chromium), 'Chromium core is required');
const cores = path.join(sandbox, 'runtime', 'cores');
fs.mkdirSync(cores, { recursive: true });
fs.symlinkSync(path.dirname(chromium), path.join(cores, 'chromium'), 'junction');
process.env.DT_APP_ROOT = sandbox;
process.env.FP_DEMO_ELECTRON = electron;

const store = require('../src/manager/store');
const browsers = require('../src/manager/process-manager');

async function freePort() {
  const server = http.createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  await new Promise(resolve => server.close(resolve));
  return port;
}

async function observe(port, testUrl, probeElectron = false) {
  const deadline = Date.now() + 12000;
  while (Date.now() < deadline) {
    const targets = await fetch('http://127.0.0.1:' + port + '/json/list', {
      signal: AbortSignal.timeout(1000),
    }).then(response => response.json()).catch(() => []);
    const target = targets.find(page => page.type === 'page' && page.url === testUrl);
    if (target) {
      try { return await evaluate(target.webSocketDebuggerUrl, probeElectron); } catch {}
    }
    await delay(150);
  }
  throw new Error('No test page at port ' + port);
}

function evaluate(url, probeElectron) {
  const expression = '(' + (electron => {
    const canvas = document.createElement('canvas');
    canvas.width = 32;
    canvas.height = 16;
    const context = canvas.getContext('2d');
    context.fillStyle = 'tomato';
    context.fillRect(0, 0, 25, 12);
    context.fillStyle = 'navy';
    context.fillRect(3, 2, 13, 5);
    document.cookie = 'dtV30=works; path=/; max-age=3600';
    const gl = electron ? document.createElement('canvas').getContext('webgl') : null;
    const debug = gl?.getExtension('WEBGL_debug_renderer_info');
    return {
      ua: navigator.userAgent,
      cores: navigator.hardwareConcurrency,
      memory: navigator.deviceMemory,
      screen: { width: screen.width, height: screen.height, dpr: devicePixelRatio },
      webgl: debug ? {
        vendor: gl.getParameter(debug.UNMASKED_VENDOR_WEBGL),
        renderer: gl.getParameter(debug.UNMASKED_RENDERER_WEBGL),
      } : null,
      languages: navigator.languages,
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      canvas: canvas.toDataURL(),
      pixels: Array.from(context.getImageData(0, 0, canvas.width, canvas.height).data).join(','),
      cookie: document.cookie,
    };
  }).toString() + ')(' + JSON.stringify(probeElectron) + ')';
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    const timer = setTimeout(() => { socket.close(); reject(new Error('CDP evaluation timed out')); }, 5000);
    socket.onopen = () => socket.send(JSON.stringify({
      id: 1, method: 'Runtime.evaluate', params: { expression, returnByValue: true },
    }));
    socket.onmessage = event => {
      const { id, result, error } = JSON.parse(event.data);
      if (id !== 1) return;
      clearTimeout(timer);
      socket.close();
      if (error || result.exceptionDetails) reject(new Error(JSON.stringify(error || result.exceptionDetails)));
      else resolve(result.result.value);
    };
    socket.onerror = () => { clearTimeout(timer); reject(new Error('CDP evaluation failed')); };
  });
}

async function main() {
  const requests = [];
  const httpServer = http.createServer((request, response) => {
    requests.push({ ua: request.headers['user-agent'], cookie: request.headers.cookie });
    response.setHeader('Content-Type', 'text/html; charset=utf-8');
    response.end('<!doctype html><title>DT dual-core test</title>');
  });
  await new Promise(resolve => httpServer.listen(0, '127.0.0.1', resolve));
  const url = 'http://127.0.0.1:' + httpServer.address().port + '/fingerprint';
  const environment = {
    id: 'v30-fixture',
    name: 'v30-fixture',
    customUa: 'DT-V3-Compatibility/1.0',
    language: 'en-GB',
    timezone: 'Asia/Shanghai',
    url,
    remotePortEnabled: true,
    remotePort: await freePort(),
    fp: generateFingerprint({ language: 'en-GB', timezone: 'Asia/Shanghai' }),
  };
  environment.fp.navigator.hardwareConcurrency = 7;
  const record = store.createRecord(environment);
  assert.equal(record.browserCore, 'chromium');
  store.saveAll([record]);

  const oldChromium = { id: 'old-chromium', name: 'old-chromium', userDataDir: 'data/profiles/old-chromium' };
  const oldElectron = { id: 'old-electron', name: 'old-electron', userDataDir: 'data/profiles/old-electron' };
  const chromiumData = chromiumProfile(store.DATA_DIR, oldChromium.id);
  const electronData = path.join(store.PROFILES_DIR, oldElectron.id);
  for (const folder of [chromiumData, electronData]) {
    fs.mkdirSync(folder, { recursive: true });
    fs.writeFileSync(path.join(folder, 'Local State'), '{}');
  }
  store.saveAll([record, oldChromium, oldElectron]);
  // Force a separate on-disk read, as it happens when an older app is upgraded.
  const { execFileSync } = require('node:child_process');
  const migration = execFileSync(process.execPath, ['-e',
    'const store = require("./src/manager/store"); store.withStoreWrite(store.loadAll).then(items => console.log(JSON.stringify(items.map(item => item.browserCore))))',
  ], { cwd: project, env: process.env, encoding: 'utf8' });
  assert.deepEqual(JSON.parse(migration), ['chromium', 'chromium', 'electron']);
  assert.equal(JSON.parse(fs.readFileSync(path.join(store.DATA_DIR, 'environments.json'), 'utf8'))[2].browserCore, 'electron');

  store.updateSettings({ browserCore: 'electron' });
  const electronRecord = store.addEnvironment({ ...environment, id: 'v30-electron', name: 'v30-electron', remotePort: await freePort() });
  assert.equal(electronRecord.browserCore, 'electron');
  const clone = store.cloneEnvironment(electronRecord.id, 'v30-electron-copy');
  assert.equal(clone.browserCore, 'electron');
  store.updateSettings({ browserCore: 'chromium' });

  try {
    const legacy = await browsers.launch(electronRecord.id, { headless: true });
    assert.equal(legacy.core, 'electron');
    const firstLegacy = await observe(legacy.port, url, true);
    const { screen: legacyScreen, navigator: legacyNavigator, webgl: legacyWebgl } = electronRecord.fp;
    assert.equal(firstLegacy.cores, 7);
    assert.equal(firstLegacy.ua, environment.customUa);
    assert.equal(firstLegacy.memory, legacyNavigator.deviceMemory);
    assert.deepEqual(firstLegacy.screen, { width: legacyScreen.width, height: legacyScreen.height, dpr: legacyScreen.dpr });
    assert.deepEqual(firstLegacy.webgl, legacyWebgl);
    const repeatLegacy = await observe(legacy.port, url);
    assert.ok(repeatLegacy.pixels === firstLegacy.pixels, 'Electron same fingerprint should preserve pixels');
    const changedLegacy = await browsers.randomizeEnvironment(electronRecord.id);
    assert.equal(changedLegacy.hotReloaded, true);
    assert.equal(browsers.getRunningStatus()[electronRecord.id].pid, legacy.pid);
    let updatedLegacy;
    for (let i = 0; i < 32; i++) {
      await delay(200);
      updatedLegacy = await observe(legacy.port, url);
      if (updatedLegacy.cores === changedLegacy.env.fp.navigator.hardwareConcurrency) break;
    }
    assert.equal(updatedLegacy.cores, changedLegacy.env.fp.navigator.hardwareConcurrency);
    assert.equal(updatedLegacy.ua, firstLegacy.ua);
    assert.ok(updatedLegacy.pixels !== firstLegacy.pixels, 'Electron randomization should change Canvas pixels');
    console.log('PASS Electron native CPU, memory, screen, WebGL and Canvas');

    const saved = store.updateEnvironment(electronRecord.id, {
      fp: { ...changedLegacy.env.fp },
      language: 'fr-FR',
      timezone: 'UTC',
      customUa: 'DT-Release-Local-Locale/1.0',
    });
    assert.deepEqual(saved.fp.navigator.languages, ['fr-FR', 'fr']);
    assert.equal(saved.fp.timezone, 'UTC');
    for (let i = 0; i < 32; i++) {
      await delay(200);
      updatedLegacy = await observe(legacy.port, url);
      if (updatedLegacy.ua === saved.customUa && updatedLegacy.timezone === 'UTC' &&
          updatedLegacy.languages[0] === 'fr-FR') break;
    }
    assert.equal(updatedLegacy.ua, saved.customUa);
    assert.deepEqual(updatedLegacy.languages, ['fr-FR', 'fr']);
    assert.equal(updatedLegacy.timezone, 'UTC');
    assert.equal(browsers.getRunningStatus()[electronRecord.id].pid, legacy.pid);
    console.log('PASS Electron runtime applies saved UA/language/timezone without a new fingerprint seed');
    await browsers.stop(electronRecord.id);
    console.log('PASS migration by existing profiles, saved Electron core, legacy hot refresh and UA preservation');

    const current = store.getEnvironment(record.id);
    const nativeFp = {
      ...current.fp, chromiumSeed: 0xffffffff, navigator: { ...current.fp.navigator, hardwareConcurrency: 7 },
    };
    store.updateEnvironment(record.id, { fp: nativeFp });
    store.updateSettings({ browserCore: 'electron' });
    const native = await browsers.launch(record.id, { headless: true });
    assert.equal(native.core, 'chromium');
    const before = await observe(native.port, url);
    assert.equal(before.ua, environment.customUa);
    assert.deepEqual(before.languages, ['en-GB', 'en']);
    assert.equal(before.timezone, 'Asia/Shanghai');
    assert.equal(before.cores, 7);
    assert.equal(chromiumSeed(store.getEnvironment(record.id).fp), 0xffffffff);
    const repeated = await observe(native.port, url);
    assert.ok(repeated.pixels === before.pixels, 'same seed should preserve pixel readback');
    assert.ok(repeated.canvas === before.canvas, 'same seed should preserve PNG output');

    const previousSeed = store.getEnvironment(record.id).fp.seed;
    const previous32 = chromiumSeed(store.getEnvironment(record.id).fp);
    const change = await browsers.randomizeEnvironment(record.id);
    assert.equal(change.restarted, true);
    assert.notEqual(change.env.fp.seed, previousSeed);
    assert.ok(isChromiumSeed(chromiumSeed(change.env.fp)));
    assert.notEqual(chromiumSeed(change.env.fp), previous32);
    const active = browsers.getRunningStatus()[record.id];
    assert.notEqual(active.pid, native.pid);
    const after = await observe(active.port, url);
    assert.equal(after.ua, before.ua);
    assert.equal(after.cores, change.env.fp.navigator.hardwareConcurrency);
    assert.notEqual(after.cores, before.cores);
    assert.match(after.canvas, /^data:image\/png;base64,/);
    assert.notEqual(after.canvas, before.canvas);
    assert.ok(after.pixels !== before.pixels, 'changing the seed should change the pixel readback');
    assert.deepEqual(after.languages, before.languages);
    assert.equal(after.timezone, before.timezone);
    assert.ok(requests.some(request => request.ua === after.ua && request.cookie?.includes('dtV30=works')));

    store.saveAll(store.loadAll().map(item => item.id === electronRecord.id ? { ...item, remotePort: active.port } : item));
    await assert.rejects(browsers.launch(electronRecord.id, { headless: true }), /调试端口已被占用/);
    store.updateEnvironment(electronRecord.id, { remotePort: await freePort() });
    const mixed = await browsers.launch(electronRecord.id, { headless: true });
    const [electronPage, chromiumPage] = await Promise.all([
      observe(mixed.port, url), observe(active.port, url),
    ]);
    assert.equal(mixed.core, 'electron');
    assert.notEqual(mixed.pid, active.pid);
    assert.equal(electronPage.ua, saved.customUa);
    assert.equal(electronPage.languages[0], 'fr-FR');
    assert.equal(chromiumPage.ua, environment.customUa);
    assert.equal(chromiumPage.languages[0], 'en-GB');
    await browsers.stop(electronRecord.id);
    assert.equal(browsers.getRunningStatus()[record.id].pid, active.pid);
    console.log('PASS simultaneous Electron and Chromium retain distinct browser settings and stop independently');
    await browsers.stop(record.id);
    console.log('PASS saved Chromium core despite changed default, Canvas pixel and PNG changes after randomization, CPU/language/timezone, restart and UA preservation');

    store.updateSettings({ browserCore: 'electron' });
    const reverted = await browsers.launch(record.id, { core: 'electron', headless: true });
    assert.equal(reverted.core, 'electron');
    assert.equal((await observe(reverted.port, url)).ua, environment.customUa);
    assert.equal(store.getEnvironment(record.id).browserCore, 'chromium');
    console.log('PASS explicit CLI-style launch override leaves the saved core unchanged');
  } finally {
    await browsers.stopAll();
    await new Promise(resolve => httpServer.close(resolve));
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; })
  .finally(() => fs.rmSync(sandbox, { force: true, recursive: true, maxRetries: 4, retryDelay: 250 }));
