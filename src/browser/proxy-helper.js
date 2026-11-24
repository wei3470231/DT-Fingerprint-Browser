'use strict';

const { createSocks5AuthBridge } = require('./socks5-bridge');
const { parseProxyString } = require('../manager/proxy-parser');
const { DEFAULT_PROXY_BYPASS, proxyHostRules, buildRoutingPac, pacDataUrl } = require('./proxy-rules');
const { BLOCKED_PROXY_PORT, startRotatingProxy, stopRotatingProxy, buildCombinedPacScript } = require('./rotating-proxy');

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
  const rotatingEnabled = Boolean(rotatingConfig?.enabled);
  if (rotatingEnabled) {
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
  if (!hasBaseProxy && !rotatingEnabled) {
    closeCurrentBridge();
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
          effectiveEndpoint = `http://127.0.0.1:${BLOCKED_PROXY_PORT}`;
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
  const pacEndpoint = effectiveEndpoint === 'DIRECT' ? 'DIRECT' :
    effectiveEndpoint.replace(/^socks5:\/\//, 'SOCKS5 ').replace(/^http:\/\//, 'PROXY ');

  if (rotatingEnabled) {
    const rules = rotatingConfig.rules?.trim();
    if (!proxyHostRules(rules).length) {
      await ses.setProxy({ mode: 'fixed_servers', proxyRules: `http://127.0.0.1:${BLOCKED_PROXY_PORT}` });
      console.error('[Proxy] 动态轮换未配置目标域名，已阻断网络请求');
      return bridge;
    }
    const ports = rotatingInfo?.ports || [];
    const pac = buildCombinedPacScript(ports, rules, pacEndpoint, proxyConfig?.bypass);
    await setPacProxy(ses, pac);
    if (rotatingInfo) {
      console.log(`[Proxy] 动态轮换代理池已启用: 规则[${rules}]，节点[${rotatingInfo.count}]，端口[${ports.join(', ')}]`);
    } else {
      console.error('[Proxy] 动态轮换代理池不可用，已阻断命中规则的请求');
    }
    return bridge;
  }

  // 3. 原有逻辑：未开启动态代理池时的基础代理设置
  const { scope = 'all', rules = '', bypass = DEFAULT_PROXY_BYPASS } = proxyConfig || {};
  if (scope === 'rules') {
    if (!proxyHostRules(rules).length) {
      await ses.setProxy({ mode: 'fixed_servers', proxyRules: `http://127.0.0.1:${BLOCKED_PROXY_PORT}` });
      console.error('[Proxy] 分流未配置有效的目标域名，已阻断网络请求');
      return bridge;
    }
    const pac = buildRoutingPac({ rules, bypass, targets: [pacEndpoint] });
    await setPacProxy(ses, pac);
    console.log('[Proxy] 已启用域名代理分流');
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

async function setPacProxy(ses, script) {
  await ses.setProxy({ mode: 'pac_script', pacScript: pacDataUrl(script) });
  // SetProxy writes the preference before the network service loads the new PAC.
  await ses.forceReloadProxyConfig();
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
}

module.exports = { applyProxy, closeCurrentBridge, stopRotatingProxy };
