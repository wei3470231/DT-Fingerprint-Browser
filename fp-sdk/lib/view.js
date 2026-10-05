'use strict';
const { app, session, WebContentsView } = require('electron');

async function createFingerprintView({ profile, partitionPrefix = 'acc-', configureSession } = {}) {
  if (!app.isReady()) throw new Error('请在 app.whenReady() 之后创建指纹实例。');
  if (!profile || !/^[a-zA-Z0-9_-]{1,128}$/.test(profile.id)) throw new Error('profile.id 必须是稳定的字母、数字、下划线或短横线标识。');
  if (!/^[a-zA-Z0-9_-]*$/.test(partitionPrefix)) throw new Error('partitionPrefix 无效。');
  if (!profile.fp?.seed || !profile.fp.uaString || !Array.isArray(profile.fp.navigator?.languages)) throw new Error('需要完整的 profile.fp 指纹配置。');
  const ses = session.fromPartition(`persist:${partitionPrefix}${profile.id}`);
  if (typeof ses.setFingerprintConfig !== 'function') throw new Error('当前内核不支持指纹配置，请使用定制的 electron.exe。');
  await ses.setProxy(profile.proxy ? { proxyRules: profile.proxy } : { mode: 'direct' });
  ses.setUserAgent(profile.fp.uaString, profile.fp.navigator.languages.join(','));
  ses.setFingerprintConfig(JSON.stringify(profile.fp));
  ses.setPermissionCheckHandler(() => false);
  ses.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
  if (configureSession) await configureSession(ses);
  const view = new WebContentsView({ webPreferences: { session: ses, sandbox: true, contextIsolation: true, nodeIntegration: false, plugins: true, backgroundThrottling: false } });
  view.webContents.setWebRTCIPHandlingPolicy('disable_non_proxied_udp');
  const onLogin = (event, contents, _details, authInfo, callback) => {
    if (contents !== view.webContents || !authInfo.isProxy) return;
    event.preventDefault();
    if (profile.proxyAuth) callback(profile.proxyAuth.username, profile.proxyAuth.password);
    else callback();
  };
  app.on('login', onLogin);
  view.webContents.once('destroyed', () => app.removeListener('login', onLogin));
  return view;
}

module.exports = { createFingerprintView };
