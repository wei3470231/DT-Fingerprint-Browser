'use strict';
// 端到端自检：用定制内核真实打开多个标签页，读取页面实际指纹并与身份配置比对。
// 运行：node fp-sdk/examples/tab-browser/start.js --self-test（使用临时 userData，结束后退出）。
const fs = require('node:fs');
const path = require('node:path');

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

async function probe(tab, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const wc = tab.view && !tab.view.webContents.isDestroyed() ? tab.view.webContents : null;
    if (wc && !wc.isLoading()) {
      const value = await wc.executeJavaScript('window.__fpb || null').catch(() => null);
      if (value) return { value, contentsId: wc.id };
    }
    await delay(150);
  }
  throw new Error(`标签页 ${tab.id} 未在 ${timeoutMs} ms 内完成指纹读取`);
}
const exec = (tab, code) => tab.view.webContents.executeJavaScript(code);

async function run(api) {
  const results = [];
  const check = (name, actual, expected) => {
    const ok = JSON.stringify(actual) === JSON.stringify(expected);
    results.push({ name, ok, ...(ok ? {} : { actual, expected }) });
  };
  try {
    const [a, b] = api.profiles;
    // 1. 自定义身份 A 的指纹（模拟用户在编辑器中修改后保存）
    const customA = {
      ...api.formFromFingerprint(a.fp), language: 'ja-JP', timezone: 'Asia/Tokyo', cores: 12, memory: 8,
      screen: '2560x1440', os: '15.0.0', gpuVendor: 'Google Inc. (NVIDIA)',
      gpuRenderer: 'ANGLE (NVIDIA, NVIDIA GeForce RTX 4070 Direct3D11 vs_5_0 ps_5_0, D3D11)',
    };
    const saved = await api.saveProfile({ id: a.id, name: '身份 A · 东京', color: a.color, proxy: '', form: customA });
    check('保存 A 后重启其 1 个标签页', saved.restarted, 1);

    // 2. A 再开一个标签页，B 保持一个
    await api.openTab(a.id);
    const tabsA = api.tabs.filter(tab => tab.profileId === a.id), tabsB = api.tabs.filter(tab => tab.profileId === b.id);
    check('标签页数量 A/B', [tabsA.length, tabsB.length], [2, 1]);

    const expect = (label, fp, value) => {
      check(`${label} userAgent`, value.userAgent, fp.uaString);
      check(`${label} 核心数`, value.hardwareConcurrency, fp.navigator.hardwareConcurrency);
      check(`${label} 内存`, value.deviceMemory, fp.navigator.deviceMemory);
      check(`${label} 语言`, value.languages, fp.navigator.languages);
      check(`${label} 时区`, value.timezone, fp.timezone);
      check(`${label} 屏幕`, [value.screen.width, value.screen.height], [fp.screen.width, fp.screen.height]);
      check(`${label} WebGL 渲染器`, value.webglRenderer, fp.webgl.renderer);
      check(`${label} webdriver`, value.webdriver, false);
    };
    const [a1, a2, b1] = [await probe(tabsA[0]), await probe(tabsA[1]), await probe(tabsB[0])];
    expect('A#1', a.fp, a1.value);
    expect('A#2', a.fp, a2.value);
    expect('B#1', b.fp, b1.value);
    check('A 自定义时区生效', a1.value.timezone, 'Asia/Tokyo');
    check('A 两个标签页 Canvas 一致', a1.value.canvasHash === a2.value.canvasHash, true);
    check('A 与 B 的 Canvas 不同', a1.value.canvasHash !== b1.value.canvasHash, true);

    // 3. 存储：同一身份标签页共享，不同身份隔离
    await exec(tabsA[0], "localStorage.setItem('self-test', 'A'); document.cookie = 'fpb=A; path=/'; true");
    check('A#2 读到 A 的 localStorage', await exec(tabsA[1], "localStorage.getItem('self-test')"), 'A');
    check('A#2 读到 A 的 Cookie', await exec(tabsA[1], "document.cookie.includes('fpb=A')"), true);
    check('B 读不到 A 的 localStorage', await exec(tabsB[0], "localStorage.getItem('self-test')"), null);
    check('B 读不到 A 的 Cookie', await exec(tabsB[0], "document.cookie.includes('fpb=A')"), false);

    // 4. 修改 B：B 的标签页重建并生效，A 的标签页不受影响
    const saveB = await api.saveProfile({ id: b.id, name: b.name, color: b.color, proxy: '', form: { ...api.formFromFingerprint(b.fp), cores: 6, timezone: 'Europe/Berlin' } });
    check('保存 B 后重启其 1 个标签页', saveB.restarted, 1);
    const b1After = await probe(tabsB[0]);
    check('B 新时区生效', b1After.value.timezone, 'Europe/Berlin');
    check('B 新核心数生效', b1After.value.hardwareConcurrency, 6);
    check('B 修改后 Cookie 与存储保留', await exec(tabsB[0], "localStorage.getItem('fpb-visits') !== null"), true);
    check('A#1 未被重建', (await probe(tabsA[0])).contentsId, a1.contentsId);

    // 5. 界面状态与关闭标签页
    api.activate(tabsA[1].id);
    await delay(300);
    check('界面标签数与主进程一致', await api.ui.webContents.executeJavaScript("document.querySelectorAll('#tabs .tab').length"), api.tabs.length);
    await api.ui.webContents.executeJavaScript("document.querySelector('#toggle-drawer').click()");
    await delay(500);
    check('身份抽屉列出全部身份', await api.ui.webContents.executeJavaScript("document.querySelectorAll('.profile-card').length"), api.profiles.length);
    const dir = require('electron').app.getPath('userData');
    const shots = { ui: path.join(dir, 'self-test-ui.png'), page: path.join(dir, 'self-test-page.png') };
    fs.writeFileSync(shots.ui, (await api.ui.webContents.capturePage()).toPNG());
    fs.writeFileSync(shots.page, (await tabsA[1].view.webContents.capturePage()).toPNG());
    api.closeTab(tabsA[1].id);
    check('关闭后剩余标签数', api.tabs.length, 2);
    results.push({ name: '截图', ok: true, detail: shots });
  } catch (error) {
    results.push({ name: '执行异常', ok: false, error: error.stack || String(error) });
  }
  const failed = results.filter(result => !result.ok);
  console.log(JSON.stringify({ passed: results.length - failed.length, failed: failed.length, results }, null, 2));
  return failed.length ? 1 : 0;
}

module.exports = { run };
