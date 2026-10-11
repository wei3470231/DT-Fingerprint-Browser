'use strict';

const net = require('node:net');
const http = require('node:http');

/**
 * 向 SOCKS5 代理发送 CONNECT 报文验证外网出口连通性 (探测公共 DNS 1.1.1.1:80)
 */
function verifySocks5Outbound(socket, startTime, resolve, prefixMsg) {
  // CONNECT 请求: VER=0x05, CMD=0x01(CONNECT), RSV=0x00, ATYP=0x01(IPv4), 1.1.1.1, PORT=80 (0x0050)
  const probePacket = Buffer.from([
    0x05, 0x01, 0x00, 0x01,
    0x01, 0x01, 0x01, 0x01,
    0x00, 0x50
  ]);

  socket.write(probePacket);
  socket.once('data', reply => {
    socket.destroy();
    const latency = Date.now() - startTime;
    if (reply && reply.length >= 2 && reply[0] === 0x05 && reply[1] === 0x00) {
      resolve({ success: true, latency, message: `SOCKS5 代理${prefixMsg}且外网打通！延迟 ${latency}ms` });
    } else {
      const rep = reply ? reply[1] : -1;
      const repReasons = {
        1: '通用失败 (General failure)',
        2: '规则集禁止连接 (Connection not allowed by ruleset)',
        3: '网络不可达 (Network unreachable)',
        4: '目标主机不可达 (Host unreachable)',
        5: '连接被拒绝 (Connection refused)',
        6: 'TTL超时 (TTL expired)'
      };
      const detail = repReasons[rep] || `REP code 0x${(rep || 0).toString(16)}`;
      resolve({ success: false, latency, message: `SOCKS5 握手通过但外网连通受阻: ${detail}` });
    }
  });
}

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
            if (authRes && authRes.length >= 2 && authRes[1] === 0x00) {
              // 认证成功，进一步发送 CONNECT 请求验证外网连通性 (探测 1.1.1.1:80)
              verifySocks5Outbound(socket, startTime, resolve, '认证成功');
            } else {
              socket.destroy();
              const latency = Date.now() - startTime;
              resolve({ success: false, latency, message: 'SOCKS5 代理账号或密码错误 (认证失败)' });
            }
          });
        } else if (method === 0x00) {
          // 无需认证，进一步发送 CONNECT 请求验证外网连通性 (探测 1.1.1.1:80)
          verifySocks5Outbound(socket, startTime, resolve, '免密连接');
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
