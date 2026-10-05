'use strict';

// DT - 指纹浏览器 主入口智能调度分流器
// 当 Electron 从 app.asar 或项目根目录启动时，根据命令行参数自动分流：
// 1. 若携带 --env-id、--browser-mode 等浏览器实例参数，拉起独立指纹浏览器环境
// 2. 否则启动可视化管理控制台
const isBrowser = process.argv.some(a => 
  a.startsWith('--env-id=') || 
  a === '--browser-mode' || 
  a.startsWith('--browser-mode=') ||
  a.includes('src/browser/main.js') ||
  a.includes('src\\browser\\main.js') ||
  a.startsWith('--remote-debugging-port=')
);

if (isBrowser) {
  require('./src/browser/main.js');
} else {
  require('./src/gui/main.js');
}
