'use strict';

const cp = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const ICON = path.join(ROOT, 'app.ico');
const CS = path.join(ROOT, 'scripts', 'Launcher.cs');
const PAYLOAD_DIR = path.join(ROOT, 'dist', 'payload');
const OUT_GUI = path.join(PAYLOAD_DIR, 'DT - 指纹浏览器.exe');
const OUT_CLI = path.join(PAYLOAD_DIR, 'DT-CLI.exe');

function getCscPath() {
  let csc = 'C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe';
  if (!fs.existsSync(csc)) {
    csc = 'C:\\Windows\\Microsoft.NET\\Framework\\v4.0.30319\\csc.exe';
  }
  return csc;
}

function compileExecutable(csc, targetPath, isGui, silent) {
  const tmpPath = targetPath + '.tmp';
  const bakPath = targetPath + '.old';

  if (fs.existsSync(tmpPath)) {
    try { fs.unlinkSync(tmpPath); } catch (_) {}
  }

  // 1. 先编译到临时文件，避免被当前运行的进程直接锁死
  cp.execFileSync(csc, [
    '/nologo',
    isGui ? '/target:winexe' : '/target:exe',
    `/win32icon:${ICON}`,
    `/out:${tmpPath}`,
    CS
  ], { stdio: silent ? 'pipe' : 'inherit' });

  // 2. 将现有文件移为 .old，再将 tmp 移入 targetPath（Windows 允许重命名正在执行的文件）
  if (fs.existsSync(targetPath)) {
    try {
      if (fs.existsSync(bakPath)) {
        try { fs.unlinkSync(bakPath); } catch (_) {}
      }
      fs.renameSync(targetPath, bakPath);
    } catch (_) {
      // 若同名替换不阻断则继续
    }
  }

  fs.renameSync(tmpPath, targetPath);

  if (fs.existsSync(bakPath)) {
    try { fs.unlinkSync(bakPath); } catch (_) {}
  }
}

function compileAll(options = {}) {
  const silent = !!options.silent;
  const csc = options.cscPath || getCscPath();

  if (!fs.existsSync(csc)) {
    throw new Error(`未在系统中找到 .NET Framework 编译器: ${csc}`);
  }
  if (!fs.existsSync(CS)) {
    throw new Error(`未在 scripts 目录下找到 Launcher.cs 源码: ${CS}`);
  }

  if (!fs.existsSync(PAYLOAD_DIR)) {
    fs.mkdirSync(PAYLOAD_DIR, { recursive: true });
  }

  const results = {
    csc,
    gui: { path: OUT_GUI, success: false },
    cli: { path: OUT_CLI, success: false }
  };

  if (!silent) {
    console.log('==================================================');
    console.log('   DT - 指纹浏览器: 原生 EXE 编译器 (csc.exe)');
    console.log('==================================================\n');
    console.log(`[1/2] 正在编译便携版桌面 GUI 管理器: "${OUT_GUI}" ...`);
  }

  // 1. 编译 GUI
  compileExecutable(csc, OUT_GUI, true, silent);
  results.gui.success = true;
  if (!silent) console.log('      -> 编译成功: "dist/payload/DT - 指纹浏览器.exe"\n');

  // 2. 编译 CLI
  if (!silent) console.log(`[2/2] 正在编译便携版命令行控制台程序: "${OUT_CLI}" ...`);
  compileExecutable(csc, OUT_CLI, false, silent);
  results.cli.success = true;
  if (!silent) console.log('      -> 编译成功: "dist/payload/DT-CLI.exe"\n');

  if (!silent) {
    console.log('==================================================');
    console.log('  恭喜！所有可执行文件均已编译完成并内嵌高清图标！');
    console.log('==================================================');
  }

  return results;
}

if (require.main === module) {
  try {
    compileAll();
  } catch (err) {
    console.error('【编译失败】:', err.message);
    process.exit(1);
  }
}

module.exports = {
  compileAll,
  getCscPath,
  OUT_GUI,
  OUT_CLI,
  CS,
  ICON
};

