'use strict';

const fs = require('node:fs');
const path = require('node:path');

const ICONS_DIR = path.resolve(__dirname, 'icons');
const iconCache = new Map();

function preloadIcons() {
  if (iconCache.size > 0) return iconCache;
  try {
    if (fs.existsSync(ICONS_DIR)) {
      const files = fs.readdirSync(ICONS_DIR);
      for (const file of files) {
        if (file.endsWith('.svg')) {
          const name = path.basename(file, '.svg');
          const content = fs.readFileSync(path.join(ICONS_DIR, file), 'utf8').trim();
          iconCache.set(name, content);
        }
      }
    }
  } catch (err) {
    console.warn('[IconLoader] 预加载图标文件失败:', err.message);
  }
  return iconCache;
}

function getIconSvg(name, options = {}) {
  preloadIcons();
  let svg = iconCache.get(name);
  const width = options.width || options.size;
  const height = options.height || options.size;

  if (!svg) {
    // 基础防崩兜底空白 svg
    return `<svg viewBox="0 0 24 24" width="${width || 13}" height="${height || 13}"></svg>`;
  }

  // 允许动态替换 width, height, size, className, style, color
  if (width || height || options.className || options.style || options.color) {
    let replaced = svg;
    if (width) replaced = replaced.replace(/width="[^"]*"/, `width="${width}"`);
    if (height) replaced = replaced.replace(/height="[^"]*"/, `height="${height}"`);
    if (options.className) replaced = replaced.replace(/<svg\s+/, `<svg class="${options.className}" `);
    let extraStyle = options.style || '';
    if (options.color) {
      extraStyle = (extraStyle ? extraStyle + ';' : '') + `color:${options.color}`;
      replaced = replaced.replace(/stroke="currentColor"/g, `stroke="${options.color}"`);
    }
    if (extraStyle) {
      if (replaced.includes('style="')) {
        replaced = replaced.replace(/style="([^"]*)"/, `style="$1;${extraStyle}"`);
      } else {
        replaced = replaced.replace(/<svg\s+/, `<svg style="${extraStyle}" `);
      }
    }
    return replaced;
  }
  return svg;
}

function getAllIcons() {
  preloadIcons();
  const res = {};
  for (const [k, v] of iconCache.entries()) {
    res[k] = v;
  }
  return res;
}

module.exports = {
  preloadIcons,
  getIconSvg,
  getAllIcons
};
