'use strict';

const net = require('node:net');

/**
 * 本地 SOCKS5 认证中转桥接服务 (解决 Chromium 原生不支持 SOCKS5 用户名/密码认证的问题)
 * 采用严格的 TCP 流式数据缓冲区与状态机，彻底杜绝数据分包、粘包与流水线请求导致的挂起死锁。
 */
function createSocks5AuthBridge(targetHost, targetPort, username, password) {
  return new Promise((resolve, reject) => {
    const server = net.createServer({ pauseOnConnect: false }, clientSocket => {
      let clientBuffer = Buffer.alloc(0);
      let upstreamBuffer = Buffer.alloc(0);
      let stage = 'greeting'; // 'greeting' | 'connect' | 'piped' | 'destroyed'
      let clientRequest = null;
      let upstream = null;

      function destroyAll() {
        if (stage === 'destroyed') return;
        stage = 'destroyed';
        try { clientSocket.destroy(); } catch (_) {}
        if (upstream) {
          try { upstream.destroy(); } catch (_) {}
        }
      }

      clientSocket.on('error', destroyAll);
      clientSocket.on('close', destroyAll);

      function getSocks5PacketLength(buf) {
        if (buf.length < 4) return 0;
        const atyp = buf[3];
        if (atyp === 0x01) {
          // IPv4: 4 (header) + 4 (IPv4) + 2 (Port) = 10
          return 10;
        } else if (atyp === 0x03) {
          // Domain: 4 (header) + 1 (len) + domainLen + 2 (Port)
          if (buf.length < 5) return 0;
          const dlen = buf[4];
          return 4 + 1 + dlen + 2;
        } else if (atyp === 0x04) {
          // IPv6: 4 (header) + 16 (IPv6) + 2 (Port) = 22
          return 22;
        }
        return -1; // 无效类型
      }

      function handleClientData(chunk) {
        if (stage === 'piped' || stage === 'destroyed') return;
        clientBuffer = Buffer.concat([clientBuffer, chunk]);

        if (stage === 'greeting') {
          if (clientBuffer.length < 2) return;
          if (clientBuffer[0] !== 0x05) return destroyAll();
          const nMethods = clientBuffer[1];
          if (clientBuffer.length < 2 + nMethods) return;

          // 消费客户端协商报文
          clientBuffer = clientBuffer.slice(2 + nMethods);
          stage = 'connect';

          // 响应客户端：无需认证 (0x00)
          clientSocket.write(Buffer.from([0x05, 0x00]));
        }

        if (stage === 'connect') {
          const reqLen = getSocks5PacketLength(clientBuffer);
          if (reqLen === -1) return destroyAll();
          if (reqLen === 0 || clientBuffer.length < reqLen) return;

          clientRequest = clientBuffer.slice(0, reqLen);
          const extraClientData = clientBuffer.slice(reqLen);
          clientBuffer = extraClientData;
          stage = 'upstream_connecting';

          // 建立远端上游连接
          upstream = net.createConnection({ host: targetHost, port: Number(targetPort) }, () => {
            // 发起带有密码认证 (0x02) 的握手
            upstream.write(Buffer.from([0x05, 0x01, 0x02]));
          });

          upstream.on('error', destroyAll);
          upstream.on('close', destroyAll);

          let upstreamStep = 0; // 0: 等待握手响应, 1: 等待认证响应, 2: 等待连接响应

          upstream.on('data', upChunk => {
            if (stage === 'piped' || stage === 'destroyed') return;
            upstreamBuffer = Buffer.concat([upstreamBuffer, upChunk]);

            if (upstreamStep === 0) {
              if (upstreamBuffer.length < 2) return;
              if (upstreamBuffer[0] !== 0x05) return destroyAll();
              const method = upstreamBuffer[1];
              upstreamBuffer = upstreamBuffer.slice(2);

              if (method === 0x02) {
                // 需要账号密码认证
                upstreamStep = 1;
                const uBuf = Buffer.from(username || '');
                const pBuf = Buffer.from(password || '');
                const authPacket = Buffer.concat([
                  Buffer.from([0x01, uBuf.length]),
                  uBuf,
                  Buffer.from([pBuf.length]),
                  pBuf
                ]);
                upstream.write(authPacket);
              } else if (method === 0x00) {
                // 免密，直接转发客户端 CONNECT 请求
                upstreamStep = 2;
                upstream.write(clientRequest);
              } else {
                return destroyAll();
              }
            }

            if (upstreamStep === 1) {
              if (upstreamBuffer.length < 2) return;
              if (upstreamBuffer[1] !== 0x00) return destroyAll(); // 认证失败
              upstreamBuffer = upstreamBuffer.slice(2);
              upstreamStep = 2;
              upstream.write(clientRequest);
            }

            if (upstreamStep === 2) {
              const respLen = getSocks5PacketLength(upstreamBuffer);
              if (respLen === -1) return destroyAll();
              if (respLen === 0 || upstreamBuffer.length < respLen) return;

              const connectResp = upstreamBuffer.slice(0, respLen);
              const extraUpstreamData = upstreamBuffer.slice(respLen);

              stage = 'piped';
              clientSocket.off('data', handleClientData);

              // 转发连接成功响应回本地客户端
              clientSocket.write(connectResp);

              // 如果客户端在握手期已有流水线堆积数据（例如 TLS Client Hello），转发给远端
              if (clientBuffer.length > 0) {
                upstream.write(clientBuffer);
                clientBuffer = Buffer.alloc(0);
              }

              // 如果远端在 CONNECT 响应中已粘带业务首包，转发给本地客户端
              if (extraUpstreamData.length > 0) {
                clientSocket.write(extraUpstreamData);
                upstreamBuffer = Buffer.alloc(0);
              }

              // 双向全双工管道打通
              clientSocket.pipe(upstream);
              upstream.pipe(clientSocket);
            }
          });
        }
      }

      clientSocket.on('data', handleClientData);
    });

    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      resolve({ server, port });
    });

    server.on('error', reject);
  });
}

module.exports = { createSocks5AuthBridge };
