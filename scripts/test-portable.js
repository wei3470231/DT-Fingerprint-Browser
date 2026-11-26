'use strict';

const assert = require('node:assert/strict');
const { execFile, execFileSync, spawn } = require('node:child_process');
const { promisify } = require('node:util');
const { createHash } = require('node:crypto');
const { setTimeout: delay } = require('node:timers/promises');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { generateFingerprint } = require('../fp-sdk');

const fullInstaller = process.argv.includes('--full');
const packageFile = path.resolve(__dirname, '../dist', fullInstaller
  ? 'DT-Fingerprint-Browser-v3.1-Full-Setup.exe'
  : 'DT-Fingerprint-Browser-v3.1-Portable.zip');
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'dt-portable-v30-'));
const app = path.join(sandbox, 'Portable app');
const data = path.join(app, 'data');
const runtime = path.join(app, 'runtime');
const launcher = path.join(app, 'DT-CLI.exe');
const envId = 'portable-fixture';
const exec = promisify(execFile);
const cleanEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.toLowerCase() !== 'path'));
cleanEnv.PATH = '';
let running = false;

function cli(...args) {
  try {
    return execFileSync(launcher, args, {
      cwd: app, env: cleanEnv, encoding: 'utf8', windowsHide: true, timeout: 900000,
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  } catch (error) {
    throw new Error([error.message, error.stdout, error.stderr].filter(Boolean).join('\n'));
  }
}

function json(...args) {
  const response = JSON.parse(cli(...args, '--json'));
  assert.equal(response.code, 0, response.message);
  return response.data;
}

async function jsonAsync(...args) {
  const { stdout } = await exec(launcher, [...args, '--json'], {
    cwd: app, env: cleanEnv, encoding: 'utf8', windowsHide: true, timeout: 120000,
  });
  const response = JSON.parse(stdout);
  assert.equal(response.code, 0, response.message);
  return response.data;
}

async function warmUpChromium(electron, executable) {
  const env = { ...process.env, DT_APP_ROOT: app };
  delete env.ELECTRON_RUN_AS_NODE;
  const launcher = spawn(path.join(app, 'DT-Fingerprint-Browser.exe'), ['--minimized'], {
    cwd: app, env: { ...cleanEnv, DT_APP_ROOT: app }, windowsHide: true, stdio: 'ignore',
  });
  try {
    const until = Date.now() + 120000;
    while (!fs.existsSync(executable) && Date.now() < until && (launcher.exitCode ?? 0) === 0) await delay(200);
    assert.ok(fs.existsSync(executable), 'The packaged GUI launcher must open and automatically install Chromium');
  } finally {
    await exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      'Get-Process electron -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq $env:DT_PACKAGED_TEST_ELECTRON } | Stop-Process -Force -ErrorAction SilentlyContinue',
    ], { env: { ...env, DT_PACKAGED_TEST_ELECTRON: electron }, windowsHide: true });
  }
}

function cdp(wsUrl, method, params) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(wsUrl);
    const timer = setTimeout(() => {
      socket.close();
      reject(new Error('CDP command did not respond: ' + method));
    }, 2500);
    socket.onopen = () => socket.send(JSON.stringify({
      id: 1, method, params,
    }));
    socket.onmessage = ({ data }) => {
      const response = JSON.parse(data);
      if (response.id !== 1) return;
      clearTimeout(timer);
      socket.close();
      if (response.error) reject(new Error(response.error.message));
      else resolve(response.result);
    };
    socket.onerror = event => {
      clearTimeout(timer);
      reject(new Error(event.message || 'Cannot connect to CDP for ' + method));
    };
  });
}

async function readCanvas(port) {
  const until = Date.now() + 15000;
  while (Date.now() < until) {
    try {
      const target = await fetch('http://127.0.0.1:' + port + '/json/list', {
        signal: AbortSignal.timeout(1500),
      }).then(response => response.json());
      const page = target.find(item => item.url.endsWith('fingerprint-check/index.html'));
      const result = page && await cdp(page.webSocketDebuggerUrl, 'Runtime.evaluate', {
        expression: 'window.fingerprintResult?.canvas', returnByValue: true,
      });
      const canvas = result?.result?.value;
      if (canvas?.status === 'ok') return canvas.data;
    } catch {}
    await delay(200);
  }
  throw new Error('Canvas readback did not complete in the packaged browser');
}

async function freePort() {
  const server = net.createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  await new Promise(resolve => server.close(resolve));
  return port;
}

function extractPackage() {
  if (!fullInstaller) {
    execFileSync('tar.exe', ['-xf', packageFile, '-C', app], { windowsHide: true });
    return;
  }

  const extract = [
    "$ErrorActionPreference = 'Stop'",
    'Add-Type -AssemblyName System.IO.Compression, System.IO.Compression.FileSystem',
    '$setup = [Reflection.Assembly]::LoadFile($env:DT_TEST_SETUP_FILE)',
    "$payload = $setup.GetManifestResourceStream('payload.zip')",
    '$archive = [IO.Compression.ZipArchive]::new($payload, [IO.Compression.ZipArchiveMode]::Read)',
    'try { [IO.Compression.ZipFileExtensions]::ExtractToDirectory($archive, $env:DT_TEST_SETUP_TARGET) }',
    'finally { $archive.Dispose() }',
  ].join('\n');
  execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', extract], {
    env: { ...process.env, DT_TEST_SETUP_FILE: packageFile, DT_TEST_SETUP_TARGET: app },
    windowsHide: true,
  });
}

async function main() {
  fs.mkdirSync(app);
  extractPackage();
  assert.ok(fs.existsSync(launcher));
  assert.ok(fs.existsSync(path.join(app, 'DT-Fingerprint-Browser.exe')));
  assert.ok(fs.existsSync(path.join(app, 'app.asar')));
  assert.ok(fs.existsSync(path.join(app, 'scripts', 'RuntimeTools.exe')));
  assert.ok(fs.existsSync(path.join(app, 'scripts', 'RuntimeTools.exe.config')));
  assert.ok(!fs.existsSync(path.join(app, 'scripts', 'install-core.ps1')));
  assert.ok(!fs.existsSync(path.join(app, 'scripts', 'spawn-browser.ps1')));
  assert.ok(!fs.existsSync(path.join(app, 'fingerprint-test')));
  assert.ok(fs.existsSync(path.join(app, 'scripts', 'ChromiumWindowIcon.exe')));
  assert.ok(fs.readdirSync(path.join(app, 'Fonts')).length);
  assert.ok(fs.existsSync(path.join(runtime, 'cores', 'electron', 'electron.exe')));
  assert.equal(fs.existsSync(path.join(runtime, 'cores', 'chromium', 'chrome.exe')), fullInstaller);

  const port = await freePort();
  fs.mkdirSync(data, { recursive: true });
  assert.equal(json('settings', 'get').browserCore, 'chromium', 'Fresh packages must start with independent settings');
  fs.writeFileSync(path.join(data, 'environments.json'), JSON.stringify([{
    id: envId, name: envId, customUa: 'DT-Portable-Fixture/1.0', browserCore: 'chromium',
    remotePortEnabled: false, remotePort: null, fp: generateFingerprint(),
  }]));

  assert.match(cli('--version'), /^Google Chrome 152\./);
  assert.match(cli('--help'), /旧版直通模式 \(Electron\)/);
  const electron = path.join(runtime, 'cores', 'electron', 'electron.exe');
  const chromium = path.join(runtime, 'cores', 'chromium', 'chrome.exe');
  assert.ok(fs.existsSync(electron));
  assert.match(cli('--product-version'), /^152\./);
  assert.equal(json('list')[0].id, envId);
  assert.equal(json('get', '--id', envId).browserCore, 'chromium');
  assert.ok(json('font', 'status').name);
  assert.ok(json('theme', 'status').managerTheme);
  assert.equal(json('settings', 'get').browserCore, 'chromium');
  const created = json('create', '--name', 'CLI Chromium test', '--core', 'chromium', '--port', String(port));
  const id = created.id;
  assert.equal(created.browserCore, 'chromium');
  assert.throws(() => cli('cdp-url', '--id', id, '--ws'), /尚未运行或未开启 CDP/);
  const proxyArgs = ['set-proxy', '--id', id, '--proxy', 'http://127.0.0.1:9', '--scope', 'rules',
    '--rules', 'target.release.test;*.route.release.test', '--bypass', 'white.target.release.test'];
  const proxy = json(...proxyArgs);
  assert.equal(proxy.enabled, true);
  assert.equal(proxy.scope, 'rules');
  assert.equal(json('get', '--id', id).proxy.bypass, 'white.target.release.test');
  json('set-proxy', '--id', id, '--clear');
  console.log('PASS bundled Electron starts the packaged CLI with empty PATH and without a local ZIP');

  const electronFixture = json('create', '--name', 'Fresh Electron environment', '--core', 'electron',
    '--port', String(await freePort()), '--url', 'about:blank');
  running = true;
  const electronStart = json('start', '--id', electronFixture.id);
  assert.equal(electronStart.core, 'electron');
  assert.match(electronStart.ws, /^ws:\/\/127\.0\.0\.1:/);
  assert.equal(json('status', '--id', electronFixture.id).info.pid, electronStart.pid);
  assert.equal(fs.existsSync(chromium), fullInstaller);
  json('stop', '--id', electronFixture.id);
  running = false;
  console.log('PASS newly created Electron environment opens with empty PATH');

  if (fullInstaller) {
    assert.ok(!fs.existsSync(path.join(app, 'runtime_chromium.zip')));
    assert.ok(!fs.existsSync(path.join(app, 'runtime_electron.zip')));
  } else {
    if (process.env.DT_TEST_CORE_ARCHIVES) {
      fs.copyFileSync(path.join(process.env.DT_TEST_CORE_ARCHIVES, 'runtime_chromium.zip'), path.join(app, 'runtime_chromium.zip'));
    }
    await warmUpChromium(electron, chromium);
    console.log('PASS fresh manager automatically prepared Chromium with empty PATH and native tools');
  }

  const independent = json('create', '--name', 'Parallel Chromium', '--core', 'chromium', '--no-port', '--url', 'about:blank');
  running = true;
  const [started, competing, parallel] = await Promise.all([
    jsonAsync('start', '--id', id, '--headless'),
    jsonAsync('start', '--id', id, '--headless'),
    jsonAsync('start', '--id', independent.id, '--headless'),
  ]);
  assert.equal(started.pid, competing.pid);
  assert.notEqual(started.alreadyRunning, competing.alreadyRunning);
  assert.notEqual(started.pid, parallel.pid);
  assert.equal(json('status', '--id', id).info.pid, started.pid);
  assert.equal(json('status', '--id', independent.id).info.pid, parallel.pid);
  json('stop', '--id', independent.id);
  assert.equal(json('status', '--id', id).info.pid, started.pid);
  console.log('PASS three independent CLI processes, same-env deduplication and separate registry entries');
  assert.equal(started.core, 'chromium');
  if (fullInstaller) console.log('PASS bundled Chromium opens with empty PATH and without a local core ZIP');
  assert.equal(started.port, port);
  assert.match(started.ws, /^ws:\/\/127\.0\.0\.1:/);
  assert.equal(cli('cdp-url', '--id', id, '--ws'), started.ws);
  assert.equal(cli('cdp-url', '--id', id, '--http'), started.http);
  assert.equal(json('status', '--id', id).info.core, 'chromium');
  assert.equal(json('start', '--id', id, '--core', 'electron').alreadyRunning, true);
  assert.throws(() => cli(...proxyArgs, '--json'), /请先停止/);
  const before = await readCanvas(port);
  const unchanged = await readCanvas(port);
  assert.deepEqual(unchanged.pixelHash, before.pixelHash);
  assert.deepEqual(unchanged.pngHash, before.pngHash);
  const changed = json('random-fp', '--id', id);
  assert.equal(changed.restarted, true);
  assert.notEqual(cli('cdp-url', '--id', id, '--ws'), started.ws);
  assert.ok(Number.isInteger(changed.fp.chromiumSeed));
  const after = await readCanvas(port);
  assert.notDeepEqual(after.pixelHash, before.pixelHash);
  assert.notDeepEqual(after.pngHash, before.pngHash);
  json('stop', '--id', id);
  assert.equal(json('status', '--id', id).running, false);

  const legacy = json('start', '--id', id, '--core', 'electron', '--headless');
  assert.equal(legacy.core, 'electron');
  assert.ok(legacy.ws);
  assert.equal(json('get', '--id', id).browserCore, 'chromium');
  json('stop', '--id', id);
  console.log('PASS packaged CLI create, saved/overridden core, CDP, proxy edit guard, randomization and stop');

  if (process.env.DT_TEST_WINDOW_ICON === '1') {
    const branded = json('create', '--name', 'Chromium icon test', '--core', 'chromium',
      '--port', String(await freePort()), '--url', 'about:blank');
    const visible = json('start', '--id', branded.id);
    const checkIcon = count => execFileSync('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-Sta', '-ExecutionPolicy', 'Bypass', '-File',
      path.join(__dirname, 'test-chromium-icon.ps1'), '-BrowserPid', String(visible.pid),
      '-IconPath', path.join(app, 'app.ico'), '-ExpectedWindows', String(count),
    ], { windowsHide: true, stdio: 'inherit' });
    checkIcon(1);
    const profile = createHash('sha256').update(branded.id).digest('hex');
    const directory = path.join(data, 'chromium-profiles', profile);
    await exec(chromium, ['--user-data-dir=' + directory, '--new-window', 'about:blank'], {
      cwd: app, windowsHide: true, timeout: 5000,
    });
    checkIcon(2);
    json('stop', '--id', branded.id);
  }
  running = false;
}

main().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => {
  if (running) {
    try { cli('stop', '--all', '--json'); } catch {}
  }
  fs.rmSync(sandbox, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 });
});
