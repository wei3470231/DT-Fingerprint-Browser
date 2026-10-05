'use strict';
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), http = require('node:http');
const { spawn } = require('node:child_process');
const { electronPath } = require('../../scripts/runtime-path');
async function main() {
  const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(),'fp-sdk-accept-'));
  const output = path.resolve(__dirname,'..','test-results',new Date().toISOString().replace(/[:.]/g,'-'));
  fs.mkdirSync(output,{recursive:true});
  const server = http.createServer((_req,res)=>{res.writeHead(200,{'Content-Type':'text/html','Cache-Control':'no-store'});res.end('<!doctype html><html><head><title>SDK test fixture</title></head><body><h1>SDK isolation fixture</h1></body></html>');});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const summary = {stateRoot,output,stages:[]};
  try {
    for (const stage of ['bootstrap','restart']) {
      const env={...process.env,FP_SDK_TEST_STATE:stateRoot,FP_SDK_TEST_OUTPUT:output,FP_SDK_TEST_STAGE:stage,FP_SDK_TEST_URL:`http://127.0.0.1:${server.address().port}/`};delete env.ELECTRON_RUN_AS_NODE;
      const code = await new Promise((resolve,reject)=>{
        const child=spawn(electronPath(),[path.join(__dirname,'main.js')],{env,windowsHide:true,stdio:['ignore','pipe','pipe']});
        let stdout='',stderr='';child.stdout.on('data',chunk=>{stdout+=chunk;process.stdout.write(chunk);});child.stderr.on('data',chunk=>{stderr+=chunk;});
        const timer=setTimeout(()=>{const kill=spawn('taskkill',['/PID',String(child.pid),'/T','/F'],{windowsHide:true});kill.on('error',()=>child.kill());},150000);
        child.on('error',error=>{clearTimeout(timer);reject(error);});child.on('close',code=>{clearTimeout(timer);fs.writeFileSync(path.join(output,stage+'.stdout.log'),stdout);fs.writeFileSync(path.join(output,stage+'.stderr.log'),stderr);resolve(code);});
      });
      const reportFile=path.join(output,stage+'.json');const report=fs.existsSync(reportFile)?JSON.parse(fs.readFileSync(reportFile,'utf8')):null;
      summary.stages.push({stage,exitCode:code,report});if(code!==0)break;
    }
    summary.passed=summary.stages.length===2&&summary.stages.every(s=>s.exitCode===0&&s.report?.passed);
  } catch(error){summary.passed=false;summary.error=error.stack;}
  finally {server.closeAllConnections();server.close();fs.writeFileSync(path.join(output,'summary.json'),JSON.stringify(summary,null,2));console.log(`RESULT ${summary.passed?'PASS':'FAIL'} ${path.join(output,'summary.json')}`);process.exitCode=summary.passed?0:1;}
}
main().catch(error=>{console.error(error);process.exitCode=1;});
