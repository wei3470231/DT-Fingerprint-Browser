'use strict';

const DEFAULT_BROWSER_CORE = 'chromium';

function isBrowserCore(value) {
  return value === 'chromium' || value === 'electron';
}

function browserCoreName(core) {
  return core === 'electron' ? 'Electron' : 'Chromium';
}

module.exports = { DEFAULT_BROWSER_CORE, isBrowserCore, browserCoreName };
