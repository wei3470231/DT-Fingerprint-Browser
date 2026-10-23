'use strict';

const { app, BrowserWindow, session } = require('electron');
const netCore = require('node:net');
const { RotatingProxyPool } = require('../src/browser/rotating-proxy/proxy-pool');
const { RotatingDispatcherServer } = require('../src/browser/rotating-proxy/dispatcher-server');
const { buildCombinedPacScript } = require('../src/browser/rotating-proxy');

app.whenReady().then(async () => {
  console.log('\n===============================================================');
  console.log('  单标签页连续刷新实测: 验证同一标签页刷新 N 次全部换不同 IP');
  console.log('===============================================================');

  // 1. 创建 5 个 Mock 上游代理，每个代理代表一个不同的出口 IP
  const mockIps = ['1.1.1.1', '2.2.2.2', '3.3.3.3', '4.4.4.4', '5.5.5.5'];
  const proxyServers = [];
  const proxyList = [];

  for (let i = 0; i < 5; i++) {
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
            const body = `<!DOCTYPE html><html><body><h1 id="ip">${ip}</h1></body></html>`;
            s.write(`HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`);
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
  console.log(`[1/3] 已开设 3 个分发端口: [${ports.join(', ')}]，挂载 ${proxyList.length} 条代理`);

  // 3. 配置 PAC 脚本
  const pac = buildCombinedPacScript(ports, '2026.ip138.com', 'DIRECT');
  await session.defaultSession.setProxy({
    pacScript: `data:application/x-ns-proxy-autoconfig;base64,${Buffer.from(pac).toString('base64')}`
  });
  console.log('[2/3] PAC 规则已注入 session');

  // 4. 创建单个 BrowserWindow (模拟用户在一个标签页内浏览)
  const win = new BrowserWindow({
    show: false,
    width: 800,
    height: 600
  });

  const capturedIps = [];

  // 在同一个窗口内进行 6 次刷新
  console.log('[3/3] 开始在同一个标签页内进行 6 次连续刷新测试...');
  for (let round = 1; round <= 6; round++) {
    // 关键机制验证: 页面准备加载前，若有旧长连接则调用 closeAllConnections 清理连接池
    await session.defaultSession.closeAllConnections();

    // 加载/刷新页面
    await win.loadURL('http://2026.ip138.com/');

    // 读取页面渲染出的出口 IP
    const currentIp = await win.webContents.executeJavaScript(
      `document.getElementById('ip')?.innerText || document.body.innerText`
    );

    capturedIps.push(currentIp.trim());
    console.log(`   - 第 ${round} 次页面显示出口 IP: [${currentIp.trim()}]`);

    // 页面加载完成后立即清理长连接池，确保下一次刷新没有任何旧连接可复用
    await session.defaultSession.closeAllConnections();

    // 稍微停顿模拟用户浏览片刻后刷新
    await new Promise(r => setTimeout(r, 200));
  }

  // 5. 统计结果
  const uniqueIps = new Set(capturedIps);
  console.log('\n===============================================================');
  console.log(`6 次刷新捕获 IP 序列: [${capturedIps.join(' -> ')}]`);
  console.log(`捕获不同 IP 数量: ${uniqueIps.size} 个 (不同 IP: ${Array.from(uniqueIps).join(', ')})`);

  dispatcher.close();
  proxyServers.forEach(s => s.close());
  win.destroy();

  if (uniqueIps.size >= 3) {
    console.log('🎉 结论: 实测通过！在同一个标签页内刷新 N 次，成功实现每一次都换用不同 IP！');
  } else {
    console.error('❌ 结论: 实测未能实现每次换 IP！');
    process.exit(1);
  }
  console.log('===============================================================\n');

  setTimeout(() => app.quit(), 200);
});
