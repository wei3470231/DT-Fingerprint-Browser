'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { createServer } = require('node:net');
const { Readable } = require('node:stream');
const { setTimeout: delay } = require('node:timers/promises');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dt-download-test-'));
process.env.DT_APP_ROOT = root;
const app = process.env.DT_TEST_CLOUD_ASAR || path.resolve(__dirname, '..');
const store = require(path.join(app, 'src/manager/store'));
const cloud = require(path.join(app, 'src/manager/cloud-sync'));
const { pack } = require(path.join(app, 'src/manager/cloud-files'));

// Allow the connection to close while a web-stream consumer is waiting to read.
const fromWeb = Readable.fromWeb;
Readable.fromWeb = stream => Readable.from((async function* () {
  await delay(250);
  yield* fromWeb(stream);
})());

async function serve(headers, body, download) {
  const server = createServer(socket => socket.once('data', () => {
    socket.write('HTTP/1.1 ' + headers + '\r\nConnection: close\r\n\r\n');
    socket.write(body);
    setTimeout(() => socket.end(), 0);
  }));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    return await download({ address: 'http://127.0.0.1:' + server.address().port, key: 'fixture-key' });
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
}

async function main() {
  await store.withStoreWrite(() => store.saveAll([]));
  const env = store.createRecord({
    id: 'download-fixture', name: 'Recovery fixture', browserCore: 'chromium', remotePortEnabled: false,
  });
  const fixture = path.join(root, 'fixture');
  fs.mkdirSync(fixture);
  for (const [file, value] of Object.entries({
    'environments.json': [env],
    'settings.json': {},
    'bookmarks.json': [],
  })) fs.writeFileSync(path.join(fixture, file), JSON.stringify(value));
  const packed = path.join(root, 'fixture.dt-sync.gz');
  await pack(fixture, packed, { environmentCount: 1, websiteData: false });
  // Padding is valid after a gzip member and makes the response size independent of the fixture JSON.
  const body = Buffer.alloc(16 * 1024);
  fs.readFileSync(packed).copy(body);
  const snapshot = {
    revision: '1'.repeat(32), sha256: createHash('sha256').update(body).digest('hex'),
    size: body.length, environmentCount: 1, websiteData: false, createdAt: new Date().toISOString(),
  };
  const restored = await serve('200 OK', body, config => cloud.download(config, snapshot));
  assert.deepEqual(store.loadAll(), [env]);
  assert.ok(fs.existsSync(restored.backup));
  console.log('PASS a complete response framed by socket close restores the snapshot');

  const truncated = body.subarray(0, body.length - 16);
  const before = cloud.listBackups().length;
  await assert.rejects(
    serve('200 OK\r\nContent-Length: ' + body.length, truncated, config => cloud.download(config, snapshot)),
    /云同步下载连接中断.*[\s\S]*已保留本地备份/,
  );
  assert.deepEqual(store.loadAll(), [env]);
  assert.equal(cloud.listBackups().length, before + 1);
  console.log('PASS an interrupted response leaves current data and its backup intact');

  const missing = Buffer.from(JSON.stringify({ error: '未找到此快照。' }));
  await assert.rejects(
    serve('404 Not Found\r\nContent-Length: ' + missing.length, missing, config => cloud.download(config, snapshot)),
    /未找到此快照.*[\s\S]*已保留本地备份/,
  );
  assert.deepEqual(store.loadAll(), [env]);
  console.log('PASS an unavailable snapshot preserves the server message and current data');
}

main().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => {
  Readable.fromWeb = fromWeb;
  await fs.promises.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});
