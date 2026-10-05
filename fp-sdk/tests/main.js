'use strict';
const fs=require('node:fs'),path=require('node:path');
const {app,BaseWindow,BrowserWindow,webContents}=require('electron');
const {createFingerprintView,generateFingerprint,AutomationManager}=require('..');
const stateRoot=process.env.FP_SDK_TEST_STATE, output=process.env.FP_SDK_TEST_OUTPUT, stage=process.env.FP_SDK_TEST_STAGE, url=process.env.FP_SDK_TEST_URL;
if(!stateRoot||!path.basename(stateRoot).startsWith('fp-sdk-accept-')||!output||!url)throw new Error('Run tests/run.js');
app.setPath('userData',path.join(stateRoot,'userData'));
let host,manager,manageWindow,attacker;const views=new Map();
const checks=[],report={stage,versions:process.versions,checks,compatibility:{}};
function check(name,passed,detail){checks.push({name,passed:Boolean(passed),detail});console.log(`${passed?'PASS':'FAIL'} ${name}`);}
const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function poll(read,accept,timeout=6000){const deadline=Date.now()+timeout;let value;do{try{value=await read();if(accept(value))return value;}catch{}await wait(50);}while(Date.now()<deadline);return value;}
const exec=(id,source)=>views.get(id).webContents.executeJavaScript(source,true);
const profileFile=path.join(stateRoot,'profiles.json'),selectionFile=path.join(stateRoot,'selection.json');
async function main(){
  const profiles=stage==='bootstrap'?[1,2].map(number=>({id:`sdk-${number}`,name:`SDK 实例 ${number}`,fp:generateFingerprint()})):JSON.parse(fs.readFileSync(profileFile,'utf8'));
  if(stage==='bootstrap')fs.writeFileSync(profileFile,JSON.stringify(profiles));
  host=new BaseWindow({show:false,width:1200,height:850});
  manager=new AutomationManager({storageDir:path.join(app.getPath('userData'),'automation'),getProfileIds:()=>profiles.map(p=>p.id),timeoutMs:800});
  for(const profile of profiles){const view=await createFingerprintView({profile});views.set(profile.id,view);host.contentView.addChildView(view);view.setBounds({x:profiles.indexOf(profile)*580,y:0,width:580,height:800});await manager.attach(profile.id,view);await view.webContents.loadURL(url);}
  check('SDK creates isolated native views with configured fingerprints',views.get('sdk-1').webContents.session!==views.get('sdk-2').webContents.session && await exec('sdk-1',`navigator.userAgent===${JSON.stringify(profiles[0].fp.uaString)} && typeof require==='undefined' && typeof process==='undefined'`));
  if(stage==='restart'){
    const saved=JSON.parse(fs.readFileSync(selectionFile,'utf8'));
    check('scripts restored and auto executed after process restart',await poll(()=>exec('sdk-1',"document.body.dataset.auto"),value=>value==='restored')==='restored');
    check('auto script remains scoped to its instance after restart',await exec('sdk-2',"!document.body.dataset.auto"));
    for(const item of saved.extensions){
      const extension=manager.state().extensions.find(ext=>ext.id===item.id);
      check(`${item.kind}: extension registration restored before navigation`,extension?.profiles.filter(p=>p.enabled).every(p=>p.status==='loaded'));
      if(item.storage){
        for(const id of ['sdk-1','sdk-2']){const popup=await manager.openExtensionPopup(item.id,id,{show:false,parent:host});
          const token=await popup.webContents.executeJavaScript("new Promise(resolve=>chrome.storage.local.get('token',data=>resolve(data.token)))");
          check(`${item.kind}: ${id} extension local storage persists separately`,token===id);popup.destroy();}
      }
    }
    check('execution logs survive restart',manager.state().logs.some(log=>log.source==='manual'));
    check('disabled extension remains disabled after restart',manager.state().extensions.find(e=>e.id===saved.disabled)?.profiles.every(p=>!p.enabled&&p.status==='disabled')&&views.get('sdk-2').webContents.session.extensions.getAllExtensions().length===2);
    check('uninstalled extension remains unregistered after restart',!manager.state().extensions.some(e=>e.id===saved.uninstalled));
    return;
  }
  const script=manager.saveScript({name:'DOM and result',code:"console.log('hello'); document.body.dataset.sdkScript='yes'; await Promise.resolve(); return {language:navigator.language,node:typeof require};",trigger:'manual',enabled:true,profileIds:['sdk-1'],matches:['http://127.0.0.1:*/*']});
  const result=(await manager.runScript(script.id))[0];
  check('manual JS returns values and captured console logs',result.status==='success'&&result.result.node==='undefined'&&result.console[0].args[0]==='hello',result);
  check('script DOM effects stay within selected instance',await exec('sdk-1',"document.body.dataset.sdkScript==='yes'")&&await exec('sdk-2',"!document.body.dataset.sdkScript"));
  let rejected=false;try{await manager.runScript(script.id,['sdk-2']);}catch{rejected=true;}check('out of scope execution is rejected',rejected);
  let syntax=false;try{manager.saveScript({...script,code:'return ('});}catch{syntax=true;}check('syntax errors do not overwrite saved scripts',syntax&&manager.state().scripts.find(s=>s.id===script.id).code===script.code);
  manager.saveScript({...script,enabled:false});let disabledRejected=false;try{await manager.runScript(script.id);}catch{disabledRejected=true;}
  check('disabled scripts cannot execute manually',disabledRejected);manager.saveScript(script);
  const failed=manager.saveScript({name:'error',code:"throw new Error('expected-fixture-error')",trigger:'manual',profileIds:['sdk-1']});
  check('runtime exceptions become error logs',(await manager.runScript(failed.id))[0].error.includes('expected-fixture-error'));
  const timed=manager.saveScript({name:'timeout',code:'await new Promise(()=>{})',trigger:'manual',profileIds:['sdk-1']});
  check('unresolved async scripts receive timeout status',(await manager.runScript(timed.id))[0].status==='timeout');
  check('timed out instance cannot start overlapping scripts',(await manager.runScript(script.id))[0].status==='skipped');
  await views.get('sdk-1').webContents.loadURL(url+'reset');
  check('navigation resets pending execution guard',(await manager.runScript(script.id))[0].status==='success');
  const scoped=manager.saveScript({...script,id:undefined,matches:['https://example.com/*']});
  check('URL allowlist applies to manual scripts',(await manager.runScript(scoped.id))[0].status==='skipped');
  const importedFile=path.join(stateRoot,'imported.js');fs.writeFileSync(importedFile,'return 7;');
  const imported=manager.importScript(importedFile,['sdk-2']);check('JS file import defaults to manual execution',imported.trigger==='manual'&&(await manager.runScript(imported.id))[0].result===7);
  const auto=manager.saveScript({name:'Automatic sample',code:"document.body.dataset.auto='restored'; return 'auto';",trigger:'page-loaded',profileIds:['sdk-1']});
  await views.get('sdk-1').webContents.loadURL(url+'auto');
  check('page-loaded trigger runs after complete navigation',await poll(()=>exec('sdk-1',"document.body.dataset.auto"),v=>v==='restored')==='restored');
  manager.deleteScript(failed.id);check('script deletion persists',!manager.state().scripts.some(item=>item.id===failed.id));
  const selection={extensions:[],auto:auto.id};
  for(const kind of ['mv2','mv3']){
    const extension=await manager.importExtension(path.join(__dirname,'fixtures',kind),['sdk-1','sdk-2']);
    const compatibility=report.compatibility[kind]={load:extension.profiles.filter(p=>p.enabled).every(p=>p.status==='loaded'),contentScript:false,backgroundMessaging:false,popup:false,storage:false};
    check(`${kind}: fixture extension loads in both sessions`,compatibility.load,extension.profiles);
    if(!compatibility.load)continue;
    await views.get('sdk-1').webContents.loadURL(url+kind);await views.get('sdk-2').webContents.loadURL(url+kind);
    compatibility.contentScript=(await poll(()=>exec('sdk-1',`document.documentElement.dataset.fp${kind==='mv2'?'Mv2':'Mv3'}`),v=>v==='injected'))==='injected';
    compatibility.backgroundMessaging=(await poll(()=>exec('sdk-1',`document.documentElement.dataset.fp${kind==='mv2'?'Mv2':'Mv3'}Background`),v=>v===kind,2500))===kind;
    compatibility.diagnostic=manager.diagnoseExtension(extension.id,'sdk-1');
    compatibility.messageResult=await exec('sdk-1',`document.documentElement.dataset.fp${kind==='mv2'?'Mv2':'Mv3'}Background`);
    for(const wc of webContents.getAllWebContents().filter(wc=>wc.getType()==='backgroundPage'&&wc.session===views.get('sdk-1').webContents.session&&wc.getURL().startsWith(`chrome-extension://${compatibility.diagnostic.runtime.runtimeId}/`))) {
      compatibility.backgroundRuntime=await wc.executeJavaScript("({url:location.href,runtime:typeof chrome.runtime,listener:typeof chrome.runtime?.onMessage,hasListeners:chrome.runtime?.onMessage?.hasListeners?.()})");
    }
    try{
      for(const id of ['sdk-1','sdk-2']){const popup=await manager.openExtensionPopup(extension.id,id,{show:false,parent:host});
        compatibility.popup=(await poll(()=>popup.webContents.executeJavaScript("document.getElementById('ready')?.textContent"),v=>v==='ready'))==='ready';
        const token=await popup.webContents.executeJavaScript(`new Promise(resolve=>chrome.storage.local.set({token:${JSON.stringify(id)}},()=>chrome.storage.local.get('token',data=>resolve(data.token))))`);
        compatibility.storage=token===id;popup.destroy();}
    }catch(error){compatibility.popupError=error.message;}
    check(`${kind}: page content injection works`,compatibility.contentScript);
    check(`${kind}: extension popup and local storage work`,compatibility.popup&&compatibility.storage);
    check(`${kind}: page communicates with extension background`,compatibility.backgroundMessaging,compatibility.messageResult);
    selection.extensions.push({id:extension.id,kind,storage:compatibility.storage});
    await manager.setExtensionEnabled(extension.id,'sdk-2',false);
    await views.get('sdk-2').webContents.loadURL(url+'disabled');
    check(`${kind}: per instance disable unloads only its own extension`,!await exec('sdk-2',`document.documentElement.dataset.fp${kind==='mv2'?'Mv2':'Mv3'}`)&&manager.state().extensions.find(e=>e.id===extension.id).profiles.find(p=>p.profileId==='sdk-1').status==='loaded');
    await manager.setExtensionEnabled(extension.id,'sdk-2',true);
  }
  const uninstall=await manager.importExtension(path.join(__dirname,'fixtures','mv2'),['sdk-1']);
  await manager.uninstallExtension(uninstall.id);check('uninstall removes registration while retaining source and managed files',!manager.state().extensions.some(e=>e.id===uninstall.id)&&fs.existsSync(uninstall.directory)&&fs.existsSync(path.join(__dirname,'fixtures','mv2','manifest.json')));
  selection.uninstalled=uninstall.id;
  const disabled=await manager.importExtension(path.join(__dirname,'fixtures','mv2'),['sdk-2']);
  await manager.setExtensionEnabled(disabled.id,'sdk-2',false);selection.disabled=disabled.id;
  const moved=disabled.directory+'-offline';fs.renameSync(disabled.directory,moved);
  await manager.setExtensionEnabled(disabled.id,'sdk-2',true);
  check('missing extension files produce a per instance error without stopping app',manager.state().extensions.find(e=>e.id===disabled.id).profiles.find(p=>p.profileId==='sdk-2').status==='error');
  fs.renameSync(moved,disabled.directory);await manager.setExtensionEnabled(disabled.id,'sdk-2',false);
  const {createManagementWindow}=require('../../fp-demo/src/management');
  manageWindow=createManagementWindow({parent:host,automation:manager,getProfiles:()=>profiles.map(({id,name})=>({id,name})),currentId:'sdk-1',show:false});
  await poll(()=>manageWindow.webContents.executeJavaScript("Boolean(window.fpManagement && document.querySelectorAll('#script-list button').length)"),Boolean);
  check('management UI renders saved scripts and both profiles',await manageWindow.webContents.executeJavaScript("document.querySelectorAll('#script-targets input').length===2 && document.querySelectorAll('#script-list button').length>0"));
  await manageWindow.webContents.executeJavaScript("document.getElementById('new-script').click();document.getElementById('script-name').value='UI saved';document.getElementById('script-code').value='return 42;';document.getElementById('save-script').click();");
  check('management UI saves a script through trusted IPC',Boolean(await poll(()=>manager.state().scripts.find(s=>s.name==='UI saved'),Boolean)));
  await poll(()=>manageWindow.webContents.executeJavaScript("!document.getElementById('run-script').disabled && document.getElementById('script-name').value==='UI saved'"),Boolean);
  await manageWindow.webContents.executeJavaScript("document.getElementById('run-script').click()");
  check('management UI executes saved script and records result',Boolean(await poll(()=>manager.state().logs.find(l=>l.name==='UI saved'&&l.result===42),Boolean)));
  attacker=new BrowserWindow({show:false,webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false,preload:path.resolve(__dirname,'../../fp-demo/src/manage/preload.js')}});await attacker.loadURL(url+'attacker');
  check('foreign window with same preload cannot access manager IPC',await attacker.webContents.executeJavaScript("window.fpManagement.invoke('state').then(()=>false,()=>true)"));
  check('foreign window cannot create an automatic script',await attacker.webContents.executeJavaScript(`window.fpManagement.invoke('save-script',{name:'unauthorized',code:'return 1',trigger:'page-loaded',profileIds:['sdk-1']}).then(()=>false,()=>true)`)&&!manager.state().scripts.some(s=>s.name==='unauthorized'));attacker.destroy();attacker=null;
  manageWindow.showInactive();await wait(250);fs.writeFileSync(path.join(output,'management.png'),(await manageWindow.webContents.capturePage()).toPNG());manageWindow.hide();
  await manageWindow.webContents.executeJavaScript("document.querySelector('[data-tab=extensions]').click()");
  check('extension UI lists imported fixtures and per instance controls',await manageWindow.webContents.executeJavaScript("!document.getElementById('extensions').hidden && document.querySelectorAll('.extension-card').length===3 && document.querySelectorAll('.profile-extension').length===6"));
  manageWindow.showInactive();await wait(150);fs.writeFileSync(path.join(output,'extensions.png'),(await manageWindow.webContents.capturePage()).toPNG());manageWindow.hide();
  await manageWindow.webContents.executeJavaScript("document.querySelector('[data-tab=logs]').click()");
  check('log UI renders expandable execution details',await manageWindow.webContents.executeJavaScript("!document.getElementById('logs').hidden && document.querySelectorAll('#log-list details').length>0 && document.getElementById('log-list').textContent.includes('UI saved')"));
  fs.writeFileSync(selectionFile,JSON.stringify(selection));
}
const timer=setTimeout(()=>{report.error='Test deadline';finish();},130000);
function finish(){
  clearTimeout(timer);if(attacker&&!attacker.isDestroyed())attacker.destroy();if(manageWindow&&!manageWindow.isDestroyed())manageWindow.destroy();manager?.dispose();
  for(const view of views.values())if(!view.webContents.isDestroyed())view.webContents.close();if(host&&!host.isDestroyed())host.close();
  report.passed=!report.error&&checks.length>0&&checks.every(c=>c.passed);fs.writeFileSync(path.join(output,stage+'.json'),JSON.stringify(report,null,2));app.exit(report.passed?0:1);
}
app.whenReady().then(main).catch(error=>{report.error=error.stack;console.error(error);}).finally(finish);
