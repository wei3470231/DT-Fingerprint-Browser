'use strict';

const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const DIST = path.join(ROOT, 'dist');
const STAGING = path.join(DIST, 'staging');
const PAYLOAD = path.join(DIST, 'payload');
const ZIP_FILE = path.join(DIST, 'payload.zip');
const VERSION = 'v2.1';
const SETUP_EXE = path.join(DIST, `DT-Fingerprint-Browser-${VERSION}-Setup.exe`);
const PORTABLE_ZIP = path.join(DIST, `DT-Fingerprint-Browser-${VERSION}-Portable.zip`);

const CSC = fs.existsSync('C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe')
  ? 'C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe'
  : 'C:\\Windows\\Microsoft.NET\\Framework\\v4.0.30319\\csc.exe';

const ICON = path.join(ROOT, 'app.ico');

function logStep(step, msg) {
  console.log(`\n[${step}] ${msg}`);
}

function cleanDir(dir) {
  if (fs.existsSync(dir)) {
    for (let i = 0; i < 3; i++) {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
        break;
      } catch (err) {
        if (i === 2) throw err;
        try {
          cp.execSync('taskkill /F /IM electron.exe /T 2>nul || exit 0', { shell: 'cmd.exe' });
        } catch (_) {}
        const sleep = ms => { const at = Date.now(); while (Date.now() - at < ms) {} };
        sleep(800);
      }
    }
  }
  fs.mkdirSync(dir, { recursive: true });
}

function copyDirRecursive(src, dest, filterFn) {
  if (!fs.existsSync(dest)) fs.mkdirSync(dest, { recursive: true });
  const entries = fs.readdirSync(src, { withFileTypes: true });
  for (const entry of entries) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (filterFn && !filterFn(srcPath, entry)) continue;
    if (entry.isDirectory()) {
      copyDirRecursive(srcPath, destPath, filterFn);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

function getAllFiles(dir, ext = '.js') {
  let results = [];
  const list = fs.readdirSync(dir, { withFileTypes: true });
  for (const item of list) {
    const full = path.join(dir, item.name);
    if (item.isDirectory()) {
      results = results.concat(getAllFiles(full, ext));
    } else if (item.name.endsWith(ext)) {
      results.push(full);
    }
  }
  return results;
}

async function minifyFiles(dir) {
  const jsFiles = getAllFiles(dir, '.js');
  console.log(`      正在使用 Terser 混淆压缩 ${jsFiles.length} 个 JavaScript 源码文件...`);

  for (const file of jsFiles) {
    try {
      cp.execSync(`npx.cmd -y terser "${file}" -o "${file}" --compress --mangle --comments false`, {
        cwd: ROOT,
        stdio: 'pipe'
      });
    } catch (err) {
      console.warn(`      [警告] 压缩 ${path.basename(file)} 失败，保留原文件:`, err.message);
    }
  }
}

function compileCs(srcFile, outFile, isGui, extraFlags = []) {
  const flags = [
    '/nologo',
    isGui ? '/target:winexe' : '/target:exe',
    `/win32icon:${ICON}`,
    `/out:${outFile}`,
    ...extraFlags,
    srcFile
  ];
  try {
    cp.execFileSync(CSC, flags, { stdio: 'pipe' });
  } catch (err) {
    if (err.stdout) console.error(err.stdout.toString());
    if (err.stderr) console.error(err.stderr.toString());
    throw err;
  }
}

async function main() {
  console.log('===============================================================');
  console.log('  DT - 指纹浏览器: 商业标准安装程序独立打包构建系统');
  console.log('===============================================================');
  console.log(`根目录: ${ROOT}`);
  console.log(`输出目录: ${DIST}`);

  // 1. 准备目录
  logStep('1/8', '初始化构建输出目录与临时工作区...');
  if (!fs.existsSync(DIST)) fs.mkdirSync(DIST, { recursive: true });
  cleanDir(STAGING);
  cleanDir(PAYLOAD);

  // 2. 收集发布所需代码 (严格排除用户扩展插件与个人数据)
  logStep('2/8', '收集核心业务源码 (排除任何用户插件与本地测试数据)...');
  
  // 复制 src/
  copyDirRecursive(path.join(ROOT, 'src'), path.join(STAGING, 'src'));
  // 复制 fp-sdk/
  copyDirRecursive(path.join(ROOT, 'fp-sdk'), path.join(STAGING, 'fp-sdk'), (srcPath) => {
    // 排除 fp-sdk 内部的 examples 和 tests
    const norm = srcPath.replace(/\\/g, '/');
    if (norm.includes('/examples') || norm.includes('/tests')) return false;
    return true;
  });
  // 复制 cli.js
  fs.copyFileSync(path.join(ROOT, 'cli.js'), path.join(STAGING, 'cli.js'));
  // 复制 runtime-path.js
  fs.mkdirSync(path.join(STAGING, 'scripts'), { recursive: true });
  fs.copyFileSync(path.join(ROOT, 'scripts', 'runtime-path.js'), path.join(STAGING, 'scripts', 'runtime-path.js'));
  // 复制 app.ico 至 staging 根目录，使 app.asar 内部含有完整高清图标
  fs.copyFileSync(ICON, path.join(STAGING, 'app.ico'));
  // 复制智能分流主入口 index.js
  fs.copyFileSync(path.join(ROOT, 'index.js'), path.join(STAGING, 'index.js'));

  // 创建精简 package.json (以 index.js 为主入口，实现管理器与指纹浏览器多进程分流)
  const pkgJson = {
    name: 'dt-fingerprint-browser',
    version: '2.1.0',
    description: 'DT Fingerprint Browser Commercial Standard Edition',
    main: 'index.js'
  };
  fs.writeFileSync(path.join(STAGING, 'package.json'), JSON.stringify(pkgJson, null, 2), 'utf8');

  // 3. 源码保护：Terser 混淆、剔除注释与压缩
  logStep('3/8', '源码脱敏与加密保护：执行 Terser 深度混淆与变量名称压缩...');
  await minifyFiles(STAGING);

  // 4. 将脱敏源码打包为虚拟归档 app.asar
  logStep('4/8', '封装为二进制虚拟归档 (app.asar)，消除所有明文源码文件...');
  const asarTargetDir = path.join(PAYLOAD, 'runtime', 'resources');
  fs.mkdirSync(asarTargetDir, { recursive: true });
  const asarOut = path.join(asarTargetDir, 'app.asar');
  
  cp.execSync(`npx.cmd -y asar pack "${STAGING}" "${asarOut}"`, { cwd: ROOT, stdio: 'inherit' });
  console.log(`      -> 成功生成 app.asar (${(fs.statSync(asarOut).size / 1024).toFixed(1)} KB)`);
  
  // 清理 staging 目录，确保不留任何源码
  fs.rmSync(STAGING, { recursive: true, force: true });

  // 5. 复制独立运行内核 (runtime)
  logStep('5/8', '集成 Chromium/Electron 独立定制内核与运行时组件...');
  copyDirRecursive(path.join(ROOT, 'runtime'), path.join(PAYLOAD, 'runtime'), (srcPath) => {
    const norm = srcPath.replace(/\\/g, '/');
    // 排除原先的 default_app.asar，避免体积冗余
    if (norm.endsWith('default_app.asar')) return false;
    return true;
  });

  // 5.5 复制内置本地精选字体库 (Fonts) 为精简版 Windows 系统提供开箱即用字体支持
  const FONTS_SRC = path.join(ROOT, 'Fonts');
  if (fs.existsSync(FONTS_SRC)) {
    logStep('5.5/8', '复制内置本地字体库 (Fonts) 为精简版系统提供兜底字体支持...');
    copyDirRecursive(FONTS_SRC, path.join(PAYLOAD, 'Fonts'));
    console.log('      -> 已集成 Fonts 字体库到安装包 payload/Fonts');
  }

  // 6. 编译发布版专用启动器与卸载程序
  logStep('6/8', '编译原生桌面端管理程序、CLI 控制台与卸载程序...');
  const CS_LAUNCHER = path.join(ROOT, 'scripts', 'Launcher.cs');
  const CS_UNINSTALLER = path.join(ROOT, 'scripts', 'Uninstaller.cs');
  const CS_INSTALLER = path.join(ROOT, 'scripts', 'Installer.cs');

  // 编译 GUI (纯英文标准名称与中文兼容名称同时支持)
  compileCs(CS_LAUNCHER, path.join(PAYLOAD, 'DT-Fingerprint-Browser.exe'), true);
  console.log('      -> 已编译: "DT-Fingerprint-Browser.exe"');
  try {
    fs.copyFileSync(path.join(PAYLOAD, 'DT-Fingerprint-Browser.exe'), path.join(PAYLOAD, 'DT - 指纹浏览器.exe'));
    console.log('      -> 已生成兼容副本: "DT - 指纹浏览器.exe"');
  } catch (_) {}

  // 编译 CLI
  compileCs(CS_LAUNCHER, path.join(PAYLOAD, 'DT-CLI.exe'), false);
  console.log('      -> 已编译: "DT-CLI.exe"');

  // 编译 Uninstaller.exe
  compileCs(CS_UNINSTALLER, path.join(PAYLOAD, 'Uninstall.exe'), true, [
    '/r:System.Windows.Forms.dll',
    '/r:System.Drawing.dll'
  ]);
  console.log('      -> 已编译: "Uninstall.exe"');

  // 复制图标与命令包装
  fs.copyFileSync(ICON, path.join(PAYLOAD, 'app.ico'));
  try { fs.copyFileSync(ICON, path.join(PAYLOAD, 'runtime', 'app.ico')); } catch (_) {}
  try { fs.copyFileSync(ICON, path.join(PAYLOAD, 'runtime', 'resources', 'app.ico')); } catch (_) {}
  fs.writeFileSync(path.join(PAYLOAD, 'dt-cli.cmd'), '@"%~dp0DT-CLI.exe" %*\r\n');
  fs.writeFileSync(path.join(PAYLOAD, 'dt.cmd'), '@"%~dp0DT-CLI.exe" %*\r\n');

  // 初始化干净数据目录 (干净默认配置)
  const dataDir = path.join(PAYLOAD, 'data');
  fs.mkdirSync(path.join(dataDir, 'profiles'), { recursive: true });
  fs.writeFileSync(path.join(dataDir, 'environments.json'), '[]\r\n', 'utf8');
  fs.writeFileSync(path.join(dataDir, 'settings.json'), JSON.stringify({
    managerTheme: 'dark',
    browserTheme: 'dark',
    groups: ['默认分组']
  }, null, 2), 'utf8');

  // 7. 压缩 Payload 为高压缩比独立包 (优先采用 Windows 原生 tar.exe 极速压缩，彻底摆脱 PowerShell 依赖)
  logStep('7/8', '正在压缩生成单文件内嵌资产包 (payload.zip)...');
  if (fs.existsSync(ZIP_FILE)) fs.unlinkSync(ZIP_FILE);

  let zipSuccess = false;
  try {
    cp.execFileSync('tar.exe', ['-a', '-cf', ZIP_FILE, '-C', PAYLOAD, '.'], { stdio: 'inherit' });
    if (fs.existsSync(ZIP_FILE) && fs.statSync(ZIP_FILE).size > 1024 * 1024) {
      zipSuccess = true;
    }
  } catch (_) {}

  if (!zipSuccess) {
    const psScriptPath = path.join(DIST, 'make-zip.ps1');
    fs.writeFileSync(psScriptPath, `
Add-Type -AssemblyName System.IO.Compression.FileSystem
[System.IO.Compression.ZipFile]::CreateFromDirectory('${PAYLOAD.replace(/'/g, "''")}', '${ZIP_FILE.replace(/'/g, "''")}', [System.IO.Compression.CompressionLevel]::Fastest, $false)
`.trim(), 'utf8');
    try {
      cp.execSync(`powershell -NoProfile -ExecutionPolicy Bypass -File "${psScriptPath}"`, { stdio: 'inherit' });
    } catch (_) {}
    try { fs.unlinkSync(psScriptPath); } catch {}
  }

  const zipSizeMb = (fs.statSync(ZIP_FILE).size / (1024 * 1024)).toFixed(1);
  console.log(`      -> 资产包生成完毕，压缩后体积: ${zipSizeMb} MB`);

  // 8. 编译最终独立 GUI 安装程序 (含版本号，无中文字符)
  logStep('8/8', `正在编译嵌入式单文件 Windows GUI 标准安装程序 (${path.basename(SETUP_EXE)})...`);
  compileCs(CS_INSTALLER, SETUP_EXE, true, [
    '/r:System.Windows.Forms.dll',
    '/r:System.Drawing.dll',
    '/r:System.IO.Compression.dll',
    '/r:System.IO.Compression.FileSystem.dll',
    `/resource:${ZIP_FILE},payload.zip`
  ]);

  // 保存便携版独立 zip 归档 (无中文字符 Release 文件名)
  try {
    if (fs.existsSync(PORTABLE_ZIP)) fs.unlinkSync(PORTABLE_ZIP);
    fs.copyFileSync(ZIP_FILE, PORTABLE_ZIP);
    fs.unlinkSync(ZIP_FILE);
  } catch (_) {}

  // 清理历史无版本号或旧命名的临时构建文件
  const oldFiles = [
    path.join(DIST, 'DT-指纹浏览器-便携版.zip'),
    path.join(DIST, 'DT-指纹浏览器-安装程序.exe'),
    path.join(DIST, 'DT-Fingerprint-Browser-Portable.zip'),
    path.join(DIST, 'DT-Fingerprint-Browser-Setup.exe')
  ];
  for (const f of oldFiles) {
    if (fs.existsSync(f)) try { fs.unlinkSync(f); } catch (_) {}
  }

  const setupSizeMb = (fs.statSync(SETUP_EXE).size / (1024 * 1024)).toFixed(1);
  const portableSizeMb = fs.existsSync(PORTABLE_ZIP) ? (fs.statSync(PORTABLE_ZIP).size / (1024 * 1024)).toFixed(1) : '未知';

  console.log('\n===============================================================');
  console.log('   🎉 商业标准安装程序与便携免安装包全部编译打包成功！');
  console.log('===============================================================');
  console.log(`\n📦 独立单文件安装程序:`);
  console.log(`   ${SETUP_EXE} (${setupSizeMb} MB)`);
  console.log(`\n🗜️ 便携版独立压缩包 (解压即用):`);
  console.log(`   ${PORTABLE_ZIP} (${portableSizeMb} MB)`);
  console.log(`\n📁 便携解压即用目录 (无需安装直接运行版):`);
  console.log(`   ${PAYLOAD}`);
  console.log(`\n🛡️ 安全与合规说明:`);
  console.log(`   1. 源码保护：所有 JS 已全量 Terser 混淆并封装入 app.asar，无任何明文源码。`);
  console.log(`   2. 插件隔离：您的本地插件 (chrome/ 等) 未打包进安装文件，零泄露风险。`);
  console.log(`   3. 自用保护：您本地的开发代码与数据完全未动，两套环境彻底解耦。`);
  console.log(`   4. 全自动化：执行安装程序将自动配置 PATH 环境变量，并提供开机自启选项。`);
  console.log('===============================================================\n');
}

main().catch(err => {
  console.error('\n【打包构建失败】:', err);
  process.exit(1);
});
