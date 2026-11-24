'use strict';

const { buildRoutingPac } = require('../proxy-rules');

const { RotatingProxyPool } = require('./proxy-pool');
const BLOCKED_PROXY_PORT = 1;
const { RotatingDispatcherServer } = require('./dispatcher-server');

let activePool = null;
let activeDispatcher = null;
let startingPromise = null;

/**
 * 启动并应用动态轮换代理服务
 * @param {Object} rotatingConfig 环境中的 rotatingProxy 配置
 * @param {boolean} [forceRestart=false] 是否强制关闭现有分发端口重新启动
 * @returns {Promise<{ port: number, pacRule: string, count: number } | null>}
 */
async function startRotatingProxy(rotatingConfig, forceRestart = false) {
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

  // 若当前进程已有运行中的分发调度器且未显式要求强制重启，直接复用当前端口，
  // 避免在 defaultSession 和 envSession 连续调用 applyProxy 时销毁前者端口引发白屏
  if (!forceRestart && activeDispatcher && activeDispatcher.server && activePool) {
    return {
      ports: activeDispatcher.ports,
      port: activeDispatcher.port,
      rules: rules.trim(),
      count: activePool.getCount(),
      dispatcher: activeDispatcher
    };
  }

  if (startingPromise) {
    return await startingPromise;
  }

  startingPromise = (async () => {
    try {
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

      const dispatcher = new RotatingDispatcherServer(pool, {
        portCount: 3,
        connectTimeout: 3000,
        maxRetries: 3
      });
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
    } finally {
      startingPromise = null;
    }
  })();

  return await startingPromise;
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
  const ports = (Array.isArray(rotatingPorts) ? rotatingPorts : [rotatingPorts])
    .filter(port => Number.isInteger(port) && port > 0 && port <= 65535);
  if (!ports.length) ports.push(BLOCKED_PROXY_PORT);
  return buildRoutingPac({
    rules: rotatingRules,
    bypass: bypassRules,
    targets: ports.map(port => 'PROXY 127.0.0.1:' + port),
    fallback: fallbackEndpoint,
  });
}

module.exports = {
  BLOCKED_PROXY_PORT,
  startRotatingProxy,
  stopRotatingProxy,
  getActiveDispatcherPort,
  buildCombinedPacScript,
  RotatingProxyPool,
  RotatingDispatcherServer
};
