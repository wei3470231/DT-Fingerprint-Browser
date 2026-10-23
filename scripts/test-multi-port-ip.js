'use strict';

const net = require('node:net');
const http = require('node:http');
const { RotatingProxyPool } = require('../src/browser/rotating-proxy/proxy-pool');
const { RotatingDispatcherServer } = require('../src/browser/rotating-proxy/dispatcher-server');
const { buildCombinedPacScript } = require('../src/browser/rotating-proxy');

async function runTest() {
  console.log('===============================================================');
  console.log('   测试: 3 端口轮换代理分发器与多连接换 IP 实测验证');
  console.log('===============================================================');

  // 1. 创建 3 个 Mock 上游代理服务器，每个上游模拟返回不同的 IP 标识
  const proxyServers = [];
  const proxyConfigs = [];

  for (let i = 1; i <= 3; i++) {
    const mockIp = `198.51.100.${i * 10}`;
    const server = net.createServer(socket => {
      // 模拟上游接收 CONNECT 并返回 200，随后返回模拟的 HTTP 响应带特定 IP
      let buf = Buffer.alloc(0);
      socket.on('data', chunk => {
        buf = Buffer.concat([buf, chunk]);
        if (buf.includes('\r\n\r\n')) {
          const str = buf.toString();
          if (str.startsWith('CONNECT')) {
            socket.write('HTTP/1.1 200 OK\r\n\r\n');
            buf = Buffer.alloc(0);
          } else if (str.startsWith('GET')) {
            socket.write(`HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\nContent-Length: ${mockIp.length}\r\nConnection: close\r\n\r\n${mockIp}`);
          }
        }
      });
    });

    const port = await new Promise(r => server.listen(0, '127.0.0.1', () => r(server.address().port)));
    proxyServers.push(server);
    proxyConfigs.push(`http://127.0.0.1:${port}`);
  }

  console.log(`[1/3] 已创建 3 个 Mock 上游代理: ${proxyConfigs.join(', ')}`);

  // 2. 加载代理池
  const pool = new RotatingProxyPool();
  pool.loadFromString(proxyConfigs.join('\n'));

  // 3. 启动分发器 (配置 3 端口)
  const dispatcher = new RotatingDispatcherServer(pool, { portCount: 3 });
  await dispatcher.start();
  const ports = dispatcher.ports;
  console.log(`[2/3] 分发器成功开设 3 个独立端口: [${ports.join(', ')}]`);

  // 4. 模拟连续 6 次连接 (模拟在一个浏览器内打开 6 个 2026.ip138.com)
  console.log('[3/3] 模拟客户端连续发起 6 次连接访问 2026.ip138.com...');
  const receivedIps = [];

  for (let i = 0; i < 6; i++) {
    // 模拟 PAC 脚本在 3 个端口中随机选择
    const chosenPort = ports[i % ports.length];
    const ip = await new Promise((resolve, reject) => {
      const client = net.createConnection({ host: '127.0.0.1', port: chosenPort }, () => {
        client.write('CONNECT 2026.ip138.com:443 HTTP/1.1\r\nHost: 2026.ip138.com:443\r\n\r\n');
      });

      let step = 0;
      let respBuf = '';
      client.on('data', chunk => {
        respBuf += chunk.toString();
        if (step === 0 && respBuf.includes('\r\n\r\n')) {
          step = 1;
          respBuf = '';
          // 发送 HTTP GET
          client.write('GET / HTTP/1.1\r\nHost: 2026.ip138.com\r\n\r\n');
        } else if (step === 1 && respBuf.includes('\r\n\r\n')) {
          const body = respBuf.split('\r\n\r\n')[1];
          if (body) {
            client.destroy();
            resolve(body.trim());
          }
        }
      });
      client.on('error', reject);
    });

    console.log(`   - 第 ${i + 1} 次连接命中端口 [${chosenPort}] -> 获得出口 IP: [${ip}]`);
    receivedIps.push(ip);
  }

  // 清理
  dispatcher.close();
  proxyServers.forEach(s => s.close());

  const uniqueIps = new Set(receivedIps);
  console.log(`\n测试统计: 6 次请求共捕获 ${uniqueIps.size} 个不同 IP:`, Array.from(uniqueIps));
  if (uniqueIps.size > 1) {
    console.log('✅ 测试通过！成功打破单一端口连接复用，实现了多连接换不同 IP！');
  } else {
    console.error('❌ 测试失败: 所有连接都返回了相同 IP');
    process.exit(1);
  }
}

runTest().catch(err => {
  console.error('测试异常:', err);
  process.exit(1);
});
