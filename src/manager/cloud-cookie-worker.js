'use strict';

const fs = require('node:fs');
const { app, session } = require('electron');
const { setElectronCookies } = require('./cloud-cookies');

const jobFile = process.argv.find(arg => arg.startsWith('--dt-cloud-cookie-job=')).slice('--dt-cloud-cookie-job='.length);
const job = JSON.parse(fs.readFileSync(jobFile, 'utf8'));
app.setPath('userData', job.profile);
app.commandLine.appendSwitch('disable-background-networking');

app.whenReady().then(async () => {
  const target = session.fromPartition('persist:' + job.id);
  if (job.cookies) {
    await target.clearStorageData({ storages: ['cookies'] });
    await setElectronCookies(target, job.cookies);
  }
  await target.cookies.flushStore();
  fs.writeFileSync(job.result, JSON.stringify({ cookies: await target.cookies.get({}) }));
  app.quit();
}).catch(() => {
  fs.writeFileSync(job.result, JSON.stringify({ failed: true }));
  app.exit(1);
});
