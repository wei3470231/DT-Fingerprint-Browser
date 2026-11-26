'use strict';

const { fork } = require('node:child_process');
const { createSocks5AuthBridge } = require('../browser/socks5-bridge');

function request(worker, payload) {
  return new Promise((resolve, reject) => {
    function finish(error, value) {
      clearTimeout(timeout);
      worker.off('exit', failed);
      worker.off('disconnect', failed);
      worker.off('error', failed);
      worker.off('message', reply);
      if (error) reject(error);
      else resolve(value);
    }
    const failed = () => finish(new Error('Chromium SOCKS5 认证桥无法启动。'));
    const reply = value => value ? finish(null, value) : failed();
    const timeout = setTimeout(failed, 10000);
    worker.once('exit', failed);
    worker.once('disconnect', failed);
    worker.once('error', failed);
    worker.once('message', reply);
    worker.send(payload, error => { if (error) failed(); });
  });
}

async function startChromiumSocks5(credentials) {
  // Detach from the launcher so a short-lived CLI can exit while the browser is open.
  // Credentials are sent over private IPC instead of putting them on either command line.
  const worker = fork(__filename, [], {
    detached: true,
    execArgv: [],
    windowsHide: true,
    stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
  });
  worker.on('error', () => {});
  const abort = () => worker.kill();
  try {
    const port = await request(worker, credentials);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      throw new Error('Chromium SOCKS5 认证桥未返回有效端口。');
    }
    return {
      port,
      abort,
      async follow(pid) {
        await request(worker, pid);
        worker.disconnect();
        worker.unref();
      },
    };
  } catch (error) {
    abort();
    throw error;
  }
}

const exitBeforeAttach = () => process.exit(0);

async function serve({ host, port, username, password }) {
  const bridge = await createSocks5AuthBridge(host, port, username, password);
  process.once('message', pid => {
    if (!Number.isSafeInteger(pid) || pid <= 0) process.exit(1);
    process.off('disconnect', exitBeforeAttach);
    setInterval(() => {
      try { process.kill(pid, 0); }
      catch (error) { if (error.code !== 'EPERM') process.exit(0); }
    }, 1000);
    process.send(true);
  });
  process.send(bridge.port);
}

if (require.main === module && process.connected) {
  process.once('disconnect', exitBeforeAttach);
  process.once('message', credentials => {
    serve(credentials).catch(() => process.exit(1));
  });
}

module.exports = { startChromiumSocks5 };
