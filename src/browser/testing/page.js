'use strict';

(() => {
  const measureButton = document.getElementById('measure');
  const copyButton = document.getElementById('copy');
  const downloadButton = document.getElementById('download');
  const status = document.getElementById('status');
  const sections = document.getElementById('sections');
  const summary = document.getElementById('summary');
  let latest = null;
  Object.defineProperty(window, 'fingerprintResult', { get: () => latest });
  const statusLabels = { ok: '已读取', partial: '部分读数', error: '读取错误', unsupported: 'API 不可用', timeout: '读取超时' };
  const format = (value) => value === null || value === undefined ? '未提供' : typeof value === 'string' ? value || '（空字符串）' : typeof value === 'object' ? JSON.stringify(value, null, 2) : String(value);
  const element = (tag, className, text) => {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  };
  const dataOf = (key) => latest[key] && latest[key].data || {};
  const digest = (hash) => hash ? `${hash.value}\n${hash.algorithm}` : null;
  const row = (list, name, value, code = false) => {
    const wrap = element('div', 'row');
    wrap.append(element('dt', '', name), element('dd', code ? 'code' : '', format(value)));
    list.append(wrap);
  };
  const card = (name, key, rows, note) => {
    const section = latest[key] || { status: 'error', error: '无结果' };
    const node = element('section', 'card');
    const head = element('div', 'card-head');
    const badge = element('span', 'badge', statusLabels[section.status] || section.status);
    badge.dataset.state = section.status;
    head.append(element('h2', '', name), badge);
    node.append(head);
    const list = element('dl');
    for (const [label, value, code] of rows) row(list, label, value, code);
    node.append(list);
    if (note) node.append(element('p', 'detail-note', note));
    if (section.error) node.append(element('p', 'error', section.error));
    if (section.errors) node.append(element('p', 'error', format(section.errors)));
    const detail = element('details');
    detail.append(element('summary', '', '查看完整读数'), element('pre', '', JSON.stringify(section, null, 2)));
    node.append(detail);
    sections.append(node);
  };
  function render() {
    sections.replaceChildren();
    summary.replaceChildren();
    for (const [title, hash] of [['Canvas', dataOf('canvas').pixelHash], ['Audio', dataOf('audio').hash], ['Rects', dataOf('rects').hash]]) {
      const item = element('div', 'summary-item');
      item.append(element('div', 'summary-label', title), element('div', 'summary-value', hash ? hash.value.slice(0, 12) : '未获得'));
      if (hash) item.title = `${hash.algorithm}: ${hash.value}`;
      summary.append(item);
    }
    const nav = dataOf('navigator');
    const ua = dataOf('userAgentData');
    const intl = dataOf('intl');
    const screen = dataOf('screen');
    const webgl = dataOf('webgl');
    const canvas = dataOf('canvas');
    const audio = dataOf('audio');
    const rects = dataOf('rects');
    const metrics = dataOf('textMetrics');
    const plugins = dataOf('plugins');
    const voices = dataOf('voices');
    const media = dataOf('mediaDevices');
    const context = dataOf('context');
    card('Navigator / 身份', 'navigator', [['User Agent', nav.userAgent, true], ['平台', nav.platform], ['语言', nav.languages], ['CPU 核心', nav.hardwareConcurrency], ['内存 GB', nav.deviceMemory], ['WebDriver', nav.webdriver], ['Vendor', nav.vendor], ['触控点', nav.maxTouchPoints]], '值为页面实际返回；false、0 和空字符串均按原值展示。');
    card('UA Client Hints', 'userAgentData', [['Brands', ua.brands], ['平台', ua.platform], ['移动设备', ua.mobile], ['高熵信息', ua.highEntropy]], '安全上下文、权限策略或浏览器版本可能影响字段可用性。');
    card('时区 / 国际化', 'intl', [['时区', intl.dateTime && intl.dateTime.timeZone], ['Locale', intl.dateTime && intl.dateTime.locale], ['当前 UTC 偏移（分）', intl.timezoneOffsetMinutes], ['1 月 / 7 月偏移', [intl.januaryOffsetMinutes, intl.julyOffsetMinutes]], ['固定时间显示', intl.fixedDateDisplay]]);
    card('屏幕 / 视口', 'screen', [['屏幕', screen.width == null ? null : `${screen.width} × ${screen.height}`], ['可用区域', screen.availWidth == null ? null : `${screen.availWidth} × ${screen.availHeight}`], ['页面视口', screen.viewportWidth == null ? null : `${screen.viewportWidth} × ${screen.viewportHeight}`], ['DPR', screen.devicePixelRatio], ['颜色深度', screen.colorDepth], ['方向', screen.orientation]], '页面视口取决于此嵌入面板尺寸，屏幕值与视口值含义不同。');
    card('WebGL / GPU', 'webgl', [['未掩码 Vendor', webgl.unmaskedVendor], ['未掩码 Renderer', webgl.unmaskedRenderer], ['Vendor', webgl.vendor], ['Renderer', webgl.renderer], ['版本', webgl.version], ['最大纹理尺寸', webgl.maxTextureSize]]);
    card('Canvas 摘要', 'canvas', [['像素摘要', digest(canvas.pixelHash), true], ['PNG 摘要', digest(canvas.pngHash), true], ['绘制场景', canvas.scene]], '相同场景下比较实际输出，摘要不同只表示数值不同。');
    card('Audio 离线摘要', 'audio', [['样本摘要', digest(audio.hash), true], ['样本绝对值和', audio.absoluteSum4500To4999], ['采样率', audio.sampleRate], ['样本数量', audio.length], ['测量方案', audio.recipe]], '仅使用 OfflineAudioContext；不播放、不录音。');
    card('DOM 几何 / Rects', 'rects', [['几何摘要', digest(rects.hash), true], ['元素矩形', rects.bounding], ['重复读数', rects.repeatedBounding]], rects.note || '在隔离的隐藏元素中测量。展开可查看 Range 和 ClientRects。');
    card('字体 / TextMetrics', 'textMetrics', [['文字摘要', digest(metrics.hash), true], ['测量文字', metrics.text], ['Arial 宽度', metrics.metrics && metrics.metrics['16px Arial'] && metrics.metrics['16px Arial'].data.width], ['Serif 宽度', metrics.metrics && metrics.metrics['16px serif'] && metrics.metrics['16px serif'].data.width]], metrics.note);
    card('插件 / PDF', 'plugins', [['PDF 查看器', plugins.pdfViewerEnabled], ['插件数量', plugins.plugins && plugins.plugins.length], ['插件名称', plugins.plugins && plugins.plugins.map((plugin) => plugin.name).join('\n')], ['MIME 数量', plugins.mimeTypes && plugins.mimeTypes.length]]);
    card('语音列表', 'voices', [['语音数量', voices.count], ['语音摘要', digest(voices.hash), true], ['前 6 个语音', voices.voices && voices.voices.slice(0, 6).map((voice) => `${voice.lang} · ${voice.name}`).join('\n')]], voices.note);
    card('媒体设备枚举', 'mediaDevices', [['设备数量', media.count], ['分类数量', media.counts], ['设备标签', media.devices && media.devices.map((device) => `${device.kind} · ${device.label || '未授权 / 无标签'}`).join('\n')], ['本次请求权限', media.permissionRequested]], media.note);
    card('测量上下文', 'context', [['URL', context.url], ['Origin', context.origin], ['安全上下文', context.secureContext], ['上下文类型', context.type], ['页面可见性', context.visibilityState], ['时间', latest.collectedAt], ['耗时', `${latest.durationMs} ms`]], latest.notice);
    document.getElementById('raw').textContent = JSON.stringify(latest, null, 2);
    document.getElementById('raw-panel').hidden = false;
  }
  async function measure() {
    measureButton.disabled = true;
    copyButton.disabled = true;
    downloadButton.disabled = true;
    status.textContent = '正在读取… 媒体和语音列表最多等待约 2.4 秒。';
    status.dataset.tone = '';
    try {
      latest = await window.collectFingerprint();
      render();
      const counts = Object.values(latest).filter((value) => value && typeof value === 'object' && value.status).reduce((acc, value) => { acc[value.status] = (acc[value.status] || 0) + 1; return acc; }, {});
      const incomplete = (counts.error || 0) + (counts.partial || 0) + (counts.timeout || 0);
      status.textContent = `${new Date(latest.collectedAt).toLocaleTimeString()} · ${latest.durationMs} ms · ${counts.ok || 0} 项已读取${counts.unsupported ? ` · ${counts.unsupported} 项不可用` : ''}${incomplete ? ` · ${incomplete} 项不完整` : ''}`;
      if (incomplete) status.dataset.tone = 'error';
      copyButton.disabled = false;
      downloadButton.disabled = false;
    } catch (error) {
      status.textContent = `读取失败：${error.message || error}`;
      status.dataset.tone = 'error';
    } finally {
      measureButton.disabled = false;
    }
  }
  measureButton.addEventListener('click', measure);
  copyButton.addEventListener('click', async () => {
    if (!latest) return;
    try {
      await navigator.clipboard.writeText(JSON.stringify(latest, null, 2));
      status.textContent = '已复制完整 JSON。';
      status.dataset.tone = '';
    } catch (error) {
      status.textContent = `复制不可用：${error.message || error}。可使用“下载 JSON”。`;
      status.dataset.tone = 'error';
    }
  });
  downloadButton.addEventListener('click', () => {
    if (!latest) return;
    const url = URL.createObjectURL(new Blob([JSON.stringify(latest, null, 2)], { type: 'application/json' }));
    const link = element('a');
    link.href = url;
    link.download = `fingerprint-${latest.collectedAt.replace(/[:.]/g, '-')}.json`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  });
  measure();
})();
