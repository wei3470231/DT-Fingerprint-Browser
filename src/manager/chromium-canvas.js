'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { chromiumSeed } = require('../shared/chromium-seed');

const compatibilityScript = path.join(__dirname, '..', 'browser', 'canvas-compat.js');
const FINGERPRINT_PAGE_FOLDER = 'fingerprint-check';
const manifest = {
  manifest_version: 3,
  name: 'DT Canvas compatibility',
  version: '1.0',
  content_scripts: [{
    matches: ['http://*/*', 'https://*/*'],
    js: ['canvas.js'],
    run_at: 'document_start',
    world: 'MAIN',
    all_frames: true,
    match_origin_as_fallback: true,
  }],
};

function usesCanvasCompatibility(fp) {
  return fp?.noise?.canvas !== false && !fp?.disable?.includes('canvas');
}

function prepareCanvasAssets(profile, fp) {
  const directory = path.join(profile, 'dt-canvas');
  const page = path.join(directory, FINGERPRINT_PAGE_FOLDER);
  fs.mkdirSync(page, { recursive: true });

  const canvasCode = usesCanvasCompatibility(fp)
    ? '(() => { const DT_CANVAS_SEED = ' + chromiumSeed(fp) + ';\n' + fs.readFileSync(compatibilityScript, 'utf8') + '\n})();'
    : '';
  fs.writeFileSync(path.join(directory, 'canvas.js'), canvasCode);
  fs.writeFileSync(path.join(directory, 'manifest.json'), JSON.stringify(manifest));
  const testing = path.join(__dirname, '..', 'browser', 'testing');
  const html = fs.readFileSync(path.join(testing, 'index.html'), 'utf8');
  fs.writeFileSync(path.join(page, 'index.html'), html.replace('</head>', '  <script src="../canvas.js"></script>\n</head>'));
  for (const asset of ['fingerprint-probe.js', 'page.js', 'styles.css']) {
    fs.writeFileSync(path.join(page, asset), fs.readFileSync(path.join(testing, asset)));
  }
}

module.exports = { FINGERPRINT_PAGE_FOLDER, usesCanvasCompatibility, prepareCanvasAssets };
