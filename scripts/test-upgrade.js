'use strict';

const assert = require('node:assert/strict');
const { execSync, spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { setTimeout: delay } = require('node:timers/promises');
const { electronPath } = require('./runtime-path');

const project = path.resolve(__dirname, '..');
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'dt-v30-upgrade-test-'));
const install = path.join(sandbox, 'Existing installation');
const launcher = path.join(install, 'DT-Fingerprint-Browser.exe');
const legacy = path.join(install, 'runtime');
const embedded = path.join(legacy, 'resources', 'app.asar');
const rootArchive = path.join(install, 'app.asar');
const result = path.join(install, 'interface.json');

function packProbe(version, hasSelector, archive) {
  const probe = path.join(sandbox, version);
  const markup = '<b id="currentVersionText">' + version + '</b>' + (hasSelector ? '<select id="browserCoreSelect"></select>' : '');
  fs.mkdirSync(probe);
  fs.writeFileSync(path.join(probe, 'package.json'), JSON.stringify({ name: 'dt-upgrade-probe', main: 'main.js' }));
  fs.writeFileSync(path.join(probe, 'main.js'), [
    "const { app, BrowserWindow } = require('electron');",
    "const fs = require('node:fs');",
    "const profile = " + JSON.stringify(path.join(probe, 'profile')) + ";",
    "fs.mkdirSync(profile, { recursive: true });",
    "app.setPath('userData', profile);",
    "app.commandLine.appendSwitch('disable-background-networking');",
    "app.whenReady().then(async () => {",
    "  const win = new BrowserWindow({ show: false });",
    "  await win.loadURL(" + JSON.stringify('data:text/html,' + encodeURIComponent(markup)) + ");",
    "  const ui = await win.webContents.executeJavaScript(" + JSON.stringify("({ version: document.getElementById('currentVersionText').textContent, selector: Boolean(document.getElementById('browserCoreSelect')) })") + ");",
    "  fs.writeFileSync(" + JSON.stringify(result) + ", JSON.stringify(ui));",
    "  app.quit();",
    "}).catch(error => { console.error(error); app.exit(1); });",
  ].join('\n'));
  execSync('npx.cmd -y asar pack "' + probe + '" "' + archive + '"', { windowsHide: true, stdio: 'pipe' });
}

async function readInterface(executable, args) {
  fs.rmSync(result, { force: true });
  const env = { ...process.env, DT_APP_ROOT: install };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(executable, args, { cwd: install, env, stdio: 'ignore', windowsHide: true });
  child.on('error', error => { console.error(error.message); });
  for (let i = 0; i < 100; i++) {
    if (fs.existsSync(result)) {
      const ui = JSON.parse(fs.readFileSync(result, 'utf8'));
      await delay(250);
      return ui;
    }
    await delay(100);
  }
  throw new Error('The launcher did not render either application archive.');
}

async function main() {
  fs.mkdirSync(install);
  fs.copyFileSync(path.join(project, 'dist', 'payload-v3.0', path.basename(launcher)), launcher);
  // Copy from the real directory even when the development runtime is a junction.
  const runtime = fs.realpathSync(path.dirname(electronPath()));
  const filter = source => !['cores', 'resources\\app.asar', 'resources\\app'].includes(path.relative(runtime, source));
  fs.cpSync(runtime, legacy, { recursive: true, filter });
  const fresh = path.join(legacy, 'cores', 'electron');
  fs.cpSync(runtime, fresh, { recursive: true, filter });
  assert.ok(fs.lstatSync(legacy).isDirectory());
  assert.ok(fs.lstatSync(fresh).isDirectory());
  packProbe('v2.6', false, embedded);
  packProbe('v3.0', true, rootArchive);

  assert.deepEqual(await readInterface(path.join(legacy, 'electron.exe'), [rootArchive]), {
    version: 'v2.6', selector: false,
  });
  const previousApp = fs.readFileSync(embedded);
  assert.deepEqual(await readInterface(launcher, ['--minimized']), {
    version: 'v3.0', selector: true,
  });
  assert.deepEqual(fs.readFileSync(embedded), previousApp);
  console.log('PASS overwrite upgrade uses the v3.0 GUI even when the v2.6 embedded app is still present');

  fs.renameSync(embedded, embedded + '.before-v3');
  fs.rmSync(path.join(legacy, 'resources', 'default_app.asar'));
  assert.deepEqual(await readInterface(launcher, ['--minimized']), {
    version: 'v3.0', selector: true,
  });
  console.log('PASS a legacy core without a default bootstrap cannot prevent the v3.0 GUI from opening');
}

main().catch(error => { console.error(error); process.exitCode = 1; })
  .finally(() => fs.rmSync(sandbox, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }));
