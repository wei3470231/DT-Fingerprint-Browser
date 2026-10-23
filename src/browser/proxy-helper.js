'use strict';

const { createSocks5AuthBridge } = require('./socks5-bridge');
const { parseProxyString } = require('../manager/proxy-parser');
const { startRotatingProxy, stopRotatingProxy, buildCombinedPacScript } = require('./rotating-proxy');

/**
 * 代理配置与生效助手：
 * - 自动识别 4 种格式的代理字符串
 * - 支持 HTTP / SOCKS5（含用户名密码认证）
 * - 针对 Chromium 不支持 SOCKS5 密码认证的问题，自动启用无感本地中转 Bridge
 * - 支持全局走代理或指定 URL 规则走代理 (PAC 脚本)
 * - 增量支持：针对特定多域名规则接入动态轮换代理池 (每连接换 IP)
 */
async function applyProxy(ses, proxyConfig, rotatingConfig) {
  // 1. 若配置了目标域名动态轮换代理池，优先启动本地多路分发调度器
  let rotatingInfo = null;
  if (rotatingConfig && rotatingConfig.enabled) {
    try {
      rotatingInfo = await startRotatingProxy(rotatingConfig);
    } catch (rErr) {
      console.error('[Proxy] 启动动态轮换代理池失败:', rErr.message);
    }
  } else {
    stopRotatingProxy();
  }

  const hasBaseProxy = Boolean(proxyConfig && proxyConfig.enabled && proxyConfig.host && proxyConfig.port);

  // 既无基础代理，也未开启动态轮换代理池 -> 直连模式
  if (!hasBaseProxy && !rotatingInfo) {
    closeCurrentBridge();
    stopRotatingProxy();
    await ses.setProxy({ mode: 'direct' });
    return null;
  }

  let bridge = null;
  let effectiveEndpoint = 'DIRECT';
  let proto = 'socks5';
  let host = '';
  let port = '';

  if (hasBaseProxy) {
    let type = proxyConfig.type || 'socks5';
    host = proxyConfig.host;
    port = proxyConfig.port;
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

    proto = type.toLowerCase() === 'socks5' ? 'socks5' : 'http';

    // 如果是 SOCKS5 且包含密码认证，通过本地 Loopback Bridge 进行协议转换
    if (proto === 'socks5' && username) {
      const bridgeKey = `${host}:${port}:${username}:${password}`;
      if (activeBridge && activeBridgeKey === bridgeKey) {
        bridge = activeBridge;
        effectiveEndpoint = `socks5://127.0.0.1:${bridge.port}`;
      } else {
        closeCurrentBridge();
        try {
          bridge = await createSocks5AuthBridge(host, port, username, password);
          activeBridge = bridge;
          activeBridgeKey = bridgeKey;
          effectiveEndpoint = `socks5://127.0.0.1:${bridge.port}`;
          console.log(`[Proxy] SOCKS5 认证中转已就绪: 127.0.0.1:${bridge.port} -> ${host}:${port}`);
        } catch (e) {
          console.error('[Proxy] 启动本地 SOCKS5 中转失败:', e.message);
          effectiveEndpoint = `socks5://${host}:${port}`;
        }
      }
    } else {
      closeCurrentBridge();
      effectiveEndpoint = `${proto}://${host}:${port}`;
    }
  } else {
    closeCurrentBridge();
  }

  // 2. 如果启用了目标域名动态轮换代理池，构建多路综合 PAC 脚本
  if (rotatingInfo && rotatingInfo.port && rotatingInfo.rules) {
    const fallbackPac = hasBaseProxy
      ? (proto === 'socks5' ? `SOCKS5 ${bridge ? `127.0.0.1:${bridge.port}` : `${host}:${port}`}` : `PROXY ${host}:${port}`)
      : 'DIRECT';

    const pac = buildCombinedPacScript(rotatingInfo.port, rotatingInfo.rules, fallbackPac);
    await ses.setProxy({
      pacScript: `data:application/x-ns-proxy-autoconfig;base64,${Buffer.from(pac).toString('base64')}`
    });
    console.log(`[Proxy] 已激活指定域名动态轮换代理池: 规则[${rotatingInfo.rules}], 挂载代理[${rotatingInfo.count}条], 调度端口[${rotatingInfo.port}]`);
    return bridge;
  }

  // 3. 原有逻辑：未开启动态代理池时的基础代理设置
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

let activeBridge = null;
let activeBridgeKey = null;

function closeCurrentBridge() {
  if (activeBridge && activeBridge.server) {
    try {
      activeBridge.server.close();
    } catch (_) {}
    activeBridge = null;
    activeBridgeKey = null;
  }
  stopRotatingProxy();
}

module.exports = { applyProxy, closeCurrentBridge, stopRotatingProxy };
