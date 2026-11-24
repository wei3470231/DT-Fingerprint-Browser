'use strict';

const { createHash } = require('node:crypto');
const net = require('node:net');
const fs = require('node:fs');
const { setTimeout: delay } = require('node:timers/promises');

async function withProcessLock(directory, key, operation) {
  const root = fs.realpathSync.native(directory).toLowerCase();
  const hash = createHash('sha256').update(root + '\0' + key).digest('hex');
  const address = '\\\\.\\pipe\\dt-fingerprint-lock-' + hash;
  const deadline = Date.now() + 30 * 60 * 1000;

  // Windows releases the pipe name when its owner exits, including after a crash.
  for (;;) {
    const server = net.createServer(socket => socket.destroy());
    try {
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(address, resolve);
      });
    } catch (error) {
      if (error.code !== 'EADDRINUSE') throw error;
      if (Date.now() >= deadline) throw new Error('等待其他窗口操作完成超时，请重试。');
      await delay(100);
      continue;
    }

    try {
      return await operation();
    } finally {
      await new Promise(resolve => server.close(resolve));
    }
  }
}

module.exports = { withProcessLock };
