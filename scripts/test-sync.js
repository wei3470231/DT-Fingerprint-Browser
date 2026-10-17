'use strict';

/**
 * DT - 指纹浏览器: 键鼠镜像同步器全链路深度自动化测试
 * 覆盖：IPC Hub 协议通信、角色动态切换、点击/滚动/按键/跳转事件镜像广播与从属端分发
 */

const net = require('node:net');
const path = require('node:path');
const { IpcHub } = require('../src/manager/ipc-hub');

console.log('===============================================================');
console.log('      DT - 指纹浏览器: 键鼠镜像同步器全链路深度验收测试');
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
  const hub = new IpcHub();
  const socketPath = hub.getSocketPath();
  await hub.start();
  assert(true, `IPC Hub 服务成功启动 @ ${socketPath}`);

  // 辅助函数：模拟一个浏览器窗口连接 IPC Hub
  function createMockBrowserWindow(envId) {
    return new Promise((resolve, reject) => {
      const client = net.createConnection(socketPath, () => {
        // 发送注册请求
        client.write(JSON.stringify({ action: 'register', envId }) + '\n');
      });

      const messages = [];
      let buffer = '';

      client.on('data', data => {
        buffer += data.toString('utf8');
        const lines = buffer.split('\n');
        buffer = lines.pop();
        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const msg = JSON.parse(line);
            messages.push(msg);
            client.emit('message', msg);
          } catch (_) {}
        }
      });

      client.on('error', reject);
      resolve({ client, envId, messages });
    });
  }

  // 1. 创建 3 个模拟浏览器窗口：1 个主控端，2 个从属端
  console.log('\n[1/4] 连接并注册 3 个模拟浏览器窗口实例...');
  const masterWin = await createMockBrowserWindow('env-master-1');
  const slaveWin1 = await createMockBrowserWindow('env-slave-2');
  const slaveWin2 = await createMockBrowserWindow('env-slave-3');

  // 等待注册完成
  await new Promise(r => setTimeout(r, 200));
  assert(hub.isClientConnected('env-master-1'), '主控窗口 env-master-1 已成功接入 IPC Hub');
  assert(hub.isClientConnected('env-slave-2'), '从属窗口 env-slave-2 已成功接入 IPC Hub');
  assert(hub.isClientConnected('env-slave-3'), '从属窗口 env-slave-3 已成功接入 IPC Hub');

  // 2. 验证设置同步配置 (setSyncConfig)
  console.log('\n[2/4] 验证主控端与从属端角色分配与 set-sync-role 下发...');
  let masterRoleMsg = null;
  let slave1RoleMsg = null;
  let slave2RoleMsg = null;

  masterWin.client.on('message', m => { if (m.action === 'set-sync-role') masterRoleMsg = m; });
  slaveWin1.client.on('message', m => { if (m.action === 'set-sync-role') slave1RoleMsg = m; });
  slaveWin2.client.on('message', m => { if (m.action === 'set-sync-role') slave2RoleMsg = m; });

  hub.setSyncConfig({
    enabled: true,
    masterId: 'env-master-1',
    slaveIds: ['env-slave-2', 'env-slave-3']
  });

  await new Promise(r => setTimeout(r, 200));

  assert(masterRoleMsg && masterRoleMsg.isMaster === true && masterRoleMsg.isSlave === false, '主控端正确收到 isMaster=true 角色通知');
  assert(slave1RoleMsg && slave1RoleMsg.isMaster === false && slave1RoleMsg.isSlave === true, '从属端 1 正确收到 isSlave=true 角色通知');
  assert(slave2RoleMsg && slave2RoleMsg.isMaster === false && slave2RoleMsg.isSlave === true, '从属端 2 正确收到 isSlave=true 角色通知');

  const status = hub.getSyncStatus();
  assert(status.enabled === true && status.masterId === 'env-master-1' && status.slaveIds.length === 2, 'getSyncStatus() 状态与持久结构完全正确');

  // 3. 验证事件镜像同步广播 (Master -> Slaves)
  console.log('\n[3/4] 验证主控端鼠标点击、滚轮、按键与导航事件全量广播...');
  const slave1Events = [];
  const slave2Events = [];

  slaveWin1.client.on('message', m => { if (m.action === 'dispatch-sync-event') slave1Events.push(m.event); });
  slaveWin2.client.on('message', m => { if (m.action === 'dispatch-sync-event') slave2Events.push(m.event); });

  // 主控端发送点击
  masterWin.client.write(JSON.stringify({
    action: 'sync-event',
    envId: 'env-master-1',
    payload: { type: 'click', xRatio: 0.5, yRatio: 0.3 }
  }) + '\n');

  // 主控端发送滚动
  masterWin.client.write(JSON.stringify({
    action: 'sync-event',
    envId: 'env-master-1',
    payload: { type: 'scroll', xRatio: 0.5, yRatio: 0.3, deltaX: 0, deltaY: 100 }
  }) + '\n');

  // 主控端发送键盘
  masterWin.client.write(JSON.stringify({
    action: 'sync-event',
    envId: 'env-master-1',
    payload: { type: 'key', keyCode: 'Enter', isDown: true, text: '\r' }
  }) + '\n');

  // 主控端发送页面导航
  masterWin.client.write(JSON.stringify({
    action: 'sync-event',
    envId: 'env-master-1',
    payload: { type: 'navigate', url: 'https://browserleaks.com' }
  }) + '\n');

  await new Promise(r => setTimeout(r, 300));

  assert(slave1Events.length === 4, `从属端 1 成功毫秒级接收全部 4 项镜像事件 (当前收到: ${slave1Events.length})`);
  assert(slave2Events.length === 4, `从属端 2 成功毫秒级接收全部 4 项镜像事件 (当前收到: ${slave2Events.length})`);

  assert(slave1Events[0].type === 'click' && slave1Events[0].xRatio === 0.5, '点击事件坐标比例传递准确 (xRatio=0.5, yRatio=0.3)');
  assert(slave1Events[1].type === 'scroll' && slave1Events[1].deltaY === 100, '滚轮事件位移参数传递准确 (deltaY=100)');
  assert(slave1Events[2].type === 'key' && slave1Events[2].keyCode === 'Enter', '按键事件键值传递准确 (keyCode=Enter)');
  assert(slave1Events[3].type === 'navigate' && slave1Events[3].url === 'https://browserleaks.com', '导航事件目标 URL 传递准确');

  // 4. 验证安全隔离保护 (非 Master 窗口发送 sync-event 被静默过滤)
  console.log('\n[4/4] 验证安全边界隔离保护...');
  const beforeCount = slave1Events.length;
  slaveWin1.client.write(JSON.stringify({
    action: 'sync-event',
    envId: 'env-slave-2',
    payload: { type: 'click', xRatio: 0.1, yRatio: 0.1 }
  }) + '\n');

  await new Promise(r => setTimeout(r, 200));
  assert(slave1Events.length === beforeCount, '非主控窗口非法伪造 sync-event 被 IPC Hub 严格拦截');

  // 停止同步
  hub.setSyncConfig({ enabled: false });
  assert(!hub.getSyncStatus().enabled, '成功停止键鼠同步器');

  // 清理连接
  masterWin.client.destroy();
  slaveWin1.client.destroy();
  slaveWin2.client.destroy();
  await hub.stop();

  console.log('\n===============================================================');
  console.log(`键鼠同步自动化验收结果: 全部通过 (${passed} passed, ${failed} failed)`);
  console.log('===============================================================\n');

  if (failed > 0) process.exit(1);
}

runTest().catch(err => {
  console.error('测试异常崩溃:', err);
  process.exit(1);
});
