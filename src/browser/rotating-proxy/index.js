'use strict';

const { RotatingProxyPool } = require('./proxy-pool');
const { RotatingDispatcherServer } = require('./dispatcher-server');

let activePool = null;
let activeDispatcher = null;

/**
 * 启动并应用动态轮换代理服务
 * @param {Object} rotatingConfig 环境中的 rotatingProxy 配置
 * @returns {Promise<{ port: number, pacRule: string, count: number } | null>}
 */
async function startRotatingProxy(rotatingConfig) {
  if (!rotatingConfig || !rotatingConfig.enabled) {
    stopRotatingProxy();
    return null;
  }

  const { filePath, rawText, rules = '', mode = 'random' } = rotatingConfig;

  // 必须指定目标域名规则，否则不生效
  if (!rules || !rules.trim()) {
    console.warn('[RotatingProxy] 未配置指定目标域名规则，动态代理不启动');
    stopRotatingProxy();
    return null;
  }

  // 关闭旧服务
  stopRotatingProxy();

  const pool = new RotatingProxyPool({ filePath, rules, mode });
  let loadResult;
  if (filePath && filePath.trim()) {
    loadResult = pool.loadFromFile(filePath.trim());
  } else if (rawText && rawText.trim()) {
    loadResult = pool.loadFromString(rawText.trim());
  } else {
    console.warn('[RotatingProxy] 未提供代理文档路径或内容');
    return null;
  }

  if (!loadResult.success || pool.getCount() === 0) {
    console.error('[RotatingProxy] 代理池初始化失败:', loadResult.error || '有效代理数为 0');
    return null;
  }

  const dispatcher = new RotatingDispatcherServer(pool, { portCount: 3 });
  const port = await dispatcher.start();

  activePool = pool;
  activeDispatcher = dispatcher;

  return {
    ports: dispatcher.ports,
    port: dispatcher.port,
    rules: rules.trim(),
    count: pool.getCount(),
    dispatcher
  };
}

/**
 * 停止当前活动的动态代理服务
 */
function stopRotatingProxy() {
  if (activeDispatcher) {
    activeDispatcher.close();
    activeDispatcher = null;
  }
  activePool = null;
}

/**
 * 获取当前活动的轮换调度器端口列表
 */
function getActiveDispatcherPort() {
  return activeDispatcher ? activeDispatcher.port : null;
}

function getActiveDispatcherPorts() {
  return activeDispatcher ? activeDispatcher.ports : [];
}

/**
 * 构建综合 PAC 脚本：
 * - 开设 3 个独立端口并在 PAC 中动态随机分配，彻底打破 Chromium 对相同端口的 HTTP/2 / Keep-Alive 会话复用
 * - 命中 rotatingRules 的多个域名，随机分配到 127.0.0.1:portA/portB/portC 之一
 * - 未命中的流量，若存在环境原有固定代理则走固定代理，否则走 DIRECT 直连
 */
function buildCombinedPacScript(rotatingPorts, rotatingRules, fallbackEndpoint = 'DIRECT', bypassRules = '') {
  const ports = Array.isArray(rotatingPorts) ? rotatingPorts : [rotatingPorts];
  const rawRules = (rotatingRules || '')
    .split(/[;\n]/)
    .map(r => r.trim())
    .filter(Boolean);

  const ruleSet = new Set();
  for (const raw of rawRules) {
    ruleSet.add(raw);
    // 智能兼容用户直接填入的 URL 路径与协议 (如 "hav.digitaldisbursements.com/s" -> "hav.digitaldisbursements.com")
    // 以及完整 URL (如 "https://hav.digitaldisbursements.com/s" -> "hav.digitaldisbursements.com")
    const stripped = raw.replace(/^[a-zA-Z]+:\/\//, '');
    const domain = stripped.split(/[/?#:]/)[0].trim();
    if (domain) {
      ruleSet.add(domain);
    }
  }

  const rawBypass = (bypassRules || '')
    .split(/[;\n,]/)
    .map(r => r.trim())
    .filter(Boolean);

  const bypassSet = new Set();
  for (const raw of rawBypass) {
    bypassSet.add(raw);
    const stripped = raw.replace(/^[a-zA-Z]+:\/\//, '');
    const domain = stripped.split(/[/?#:]/)[0].trim();
    if (domain) {
      bypassSet.add(domain);
    }
  }

  const ruleList = Array.from(ruleSet).map(r => JSON.stringify(r));
  const bypassList = Array.from(bypassSet).map(r => JSON.stringify(r));

  return `
    function FindProxyForURL(url, host) {
      // 1. 白名单域名走本地 IP (不使用任何代理，直接走 DIRECT)
      var bypassRules = [${bypassList.join(', ')}];
      for (var b = 0; b < bypassRules.length; b++) {
        var bp = bypassRules[b];
        if (bp === "<local>" && isPlainHostName(host)) {
          return "DIRECT";
        }
        if (
          shExpMatch(host, bp) || 
          dnsDomainIs(host, bp) || 
          shExpMatch(url, bp) ||
          shExpMatch(url, "*" + bp + "*")
        ) {
          return "DIRECT";
        }
      }

      // 2. 目标多域名动态轮换代理池 (在 3 个独立端口随机分配，打破连接池复用)
      var rotatingRules = [${ruleList.join(', ')}];
      var ports = [${ports.join(', ')}];
      for (var i = 0; i < rotatingRules.length; i++) {
        var pattern = rotatingRules[i];
        if (
          shExpMatch(host, pattern) || 
          dnsDomainIs(host, pattern) || 
          shExpMatch(url, pattern) ||
          shExpMatch(url, "*" + pattern + "*")
        ) {
          var p = ports[Math.floor(Math.random() * ports.length)];
          return "PROXY 127.0.0.1:" + p + "; SOCKS5 127.0.0.1:" + p + "; DIRECT";
        }
      }

      // 3. 未命中规则流量走环境回退代理或 DIRECT 直连
      return "${fallbackEndpoint}; DIRECT";
    }
  `.trim();
}

module.exports = {
  startRotatingProxy,
  stopRotatingProxy,
  getActiveDispatcherPort,
  buildCombinedPacScript,
  RotatingProxyPool,
  RotatingDispatcherServer
};
