'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { createHash } = require('node:crypto');
const { setTimeout: delay } = require('node:timers/promises');
const { DatabaseSync } = require('node:sqlite');
const { electronPath, executableFor } = require('./runtime-path');

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'dt-cloud-test-'));
const app = path.join(sandbox, 'app');
const storage = path.join(sandbox, 'server');
const electron = electronPath();
const chromium = executableFor('chromium');
fs.mkdirSync(path.join(app, 'runtime', 'cores'), { recursive: true });
fs.symlinkSync(path.dirname(chromium), path.join(app, 'runtime', 'cores', 'chromium'), 'junction');
process.env.DT_APP_ROOT = app;
process.env.FP_DEMO_ELECTRON = electron;

const cloud = require('../src/manager/cloud-sync');
const store = require('../src/manager/store');
const { chromiumProfile } = require('../src/manager/chromium');
const { electronCookies, chromiumCookies, browserConnection } = require('../src/manager/cloud-cookies');
const { pack, unpack, recoverInterruptedApply } = require('../src/manager/cloud-files');
const browsers = require('../src/manager/process-manager');

const host = '127.0.0.1';
const server = spawn(process.env.DT_TEST_PYTHON || 'python', [
  path.resolve(__dirname, '../sync-server/server.py'), '--host', host, '--port', '0', '--data-dir', storage,
], { stdio: ['ignore', 'pipe', 'inherit'], windowsHide: true });
const exited = new Promise(resolve => server.once('close', resolve));

function serverAddress() {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Python server did not start')), 10000);
    let output = '';
    server.stdout.on('data', chunk => {
      output += chunk;
      const found = output.match(/listening on 127\.0\.0\.1:(\d+)\r?\n/);
      if (found) { clearTimeout(timer); resolve('http://' + host + ':' + found[1]); }
    });
    server.once('error', error => { clearTimeout(timer); reject(error); });
    server.once('exit', () => { clearTimeout(timer); reject(new Error('Python server exited')); });
  });
}

async function addKey(address, key) {
  const html = await (await fetch(address + '/admin')).text();
  const token = html.match(/name="token" value="([^"]+)"/)[1];
  return fetch(address + '/admin/keys', { method: 'POST', body: new URLSearchParams({ token, key }) });
}

async function checkWebBackup(page, revision, checksum, expectedFilename) {
  const response = await fetch(page + '/' + revision);
  assert.equal(response.status, 200);
  const disposition = response.headers.get('content-disposition');
  assert.match(disposition, /^attachment; .*filename\*=UTF-8''/);
  assert.match(decodeURIComponent(disposition), expectedFilename);
  const bytes = Buffer.from(await response.arrayBuffer());
  assert.equal(Number(response.headers.get('content-length')), bytes.length);
  assert.equal(createHash('sha256').update(bytes).digest('hex'), checksum);
}

async function main() {
  const address = await serverAddress();
  const first = cloud.normalizeConnection({ address, key: 'team-alpha' });
  const second = cloud.normalizeConnection({ address, key: 'team-beta' });
  assert.equal(cloud.normalizeConnection({ address: host, key: first.key }).address, 'http://127.0.0.1:55550');
  assert.equal(cloud.normalizeConnection({ address: '[::1]', key: first.key }).address, 'http://[::1]:55550');
  assert.throws(() => cloud.normalizeConnection({ address, key: '../other' }));
  assert.equal((await addKey(address, 'con')).status, 400);
  assert.equal((await addKey(address, first.key)).status, 201);
  assert.equal((await addKey(address, second.key)).status, 201);
  assert.equal((await addKey(address, second.key)).status, 409);
  await assert.rejects(cloud.query({ address, key: 'no-such-key' }), /密钥无效/);

  const electronRecord = store.createRecord({ id: 'cloud-electron', name: 'Electron fixture', browserCore: 'electron', remotePort: 31371 });
  const chromiumRecord = store.createRecord({ id: 'cloud-chromium', name: 'Chromium fixture', browserCore: 'chromium', remotePort: 31372 });
  const electronData = path.join(store.PROFILES_DIR, electronRecord.id);
  const nativeData = chromiumProfile(store.DATA_DIR, chromiumRecord.id);
  const expiry = Math.floor(Date.now() / 1000) + 86400;
  const example = { name: 'sync-fixture', value: 'only-a-mock', domain: 'fixture.test', path: '/',
    secure: true, httpOnly: true, session: false, hostOnly: true };
  fs.mkdirSync(electronData, { recursive: true });
  fs.mkdirSync(nativeData, { recursive: true });
  await electronCookies(electron, electronData, electronRecord.id, sandbox,
    [{ ...example, expirationDate: expiry, sameSite: 'strict' }]);
  await chromiumCookies(chromium, nativeData, [{ ...example, expires: expiry, sameSite: 'Lax' }]);
  fs.writeFileSync(path.join(electronData, 'cloud-history.jsonl'), '{"url":"https://fixture.test/history"}\n');
  const website = path.join(nativeData, 'Default', 'Local Storage', 'fixture.txt');
  fs.mkdirSync(path.dirname(website), { recursive: true });
  fs.writeFileSync(website, 'fixture-local-storage');
  const cache = path.join(nativeData, 'Default', 'Cache', 'fixture.txt');
  fs.mkdirSync(path.dirname(cache), { recursive: true });
  fs.writeFileSync(cache, 'fixture-cache');
  await store.withStoreWrite(() => {
    store.saveAll([electronRecord, chromiumRecord]);
    store.updateSettings({ cloudSync: { address, key: 'device-private' }, browserTheme: 'dark' });
    store.saveBookmarks([{ id: 'cloud-bookmark', title: 'Fixture', url: 'https://fixture.test/' }]);
  });
  const historyUrl = address + '/admin';
  const visit = await browsers.launch(chromiumRecord.id, { headless: true, url: historyUrl });
  try {
    for (let attempt = 0; attempt < 60; attempt++) {
      const targets = await (await fetch(visit.http + '/json/list')).json();
      if (targets.some(target => target.type === 'page' && target.url === historyUrl)) break;
      await delay(100);
    }
  } finally { await browsers.stop(chromiumRecord.id); }
  function chromiumVisitRecorded() {
    const database = new DatabaseSync(path.join(nativeData, 'Default', 'History'), { readOnly: true });
    try { return Boolean(database.prepare('SELECT 1 FROM urls WHERE url = ?').get(historyUrl)); }
    finally { database.close(); }
  }
  assert.ok(chromiumVisitRecorded(), 'Chromium must persist the fixture visit');
  const sessionCookie = { ...example, name: 'sync-session', session: true };
  for (const folder of [electronData, nativeData]) {
    fs.writeFileSync(path.join(folder, 'cloud-session-cookies.json'), JSON.stringify([sessionCookie]));
  }

  const max = (await cloud.query(first)).maxBytes;
  assert.equal(await cloud.upload(first, 'none', false, max, async () => false), null);
  assert.equal((await cloud.query(first)).snapshots.length, 0);
  const snapshot = await cloud.upload(first, 'none', true, max);
  assert.equal(snapshot.environmentCount, 2);
  assert.equal((await cloud.query(second)).snapshots.length, 0);
  assert.equal((await fetch(address + '/api/v1/snapshots/' + snapshot.revision, {
    headers: { 'X-DT-Sync-Key': second.key },
  })).status, 404);
  assert.deepEqual(fs.readdirSync(path.join(storage, first.key)), [snapshot.revision + '.dt-sync.gz']);
  console.log('PASS administrator keys, upload cancellation, key isolation and per-key storage');

  await store.withStoreWrite(() => {
    store.saveAll([]);
    store.updateSettings({ cloudSync: first, browserTheme: 'blue', autoStart: true });
    store.saveBookmarks([]);
  });
  await assert.rejects(cloud.download(first, { ...snapshot, sha256: '0'.repeat(64) }), /校验失败/);
  assert.deepEqual(store.loadAll(), []);
  const previous = cloud.listBackups()[0];
  const receipt = await cloud.download(first, snapshot);
  assert.ok(fs.existsSync(receipt.backup));
  assert.equal(store.loadAll().length, 2);
  assert.deepEqual(store.loadAll().map(env => env.fp), [electronRecord.fp, chromiumRecord.fp]);
  assert.equal(store.getSettings().cloudSync.key, first.key);
  assert.equal(store.getSettings().autoStart, true);
  assert.equal(store.getSettings().browserTheme, 'dark');
  assert.equal(store.loadBookmarks()[0].id, 'cloud-bookmark');
  assert.equal(fs.readFileSync(website, 'utf8'), 'fixture-local-storage');
  assert.ok(!fs.existsSync(cache));
  assert.match(fs.readFileSync(path.join(electronData, 'cloud-history.jsonl'), 'utf8'), /fixture.test\/history/);
  assert.ok(chromiumVisitRecorded(), 'Chromium history must survive downloading a snapshot');
  assert.ok((await electronCookies(electron, electronData, electronRecord.id, sandbox)).some(cookie => cookie.value === example.value));
  assert.ok((await chromiumCookies(chromium, nativeData)).some(cookie => cookie.value === example.value));
  for (const record of [electronRecord, chromiumRecord]) {
    const running = await browsers.launch(record.id, { headless: true, url: 'about:blank' });
    try {
      const profile = record.browserCore === 'electron' ? electronData : nativeData;
      const pending = path.join(profile, 'cloud-session-cookies.json');
      let endpoint = record.browserCore === 'chromium' ? running.ws : null;
      for (let attempt = 0; attempt < 60 && (!endpoint || fs.existsSync(pending)); attempt++) {
        await delay(100);
        if (record.browserCore === 'electron') {
          const targets = await (await fetch('http://127.0.0.1:' + running.port + '/json/list')).json();
          endpoint = targets.find(page => page.type === 'page' && page.url === 'about:blank')?.webSocketDebuggerUrl;
        }
      }
      assert.ok(endpoint && !fs.existsSync(pending), record.browserCore + ' session Cookie was not restored');
      const connection = browserConnection(endpoint);
      try {
        await connection.opened;
        const result = record.browserCore === 'chromium' ? await connection.send('Storage.getCookies')
          : await connection.send('Network.getCookies', { urls: ['https://fixture.test/'] });
        assert.ok(result.cookies.some(cookie => cookie.name === sessionCookie.name && cookie.value === sessionCookie.value));
      } finally { connection.close(); }
    } finally { await browsers.stop(record.id); }
  }
  console.log('PASS both cores restore session Cookies before first navigation');
  const restored = await cloud.restoreBackup(previous);
  assert.ok(fs.existsSync(restored.backup));
  assert.deepEqual(store.loadAll(), []);
  console.log('PASS verified download, rollback backup, portable Cookie restoration in both cores and optional site data');

  const archive = path.join(sandbox, 'invalid.dt-sync.gz');
  const packageRoot = path.join(sandbox, 'broken');
  fs.mkdirSync(packageRoot);
  fs.writeFileSync(path.join(packageRoot, 'unexpected.txt'), 'unexpected');
  await pack(packageRoot, archive, { websiteData: false, environmentCount: 0 });
  await assert.rejects(unpack(archive, packageRoot), /文件清单无效/);
  const bytes = fs.readFileSync(path.join(storage, first.key, snapshot.revision + '.dt-sync.gz'));
  const headers = {
    'X-DT-Sync-Key': first.key, 'X-DT-Expected-Revision': 'none',
    'X-DT-SHA256': createHash('sha256').update(bytes).digest('hex'),
    'X-DT-Environment-Count': '2', 'X-DT-Website-Data': '1',
  };
  const send = () => fetch(address + '/api/v1/snapshots', { method: 'PUT', headers, body: bytes });
  assert.equal((await send()).status, 409);
  let newest = snapshot;
  for (let index = 0; index < 4; index++) {
    headers['X-DT-Expected-Revision'] = newest.revision;
    const reply = await send();
    assert.equal(reply.status, 201);
    newest = (await reply.json()).snapshot;
  }
  const { snapshots } = await cloud.query(first);
  assert.equal(snapshots.length, 4);
  assert.equal(snapshots[0].revision, newest.revision);
  assert.ok(!snapshots.some(item => item.revision === snapshot.revision));
  assert.equal(fs.readdirSync(path.join(storage, first.key)).length, 4);
  const recovery = path.join(store.DATA_DIR, '.cloud-work-' + '9'.repeat(32));
  const live = path.join(store.DATA_DIR, 'environments.json');
  const saved = fs.readFileSync(live, 'utf8');
  fs.mkdirSync(path.join(recovery, 'previous'), { recursive: true });
  fs.renameSync(live, path.join(recovery, 'previous', 'environments.json'));
  fs.writeFileSync(live, '["incomplete-apply"]');
  fs.writeFileSync(path.join(store.DATA_DIR, '.cloud-apply.json'),
    JSON.stringify({ stage: path.basename(recovery), previous: ['environments.json', 'settings.json',
      'bookmarks.json', 'environments.bak.json', 'settings.bak.json', 'profiles'] }));
  recoverInterruptedApply(store.DATA_DIR);
  assert.equal(fs.readFileSync(live, 'utf8'), saved);
  console.log('PASS stale upload rejection, four retained cloud versions and archive path validation');

  const admin = key => address + '/admin/keys/' + key + '/backups';
  const homePage = await (await fetch(address + '/admin')).text();
  assert.ok(homePage.includes('/admin/keys/' + first.key + '/backups'));
  assert.ok(homePage.includes('/admin/keys/' + second.key + '/backups'));
  const legacyPage = await (await fetch(admin(first.key))).text();
  assert.match(legacyPage, /整套备份/);
  assert.match(legacyPage, /2 个环境/);
  assert.match(legacyPage, /Electron fixture/);
  assert.match(legacyPage, /Chromium fixture/);
  await checkWebBackup(admin(first.key), newest.revision, newest.sha256, /整套备份.*\.dt-sync\.gz/);
  const emptyPage = await (await fetch(admin(second.key))).text();
  assert.match(emptyPage, /暂无备份/);
  assert.doesNotMatch(emptyPage, /Electron fixture|Chromium fixture/);
  assert.equal((await fetch(admin('no-such-key'))).status, 404);
  assert.equal((await fetch(admin(second.key) + '/' + newest.revision)).status, 404);
  const cloudLegacy = (await cloud.listEnvironments(first)).environments;
  assert.equal(cloudLegacy.length, 8);
  assert.equal((await cloud.listEnvironments(second)).environments.length, 0);
  const urls = [address + '/admin?dt-sync-tab=first', address + '/admin?dt-sync-tab=second'];
  chromiumRecord.group = 'Chromium QA';
  electronRecord.group = 'Electron QA';
  await store.withStoreWrite(() => store.saveAll([chromiumRecord, electronRecord]));
  const source = await browsers.launch(chromiumRecord.id, { url: urls[0] });
  const sessionDir = path.join(nativeData, 'Default', 'Sessions');
  try {
    const connection = browserConnection(source.ws);
    try {
      await connection.opened;
      await connection.send('Target.createTarget', { url: urls[1] });
      await waitForTabs(connection, urls);
    } finally { connection.close(); }
  } finally { await browsers.stop(chromiumRecord.id); }
  const sourceSessions = () => Object.fromEntries(fs.readdirSync(sessionDir).sort()
    .map(name => [name, createHash('sha256').update(fs.readFileSync(path.join(sessionDir, name))).digest('hex')]));
  const sessionsBefore = sourceSessions();
  assert.ok(Object.keys(sessionsBefore).some(name => name.startsWith('Session_')));
  assert.ok(fs.readdirSync(sessionDir).some(name => name.startsWith('Session_') &&
    urls.every(url => fs.readFileSync(path.join(sessionDir, name)).includes(url))),
  'Chromium must save both open pages in its native session file');
  fs.writeFileSync(path.join(nativeData, 'cloud-session-cookies.json'), JSON.stringify([sessionCookie]));
  assert.deepEqual((await cloud.uploadSelection(first, { ids: [chromiumRecord.id] })).uploaded, [chromiumRecord.name]);
  assert.deepEqual(sourceSessions(), sessionsBefore, 'upload must leave the original Chromium session untouched');
  assert.deepEqual((await cloud.uploadSelection(first, { group: 'Electron QA' })).uploaded, [electronRecord.name]);
  const select = (await cloud.listEnvironments(first)).environments.find(env => env.group === 'Chromium QA');
  assert.ok(select && select.snapshot.environmentCount === 1);
  assert.equal((await cloud.query(first)).snapshots.length, 4, 'selective uploads must keep legacy revisions');
  const allBackups = cloud.listBackups();
  const uploadPort = chromiumRecord.remotePort;
  const target = store.createRecord({ id: 'device-chromium', name: chromiumRecord.name,
    browserCore: 'chromium', remotePort: 31377 });
  const other = store.createRecord({ id: chromiumRecord.id, name: 'Unrelated environment',
    browserCore: 'electron', remotePort: uploadPort });
  await store.withStoreWrite(() => store.saveAll([target, other]));
  fs.mkdirSync(path.join(store.PROFILES_DIR, other.id), { recursive: true });
  const sentinel = path.join(store.PROFILES_DIR, other.id, 'keep.txt');
  fs.writeFileSync(sentinel, 'unrelated');
  const identity = { id: select.id, revision: select.snapshot.revision };
  assert.equal(await cloud.syncEnvironment(first, identity, async () => false), null);
  let confirmations = 0;
  const synced = await cloud.syncEnvironment(first, identity, async record => {
    confirmations++;
    assert.equal(record.id, target.id);
    return true;
  });
  assert.equal(confirmations, 1);
  assert.equal(synced.replaced, true);
  assert.ok(synced.adjustedPort && synced.adjustedPort !== uploadPort);
  assert.equal(store.getEnvironment(target.id).group, 'Chromium QA');
  assert.deepEqual(store.getEnvironment(target.id).fp, chromiumRecord.fp);
  assert.equal(store.getEnvironment(other.id).remotePort, uploadPort);
  assert.equal(fs.readFileSync(sentinel, 'utf8'), 'unrelated');
  assert.deepEqual(cloud.listBackups(), allBackups, 'sync must not create an automatic local backup');
  const targetProfile = chromiumProfile(store.DATA_DIR, target.id);
  const targetMarker = path.join(targetProfile, 'cloud-restore-tabs');
  assert.ok(fs.existsSync(targetMarker));
  const reloaded = await browsers.launch(target.id);
  try {
    const connection = browserConnection(reloaded.ws);
    try {
      await connection.opened;
      await waitForTabs(connection, urls);
      const { cookies } = await connection.send('Storage.getCookies');
      assert.ok(cookies.some(cookie => cookie.name === sessionCookie.name));
    } finally { connection.close(); }
    assert.ok(!fs.existsSync(targetMarker));
  } finally { await browsers.stop(target.id); }
  const groupBackup = (await cloud.listEnvironments(first)).environments.find(env => env.group === 'Electron QA');
  const added = await cloud.syncEnvironment(first, { id: groupBackup.id, revision: groupBackup.snapshot.revision },
    () => assert.fail('adding a missing environment should not request overwrite confirmation'));
  assert.equal(added.replaced, false);
  const exported = path.join(sandbox, 'manual.dt-sync.gz');
  assert.equal((await cloud.exportFile(exported)).count, 3);
  assert.equal((await cloud.inspectFile(exported)).length, 3);
  const oldFile = path.join(storage, first.key, newest.revision + '.dt-sync.gz');
  assert.equal((await cloud.inspectFile(oldFile)).length, 2);
  const manual = await cloud.restoreFile(oldFile, electronRecord.id, async () => true);
  assert.equal(manual.replaced, true);
  assert.equal(store.loadAll().length, 3);
  assert.equal(fs.readFileSync(sentinel, 'utf8'), 'unrelated');
  assert.deepEqual(cloud.listBackups(), allBackups);
  console.log('PASS selective and group upload, legacy index, overwrite/add, portable backup and actual Chromium tab restore');

  const record = store.createRecord({ name: '环境 <QA>', group: '测试 & 分组', remotePortEnabled: false });
  await store.withStoreWrite(() => store.saveAll([...store.loadAll(), record]));
  for (let i = 0; i < 5; i++) {
    assert.deepEqual((await cloud.uploadSelection(first, { ids: [record.id] })).uploaded, [record.name]);
  }
  const afterRetention = (await cloud.listEnvironments(first)).environments;
  assert.equal(afterRetention.filter(env => env.id === record.id).length, 4);
  assert.ok(afterRetention.some(env => env.snapshot.revision === select.snapshot.revision));
  assert.ok(afterRetention.some(env => env.snapshot.revision === groupBackup.snapshot.revision));
  assert.equal((await cloud.listEnvironments(second)).environments.length, 0);
  console.log('PASS selective revision retention is isolated by environment and key');
  const selectivePage = await (await fetch(admin(first.key))).text();
  assert.match(selectivePage, /Chromium QA/);
  assert.match(selectivePage, /环境 &lt;QA&gt;/);
  assert.match(selectivePage, /测试 &amp; 分组/);
  assert.doesNotMatch(selectivePage, /环境 <QA>/);
  const latest = afterRetention.find(env => env.id === record.id).snapshot;
  assert.ok(selectivePage.includes('/admin/keys/' + first.key + '/backups/' + latest.revision));
  await checkWebBackup(admin(first.key), latest.revision, latest.sha256, /环境 _QA_.*\.dt-sync\.gz/);
  const missingRevision = '0'.repeat(32);
  assert.equal((await fetch(admin(first.key) + '/' + missingRevision)).status, 404);
  console.log('PASS per-key web listings and attachment downloads preserve both archive formats');
}

async function waitForTabs(connection, urls) {
  let pages;
  for (let attempt = 0; attempt < 80; attempt++) {
    const { targetInfos } = await connection.send('Target.getTargets');
    pages = targetInfos.filter(target => target.type === 'page').map(target => target.url);
    if (urls.every(url => pages.includes(url))) return;
    await delay(100);
  }
  assert.fail('Chromium session pages missing: ' + JSON.stringify({ expected: urls, pages }));
}

main().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => {
  server.kill();
  await exited;
  fs.rmSync(sandbox, { recursive: true, force: true, maxRetries: 10, retryDelay: 250 });
});
