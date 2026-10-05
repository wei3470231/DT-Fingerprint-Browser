'use strict';

const net = require('node:net');
const http = require('node:http');

/**
 * 测试代理连通性 (支持 HTTP 和 SOCKS5)
 */
function testProxy(proxyConfig) {
  return new Promise((resolve) => {
    const startTime = Date.now();
    const type = (proxyConfig.type || 'socks5').toLowerCase();
    const host = proxyConfig.host;
    const port = Number(proxyConfig.port);
    const username = proxyConfig.username || '';
    const password = proxyConfig.password || '';

    if (!host || !port) {
      return resolve({ success: false, message: '代理主机或端口为空' });
    }

    if (type === 'socks5') {
      const socket = net.createConnection({ host, port }, () => {
        // SOCKS5 握手
        socket.write(Buffer.from([0x05, 0x02, 0x00, 0x02]));
      });

      socket.setTimeout(6000, () => {
        socket.destroy();
        resolve({ success: false, message: '连接代理服务器超时 (6s)' });
      });

      socket.once('data', greeting => {
        if (greeting[0] !== 0x05) {
          socket.destroy();
          return resolve({ success: false, message: '非有效 SOCKS5 协议响应' });
        }

        const method = greeting[1];
        if (method === 0x02) {
          // 需要密码认证
          if (!username) {
            socket.destroy();
            return resolve({ success: false, message: '代理服务器要求账号密码，但未填写' });
          }
          const uBuf = Buffer.from(username);
          const pBuf = Buffer.from(password);
          const authPacket = Buffer.concat([
            Buffer.from([0x01, uBuf.length]),
            uBuf,
            Buffer.from([pBuf.length]),
            pBuf
          ]);
          socket.write(authPacket);

          socket.once('data', authRes => {
            const latency = Date.now() - startTime;
            if (authRes && authRes.length >= 2 && authRes[1] === 0x00) {
              socket.destroy();
              resolve({ success: true, latency, message: `SOCKS5 代理认证成功！延迟 ${latency}ms` });
            } else {
              socket.destroy();
              resolve({ success: false, latency, message: 'SOCKS5 代理账号或密码错误 (认证失败)' });
            }
          });
        } else if (method === 0x00) {
          // 无需认证
          const latency = Date.now() - startTime;
          socket.destroy();
          resolve({ success: true, latency, message: `SOCKS5 代理连接成功 (免密)！延迟 ${latency}ms` });
        } else {
          socket.destroy();
          resolve({ success: false, message: '代理服务器不支持的认证方式' });
        }
      });

      socket.on('error', err => {
        resolve({ success: false, message: `连接失败: ${err.message}` });
      });
    } else {
      // HTTP 代理测试
      const req = http.request({
        host,
        port,
        method: 'CONNECT',
        path: 'www.google.com:443',
        headers: username ? {
          'Proxy-Authorization': 'Basic ' + Buffer.from(`${username}:${password}`).toString('base64')
        } : {}
      });

      req.setTimeout(6000, () => {
        req.destroy();
        resolve({ success: false, message: '连接 HTTP 代理超时 (6s)' });
      });

      req.on('connect', (res, socket) => {
        const latency = Date.now() - startTime;
        socket.destroy();
        if (res.statusCode === 200) {
          resolve({ success: true, latency, message: `HTTP 代理连通正常！延迟 ${latency}ms` });
        } else if (res.statusCode === 407) {
          resolve({ success: false, latency, message: 'HTTP 代理 407: 代理账号或密码错误 (认证失败)' });
        } else {
          resolve({ success: false, latency, message: `HTTP 代理返回状态码: ${res.statusCode}` });
        }
      });

      // 当代理返回非 200/非 CONNECT 建立时（如 403, 407, 502 等），处理 response 避免卡死超时
      req.on('response', res => {
        const latency = Date.now() - startTime;
        req.destroy();
        if (res.statusCode === 407) {
          resolve({ success: false, latency, message: 'HTTP 代理 407: 代理账号或密码错误 (认证失败)' });
        } else {
          resolve({ success: false, latency, message: `HTTP 代理返回状态码: ${res.statusCode}` });
        }
      });

      req.on('error', err => {
        resolve({ success: false, message: `HTTP 代理连接失败: ${err.message}` });
      });

      req.end();
    }
  });
}

module.exports = { testProxy };
