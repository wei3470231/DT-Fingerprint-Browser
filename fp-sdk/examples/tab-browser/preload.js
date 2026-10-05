'use strict';
// 只给浏览器界面（ui/index.html）使用；网页标签页没有这个 preload。
const { contextBridge, ipcRenderer } = require('electron');

const CHANNELS = new Set(['state', 'tab:new', 'tab:activate', 'tab:close', 'tab:navigate', 'tab:action', 'tab:menu',
  'tab:new-menu', 'drawer', 'profile:create', 'profile:save', 'profile:random', 'profile:delete']);

contextBridge.exposeInMainWorld('browserShell', {
  call: (channel, payload) => (CHANNELS.has(channel)
    ? ipcRenderer.invoke(channel, payload)
    : Promise.reject(new Error(`未知调用：${channel}`))),
  on: (event, callback) => {
    if (!['state', 'toast', 'focus-address'].includes(event)) return;
    ipcRenderer.on(event, (_event, value) => callback(value));
  },
});
