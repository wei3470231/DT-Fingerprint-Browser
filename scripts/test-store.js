'use strict';

const assert = require('node:assert/strict');
const { execFile } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { promisify } = require('node:util');

const run = promisify(execFile);
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dt-store-test-'));
const data = path.join(root, 'data');
const config = path.join(data, 'environments.json');
const backup = path.join(data, 'environments.bak.json');
const cli = path.resolve(__dirname, '..', 'cli.js');
const env = { ...process.env, DT_APP_ROOT: root };

async function command(...args) {
  const { stdout } = await run(process.execPath, [cli, ...args, '--json'], { env, timeout: 30000 });
  return JSON.parse(stdout);
}

async function main() {
  fs.mkdirSync(data);
  fs.writeFileSync(config, '[]');
  fs.writeFileSync(backup, '[{"id":"old","name":"Archived environment"}]');
  const listed = await command('list');
  assert.equal(listed.count, 0, 'An empty environment list must not trigger recovery');

  const created = await Promise.all(Array.from({ length: 10 }, (_, index) =>
    command('create', '--name', 'Fixture ' + index)));
  assert.equal(new Set(created.map(result => result.data.remotePort)).size, created.length);
  assert.equal((await command('list')).count, created.length, 'Concurrent saves must keep every environment');
  await assert.rejects(command('create', '--name', 'Duplicate port', '--port', String(created[0].data.remotePort)));

  const bookmark = await Promise.all(Array.from({ length: 5 }, (_, index) =>
    command('bookmark', 'add', '--title', 'Fixture ' + index, '--url', 'https://fixture' + index + '.test')));
  const bookmarked = await command('bookmark', 'list');
  assert.ok(bookmark.every(result => bookmarked.data.some(item => item.id === result.data.id)));

  const removed = await command('batch-delete', '--ids', created.map(result => result.data.id).join(','));
  assert.equal(removed.deletedCount, created.length);
  assert.equal((await command('list')).count, 0, 'Deleted environments must stay deleted');
  assert.deepEqual(JSON.parse(fs.readFileSync(backup, 'utf8')), []);
  console.log('PASS concurrent CLI saves, unique ports, bookmarks and permanent deletion of the last environment');
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
}).finally(() => fs.rmSync(root, { recursive: true, force: true }));
