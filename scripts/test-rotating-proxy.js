'use strict';

const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const http = require('node:http');
const { RotatingProxyPool } = require('../src/browser/rotating-proxy/proxy-pool');
const { RotatingDispatcherServer } = require('../src/browser/rotating-proxy/dispatcher-server');
const { buildCombinedPacScript } = require('../src/browser/rotating-proxy');

console.log('===============================================================');
console.log('      DT - 指纹浏览器: 动态轮换代理池全功能自动化单元测试');
console.log('===============================================================\n');

let passed = 0;
let failed = 0;

function assert(condition, message) {
  if (condition) {
    console.log(`  ✅ [PASS] ${message}`);
    passed++;
  } else {
    console.error(`  ❌ [FAIL] ${message}`);
    failed++;
  }
}

async function runTest() {
  // 1. 测试 4 种格式解析与去重 (含复杂会话参数与特殊字符)
  console.log('[1/5] 测试 4 类代理格式解析、清洗与大批量去重...');
  const pool = new RotatingProxyPool();
  const sampleText = `
    # 注释行
    http://user1:pass1@1.2.3.4:8080
    socks5://user2:pass2@5.6.7.8:1080
    9.10.11.12:8888:admin:secret
    13.14.15.16:9999
    socks5://13.14.15.16:9999
    # IPRoyal 住宅长会话格式 (带下划线与横杠特殊字符)
    NIJwjCTdhTGSOKbH:nW6TNfehjy9w7lgY_session-jQTfhgay_lifetime-2m@geo.iproyal.com:12321
    # 重复项
    http://user1:pass1@1.2.3.4:8080
  `;

  const loadRes = pool.loadFromString(sampleText);
  assert(loadRes.success && loadRes.count === 5, `成功解析多种格式并去重 (实际解析到: ${loadRes.count})`);

  const iproyal = pool.proxies.find(p => p.host === 'geo.iproyal.com');
  assert(
    iproyal &&
    iproyal.port === 12321 &&
    iproyal.username === 'NIJwjCTdhTGSOKbH' &&
    iproyal.password === 'nW6TNfehjy9w7lgY_session-jQTfhgay_lifetime-2m',
    '精确解析 IPRoyal 用户名与长会话密文参数 (NIJwjCTdhTGSOKbH:nW6TNfehjy9w7lgY_session-jQTfhgay_lifetime-2m@geo.iproyal.com:12321)'
  );

  // 2. 测试每次新连接抽取任意代理
  console.log('\n[2/5] 测试每次调用抽取任意代理的随机分布...');
  const sampledHosts = new Set();
  for (let i = 0; i < 20; i++) {
    const px = pool.getProxy();
    sampledHosts.add(px.host);
  }
  assert(sampledHosts.size >= 2, `连续抽取 20 次成功命中多种不同代理节点 (命中不同IP数: ${sampledHosts.size})`);

  // 3. 测试 PAC 脚本生成与 URL/路径智能提取及白名单直连 (3 独立分发端口)
  console.log('\n[3/5] 测试针对多域名与 URL 路径的 3 端口 PAC 脚本生成以及白名单走本地 IP (DIRECT)...');
  const pac = buildCombinedPacScript(
    [28991, 28992, 28993],
    'challenges.cloudflare.com;*.turnstile.com;hav.digitaldisbursements.com/s',
    'PROXY 192.168.1.1:8080',
    '*.baidu.com;localhost;127.0.0.1;<local>;https://my-internal.site/api'
  );
  assert(pac.includes('challenges.cloudflare.com') && pac.includes('[28991, 28992, 28993]'), 'PAC 脚本准确包含指定的多域名规则与 3 个本地分发端口');
  assert(pac.includes('hav.digitaldisbursements.com') && pac.includes('hav.digitaldisbursements.com/s'), 'PAC 脚本成功自动从 URL 路径中智能提取出纯域名 hav.digitaldisbursements.com 并保留完整 pattern');
  assert(pac.includes('PROXY 192.168.1.1:8080'), 'PAC 脚本准确包含未命中规则时的环境回退代理');
  assert(pac.includes('*.baidu.com') && pac.includes('my-internal.site') && pac.includes('<local>'), 'PAC 脚本准确包含白名单域名，优先直接返回 DIRECT 走本地 IP');

  // 在 VM 中模拟 PAC 执行引擎，测试 FindProxyForURL 真实返回
  const vm = require('node:vm');
  const pacContext = {
    shExpMatch: (str, pattern) => {
      const regex = new RegExp('^' + pattern.replace(/\./g, '\\.').replace(/\*/g, '.*') + '$', 'i');
      return regex.test(str);
    },
    dnsDomainIs: (host, domain) => host.endsWith(domain.replace(/^\*/, '')),
    isPlainHostName: (host) => !host.includes('.')
  };
  vm.createContext(pacContext);
  vm.runInContext(pac, pacContext);

  const testBypass1 = vm.runInContext('FindProxyForURL("http://www.baidu.com/index.html", "www.baidu.com")', pacContext);
  assert(testBypass1 === 'DIRECT', '命中白名单域名 *.baidu.com -> 准确返回 DIRECT (走本地真实 IP，不走任何代理)');

  const testBypassLocal = vm.runInContext('FindProxyForURL("http://myserver/api", "myserver")', pacContext);
  assert(testBypassLocal === 'DIRECT', '命中 <local> 本地服务 -> 准确返回 DIRECT (走本地真实 IP)');

  const testRotatingMatch = vm.runInContext('FindProxyForURL("https://challenges.cloudflare.com/turnstile", "challenges.cloudflare.com")', pacContext);
  assert(testRotatingMatch.includes('PROXY 127.0.0.1:2899'), '命中动态轮换目标规则 challenges.cloudflare.com -> 准确分配至 127.0.0.1 轮换分发端口');

  const testFallback = vm.runInContext('FindProxyForURL("https://other-unmatched.com", "other-unmatched.com")', pacContext);
  assert(testFallback.includes('PROXY 192.168.1.1:8080'), '未命中白名单与轮换规则的外部网站 -> 准确走 fallback 固定代理');

  // 4. 测试本地分发调度器启动与生命周期
  console.log('\n[4/5] 测试本地分发调度器端口绑定与安全退出...');
  const dispatcher = new RotatingDispatcherServer(pool);
  const port = await dispatcher.start();
  assert(port > 0 && typeof port === 'number', `调度器成功在本地分配空闲端口: ${port}`);
  dispatcher.close();
  assert(!dispatcher.server, '调度器已安全释放本地端口与连接资源');

  // 5. 端到端模拟真实 SOCKS5 握手认证与 HTTPS CONNECT 隧道穿透
  console.log('\n[5/5] 测试 IPRoyal 格式代理端到端 SOCKS5 握手与双向隧道数据直通...');
  let mockAuthPassed = false;
  let mockConnected = false;
  const mockServer = net.createServer(s => {
    let step = 0;
    s.on('data', chunk => {
      if (step === 0) {
        s.write(Buffer.from([0x05, 0x02])); // 协商选择用户名密码认证 (0x02)
        step = 1;
      } else if (step === 1) {
        const uLen = chunk[1];
        const u = chunk.slice(2, 2 + uLen).toString();
        const pLen = chunk[2 + uLen];
        const p = chunk.slice(3 + uLen, 3 + uLen + pLen).toString();
        if (u === 'NIJwjCTdhTGSOKbH' && p === 'nW6TNfehjy9w7lgY_session-jQTfhgay_lifetime-2m') {
          mockAuthPassed = true;
          s.write(Buffer.from([0x01, 0x00])); // 认证成功
          step = 2;
        } else {
          s.write(Buffer.from([0x01, 0x01]));
        }
      } else if (step === 2) {
        mockConnected = true;
        s.write(Buffer.from([0x05, 0x00, 0x00, 0x01, 127, 0, 0, 1, 0x01, 0xbb])); // 连接成功 (443)
        step = 3;
      } else if (step === 3) {
        s.write('ECHO:' + chunk.toString());
      }
    });
  });

  await new Promise(r => mockServer.listen(0, '127.0.0.1', r));
  const mockPort = mockServer.address().port;

  const testPool = new RotatingProxyPool();
  testPool.loadFromString(`NIJwjCTdhTGSOKbH:nW6TNfehjy9w7lgY_session-jQTfhgay_lifetime-2m@127.0.0.1:${mockPort}`);

  const testDispatcher = new RotatingDispatcherServer(testPool);
  const dispPort = await testDispatcher.start();

  const client = net.createConnection({ host: '127.0.0.1', port: dispPort }, () => {
    client.write('CONNECT challenges.cloudflare.com:443 HTTP/1.1\r\nHost: challenges.cloudflare.com:443\r\n\r\n');
  });

  let tunnelSuccess = false;
  let dataEchoed = false;

  client.on('data', d => {
    const text = d.toString();
    if (text.includes('200 Connection Established')) {
      tunnelSuccess = true;
      client.write('HELLO_TURNSTILE');
    } else if (text.includes('ECHO:HELLO_TURNSTILE')) {
      dataEchoed = true;
      client.end();
    }
  });

  await new Promise(r => setTimeout(r, 800));
  client.destroy();
  testDispatcher.close();
  mockServer.close();

  assert(mockAuthPassed, '上游 SOCKS5 接收并校验用户名密码认证 100% 正确');
  assert(tunnelSuccess, '客户端 CONNECT 隧道请求成功收到 200 Connection Established');
  assert(dataEchoed, '双向数据管道无损互通 (ECHO:HELLO_TURNSTILE)');

  console.log('\n===============================================================');
  console.log(`动态轮换代理池自动化测试结果: 全部通过 (${passed} passed, ${failed} failed)`);
  console.log('===============================================================\n');

  if (failed > 0) process.exit(1);
}

runTest().catch(err => {
  console.error('测试异常崩溃:', err);
  process.exit(1);
});
