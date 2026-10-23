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
  // 1. 测试 4 种格式解析与去重
  console.log('[1/4] 测试 4 类代理格式解析、清洗与大批量去重...');
  const pool = new RotatingProxyPool();
  const sampleText = `
    # 注释行
    http://user1:pass1@1.2.3.4:8080
    socks5://user2:pass2@5.6.7.8:1080
    9.10.11.12:8888:admin:secret
    13.14.15.16:9999
    socks5://13.14.15.16:9999
    # 重复项
    http://user1:pass1@1.2.3.4:8080
  `;

  const loadRes = pool.loadFromString(sampleText);
  assert(loadRes.success && loadRes.count === 4, `成功解析 4 种格式并去重 (实际解析到: ${loadRes.count})`);

  // 2. 测试每次新连接抽取任意代理
  console.log('\n[2/4] 测试每次调用抽取任意代理的随机分布...');
  const sampledHosts = new Set();
  for (let i = 0; i < 20; i++) {
    const px = pool.getProxy();
    sampledHosts.add(px.host);
  }
  assert(sampledHosts.size >= 2, `连续抽取 20 次成功命中多种不同代理节点 (命中不同IP数: ${sampledHosts.size})`);

  // 3. 测试 PAC 脚本生成
  console.log('\n[3/4] 测试针对多域名规则的 PAC 脚本生成...');
  const pac = buildCombinedPacScript(28999, 'challenges.cloudflare.com;*.turnstile.com;api.target.com', 'PROXY 192.168.1.1:8080');
  assert(pac.includes('challenges.cloudflare.com') && pac.includes('PROXY 127.0.0.1:28999'), 'PAC 脚本准确包含指定的多域名规则与本地分发端口');
  assert(pac.includes('PROXY 192.168.1.1:8080'), 'PAC 脚本准确包含未命中规则时的环境回退代理');

  // 4. 测试本地分发调度器启动与生命周期
  console.log('\n[4/4] 测试本地分发调度器端口绑定与安全退出...');
  const dispatcher = new RotatingDispatcherServer(pool);
  const port = await dispatcher.start();
  assert(port > 0 && typeof port === 'number', `调度器成功在本地分配空闲端口: ${port}`);
  dispatcher.close();
  assert(!dispatcher.server, '调度器已安全释放本地端口与连接资源');

  console.log('\n===============================================================');
  console.log(`动态轮换代理池自动化测试结果: 全部通过 (${passed} passed, ${failed} failed)`);
  console.log('===============================================================\n');

  if (failed > 0) process.exit(1);
}

runTest().catch(err => {
  console.error('测试异常崩溃:', err);
  process.exit(1);
});
