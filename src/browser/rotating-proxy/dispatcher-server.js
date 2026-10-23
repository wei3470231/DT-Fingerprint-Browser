'use strict';

const net = require('node:net');
const http = require('node:http');

/**
 * 本地多路动态代理分发调度器 (Local Dynamic Rotating Dispatcher)
 * - 拦截来自 Chromium 的每一个网络连接
 * - 为每一次新连接动态随机指派一个独立的上游代理 (支持 SOCKS5 / HTTP，含认证透传)
 * - 毫秒级建立双向数据隧道，支持自动故障重试
 */
class RotatingDispatcherServer {
  constructor(proxyPool, options = {}) {
    this.pool = proxyPool;
    this.port = 0;
    this.ports = [];
    this.servers = [];
    this.portCount = options.portCount || 3; // 默认开设 3 个独立分发端口，打破 Chromium 单端口连接池复用
    this.connectTimeout = options.connectTimeout || 4000; // 单个上游连接超时 (毫秒)
    this.maxRetries = options.maxRetries || 2; // 连接失败自动换新代理重试次数
    this.activeConnections = new Set();
  }

  /**
   * 启动本地监听 (同时开设多个独立端口)
   */
  start() {
    return new Promise((resolve, reject) => {
      this.servers = [];
      this.ports = [];
      let startedCount = 0;
      let hasError = false;

      for (let i = 0; i < this.portCount; i++) {
        const server = net.createServer({ pauseOnConnect: false }, clientSocket => {
          this.handleClientSocket(clientSocket);
        });

        server.on('error', err => {
          console.error('[RotatingDispatcher] 本地服务异常:', err.message);
          if (!hasError) {
            hasError = true;
            reject(err);
          }
        });

        // 绑定到 127.0.0.1 上的随机可用端口
        server.listen(0, '127.0.0.1', () => {
          const addr = server.address();
          this.ports.push(addr.port);
          this.servers.push(server);
          startedCount++;

          if (startedCount === this.portCount) {
            this.port = this.ports[0];
            this.server = this.servers[0];
            console.log(`[RotatingDispatcher] 动态轮换代理分发器已就绪 @ 127.0.0.1:[${this.ports.join(', ')}] (开设 ${this.ports.length} 个独立分发端口，已挂载 ${this.pool.getCount()} 条代理)`);
            resolve(this.port);
          }
        });
      }
    });
  }

  /**
   * 关闭分发器并清理所有正在进行的连接
   */
  close() {
    for (const s of this.servers) {
      try {
        s.close();
      } catch (_) {}
    }
    this.servers = [];
    this.ports = [];
    this.server = null;

    for (const socket of this.activeConnections) {
      try {
        socket.destroy();
      } catch (_) {}
    }
    this.activeConnections.clear();
  }

  /**
   * 处理进入的客户端连接
   */
  handleClientSocket(clientSocket) {
    this.activeConnections.add(clientSocket);

    let clientBuffer = Buffer.alloc(0);
    let isHandled = false;

    const cleanup = () => {
      this.activeConnections.delete(clientSocket);
      try { clientSocket.destroy(); } catch (_) {}
    };

    clientSocket.once('error', cleanup);
    clientSocket.once('close', cleanup);

    clientSocket.on('data', chunk => {
      if (isHandled) return;
      clientBuffer = Buffer.concat([clientBuffer, chunk]);

      // 检测是否为 HTTP CONNECT 请求 (HTTPS 隧道握手)
      const headerEnd = clientBuffer.indexOf('\r\n\r\n');
      if (headerEnd !== -1) {
        const headerStr = clientBuffer.slice(0, headerEnd).toString('utf8');
        const firstLine = headerStr.split('\r\n')[0] || '';
        const match = firstLine.match(/^CONNECT\s+([^:]+)(?::(\d+))?\s+HTTP/i);

        if (match) {
          isHandled = true;
          const targetHost = match[1];
          const targetPort = Number(match[2]) || 443;
          const initialPayload = clientBuffer.slice(headerEnd + 4);

          this.dispatchTunnel(clientSocket, targetHost, targetPort, initialPayload);
          return;
        }

        // 普通 HTTP 代理请求 (GET http://host:port/... 或 GET /path ...)
        const httpMatch = firstLine.match(/^(GET|POST|HEAD|PUT|DELETE|OPTIONS|PATCH)\s+(?:http:\/\/([^/:]+)(?::(\d+))?)?(\/[^\s]*)?\s+HTTP/i);
        if (httpMatch) {
          isHandled = true;
          const targetHost = httpMatch[2] || this.extractHostHeader(headerStr);
          const targetPort = Number(httpMatch[3]) || 80;

          if (targetHost) {
            this.dispatchTunnel(clientSocket, targetHost, targetPort, clientBuffer, true);
            return;
          }
        }
      }

      // 如果数据超出 16KB 仍无法识别有效 HTTP 头部，安全关闭
      if (clientBuffer.length > 16384 && !isHandled) {
        cleanup();
      }
    });
  }

  extractHostHeader(headerStr) {
    const lines = headerStr.split('\r\n');
    for (const line of lines) {
      if (/^Host:\s*/i.test(line)) {
        return line.replace(/^Host:\s*/i, '').split(':')[0].trim();
      }
    }
    return '';
  }

  /**
   * 调度转发核心：为每一次新连接从池中抽取随机代理，并建立上游管道
   */
  async dispatchTunnel(clientSocket, targetHost, targetPort, initialPayload, isRawHttp = false) {
    const candidates = this.pool.getCandidates(this.maxRetries + 1);
    if (candidates.length === 0) {
      console.warn('[RotatingDispatcher] 代理池中无可用代理！');
      this.sendHttpError(clientSocket, 502, 'Bad Gateway: Empty Proxy Pool');
      return;
    }

    let connected = false;

    for (let attempt = 0; attempt < candidates.length; attempt++) {
      const upstreamProxy = candidates[attempt];
      try {
        const upstreamSocket = await this.connectViaProxy(upstreamProxy, targetHost, targetPort);
        connected = true;

        if (!isRawHttp) {
          // HTTPS CONNECT 成功，回复 200 建立隧道并提示关闭长连接
          clientSocket.write('HTTP/1.1 200 Connection Established\r\nProxy-Agent: DT-Rotating-Dispatcher\r\nProxy-Connection: close\r\nConnection: close\r\n\r\n');
        }

        if (initialPayload && initialPayload.length > 0) {
          upstreamSocket.write(initialPayload);
        }

        // 双向管道数据直通
        clientSocket.pipe(upstreamSocket);
        upstreamSocket.pipe(clientSocket);

        // 关键增强：为解决 Chromium HTTP/2 和 Keep-Alive 连接池长久保持导致多标签页/多次刷新复用旧 IP 的问题：
        // 增加数据活动感应空闲超时计时器 (2000ms)。在网页资源加载完毕空闲 2 秒后，自动优雅断开隧道，
        // 确保下一次页面刷新、点击或打开新标签页时，强制 Chromium 重新向 3 个端口之一发起新建连接并换用新 IP！
        let idleTimer = null;
        const resetIdleTimer = () => {
          if (idleTimer) clearTimeout(idleTimer);
          idleTimer = setTimeout(() => {
            try { clientSocket.end(); } catch (_) {}
            try { upstreamSocket.end(); } catch (_) {}
          }, 2000);
        };

        clientSocket.on('data', resetIdleTimer);
        upstreamSocket.on('data', resetIdleTimer);
        resetIdleTimer();

        const cleanPipes = () => {
          if (idleTimer) clearTimeout(idleTimer);
          try { clientSocket.destroy(); } catch (_) {}
          try { upstreamSocket.destroy(); } catch (_) {}
        };

        upstreamSocket.once('error', cleanPipes);
        clientSocket.once('error', cleanPipes);
        upstreamSocket.once('close', cleanPipes);
        clientSocket.once('close', cleanPipes);

        break;
      } catch (err) {
        console.warn(`[RotatingDispatcher] 代理节点 [${upstreamProxy.type}://${upstreamProxy.host}:${upstreamProxy.port}] 握手失败: ${err.message}，正在尝试换用下一个代理...`);
      }
    }

    if (!connected) {
      this.sendHttpError(clientSocket, 504, 'Gateway Timeout: All Candidate Proxies Failed');
    }
  }

  /**
   * 向上游代理发起连接并完成协议握手
   */
  connectViaProxy(proxy, targetHost, targetPort) {
    return new Promise((resolve, reject) => {
      let settled = false;
      const timeout = setTimeout(() => {
        if (!settled) {
          settled = true;
          try { socket.destroy(); } catch (_) {}
          reject(new Error(`连接上游代理超时 (${this.connectTimeout}ms)`));
        }
      }, this.connectTimeout);

      const socket = net.createConnection({ host: proxy.host, port: Number(proxy.port) }, () => {
        if (proxy.type === 'socks5') {
          this.performSocks5Handshake(socket, proxy, targetHost, targetPort, (err) => {
            clearTimeout(timeout);
            if (settled) return;
            settled = true;
            if (err) {
              try { socket.destroy(); } catch (_) {}
              return reject(err);
            }
            resolve(socket);
          });
        } else {
          // 默认 HTTP CONNECT 隧道代理
          this.performHttpConnectHandshake(socket, proxy, targetHost, targetPort, (err) => {
            clearTimeout(timeout);
            if (settled) return;
            settled = true;
            if (err) {
              try { socket.destroy(); } catch (_) {}
              return reject(err);
            }
            resolve(socket);
          });
        }
      });

      socket.once('error', err => {
        clearTimeout(timeout);
        if (!settled) {
          settled = true;
          reject(err);
        }
      });
    });
  }

  /**
   * 执行 SOCKS5 上游代理握手
   */
  performSocks5Handshake(socket, proxy, targetHost, targetPort, callback) {
    let step = 0; // 0: greeting, 1: auth (if needed), 2: connect
    let buf = Buffer.alloc(0);

    const onData = chunk => {
      buf = Buffer.concat([buf, chunk]);

      if (step === 0) {
        if (buf.length < 2) return;
        if (buf[0] !== 0x05) {
          cleanup();
          return callback(new Error('上游不是有效 SOCKS5 服务'));
        }
        const method = buf[1];
        buf = buf.slice(2);

        if (method === 0x02) {
          // 用户名密码认证
          step = 1;
          const uBuf = Buffer.from(proxy.username || '');
          const pBuf = Buffer.from(proxy.password || '');
          const authReq = Buffer.concat([
            Buffer.from([0x01, uBuf.length]),
            uBuf,
            Buffer.from([pBuf.length]),
            pBuf
          ]);
          socket.write(authReq);
          return;
        } else if (method === 0x00) {
          // 无需认证，直接连接目标
          step = 2;
          this.sendSocks5ConnectRequest(socket, targetHost, targetPort);
          return;
        } else {
          cleanup();
          return callback(new Error(`上游 SOCKS5 要求的认证方式不支持: ${method}`));
        }
      }

      if (step === 1) {
        if (buf.length < 2) return;
        if (buf[1] !== 0x00) {
          cleanup();
          return callback(new Error('上游 SOCKS5 用户名或密码认证被拒绝'));
        }
        buf = buf.slice(2);
        step = 2;
        this.sendSocks5ConnectRequest(socket, targetHost, targetPort);
        return;
      }

      if (step === 2) {
        if (buf.length < 4) return;
        if (buf[1] !== 0x00) {
          cleanup();
          return callback(new Error(`上游 SOCKS5 连接目标失败，错误码: 0x${buf[1].toString(16)}`));
        }

        // 判定 SOCKS5 响应完整长度
        const atyp = buf[3];
        let totalLen = 0;
        if (atyp === 0x01) totalLen = 10;
        else if (atyp === 0x03) {
          if (buf.length < 5) return;
          totalLen = 5 + buf[4] + 2;
        } else if (atyp === 0x04) totalLen = 22;

        if (buf.length < totalLen) return;

        // 握手圆满完成！
        cleanup();
        callback(null);
      }
    };

    const cleanup = () => {
      socket.removeListener('data', onData);
    };

    socket.on('data', onData);

    // 发起初始协商 (支持无密 0x00 与密码 0x02)
    const hasAuth = Boolean(proxy.username);
    socket.write(hasAuth ? Buffer.from([0x05, 0x02, 0x00, 0x02]) : Buffer.from([0x05, 0x01, 0x00]));
  }

  sendSocks5ConnectRequest(socket, targetHost, targetPort) {
    const isIp = net.isIP(targetHost);
    let destBuf;
    if (isIp === 4) {
      destBuf = Buffer.concat([
        Buffer.from([0x05, 0x01, 0x00, 0x01]),
        Buffer.from(targetHost.split('.').map(Number)),
        this.portToBuffer(targetPort)
      ]);
    } else if (isIp === 6) {
      // IPv6
      destBuf = Buffer.concat([
        Buffer.from([0x05, 0x01, 0x00, 0x04]),
        Buffer.alloc(16),
        this.portToBuffer(targetPort)
      ]);
    } else {
      // 域名
      const hostBuf = Buffer.from(targetHost);
      destBuf = Buffer.concat([
        Buffer.from([0x05, 0x01, 0x00, 0x03, hostBuf.length]),
        hostBuf,
        this.portToBuffer(targetPort)
      ]);
    }
    socket.write(destBuf);
  }

  portToBuffer(port) {
    const buf = Buffer.alloc(2);
    buf.writeUInt16BE(Number(port), 0);
    return buf;
  }

  /**
   * 执行 HTTP CONNECT 上游代理握手
   */
  performHttpConnectHandshake(socket, proxy, targetHost, targetPort, callback) {
    let headers = `CONNECT ${targetHost}:${targetPort} HTTP/1.1\r\nHost: ${targetHost}:${targetPort}\r\n`;
    if (proxy.username) {
      const auth = Buffer.from(`${proxy.username}:${proxy.password || ''}`).toString('base64');
      headers += `Proxy-Authorization: Basic ${auth}\r\n`;
    }
    headers += 'Proxy-Connection: keep-alive\r\n\r\n';

    let resBuf = Buffer.alloc(0);
    const onData = chunk => {
      resBuf = Buffer.concat([resBuf, chunk]);
      const headerEnd = resBuf.indexOf('\r\n\r\n');
      if (headerEnd !== -1) {
        cleanup();
        const headerStr = resBuf.slice(0, headerEnd).toString('utf8');
        const statusCode = Number((headerStr.match(/^HTTP\/\d\.\d\s+(\d+)/i) || [])[1]);

        if (statusCode === 200) {
          callback(null);
        } else {
          callback(new Error(`上游 HTTP 代理拒绝 CONNECT 隧道请求 (状态码: ${statusCode})`));
        }
      }
    };

    const cleanup = () => {
      socket.removeListener('data', onData);
    };

    socket.on('data', onData);
    socket.write(headers);
  }

  sendHttpError(socket, code, msg) {
    try {
      socket.write(`HTTP/1.1 ${code} ${msg}\r\nContent-Type: text/plain; charset=utf-8\r\nConnection: close\r\n\r\n${msg}\n`);
      socket.end();
    } catch (_) {}
  }
}

module.exports = { RotatingDispatcherServer };
