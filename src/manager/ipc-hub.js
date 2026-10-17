'use strict';

const net = require('node:net');
const EventEmitter = require('node:events');

const PIPE_PATH = process.platform === 'win32'
  ? '\\\\.\\pipe\\dt-fingerprint-hub'
  : '/tmp/dt-fingerprint-hub.sock';

class IpcHub extends EventEmitter {
  constructor() {
    super();
    this.server = null;
    this.clients = new Map(); // envId -> socket
    this.syncConfig = {
      enabled: false,
      masterEnvId: null,
      slaveEnvIds: []
    };
    this.pendingCallbacks = new Map(); // msgId -> { resolve, reject, timer }
  }

  start() {
    if (this.server) return;

    this.server = net.createServer((socket) => {
      let buffer = '';
      let registeredEnvId = null;

      socket.on('data', (chunk) => {
        buffer += chunk.toString('utf8');
        const lines = buffer.split('\n');
        buffer = lines.pop(); // 保留未完整的片段

        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const msg = JSON.parse(line);
            this._handleMessage(socket, msg, (envId) => {
              registeredEnvId = envId;
            });
          } catch (e) {
            console.warn('[IPC Hub] 解析消息异常:', e.message);
          }
        }
      });

      socket.on('close', () => {
        if (registeredEnvId) {
          this.clients.delete(registeredEnvId);
          this.emit('client-disconnected', registeredEnvId);
          // 若断开的是主控窗口，自动暂停同步
          if (this.syncConfig.masterEnvId === registeredEnvId) {
            this.syncConfig.enabled = false;
            this.syncConfig.masterEnvId = null;
            this.emit('sync-state-changed', this.syncConfig);
          }
        }
      });

      socket.on('error', () => {
        if (registeredEnvId) {
          this.clients.delete(registeredEnvId);
        }
      });
    });

    this.server.on('error', (err) => {
      console.warn('[IPC Hub] Server error:', err.message);
    });

    try {
      this.server.listen(PIPE_PATH, () => {
        console.log(`[IPC Hub] 内部控制通道已启动: ${PIPE_PATH}`);
      });
    } catch (e) {
      console.warn('[IPC Hub] 监听管道失败:', e.message);
    }
  }

  _handleMessage(socket, msg, setEnvIdCallback) {
    const { action, envId, msgId, payload } = msg;

    if (action === 'register') {
      if (envId) {
        this.clients.set(envId, socket);
        setEnvIdCallback(envId);
        this.emit('client-connected', envId);
        // 回复注册成功并下发当前同步状态
        this._send(socket, {
          action: 'register-ack',
          syncConfig: this.syncConfig,
          isMaster: this.syncConfig.enabled && this.syncConfig.masterEnvId === envId,
          isSlave: this.syncConfig.enabled && this.syncConfig.slaveEnvIds.includes(envId)
        });
      }
      return;
    }

    // 处理带请求 ID 的响应回调
    if (msgId && this.pendingCallbacks.has(msgId)) {
      const cb = this.pendingCallbacks.get(msgId);
      this.pendingCallbacks.delete(msgId);
      clearTimeout(cb.timer);
      if (msg.error) cb.reject(new Error(msg.error));
      else cb.resolve(payload);
      return;
    }

    // 键鼠与事件同步转发 (Master -> Slaves)
    if (action === 'sync-event') {
      if (!this.syncConfig.enabled || this.syncConfig.masterEnvId !== envId) {
        return;
      }
      // 广播给所有被勾选的从属窗口
      for (const slaveId of this.syncConfig.slaveEnvIds) {
        if (slaveId === envId) continue;
        const slaveSocket = this.clients.get(slaveId);
        if (slaveSocket && !slaveSocket.destroyed) {
          this._send(slaveSocket, {
            action: 'dispatch-sync-event',
            event: payload
          });
        }
      }
    }
  }

  _send(socket, obj) {
    if (socket && !socket.destroyed) {
      try {
        socket.write(JSON.stringify(obj) + '\n');
      } catch (_) {}
    }
  }

  /**
   * 设置多窗口键鼠同步状态 (同时兼容 masterId/slaveIds 与 masterEnvId/slaveEnvIds)
   */
  setSyncConfig({ enabled, masterId, slaveIds, masterEnvId, slaveEnvIds } = {}) {
    const finalMaster = masterId || masterEnvId || null;
    const finalSlaves = Array.isArray(slaveIds) ? slaveIds : (Array.isArray(slaveEnvIds) ? slaveEnvIds : []);

    this.syncConfig.enabled = Boolean(enabled);
    this.syncConfig.masterEnvId = finalMaster;
    this.syncConfig.masterId = finalMaster;
    this.syncConfig.slaveEnvIds = finalSlaves;
    this.syncConfig.slaveIds = finalSlaves;

    // 通知所有连接的窗口更新其角色 (是否是主控/是否是从属)
    for (const [envId, socket] of this.clients.entries()) {
      const isMaster = this.syncConfig.enabled && this.syncConfig.masterEnvId === envId;
      const isSlave = this.syncConfig.enabled && this.syncConfig.slaveEnvIds.includes(envId);
      this._send(socket, {
        action: 'set-sync-role',
        isMaster,
        isSlave,
        syncConfig: this.getSyncStatus()
      });
    }

    this.emit('sync-state-changed', this.getSyncStatus());
    return this.getSyncStatus();
  }

  getSyncStatus() {
    return {
      enabled: Boolean(this.syncConfig.enabled),
      masterId: this.syncConfig.masterEnvId || this.syncConfig.masterId || null,
      masterEnvId: this.syncConfig.masterEnvId || this.syncConfig.masterId || null,
      slaveIds: this.syncConfig.slaveEnvIds || this.syncConfig.slaveIds || [],
      slaveEnvIds: this.syncConfig.slaveEnvIds || this.syncConfig.slaveIds || [],
      connectedCount: this.clients.size,
      connectedEnvIds: Array.from(this.clients.keys())
    };
  }

  getSyncConfig() {
    return this.getSyncStatus();
  }

  /**
   * 优雅安全关闭 IPC 服务通道
   */
  stop() {
    if (this.server) {
      try {
        this.server.close();
      } catch (_) {}
      this.server = null;
    }
    for (const socket of this.clients.values()) {
      try {
        socket.destroy();
      } catch (_) {}
    }
    this.clients.clear();
    this.pendingCallbacks.clear();
  }

  /**
   * 通知指定环境窗口修改位置与尺寸 (平铺与排列)
   */
  setWindowBounds(envId, bounds) {
    const socket = this.clients.get(envId);
    if (socket && !socket.destroyed) {
      this._send(socket, {
        action: 'set-bounds',
        bounds
      });
      return true;
    }
    return false;
  }

  /**
   * 异步向运行中浏览器请求当前 Cookie 列表
   */
  async requestCookies(envId, timeoutMs = 3000) {
    const socket = this.clients.get(envId);
    if (!socket || socket.destroyed) {
      throw new Error(`环境 ${envId} 未在运行或未连接`);
    }

    const msgId = 'req-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingCallbacks.delete(msgId);
        reject(new Error('获取 Cookie 超时'));
      }, timeoutMs);

      this.pendingCallbacks.set(msgId, { resolve, reject, timer });
      this._send(socket, {
        action: 'get-cookies',
        msgId
      });
    });
  }

  /**
   * 异步向运行中浏览器注入 Cookie 列表
   */
  async injectCookies(envId, cookies, timeoutMs = 4000) {
    const socket = this.clients.get(envId);
    if (!socket || socket.destroyed) {
      throw new Error(`环境 ${envId} 未在运行或未连接`);
    }

    const msgId = 'inj-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingCallbacks.delete(msgId);
        reject(new Error('注入 Cookie 超时'));
      }, timeoutMs);

      this.pendingCallbacks.set(msgId, { resolve, reject, timer });
      this._send(socket, {
        action: 'set-cookies',
        msgId,
        payload: cookies
      });
    });
  }

  /**
   * 检查某个环境窗口是否在线连接在 Hub 中
   */
  isClientConnected(envId) {
    const s = this.clients.get(envId);
    return Boolean(s && !s.destroyed);
  }

  getConnectedEnvIds() {
    return Array.from(this.clients.keys());
  }
}

const hubInstance = new IpcHub();
hubInstance.ipcHub = hubInstance;
hubInstance.PIPE_PATH = PIPE_PATH;
hubInstance.IpcHub = IpcHub;

module.exports = hubInstance;
