'use strict';

const path = require('node:path');
const { spawn } = require('node:child_process');
const { electronPath } = require('./scripts/runtime-path');

const args = process.argv.slice(2);

if (args.length > 0) {
  require('./cli');
} else {
  // 否则默认打开桌面 GUI 管理器
  const guiEntry = path.resolve(__dirname, 'src/gui/main.js');
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;

  const child = spawn(electronPath(), [guiEntry, ...args], {
    cwd: __dirname,
    stdio: 'inherit',
    env
  });

  child.on('exit', code => {
    process.exit(code ?? 0);
  });
}
