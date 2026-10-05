'use strict';
// 指纹编辑表单与 SDK FingerprintConfig 之间的转换和校验。
// 界面只提交扁平字段；这里负责生成完整、一致的配置，拒绝无效输入。
const fs = require('node:fs');
const path = require('node:path');

const templates = fs.readdirSync(path.join(__dirname, '..', '..', 'profiles'))
  .filter(file => file.endsWith('.json'))
  .map(file => JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'profiles', file), 'utf8')));
const unique = (list, key) => [...new Map(list.map(item => [key(item), item])).values()];

const OPTIONS = {
  os: [{ value: '10.0.0', label: 'Windows 10' }, { value: '15.0.0', label: 'Windows 11' }],
  languages: [
    ['zh-CN', '中文（简体）'], ['zh-TW', '中文（繁體）'], ['en-US', 'English (US)'], ['en-GB', 'English (UK)'],
    ['ja-JP', '日本語'], ['ko-KR', '한국어'], ['de-DE', 'Deutsch'], ['fr-FR', 'Français'],
    ['es-ES', 'Español'], ['pt-BR', 'Português (BR)'], ['ru-RU', 'Русский'],
  ].map(([value, label]) => ({ value, label })),
  timezones: [
    'Asia/Shanghai', 'Asia/Hong_Kong', 'Asia/Taipei', 'Asia/Tokyo', 'Asia/Seoul', 'Asia/Singapore',
    'Europe/London', 'Europe/Berlin', 'Europe/Paris', 'Europe/Moscow', 'America/New_York',
    'America/Chicago', 'America/Los_Angeles', 'America/Sao_Paulo', 'Australia/Sydney', 'UTC',
  ],
  cores: [2, 4, 6, 8, 12, 16, 20, 24, 32],
  memory: [2, 4, 8, 16],
  screens: unique([
    ...templates.flatMap(t => t.resolutions),
    { width: 1440, height: 900 }, { width: 1536, height: 864 }, { width: 1600, height: 900 },
    { width: 2560, height: 1600 }, { width: 3840, height: 2160 },
  ], r => `${r.width}x${r.height}`).map(r => `${r.width}x${r.height}`),
  dpr: [1, 1.25, 1.5, 2],
  gpus: unique([
    ...templates.flatMap(t => t.gpus),
    { vendor: 'Google Inc. (AMD)', renderer: 'ANGLE (AMD, AMD Radeon RX 6600 Direct3D11 vs_5_0 ps_5_0, D3D11)' },
  ], g => g.renderer),
};

function formFromFingerprint(fp) {
  return {
    seed: fp.seed, os: fp.ua.platformVersion, language: fp.navigator.languages[0], timezone: fp.timezone,
    cores: fp.navigator.hardwareConcurrency, memory: fp.navigator.deviceMemory,
    screen: `${fp.screen.width}x${fp.screen.height}`, dpr: fp.screen.dpr,
    gpuVendor: fp.webgl.vendor, gpuRenderer: fp.webgl.renderer,
    canvas: fp.noise.canvas, audio: fp.noise.audio, rects: fp.noise.rects,
  };
}

function text(value, label) {
  const result = String(value ?? '').trim();
  if (!result || result.length > 200 || /[\u0000-\u001f]/.test(result)) throw new Error(`${label}无效。`);
  return result;
}
function oneOf(value, list, label) {
  const number = Number(value);
  if (!list.includes(number)) throw new Error(`${label}必须是 ${list.join(' / ')} 之一。`);
  return number;
}

// base 提供表单不涉及的字段（schemaVersion、uaString、ua.brand 等），返回全新对象。
function buildFingerprint(base, form) {
  const fp = structuredClone(base);
  const seed = String(form.seed ?? '').trim().toLowerCase();
  if (!/^[0-9a-f]{16}$/.test(seed)) throw new Error('种子必须是 16 位十六进制。');
  if (!OPTIONS.os.some(os => os.value === form.os)) throw new Error('系统版本无效。');
  const language = String(form.language ?? '');
  if (!/^[a-z]{2,3}(-[A-Z]{2})?$/.test(language)) throw new Error('语言代码无效。');
  const timezone = text(form.timezone, '时区');
  try { new Intl.DateTimeFormat('en-US', { timeZone: timezone }); } catch { throw new Error(`未知时区：${timezone}`); }
  const size = /^(\d{3,5})\s*[x×*]\s*(\d{3,5})$/.exec(String(form.screen ?? '').trim());
  const [width, height] = size ? [Number(size[1]), Number(size[2])] : [];
  if (!size || width < 640 || height < 480 || width > 7680 || height > 4320) throw new Error('屏幕分辨率格式为 宽x高，范围 640x480 – 7680x4320。');
  const base_ = language.split('-')[0];

  fp.seed = seed;
  fp.ua = { ...fp.ua, fullVersion: process.versions.chrome, platformVersion: form.os };
  fp.navigator = {
    ...fp.navigator,
    hardwareConcurrency: oneOf(form.cores, OPTIONS.cores, 'CPU 核心数'),
    deviceMemory: oneOf(form.memory, OPTIONS.memory, '内存'),
    languages: base_ === language ? [language] : [language, base_],
  };
  fp.screen = { width, height, availWidth: width, availHeight: height - 40, colorDepth: 24, dpr: oneOf(form.dpr, OPTIONS.dpr, 'DPR') };
  fp.webgl = { vendor: text(form.gpuVendor, 'WebGL 厂商'), renderer: text(form.gpuRenderer, 'WebGL 渲染器') };
  fp.timezone = timezone;
  fp.noise = { canvas: !!form.canvas, audio: !!form.audio, rects: !!form.rects };
  return fp;
}

function summarize(fp) {
  const os = OPTIONS.os.find(item => item.value === fp.ua.platformVersion)?.label ?? fp.ua.platform;
  return `${fp.navigator.languages[0]} · ${fp.timezone} · ${os} · ${fp.navigator.hardwareConcurrency} 核 / ${fp.navigator.deviceMemory} GB · ${fp.screen.width}×${fp.screen.height}`;
}

module.exports = { OPTIONS, formFromFingerprint, buildFingerprint, summarize };
