'use strict';

const { app, net, session } = require('electron');
const netCore = require('node:net');
const { RotatingProxyPool } = require('../src/browser/rotating-proxy/proxy-pool');
const { RotatingDispatcherServer } = require('../src/browser/rotating-proxy/dispatcher-server');
const { buildCombinedPacScript } = require('../src/browser/rotating-proxy');

app.whenReady().then(async () => {
  console.log('\n===============================================================');
  console.log('  Chromium 内核实测: 3 端口轮换代理分发器 + 多标签页换 IP 验证');
  console.log('===============================================================');

  // 1. 创建 3 个上游 Mock 代理，每个代理代表一个独立公网出口 IP
  const mockIps = ['114.114.114.114', '8.8.8.8', '1.1.1.1'];
  const proxyServers = [];
  const proxyList = [];

  for (let i = 0; i < 3; i++) {
    const ip = mockIps[i];
    const server = netCore.createServer(s => {
      let buf = Buffer.alloc(0);
      s.on('data', chunk => {
        buf = Buffer.concat([buf, chunk]);
        if (buf.includes('\r\n\r\n')) {
          const str = buf.toString();
          if (str.startsWith('CONNECT')) {
            s.write('HTTP/1.1 200 Connection Established\r\n\r\n');
            buf = Buffer.alloc(0);
          } else if (str.startsWith('GET')) {
            const body = `{"code":0,"data":{"ip":"${ip}","myip":"${ip}"}}`;
            s.write(`HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`);
          }
        }
      });
    });

    const p = await new Promise(r => server.listen(0, '127.0.0.1', () => r(server.address().port)));
    proxyServers.push(server);
    proxyList.push(`http://127.0.0.1:${p}`);
  }

  // 2. 挂载代理池并开设 3 个分发端口
  const pool = new RotatingProxyPool();
  pool.loadFromString(proxyList.join('\n'));
  const dispatcher = new RotatingDispatcherServer(pool, { portCount: 3 });
  await dispatcher.start();
  const ports = dispatcher.ports;
  console.log(`[1/3] 已成功开设 3 个独立分发端口: [${ports.join(', ')}]`);

  // 3. 生成 PAC 脚本并设置到 Chromium Session
  const pac = buildCombinedPacScript(ports, '2026.ip138.com', 'DIRECT');
  await session.defaultSession.setProxy({
    pacScript: `data:application/x-ns-proxy-autoconfig;base64,${Buffer.from(pac).toString('base64')}`
  });
  console.log('[2/3] PAC 代理规则已成功注入 Chromium 网络会话');

  // 4. 在同一个 Chromium 进程中，连续并发发起 6 次对 http://2026.ip138.com/ 的请求
  console.log('[3/3] 模拟同一浏览器内并发访问 http://2026.ip138.com/ ...');
  const capturedIps = [];

  for (let i = 1; i <= 6; i++) {
    try {
      const res = await net.fetch('http://2026.ip138.com/', {
        headers: { 'Accept': 'application/json' }
      });
      const data = await res.json();
      const ip = data.data?.ip || '未知';
      capturedIps.push(ip);
      console.log(`   - 标签/请求 #${i} 响应出口 IP: [${ip}]`);
    } catch (err) {
      console.warn(`   - 请求 #${i} 异常:`, err.message);
    }
  }

  // 5. 验证是否获取到了多个不同 IP
  const unique = new Set(capturedIps);
  console.log('\n===============================================================');
  console.log(`实测捕获 IP 列表: [${capturedIps.join(', ')}]`);
  console.log(`独立 IP 数量: ${unique.size} 个 (不同 IP: ${Array.from(unique).join(', ')})`);

  dispatcher.close();
  proxyServers.forEach(s => s.close());

  if (unique.size >= 2) {
    console.log('🎉 结论: 实测通过！3 端口分流与短空闲断开成功打破连接复用，各标签页成功换用不同 IP！');
  } else {
    console.error('❌ 结论: 实测未换 IP，需进一步分析！');
  }
  console.log('===============================================================\n');

  setTimeout(() => app.quit(), 200);
});
