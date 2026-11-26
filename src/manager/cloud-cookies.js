'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawn, execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { setTimeout: delay } = require('node:timers/promises');
const { randomUUID } = require('node:crypto');
const { buildCookieUrl } = require('../shared/cookie-helper');
const run = promisify(execFile);

function isCurrent(cookie) {
  return cookie.session || !(cookie.expirationDate || cookie.expires) ||
    (cookie.expirationDate || cookie.expires) > Date.now() / 1000;
}

async function setElectronCookies(target, cookies) {
  for (const cookie of cookies.filter(isCurrent)) {
    await target.cookies.set({
      url: buildCookieUrl(cookie),
      name: cookie.name,
      value: cookie.value,
      domain: cookie.hostOnly ? undefined : cookie.domain,
      path: cookie.path,
      secure: cookie.secure,
      httpOnly: cookie.httpOnly,
      expirationDate: cookie.session ? undefined : cookie.expirationDate,
      sameSite: cookie.sameSite,
    });
  }
  await target.cookies.flushStore();
}

async function electronCookies(executable, profile, id, staging, cookies) {
  const jobFile = path.join(staging, randomUUID() + '.json');
  const result = jobFile + '.result';
  const entry = __dirname.match(/^(.+?[/\\]app\.asar)(?:[/\\]|$)/i)?.[1] || path.resolve(__dirname, '../../index.js');
  fs.writeFileSync(jobFile, JSON.stringify({ profile, id, result, cookies: cookies?.filter(isCurrent) }), { flag: 'wx' });
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  try {
    await run(executable, [entry, '--dt-cloud-cookie-job=' + jobFile], { env, windowsHide: true, timeout: 60000 });
    const reply = JSON.parse(fs.readFileSync(result, 'utf8'));
    if (!Array.isArray(reply.cookies)) throw new Error('Cookie 读取失败。');
    return reply.cookies;
  } finally {
    fs.rmSync(jobFile, { force: true });
    fs.rmSync(result, { force: true });
  }
}

function browserConnection(address) {
  const socket = new WebSocket(address);
  let sequence = 0;
  const calls = new Map();
  const opened = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('连接 Chromium Cookie 接口超时。')), 3000);
    socket.addEventListener('open', () => { clearTimeout(timer); resolve(); }, { once: true });
    socket.addEventListener('error', () => { clearTimeout(timer); reject(new Error('无法连接 Chromium Cookie 接口。')); }, { once: true });
  });
  socket.addEventListener('message', event => {
    const response = JSON.parse(event.data);
    const pending = calls.get(response.id);
    if (pending) {
      clearTimeout(pending.timer);
      calls.delete(response.id);
      if (response.error) pending.reject(new Error('Chromium 未能完成 ' + pending.method));
      else pending.resolve(response.result);
    }
  });
  return {
    opened,
    close: () => socket.close(),
    send(method, params, sessionId) {
      return new Promise((resolve, reject) => {
        const id = ++sequence;
        const timer = setTimeout(() => {
          calls.delete(id);
          reject(new Error('Chromium Cookie 操作超时。'));
        }, 5000);
        calls.set(id, { method, resolve, reject, timer });
        socket.send(JSON.stringify({ id, method, params, sessionId }));
      });
    },
  };
}

function chromiumCookieParams(cookie) {
  const domain = cookie.domain.replace(/^\./, '');
  const address = domain.includes(':') ? '[' + domain.replace(/^\[|\]$/g, '') + ']' : domain;
  const { name, value, path: cookiePath, secure, httpOnly, sameSite, priority, sourceScheme, sourcePort, partitionKey } = cookie;
  return {
    name, value, path: cookiePath, secure, httpOnly, sameSite, priority, sourceScheme, sourcePort, partitionKey,
    url: (secure ? 'https://' : 'http://') + address + (cookiePath || '/'),
    domain: cookie.domain.startsWith('.') ? cookie.domain : undefined,
    expires: cookie.session ? undefined : cookie.expires,
  };
}

async function chromiumCookies(executable, profile, cookies) {
  const portFile = path.join(profile, 'DevToolsActivePort');
  fs.rmSync(portFile, { force: true });
  const child = spawn(executable, ['--user-data-dir=' + profile, '--headless', '--remote-debugging-port=0',
    '--remote-debugging-address=127.0.0.1', '--disable-background-networking', '--disable-background-mode',
    '--no-first-run', '--no-default-browser-check', '--no-proxy-server', 'about:blank'], {
    windowsHide: true, stdio: 'ignore',
  });
  let launchError;
  child.once('error', error => { launchError = error; });
  const closed = new Promise(resolve => child.once('close', resolve));
  let connection;
  try {
    for (let attempt = 0; attempt < 200; attempt++) {
      if (launchError || child.exitCode !== null) throw new Error('无法启动 Chromium 资料读取进程。');
      if (fs.existsSync(portFile)) {
        const [port, endpoint] = fs.readFileSync(portFile, 'utf8').trim().split(/\r?\n/);
        if (/^\d{1,5}$/.test(port) && /^\/devtools\/browser\/[a-f0-9-]+$/i.test(endpoint)) {
          connection = browserConnection('ws://127.0.0.1:' + port + endpoint);
          await connection.opened;
          break;
        }
      }
      await delay(100);
    }
    if (!connection) throw new Error('Chromium 资料读取进程启动超时。');
    if (cookies) {
      await connection.send('Storage.clearCookies');
      const current = cookies.filter(isCurrent).map(chromiumCookieParams);
      for (let offset = 0; offset < current.length; offset += 200) {
        await connection.send('Storage.setCookies', { cookies: current.slice(offset, offset + 200) });
      }
    }
    const result = await connection.send('Storage.getCookies');
    if (!Array.isArray(result.cookies)) throw new Error('未能读取 Chromium Cookie。');
    if (result.cookies.some(cookie => cookie.partitionKeyOpaque)) throw new Error('Chromium 环境含有无法导出的站点分区 Cookie。');
    return result.cookies;
  } finally {
    if (connection) {
      connection.send('Browser.close').catch(() => {});
      if (!await Promise.race([closed.then(() => true), delay(4000, false, { ref: false })])) child.kill();
      connection.close();
    } else {
      child.kill();
    }
    await closed;
    fs.rmSync(portFile, { force: true });
  }
}

module.exports = { electronCookies, setElectronCookies, chromiumCookies, chromiumCookieParams, browserConnection, isCurrent };
