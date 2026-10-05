'use strict';
const fs = require('node:fs');
const path = require('node:path');
function getAppRoot() {
  if (process.env.DT_APP_ROOT && fs.existsSync(process.env.DT_APP_ROOT)) {
    return path.resolve(process.env.DT_APP_ROOT);
  }
  const asarIdx = __dirname.indexOf('app.asar');
  if (asarIdx !== -1) {
    const beforeAsar = __dirname.substring(0, asarIdx);
    const candidate = path.resolve(beforeAsar, '..', '..');
    if (fs.existsSync(candidate)) return candidate;
  }
  return path.resolve(__dirname, '..');
}
const root = getAppRoot();

function electronPath() {
  const configFile = path.join(root, 'runtime', 'current.json');
  const localFile = path.join(root, '.fp-local.json');
  let requested = process.env.FP_DEMO_ELECTRON;
  if (!requested && fs.existsSync(configFile)) requested = JSON.parse(fs.readFileSync(configFile, 'utf8')).executable;
  if (!requested && fs.existsSync(localFile)) requested = JSON.parse(fs.readFileSync(localFile, 'utf8')).electron;
  const executable = requested ? path.resolve(root, requested) : path.join(root, 'runtime', 'electron.exe');
  if (!fs.existsSync(executable)) throw new Error('未找到定制运行时。将已校验运行时解压到 runtime，或设置 FP_DEMO_ELECTRON 为 electron.exe 完整路径。');
  return executable;
}
module.exports = { electronPath };
