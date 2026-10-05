'use strict';
// 在网页环境中读取常见指纹值。结果同时写到 window.__fpb，供 self-test 校验。
(async () => {
  const safe = (fn, fallback = '（不可用）') => { try { const value = fn(); return value ?? fallback; } catch (error) { return `（${error.name}）`; } };
  const hex = buffer => [...new Uint8Array(buffer)].map(byte => byte.toString(16).padStart(2, '0')).join('');

  const gl = document.createElement('canvas').getContext('webgl');
  const debug = gl?.getExtension('WEBGL_debug_renderer_info');
  const canvas = document.createElement('canvas');
  canvas.width = 240; canvas.height = 60;
  const ctx = canvas.getContext('2d');
  ctx.textBaseline = 'top'; ctx.font = '16px Arial'; ctx.fillStyle = '#f60'; ctx.fillRect(100, 1, 62, 20);
  ctx.fillStyle = '#069'; ctx.fillText('FP Lab 指纹 ✓ 1.0', 2, 15);
  ctx.fillStyle = 'rgba(102, 204, 0, 0.7)'; ctx.fillText('FP Lab 指纹 ✓ 1.0', 4, 17);
  const canvasHash = hex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canvas.toDataURL()))).slice(0, 16);
  const uaData = await (navigator.userAgentData?.getHighEntropyValues(['platform', 'platformVersion']).catch(() => null) ?? null);

  const data = {
    userAgent: navigator.userAgent,
    platform: navigator.platform,
    uaPlatform: uaData ? `${uaData.platform} ${uaData.platformVersion}` : '（不可用）',
    hardwareConcurrency: navigator.hardwareConcurrency,
    deviceMemory: navigator.deviceMemory,
    languages: [...navigator.languages],
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    localTime: new Date().toString(),
    screen: { width: screen.width, height: screen.height, availWidth: screen.availWidth, availHeight: screen.availHeight, colorDepth: screen.colorDepth },
    devicePixelRatio,
    webglVendor: safe(() => gl.getParameter(debug.UNMASKED_VENDOR_WEBGL)),
    webglRenderer: safe(() => gl.getParameter(debug.UNMASKED_RENDERER_WEBGL)),
    canvasHash,
    webdriver: navigator.webdriver,
  };

  const rows = [
    ['User-Agent', data.userAgent],
    ['navigator.platform', data.platform],
    ['UA-CH 平台', data.uaPlatform],
    ['CPU 核心', data.hardwareConcurrency],
    ['设备内存', `${data.deviceMemory} GB`],
    ['语言', data.languages.join(', ')],
    ['时区', data.timezone],
    ['本地时间', data.localTime],
    ['屏幕', `${data.screen.width} × ${data.screen.height}（可用 ${data.screen.availWidth} × ${data.screen.availHeight}，色深 ${data.screen.colorDepth}）`],
    ['devicePixelRatio', data.devicePixelRatio],
    ['WebGL 厂商', data.webglVendor],
    ['WebGL 渲染器', data.webglRenderer],
    ['Canvas 哈希', data.canvasHash],
    ['navigator.webdriver', String(data.webdriver)],
  ];
  document.querySelector('#fingerprint tbody').replaceChildren(...rows.map(([name, value]) => {
    const row = document.createElement('tr');
    row.append(Object.assign(document.createElement('th'), { textContent: name }), Object.assign(document.createElement('td'), { textContent: String(value) }));
    return row;
  }));

  // 每个身份是独立的 Session：同一身份的标签页共享这个计数，不同身份互不可见。
  let visits = '（localStorage 不可用）';
  try {
    const count = Number(localStorage.getItem('fpb-visits') || 0) + 1;
    localStorage.setItem('fpb-visits', String(count));
    visits = `本身份第 ${count} 次打开新标签页。同一身份的标签页共享此计数，不同身份各自独立。`;
  } catch {}
  document.getElementById('visits').textContent = visits;

  window.__fpb = data;
})();
