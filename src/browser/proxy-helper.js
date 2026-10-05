'use strict';

const { createSocks5AuthBridge } = require('./socks5-bridge');
const { parseProxyString } = require('../manager/proxy-parser');

/**
 * 代理配置与生效助手：
 * - 自动识别 4 种格式的代理字符串
 * - 支持 HTTP / SOCKS5（含用户名密码认证）
 * - 针对 Chromium 不支持 SOCKS5 密码认证的问题，自动启用无感本地中转 Bridge
 * - 支持全局走代理或指定 URL 规则走代理 (PAC 脚本)
 */
async function applyProxy(ses, proxyConfig) {
  if (!proxyConfig || !proxyConfig.enabled) {
    await ses.setProxy({ mode: 'direct' });
    return null;
  }

  // 若提供了代理原始字符串，自动解析
  let type = proxyConfig.type || 'socks5';
  let host = proxyConfig.host;
  let port = proxyConfig.port;
  let username = proxyConfig.username || '';
  let password = proxyConfig.password || '';

  if (proxyConfig.rawString) {
    const parsed = parseProxyString(proxyConfig.rawString);
    if (parsed) {
      type = parsed.type;
      host = parsed.host;
      port = parsed.port;
      username = parsed.username || username;
      password = parsed.password || password;
    }
  }

  if (!host || !port) {
    await ses.setProxy({ mode: 'direct' });
    return null;
  }

  let bridge = null;
  let effectiveEndpoint = '';
  const proto = type.toLowerCase() === 'socks5' ? 'socks5' : 'http';

  // 如果是 SOCKS5 且包含密码认证，通过本地 Loopback Bridge 进行协议转换
  if (proto === 'socks5' && username) {
    try {
      bridge = await createSocks5AuthBridge(host, port, username, password);
      effectiveEndpoint = `socks5://127.0.0.1:${bridge.port}`;
      console.log(`[Proxy] SOCKS5 认证中转已就绪: 127.0.0.1:${bridge.port} -> ${host}:${port}`);
    } catch (e) {
      console.error('[Proxy] 启动本地 SOCKS5 中转失败:', e.message);
      effectiveEndpoint = `socks5://${host}:${port}`;
    }
  } else {
    effectiveEndpoint = `${proto}://${host}:${port}`;
  }

  const { scope = 'all', rules = '', bypass = '<local>;localhost;127.0.0.1' } = proxyConfig;

  if (scope === 'rules' && rules.trim()) {
    // 指定 URL 规则走代理，其余直连
    const rulePatterns = rules.split(';')
      .map(r => r.trim())
      .filter(Boolean)
      .map(r => JSON.stringify(r));

    const proxyType = proto === 'socks5' ? 'SOCKS5' : 'PROXY';
    const pacTarget = bridge ? `127.0.0.1:${bridge.port}` : `${host}:${port}`;

    const pac = `
      function FindProxyForURL(url, host) {
        var rules = [${rulePatterns.join(', ')}];
        for (var i = 0; i < rules.length; i++) {
          if (shExpMatch(host, rules[i]) || shExpMatch(url, rules[i])) {
            return "${proxyType} ${pacTarget}; DIRECT";
          }
        }
        return "DIRECT";
      }
    `.trim();

    await ses.setProxy({
      pacScript: `data:application/x-ns-proxy-autoconfig;base64,${Buffer.from(pac).toString('base64')}`
    });
    console.log(`[Proxy] 已启用指定 URL 规则代理模式: ${rules}`);
  } else {
    // 全局代理模式
    await ses.setProxy({
      proxyRules: effectiveEndpoint,
      proxyBypassRules: bypass || '<local>;localhost;127.0.0.1'
    });
    console.log(`[Proxy] 已启用全局代理模式: ${effectiveEndpoint}`);
  }

  return bridge;
}

module.exports = { applyProxy };
