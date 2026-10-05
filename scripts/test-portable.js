'use strict';

/**
 * DT - 指纹浏览器: 便携包全功能自动化验证套件
 * 专门用于测试 dist/payload 便携包的完整性、二进制功能、CLI 接口与独立运行能力
 */

const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const PAYLOAD = path.join(ROOT, 'dist', 'payload');

console.log('===============================================================');
console.log('      DT - 指纹浏览器: 便携发布包全链路自动化验收测试');
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

function runPayloadCli(args) {
  const cliExe = path.join(PAYLOAD, 'DT-CLI.exe');
  try {
    const res = cp.execFileSync(cliExe, args, {
      cwd: PAYLOAD,
      encoding: 'utf8',
      timeout: 15000,
      env: Object.assign({}, process.env)
    });
    return { success: true, stdout: res.trim() };
  } catch (err) {
    return { success: false, error: err.message, stdout: (err.stdout || '').trim() };
  }
}

async function runTests() {
  // 1. 结构与文件完整性检测
  console.log('[1/4] 验证便携包目录结构与核心资产完整性...');
  assert(fs.existsSync(PAYLOAD), `便携包目录存在: ${PAYLOAD}`);
  
  const guiExe = fs.existsSync(path.join(PAYLOAD, 'DT-Fingerprint-Browser.exe'))
    ? path.join(PAYLOAD, 'DT-Fingerprint-Browser.exe')
    : path.join(PAYLOAD, 'DT - 指纹浏览器.exe');
  assert(fs.existsSync(guiExe) && fs.statSync(guiExe).size > 10000, `便携版主程序 "${path.basename(guiExe)}" 存在且体积正常`);

  const cliExe = path.join(PAYLOAD, 'DT-CLI.exe');
  assert(fs.existsSync(cliExe) && fs.statSync(cliExe).size > 10000, '便携版控制台 "DT-CLI.exe" 存在且体积正常');

  const asarFile = path.join(PAYLOAD, 'runtime', 'resources', 'app.asar');
  assert(fs.existsSync(asarFile) && fs.statSync(asarFile).size > 100000, '核心业务代码虚拟归档 "app.asar" 存在且体积正常 (>100KB)');

  const electronExe = path.join(PAYLOAD, 'runtime', 'electron.exe');
  assert(fs.existsSync(electronExe), '定制 Chromium/Electron 内核 "runtime/electron.exe" 存在');

  const fontsDir = path.join(PAYLOAD, 'Fonts');
  assert(fs.existsSync(fontsDir) && fs.readdirSync(fontsDir).length > 0, '精简系统兜底字体库 "Fonts/" 存在且包含字体文件');

  const iconFile = path.join(PAYLOAD, 'app.ico');
  assert(fs.existsSync(iconFile), '高清应用程序图标 "app.ico" 存在');

  // 2. CLI 版本探测与 Chrome Drop-in 模式
  console.log('\n[2/4] 验证便携版 CLI 运行时调用与版本伪装...');
  const verRes = runPayloadCli(['--version']);
  assert(verRes.success && verRes.stdout.includes('Google Chrome'), `版本返回正常: "${verRes.stdout}"`);

  const prodVerRes = runPayloadCli(['--product-version']);
  assert(prodVerRes.success && prodVerRes.stdout.includes('152.'), `产品版本号正常: "${prodVerRes.stdout}"`);

  // 3. CLI JSON 结构化管理指令测试
  console.log('\n[3/4] 验证便携版 CLI 管理控制与 JSON 接口...');
  const listRes = runPayloadCli(['list', '--json']);
  assert(listRes.success, 'dt-cli list --json 执行成功');
  try {
    const listData = JSON.parse(listRes.stdout);
    assert(listData.code === 0 && Array.isArray(listData.data), `环境列表 JSON 解析成功 (包含 ${listData.data ? listData.data.length : 0} 个环境)`);
  } catch (e) {
    assert(false, `list --json 返回非法 JSON: ${e.message}`);
  }

  const fontRes = runPayloadCli(['font', 'status', '--json']);
  assert(fontRes.success, 'dt-cli font status --json 执行成功');
  try {
    const fontData = JSON.parse(fontRes.stdout);
    assert(fontData.code === 0 && fontData.data && (fontData.data.name || fontData.data.fileName), `当前生效字体检测正常: ${fontData.data ? (fontData.data.name || fontData.data.fileName) : ''}`);
  } catch (e) {
    assert(false, `font status --json 返回非法 JSON: ${e.message}`);
  }

  const themeRes = runPayloadCli(['theme', 'status', '--json']);
  assert(themeRes.success, 'dt-cli theme status --json 执行成功');
  try {
    const themeData = JSON.parse(themeRes.stdout);
    assert(themeData.code === 0 && themeData.data, `当前生效主题检测正常: 浏览器[${themeData.data.browserTheme || themeData.data.browser}] / 管理器[${themeData.data.managerTheme || themeData.data.manager}]`);
  } catch (e) {
    assert(false, `theme status --json 返回非法 JSON: ${e.message}`);
  }

  const settingsRes = runPayloadCli(['settings', 'get', '--json']);
  assert(settingsRes.success, 'dt-cli settings get --json 执行成功');
  try {
    const settingsData = JSON.parse(settingsRes.stdout);
    assert(settingsData.code === 0 && settingsData.data, '全局配置 settings.json 读取正常');
  } catch (e) {
    assert(false, `settings get --json 返回非法 JSON: ${e.message}`);
  }

  // 4. 便携发布包 ZIP 文件验证 (纯英文含版本号 Release 文件名)
  console.log('\n[4/4] 验证便携发布包压缩文件 (dist/DT-Fingerprint-Browser-v2.1-Portable.zip)...');
  const zipPath = fs.existsSync(path.join(ROOT, 'dist', 'DT-Fingerprint-Browser-v2.1-Portable.zip'))
    ? path.join(ROOT, 'dist', 'DT-Fingerprint-Browser-v2.1-Portable.zip')
    : (fs.existsSync(path.join(ROOT, 'dist', 'DT-Fingerprint-Browser-Portable.zip'))
      ? path.join(ROOT, 'dist', 'DT-Fingerprint-Browser-Portable.zip')
      : path.join(ROOT, 'dist', 'DT-指纹浏览器-便携版.zip'));
  assert(fs.existsSync(zipPath), `便携版 ZIP 压缩包存在: ${zipPath}`);
  if (fs.existsSync(zipPath)) {
    const zipSizeMB = (fs.statSync(zipPath).size / (1024 * 1024)).toFixed(1);
    assert(fs.statSync(zipPath).size > 150 * 1024 * 1024, `便携版 ZIP 大小正常: ${zipSizeMB} MB`);
  }

  console.log('\n===============================================================');
  if (failed === 0) {
    console.log(`  🎉 全部便携包测试通过！(${passed} 项检查全部成功)`);
    console.log('===============================================================');
    process.exit(0);
  } else {
    console.error(`  ❌ 测试未全部通过: ${passed} 项通过, ${failed} 项失败`);
    console.log('===============================================================');
    process.exit(1);
  }
}

runTests().catch(err => {
  console.error('测试运行异常:', err);
  process.exit(1);
});
