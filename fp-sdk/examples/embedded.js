'use strict';
const { app, BaseWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { createFingerprintView, generateFingerprint, AutomationManager } = require('..');

// Use a separate development profile. Do not reuse fp-demo's live userData.
app.setPath('userData', path.join(app.getPath('appData'), 'fp-sdk-embedded-example'));
if (!app.requestSingleInstanceLock()) app.quit();
else app.whenReady().then(async () => {
  const file = path.join(app.getPath('userData'), 'profiles.json');
  fs.mkdirSync(path.dirname(file), { recursive:true });
  let profiles;
  if (fs.existsSync(file)) profiles = JSON.parse(fs.readFileSync(file, 'utf8'));
  else {
    profiles = [1,2].map(number => ({id:`account-${number}`, name:`账号 ${number}`, fp:generateFingerprint({language:'zh-CN',timezone:'Asia/Shanghai'})}));
    fs.writeFileSync(file, JSON.stringify(profiles,null,2));
  }
  const win = new BaseWindow({width:1300,height:800,title:'FP SDK · 双账号嵌入示例'});
  const automation = new AutomationManager({storageDir:path.join(app.getPath('userData'),'automation'),getProfileIds:()=>profiles.map(p=>p.id)});
  const views = [];
  for (const profile of profiles) {
    const view = await createFingerprintView({profile});
    win.contentView.addChildView(view); views.push(view);
    await automation.attach(profile.id,view); // Restore extensions BEFORE navigation.
    view.webContents.setWindowOpenHandler(({url}) => { if (/^https?:\/\//.test(url)) void view.webContents.loadURL(url).catch(console.error); return {action:'deny'}; });
    void view.webContents.loadURL(process.env.FP_EXAMPLE_URL || 'https://example.com/').catch(console.error);
  }
  const layout = () => {
    const [width,height] = win.getContentSize(), split = Math.floor(width / views.length);
    views.forEach((view,index) => view.setBounds({x:index*split,y:0,width:index===views.length-1?width-index*split:split,height}));
  };
  layout(); win.on('resize',layout);
  win.on('closed',()=>{automation.dispose();for(const view of views)if(!view.webContents.isDestroyed())view.webContents.close();});
}).catch(error=>{console.error(error);app.exit(1);});
app.on('window-all-closed',()=>app.quit());
