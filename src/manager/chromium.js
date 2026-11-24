'use strict';

const { createHash } = require('node:crypto');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { effectiveUserAgent } = require('../shared/user-agent');
const { chromiumSeed } = require('../shared/chromium-seed');
const { FINGERPRINT_PAGE_FOLDER, usesCanvasCompatibility } = require('./chromium-canvas');
const { DEFAULT_PROXY_BYPASS, proxyHostRules, buildRoutingPac, pacDataUrl } = require('../browser/proxy-rules');

function chromiumProfile(dataDir, id) {
  const key = createHash('sha256').update(String(id)).digest('hex');
  return path.join(dataDir, 'chromium-profiles', key);
}

function proxyFlags(proxy = {}, rotating = {}) {
  if (rotating.enabled) throw new Error('此环境启用了轮换代理，请使用 Electron 内核启动。');
  if (!proxy.enabled) return ['--no-proxy-server'];
  if (proxy.username || proxy.password) {
    throw new Error('此环境使用了认证代理，请使用 Electron 内核启动。');
  }
  if (!proxy.host || !proxy.port) throw new Error('Chromium 代理地址或端口无效。');
  const protocol = proxy.type === 'socks5' ? 'socks5' : 'http';
  const host = proxy.host.includes(':') && !proxy.host.startsWith('[') ? '[' + proxy.host + ']' : proxy.host;
  if (!/^(?:[\w.-]+|\[[0-9a-f:]+\])$/i.test(host) || !Number.isInteger(Number(proxy.port)) || proxy.port < 1 || proxy.port > 65535) {
    throw new Error('Chromium 代理地址或端口无效。');
  }
  const bypass = proxy.bypass ?? DEFAULT_PROXY_BYPASS;
  if (proxy.scope === 'rules') {
    if (!proxyHostRules(proxy.rules).length) throw new Error('请至少提供一个有效的代理目标域名。');
    const endpoint = (protocol === 'socks5' ? 'SOCKS5 ' : 'PROXY ') + host + ':' + proxy.port;
    return ['--proxy-pac-url=' + pacDataUrl(buildRoutingPac({
      rules: proxy.rules, bypass, targets: [endpoint],
    }))];
  }
  return [
    '--proxy-server=' + protocol + '://' + host + ':' + proxy.port,
    '--proxy-bypass-list=' + bypass,
  ];
}

function launchArgs(env, options, root, dataDir) {
  if (!env.fp?.seed) throw new Error('缺少环境指纹，请先生成指纹。');
  if (options.blockDialogs ?? env.blockDialogs) throw new Error('此环境启用了弹窗屏蔽，请使用 Electron 内核启动。');

  const fp = env.fp;
  const profile = chromiumProfile(dataDir, env.id);
  const canvasAssets = path.join(profile, 'dt-canvas');
  const seed = chromiumSeed(fp);
  const language = env.language || fp.navigator?.languages?.[0] || 'en-US';
  const languages = fp.navigator?.languages?.join(',') || language;
  // Use the profile's Canvas compatibility code in place of the blocking native readback hook.
  const disable = new Set(['canvas', ...(fp.disable || []).filter(value =>
    ['font', 'audio', 'clientrects', 'gpu'].includes(value))]);
  if (fp.noise?.audio === false) disable.add('audio');
  if (fp.noise?.rects === false) disable.add('clientrects');
  const args = [
    '--user-data-dir=' + profile,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-background-mode',
    '--disable-non-proxied-udp',
    '--fingerprint=' + seed,
    '--fingerprint-platform=windows',
    '--fingerprint-brand=Chrome',
    '--lang=' + language,
    '--accept-lang=' + languages,
    '--timezone=' + (env.timezone || fp.timezone || 'America/New_York'),
    ...proxyFlags(env.proxy, { enabled: Boolean(env.rotatingProxy?.enabled || options.rotatingFile || options.rotatingRules) }),
  ];
  if (fp.navigator?.hardwareConcurrency > 0) args.push('--fingerprint-hardware-concurrency=' + fp.navigator.hardwareConcurrency);
  const ua = effectiveUserAgent(env);
  if (ua) args.push('--user-agent=' + ua);
  args.push('--disable-spoofing=' + [...disable].join(','));
  if (env.remotePortEnabled && env.remotePort) {
    args.push('--remote-debugging-port=' + env.remotePort, '--remote-debugging-address=127.0.0.1');
  }
  if (options.headless) args.push('--headless');

  const extensions = (env.extensions || '').split(/[;\r\n]+/).map(item => item.trim()).filter(Boolean)
    .map(item => path.resolve(root, item));
  if (usesCanvasCompatibility(fp)) extensions.push(canvasAssets);
  if (extensions.length) args.push('--load-extension=' + extensions.join(','));

  const custom = [env.customArgs, options.args].filter(Boolean).join(' ').match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) || [];
  for (const part of custom) {
    const arg = part.replace(/["']/g, '');
    if (!arg.startsWith('--') || /^--(?:user-data-dir|user-agent|proxy-[\w-]+|no-proxy-server|remote-debugging-[\w-]+|fingerprint[\w-]*|disable-spoofing|load-extension|disable-extensions[\w-]*|lang|accept-lang|timezone)(?:=|$)/.test(arg)) {
      throw new Error('Chromium 自定义参数与环境设置冲突：' + arg.split('=')[0]);
    }
    args.push(arg);
  }

  if (options.restoreSession) {
    args.push('--restore-last-session');
  } else {
    const url = options.url || env.url;
    if (url === 'dt://fingerprint-test' || !url) {
      args.push(pathToFileURL(path.join(canvasAssets, FINGERPRINT_PAGE_FOLDER, 'index.html')).href);
    } else {
      args.push('--', url);
    }
  }
  return args;
}

module.exports = { chromiumProfile, launchArgs };
