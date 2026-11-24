'use strict';

// Run with Node.js 22+ after installing the Chromium core in the workspace.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { setTimeout: delay } = require('node:timers/promises');
const { executableFor } = require('./runtime-path');

const project = path.resolve(__dirname, '..');
const chromium = executableFor('chromium', project);
assert.ok(fs.existsSync(chromium), 'The installed Chromium core is required for this offline test');

const tempRoot = fs.realpathSync(os.tmpdir());
const sandbox = fs.mkdtempSync(path.join(tempRoot, 'dt-chromium-proxy-'));
const junction = path.join(sandbox, 'runtime', 'cores', 'chromium');
fs.mkdirSync(path.dirname(junction), { recursive: true });
fs.symlinkSync(path.dirname(chromium), junction, 'junction');
process.env.DT_APP_ROOT = sandbox;

const store = require('../src/manager/store');
const browsers = require('../src/manager/process-manager');

const listen = server => new Promise((resolve, reject) => {
  server.once('error', reject);
  server.listen(0, '127.0.0.1', () => resolve(server.address().port));
});
const close = server => new Promise(resolve => {
  server.close(resolve);
  server.closeAllConnections?.();
});

async function freePort() {
  const server = http.createServer();
  const port = await listen(server);
  await close(server);
  return port;
}

async function openPage(port) {
  const targets = await fetch('http://127.0.0.1:' + port + '/json/list', {
    signal: AbortSignal.timeout(3000),
  }).then(response => response.json());
  const target = targets.find(page => page.type === 'page');
  assert.ok(target?.webSocketDebuggerUrl, 'No CDP page found');
  const socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.close();
      reject(new Error('Timed out connecting to CDP'));
    }, 4000);
    socket.addEventListener('open', () => { clearTimeout(timer); resolve(); }, { once: true });
    socket.addEventListener('error', () => {
      clearTimeout(timer);
      reject(new Error('Failed connecting to CDP'));
    }, { once: true });
  });
  let nextId = 0;
  const pending = new Map();
  socket.onmessage = ({ data }) => {
    const message = JSON.parse(data);
    const callback = pending.get(message.id);
    if (callback) callback(message);
  };
  return {
    close() { socket.close(); },
    send(method, params) {
      return new Promise((resolve, reject) => {
        const id = ++nextId;
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error('Timed out waiting for CDP ' + method));
        }, 7000);
        pending.set(id, message => {
          clearTimeout(timer);
          pending.delete(id);
          if (message.error) reject(new Error(JSON.stringify(message.error)));
          else resolve(message.result);
        });
        socket.send(JSON.stringify({ id, method, params }));
      });
    },
  };
}

async function navigate(page, url, expected) {
  const navigation = await page.send('Page.navigate', { url });
  assert.equal(navigation.errorText, undefined, url + ' should load');
  let received;
  const deadline = Date.now() + 5000;
  do {
    try {
      const { result } = await page.send('Runtime.evaluate', {
        expression: 'document.body?.textContent.trim()',
        returnByValue: true,
      });
      received = result.value;
      if (received === expected) return;
    } catch {}
    await delay(75);
  } while (Date.now() < deadline);
  throw new Error(url + ' did not return ' + expected + '; received ' + JSON.stringify(received));
}

function createSocksProxy(host, port, sockets, hits) {
  return net.createServer(socket => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
    socket.on('error', () => {});
    let buffer = Buffer.alloc(0);
    let stage = 'greeting';
    socket.on('data', chunk => {
      buffer = Buffer.concat([buffer, chunk]);
      if (stage === 'greeting') {
        if (buffer.length < 2 || buffer.length < 2 + buffer[1]) return;
        const methods = buffer.subarray(2, 2 + buffer[1]);
        if (buffer[0] !== 5 || !methods.includes(0)) return socket.destroy();
        buffer = buffer.subarray(2 + methods.length);
        socket.write(Buffer.from([5, 0]));
        stage = 'connect';
      }

      if (stage === 'connect') {
        if (buffer.length < 5) return;
        // Chromium supplies the destination as a domain name for SOCKS5.
        if (buffer[0] !== 5 || buffer[1] !== 1 || buffer[2] !== 0 || buffer[3] !== 3) {
          return socket.destroy();
        }
        const domainEnd = 5 + buffer[4];
        if (buffer.length < domainEnd + 2) return;
        const requestedHost = buffer.toString('ascii', 5, domainEnd);
        const requestedPort = buffer.readUInt16BE(domainEnd);
        if (requestedHost !== host || requestedPort !== port) return socket.destroy();
        hits.push(requestedHost + ':' + requestedPort);
        buffer = buffer.subarray(domainEnd + 2);
        socket.write(Buffer.from([5, 0, 0, 1, 127, 0, 0, 1, 0, 0]));
        stage = 'http';
      }

      if (stage !== 'http' || buffer.indexOf('\r\n\r\n') === -1) return;
      const [method, route] = buffer.toString('latin1').split(' ', 2);
      if (method !== 'GET' || !route?.startsWith('/')) return socket.destroy();
      const body = 'socks:' + route;
      stage = 'done';
      socket.end('HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\n'
        + 'Connection: close\r\nContent-Length: ' + Buffer.byteLength(body) + '\r\n\r\n' + body);
    });
  });
}

async function main() {
  const originHits = [];
  const proxyHits = [];
  const connectHits = [];
  const socksHits = [];
  const socksSockets = new Set();
  const origin = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://' + req.headers.host);
    originHits.push(url.pathname);
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.end('direct:' + url.pathname);
  });
  const proxy = http.createServer((req, res) => {
    const url = URL.parse(req.url);
    if (!url?.hostname.endsWith('.release.test')) {
      res.writeHead(403).end();
      return;
    }
    proxyHits.push(url.pathname);
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.end('proxy:' + url.pathname);
  });
  // The mock proxy never forwards requests. Chromium cannot resolve external hosts.
  proxy.on('connect', (req, socket) => {
    connectHits.push(req.url);
    socket.on('error', () => {});
    socket.end('HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\nConnection: close\r\n\r\n');
  });
  let unexpectedTlsConnections = 0;
  const tlsProbe = net.createServer(socket => {
    unexpectedTlsConnections++;
    socket.destroy();
  });

  let page;
  let socks;
  try {
    const originPort = await listen(origin);
    const proxyPort = await listen(proxy);
    const tlsProbePort = await listen(tlsProbe);
    socks = createSocksProxy('target.release.test', originPort, socksSockets, socksHits);
    const socksPort = await listen(socks);
    const debugPort = await freePort();
    const id = 'chromium-routing';
    const options = {
      headless: true,
      args: '--disable-background-networking --disable-component-update --disable-domain-reliability --disable-sync --no-pings '
        + '--host-resolver-rules="MAP *.release.test 127.0.0.1, EXCLUDE 127.0.0.1, MAP * ~NOTFOUND"',
    };
    const config = {
      enabled: true, host: '127.0.0.1', port: proxyPort, type: 'http',
      scope: 'rules', rules: 'target.release.test;white.target.release.test;*.wild.release.test',
      bypass: 'white.target.release.test',
    };
    store.saveAll([store.createRecord({
      id, name: id, url: 'about:blank', remotePortEnabled: true, remotePort: debugPort,
      browserCore: 'chromium', proxy: config,
    })]);

    const launched = await browsers.launch(id, options);
    assert.equal(launched.core, 'chromium');
    page = await openPage(debugPort);
    const url = (host, route) => 'http://' + host + ':' + originPort + route;
    await navigate(page, url('target.release.test', '/target'), 'proxy:/target');
    await navigate(page, url('sub.wild.release.test', '/wildcard'), 'proxy:/wildcard');
    await navigate(page, url('white.target.release.test', '/whitelist'), 'direct:/whitelist');
    await navigate(page, url('other.release.test', '/unmatched'), 'direct:/unmatched');
    await navigate(page, url('not-target.release.test', '/lookalike'), 'direct:/lookalike');
    await navigate(page, url('other.release.test', '/query?next=target.release.test'), 'direct:/query');
    assert.ok(proxyHits.includes('/target') && proxyHits.includes('/wildcard'));
    assert.ok(!originHits.some(hit => ['/target', '/wildcard'].includes(hit)));
    assert.ok(!proxyHits.some(hit => ['/whitelist', '/unmatched', '/lookalike', '/query'].includes(hit)));
    console.log('PASS Chromium rule proxy, wildcard, whitelist overlap and unrelated domains');

    const tlsAuthority = 'target.release.test:' + tlsProbePort;
    const tunnel = await page.send('Page.navigate', { url: 'https://' + tlsAuthority + '/connect' });
    assert.match(tunnel.errorText || '', /ERR_TUNNEL_CONNECTION_FAILED/);
    assert.ok(connectHits.includes(tlsAuthority), 'The HTTP proxy must receive the expected HTTPS CONNECT');
    assert.equal(unexpectedTlsConnections, 0, 'A rejected CONNECT must not reach the origin directly');
    console.log('PASS Chromium HTTPS CONNECT routing and rejected tunnel isolation');

    page.close();
    page = null;
    await browsers.stop(id);
    store.updateEnvironment(id, { proxy: { ...config, scope: 'all' } });
    const global = await browsers.launch(id, options);
    assert.equal(global.core, 'chromium');
    page = await openPage(debugPort);
    await navigate(page, url('other.release.test', '/global'), 'proxy:/global');
    await navigate(page, url('white.target.release.test', '/global-whitelist'), 'direct:/global-whitelist');
    console.log('PASS Chromium global proxy and direct whitelist');

    page.close();
    page = null;
    await browsers.stop(id);
    store.updateEnvironment(id, { proxy: { ...config, port: socksPort, type: 'socks5' } });
    await browsers.launch(id, options);
    page = await openPage(debugPort);
    await navigate(page, url('target.release.test', '/socks-target'), 'socks:/socks-target');
    await navigate(page, url('white.target.release.test', '/socks-whitelist'), 'direct:/socks-whitelist');
    await navigate(page, url('other.release.test', '/socks-unmatched'), 'direct:/socks-unmatched');
    assert.ok(socksHits.includes('target.release.test:' + originPort));
    assert.ok(!originHits.includes('/socks-target'));
    console.log('PASS Chromium SOCKS5 rule proxy and direct whitelist');

    page.close();
    page = null;
    await browsers.stop(id);
    await close(proxy);
    store.updateEnvironment(id, { proxy: config });
    await browsers.launch(id, options);
    page = await openPage(debugPort);
    const blocked = await page.send('Page.navigate', { url: url('target.release.test', '/offline') });
    assert.match(blocked.errorText || '', /ERR_PROXY_CONNECTION_FAILED|ERR_NO_SUPPORTED_PROXIES|ERR_TUNNEL_CONNECTION_FAILED/);
    assert.ok(!originHits.includes('/offline'), 'Proxy failure must not hit the origin directly');
    await navigate(page, url('white.target.release.test', '/offline-whitelist'), 'direct:/offline-whitelist');
    console.log('PASS Chromium unavailable upstream fails closed for rule targets');
  } finally {
    if (page) page.close();
    try { await browsers.stopAll(); }
    finally {
      for (const socket of socksSockets) socket.destroy();
      const servers = [origin, proxy, tlsProbe];
      if (socks) servers.push(socks);
      await Promise.all(servers.map(close));
    }
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => {
  const relative = path.relative(tempRoot, fs.realpathSync(sandbox));
  assert.match(relative, /^dt-chromium-proxy-[^\\/]+$/);
  if (fs.lstatSync(junction).isSymbolicLink()) fs.unlinkSync(junction);
  fs.rmSync(sandbox, { force: true, recursive: true, maxRetries: 8, retryDelay: 250 });
});
