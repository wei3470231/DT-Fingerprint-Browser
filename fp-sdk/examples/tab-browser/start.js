'use strict';
// 用定制运行时启动样例：node fp-sdk/examples/tab-browser/start.js [--self-test]
const path = require('node:path');
const { spawn } = require('node:child_process');
const { electronPath } = require('../../../scripts/runtime-path');

try {
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  if (process.argv.includes('--self-test')) env.FPB_SELF_TEST = '1';
  const child = spawn(electronPath(), [__dirname], { stdio: 'inherit', env });
  child.on('error', error => { console.error(error.message); process.exitCode = 1; });
  child.on('exit', code => { process.exitCode = code ?? 1; });
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
