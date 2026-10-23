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

  const dispatcher = new RotatingDispatcherServer(pool);
  const port = await dispatcher.start();

  activePool = pool;
  activeDispatcher = dispatcher;

  return {
    port,
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
 * 获取当前活动的轮换调度器端口
 */
function getActiveDispatcherPort() {
  return activeDispatcher ? activeDispatcher.port : null;
}

/**
 * 构建综合 PAC 脚本：
 * - 命中 rotatingRules 的多个域名，全部走本地动态分发器 (127.0.0.1:dispatcherPort)
 * - 未命中的流量，若存在环境原有固定代理则走固定代理，否则走 DIRECT 直连
 */
function buildCombinedPacScript(rotatingPort, rotatingRules, fallbackEndpoint = 'DIRECT') {
  const ruleList = rotatingRules.split(/[;\n]/)
    .map(r => r.trim())
    .filter(Boolean)
    .map(r => JSON.stringify(r));

  return `
    function FindProxyForURL(url, host) {
      var rotatingRules = [${ruleList.join(', ')}];
      for (var i = 0; i < rotatingRules.length; i++) {
        var pattern = rotatingRules[i];
        if (shExpMatch(host, pattern) || shExpMatch(url, pattern) || dnsDomainIs(host, pattern)) {
          return "PROXY 127.0.0.1:${rotatingPort}; SOCKS5 127.0.0.1:${rotatingPort}; DIRECT";
        }
      }
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
