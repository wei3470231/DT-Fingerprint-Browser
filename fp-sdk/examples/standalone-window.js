'use strict';
/**
 * 独立指纹浏览器窗口启动器 (带远程调试端口与独立缓存)
 * 
 * 用法：
 *   node fp-sdk/examples/standalone-window.js --port=9222 --user-data-dir=./cache/p1 --url=https://bot.sannysoft.com
 *   node fp-sdk/examples/standalone-window.js --port=9223 --user-data-dir=./cache/p2 --url=https://bot.sannysoft.com
 */

const fs = require('node:fs');
const path = require('node:path');

// 判断当前是在普通 Node.js 环境还是在 Electron 主进程运行
if (!process.versions.electron) {
  const { spawn } = require('node:child_process');
  const { electronPath } = require('../../scripts/runtime-path');

  // 解析并传递命令行参数
  const args = [__filename, ...process.argv.slice(2)];
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;

  const child = spawn(electronPath(), args, {
    stdio: 'inherit',
    env
  });

  child.on('exit', code => {
    process.exit(code ?? 0);
  });
} else {
  // ----------- 在定制 Electron 进程内部运行 -----------
  const { app, BrowserWindow, session } = require('electron');
  const { generateFingerprint } = require('../index');

  // 1. 解析命令行参数
  function getArg(key, defaultValue = null) {
    for (const arg of process.argv) {
      if (arg.startsWith(`--${key}=`)) {
        return arg.slice(key.length + 3);
      }
    }
    return defaultValue;
  }

  const port = getArg('port') || getArg('remote-debugging-port') || '9222';
  const customUserData = getArg('user-data-dir') || getArg('cache-dir');
  const targetUrl = getArg('url', 'https://example.com');
  const profileId = getArg('profile-id', `profile-${port}`);
  const proxy = getArg('proxy', null);
  const lang = getArg('lang', 'zh-CN');
  const timezone = getArg('timezone', 'Asia/Shanghai');
  const autoCloseSec = parseInt(getArg('auto-close', '0'), 10);

  // 2. 配置远程调试端口与缓存路径 (必须在 app.whenReady 之前配置)
  app.commandLine.appendSwitch('remote-debugging-port', String(port));

  if (customUserData) {
    const absUserData = path.resolve(process.cwd(), customUserData);
    fs.mkdirSync(absUserData, { recursive: true });
    app.setPath('userData', absUserData);
  }

  // 3. 准备指纹配置
  function getOrCreateProfile(userDataDir) {
    const profilePath = path.join(userDataDir, 'profile.json');
    if (fs.existsSync(profilePath)) {
      try {
        const data = JSON.parse(fs.readFileSync(profilePath, 'utf8'));
        // 修正 Chromium 版本与当前内核保持一致
        if (data.fp && data.fp.ua && data.fp.ua.fullVersion !== process.versions.chrome) {
          const old = data.fp.ua.fullVersion;
          const current = process.versions.chrome;
          data.fp.ua.fullVersion = current;
          data.fp.uaString = data.fp.uaString.replace(`Chrome/${old}`, `Chrome/${current}`);
        }
        return data;
      } catch (e) {
        console.warn('读取旧 profile 失败，将重新生成:', e.message);
      }
    }

    const newFp = generateFingerprint({ language: lang, timezone });
    const profile = {
      id: profileId,
      proxy: proxy || '',
      fp: newFp
    };
    fs.writeFileSync(profilePath, JSON.stringify(profile, null, 2), 'utf8');
    return profile;
  }

  app.whenReady().then(async () => {
    const userData = app.getPath('userData');
    const profile = getOrCreateProfile(userData);

    // 4. 设置 Session 与指纹内核参数
    // 每个窗口可以使用独立 partition，或者使用当前进程 defaultSession (因为本进程已经设置了独立的 userData)
    const ses = session.fromPartition(`persist:${profile.id}`);
    
    if (typeof ses.setFingerprintConfig !== 'function') {
      console.error('【错误】当前内核不支持 setFingerprintConfig，必须使用定制的 electron.exe！');
      app.exit(1);
      return;
    }

    // 设置代理
    if (profile.proxy) {
      await ses.setProxy({ proxyRules: profile.proxy });
    } else {
      await ses.setProxy({ mode: 'direct' });
    }

    // 设置 UA 与语言
    ses.setUserAgent(profile.fp.uaString, profile.fp.navigator.languages.join(','));

    // 【核心注入点】：向定制 Chromium 内核注入指纹配置
    ses.setFingerprintConfig(JSON.stringify(profile.fp));

    // 5. 创建真实的浏览器窗口
    const win = new BrowserWindow({
      width: 1280,
      height: 850,
      title: `指纹浏览器 [端口: ${port} | 分区: ${profile.id}]`,
      webPreferences: {
        session: ses,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        backgroundThrottling: false
      }
    });

    // 打印调试就绪信息，方便自动化工具捕获端口
    console.log(`[CDP Ready] 远程调试端口: ${port}`);
    console.log(`[User Data] 缓存与数据目录: ${userData}`);
    console.log(`[Profile ID] ${profile.id}`);
    console.log(`[CDP URL] http://127.0.0.1:${port}/json/version`);

    await win.loadURL(targetUrl);

    if (autoCloseSec > 0) {
      console.log(`[Auto Close] 将在 ${autoCloseSec} 秒后自动关闭测试窗口...`);
      setTimeout(() => {
        win.close();
      }, autoCloseSec * 1000);
    }

    win.on('closed', () => {
      app.quit();
    });
  }).catch(err => {
    console.error('启动失败:', err);
    app.exit(1);
  });
}
