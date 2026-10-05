/* Read-only fingerprint measurements. The function is deliberately self-contained:
 * its source can be injected with webContents.executeJavaScript without a preload. */
(function exposeProbe(root, factory) {
  const collectFingerprint = factory();
  if (typeof module === 'object' && module.exports) module.exports = collectFingerprint;
  else root.collectFingerprint = collectFingerprint;
})(typeof globalThis !== 'undefined' ? globalThis : this, function createProbe() {
  return async function collectFingerprint() {
    const started = Date.now();
    const root = globalThis;
    const nav = root.navigator;
    const doc = root.document;
    const errorText = (error) => `${error && error.name ? error.name : 'Error'}: ${error && error.message ? error.message : String(error)}`;
    const unsupported = (reason) => ({ status: 'unsupported', error: reason, data: null });
    const read = (getters) => {
      const data = {};
      const errors = {};
      for (const [key, getter] of Object.entries(getters)) {
        try {
          const value = getter();
          data[key] = value === undefined ? null : value;
        } catch (error) {
          data[key] = null;
          errors[key] = errorText(error);
        }
      }
      return Object.keys(errors).length ? { status: 'partial', data, errors } : { status: 'ok', data };
    };
    const measure = async (fn, timeoutMs = 2400) => {
      let timer;
      try {
        return await Promise.race([
          Promise.resolve().then(fn).then((value) => value && typeof value.status === 'string' ? value : { status: 'ok', data: value }),
          new Promise((resolve) => { timer = setTimeout(() => resolve({ status: 'timeout', data: null, error: `超过 ${timeoutMs} ms，未获得读数` }), timeoutMs); }),
        ]);
      } catch (error) {
        return { status: 'error', data: null, error: errorText(error) };
      } finally {
        clearTimeout(timer);
      }
    };
    const hashBytes = async (bytes) => {
      if (root.crypto && root.crypto.subtle) {
        try {
          const digest = await root.crypto.subtle.digest('SHA-256', bytes);
          return { algorithm: 'SHA-256', value: Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('') };
        } catch (_) { /* Some origins disallow SubtleCrypto. Identify the fallback explicitly. */ }
      }
      let value = 0x811c9dc5;
      for (let index = 0; index < bytes.length; index += 1) value = Math.imul(value ^ bytes[index], 0x01000193) >>> 0;
      return { algorithm: 'FNV-1a 32-bit (non-cryptographic)', value: value.toString(16).padStart(8, '0') };
    };
    const hashText = (value) => hashBytes(new TextEncoder().encode(value));
    const rectValue = (rect) => ({ x: rect.x, y: rect.y, width: rect.width, height: rect.height, top: rect.top, right: rect.right, bottom: rect.bottom, left: rect.left });
    const result = {
      schemaVersion: 1,
      probeVersion: '1.1.0',
      collectedAt: new Date().toISOString(),
      context: read({
        url: () => root.location.href,
        origin: () => root.location.origin,
        title: () => doc ? doc.title : null,
        secureContext: () => root.isSecureContext,
        crossOriginIsolated: () => root.crossOriginIsolated,
        visibilityState: () => doc ? doc.visibilityState : null,
        type: () => doc ? 'window' : 'worker',
      }),
    };
    const tasks = {
      navigator: () => read({
        userAgent: () => nav.userAgent,
        appVersion: () => nav.appVersion,
        platform: () => nav.platform,
        vendor: () => nav.vendor,
        hardwareConcurrency: () => nav.hardwareConcurrency,
        deviceMemory: () => nav.deviceMemory,
        language: () => nav.language,
        languages: () => Array.from(nav.languages || []),
        webdriver: () => nav.webdriver,
        maxTouchPoints: () => nav.maxTouchPoints,
        cookieEnabled: () => nav.cookieEnabled,
        doNotTrack: () => nav.doNotTrack,
        pdfViewerEnabled: () => nav.pdfViewerEnabled,
      }),
      userAgentData: async () => {
        if (!nav.userAgentData) return unsupported('此上下文未提供 navigator.userAgentData');
        const section = read({
          brands: () => Array.from(nav.userAgentData.brands || [], (brand) => ({ brand: brand.brand, version: brand.version })),
          mobile: () => nav.userAgentData.mobile,
          platform: () => nav.userAgentData.platform,
        });
        if (typeof nav.userAgentData.getHighEntropyValues !== 'function') {
          section.data.highEntropy = null;
          section.highEntropyStatus = 'unsupported';
          return section;
        }
        const entropy = await measure(() => nav.userAgentData.getHighEntropyValues(['architecture', 'bitness', 'model', 'platformVersion', 'uaFullVersion', 'fullVersionList', 'wow64']), 1800);
        section.data.highEntropy = entropy.data;
        section.highEntropyStatus = entropy.status;
        if (entropy.status !== 'ok') {
          section.status = 'partial';
          section.errors = { ...(section.errors || {}), highEntropy: entropy.error };
        }
        return section;
      },
      intl: () => read({
        dateTime: () => new Intl.DateTimeFormat().resolvedOptions(),
        numberFormat: () => new Intl.NumberFormat().resolvedOptions(),
        timezoneOffsetMinutes: () => new Date().getTimezoneOffset(),
        januaryOffsetMinutes: () => new Date('2026-01-15T12:00:00Z').getTimezoneOffset(),
        julyOffsetMinutes: () => new Date('2026-07-15T12:00:00Z').getTimezoneOffset(),
        fixedDateDisplay: () => new Date('2026-01-15T12:34:56Z').toString(),
      }),
      screen: () => {
        if (!root.screen) return unsupported('此上下文未提供 screen');
        return read({
          width: () => root.screen.width,
          height: () => root.screen.height,
          availWidth: () => root.screen.availWidth,
          availHeight: () => root.screen.availHeight,
          availLeft: () => root.screen.availLeft,
          availTop: () => root.screen.availTop,
          colorDepth: () => root.screen.colorDepth,
          pixelDepth: () => root.screen.pixelDepth,
          devicePixelRatio: () => root.devicePixelRatio,
          viewportWidth: () => root.innerWidth,
          viewportHeight: () => root.innerHeight,
          outerWidth: () => root.outerWidth,
          outerHeight: () => root.outerHeight,
          orientation: () => root.screen.orientation ? { type: root.screen.orientation.type, angle: root.screen.orientation.angle } : null,
        });
      },
      webgl: () => {
        if (!doc) return unsupported('此上下文无 document');
        const canvas = doc.createElement('canvas');
        const gl = canvas.getContext('webgl') || canvas.getContext('experimental-webgl');
        if (!gl) return unsupported('无法创建 WebGL context');
        try {
          const extension = gl.getExtension('WEBGL_debug_renderer_info');
          return read({
            vendor: () => gl.getParameter(gl.VENDOR),
            renderer: () => gl.getParameter(gl.RENDERER),
            unmaskedVendor: () => extension ? gl.getParameter(extension.UNMASKED_VENDOR_WEBGL) : null,
            unmaskedRenderer: () => extension ? gl.getParameter(extension.UNMASKED_RENDERER_WEBGL) : null,
            version: () => gl.getParameter(gl.VERSION),
            shadingLanguageVersion: () => gl.getParameter(gl.SHADING_LANGUAGE_VERSION),
            maxTextureSize: () => gl.getParameter(gl.MAX_TEXTURE_SIZE),
            debugRendererInfoAvailable: () => Boolean(extension),
            extensions: () => gl.getSupportedExtensions(),
          });
        } finally {
          const lose = gl.getExtension('WEBGL_lose_context');
          if (lose) lose.loseContext();
        }
      },
      canvas: async () => {
        if (!doc) return unsupported('此上下文无 document');
        const canvas = doc.createElement('canvas');
        canvas.width = 320;
        canvas.height = 100;
        const ctx = canvas.getContext('2d');
        if (!ctx) return unsupported('无法创建 Canvas 2D context');
        ctx.fillStyle = '#f4c46f';
        ctx.fillRect(0, 0, 320, 100);
        ctx.fillStyle = '#15486b';
        ctx.font = '19px Arial';
        ctx.textBaseline = 'alphabetic';
        ctx.fillText('Fingerprint / 指纹 / Aa Ω 0123', 7.25, 31.5);
        ctx.globalCompositeOperation = 'multiply';
        ctx.fillStyle = 'rgba(225, 62, 95, 0.72)';
        ctx.beginPath();
        ctx.arc(100.75, 59.25, 28.5, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = 'rgba(43, 177, 153, 0.68)';
        ctx.fillRect(91.75, 43.125, 138.375, 31.5);
        const values = {};
        const errors = {};
        for (const [key, getter] of Object.entries({
          pixelHash: () => hashBytes(ctx.getImageData(0, 0, 320, 100).data),
          pngHash: () => hashText(canvas.toDataURL('image/png')),
        })) {
          try { values[key] = await getter(); } catch (error) { values[key] = null; errors[key] = errorText(error); }
        }
        return { status: Object.keys(errors).length ? 'partial' : 'ok', data: { scene: 'fp-workbench-canvas-v1', width: 320, height: 100, ...values }, ...(Object.keys(errors).length ? { errors } : {}) };
      },
      audio: async () => {
        const AudioContext = root.OfflineAudioContext || root.webkitOfflineAudioContext;
        if (!AudioContext) return unsupported('此上下文未提供 OfflineAudioContext');
        const ctx = new AudioContext(1, 44100, 44100);
        const oscillator = ctx.createOscillator();
        const compressor = ctx.createDynamicsCompressor();
        try {
          oscillator.type = 'triangle';
          oscillator.frequency.value = 10000;
          compressor.threshold.value = -50;
          compressor.knee.value = 40;
          compressor.ratio.value = 12;
          compressor.attack.value = 0;
          compressor.release.value = 0.25;
          oscillator.connect(compressor);
          compressor.connect(ctx.destination);
          oscillator.start(0);
          const rendered = await ctx.startRendering();
          const samples = rendered.getChannelData(0);
          const bytes = new Uint8Array(samples.buffer, samples.byteOffset, samples.byteLength);
          let sum = 0;
          for (let index = 4500; index < 5000; index += 1) sum += Math.abs(samples[index]);
          return { hash: await hashBytes(bytes), sampleRate: rendered.sampleRate, length: samples.length, absoluteSum4500To4999: sum, samplePreview: Array.from(samples.slice(4500, 4508)), recipe: 'triangle-10000Hz-compressor-v1', offline: true };
        } finally {
          oscillator.disconnect();
          compressor.disconnect();
        }
      },
      rects: async () => {
        if (!doc || !doc.documentElement) return unsupported('此上下文无 DOM');
        // The host remains exposed to page selectors even when its children live
        // in a shadow root. Important inline declarations defeat site-wide rules
        // such as `div { display: none !important }`. `all` does not reset bidi.
        const forceStyles = (target, styles) => {
          for (const [key, value] of Object.entries(styles)) target.style.setProperty(key, value, 'important');
        };
        const host = doc.createElement('div');
        forceStyles(host, { all: 'initial', display: 'block', position: 'fixed', left: '-10000px', top: '0', width: '240px', height: '120px', visibility: 'hidden', contain: 'strict', 'pointer-events': 'none', direction: 'ltr', 'unicode-bidi': 'isolate' });
        const shadow = host.attachShadow({ mode: 'closed' });
        const node = doc.createElement('div');
        forceStyles(node, { all: 'initial', display: 'block', 'box-sizing': 'content-box', width: '173.375px', height: '49.125px', padding: '3.25px 5.5px', border: '0.75px solid transparent', font: '17px Arial', 'line-height': '23.5px', 'letter-spacing': '0.125px', transform: 'rotate(0.125deg)', 'transform-origin': '0 0', direction: 'ltr', 'unicode-bidi': 'isolate' });
        node.textContent = 'Fingerprint 指纹 Ω 012345';
        shadow.appendChild(node);
        doc.documentElement.appendChild(host);
        try {
          const range = doc.createRange();
          range.selectNodeContents(node);
          const values = read({
            bounding: () => rectValue(node.getBoundingClientRect()),
            repeatedBounding: () => rectValue(node.getBoundingClientRect()),
            clientRects: () => Array.from(node.getClientRects(), rectValue),
            rangeBounding: () => rectValue(range.getBoundingClientRect()),
            rangeRects: () => Array.from(range.getClientRects(), rectValue),
          });
          values.data.hash = await hashText(JSON.stringify(values.data));
          values.data.recipe = 'fp-workbench-rects-v2';
          const rootStyle = root.getComputedStyle(doc.documentElement);
          values.data.documentRoot = { transform: rootStyle.transform, zoom: rootStyle.zoom, perspective: rootStyle.perspective, filter: rootStyle.filter, contentVisibility: rootStyle.contentVisibility };
          values.data.note = '已隔离页面选择器及文字方向；页面根元素的缩放、变换、隐藏状态或同名字体仍可能改变几何读数。比较 seed 稳定性请使用相同页面与缩放设置。';
          return values;
        } finally {
          host.remove();
        }
      },
      textMetrics: async () => {
        if (!doc) return unsupported('此上下文无 document');
        const ctx = doc.createElement('canvas').getContext('2d');
        if (!ctx) return unsupported('无法创建 Canvas 2D context');
        const text = 'Fingerprint 指纹 Aa Ω 0123456789';
        const fonts = ['16px Arial', '16px "Times New Roman"', '16px "Courier New"', '16px sans-serif', '16px serif', '16px monospace'];
        const metrics = {};
        for (const font of fonts) {
          ctx.font = font;
          const measured = ctx.measureText(text);
          metrics[font] = read(Object.fromEntries(['width', 'actualBoundingBoxLeft', 'actualBoundingBoxRight', 'actualBoundingBoxAscent', 'actualBoundingBoxDescent', 'fontBoundingBoxAscent', 'fontBoundingBoxDescent', 'emHeightAscent', 'emHeightDescent', 'hangingBaseline', 'alphabeticBaseline', 'ideographicBaseline'].map((key) => [key, () => measured[key]])));
        }
        return { text, metrics, hash: await hashText(JSON.stringify(metrics)), note: '字体名称是测量请求值；浏览器可能使用回退字体，并非已安装字体清单。' };
      },
      plugins: () => read({
        pdfViewerEnabled: () => nav.pdfViewerEnabled,
        plugins: () => Array.from(nav.plugins || [], (plugin) => ({ name: plugin.name, filename: plugin.filename, description: plugin.description, mimeTypes: Array.from(plugin, (type) => ({ type: type.type, suffixes: type.suffixes, description: type.description })) })),
        mimeTypes: () => Array.from(nav.mimeTypes || [], (type) => ({ type: type.type, suffixes: type.suffixes, description: type.description, enabledPlugin: type.enabledPlugin ? type.enabledPlugin.name : null })),
      }),
      voices: async () => {
        if (!root.speechSynthesis) return unsupported('此上下文未提供 speechSynthesis');
        const synth = root.speechSynthesis;
        let voices = synth.getVoices();
        let waitedForVoices = false;
        if (!voices.length) {
          waitedForVoices = true;
          await new Promise((resolve) => {
            let timer;
            const finish = () => {
              clearTimeout(timer);
              synth.removeEventListener('voiceschanged', changed);
              resolve();
            };
            const changed = () => { if (synth.getVoices().length) finish(); };
            synth.addEventListener('voiceschanged', changed);
            timer = setTimeout(finish, 1000);
            changed();
          });
          voices = synth.getVoices();
        }
        const list = Array.from(voices, (voice) => ({ name: voice.name, lang: voice.lang, localService: voice.localService, default: voice.default, voiceURI: voice.voiceURI }));
        return { count: list.length, waitedForVoices, voices: list, hash: await hashText(JSON.stringify(list)), note: list.length ? '仅读取语音列表，未播放或合成语音。' : '当前读取到空列表；语音服务也可能尚未完成初始化。' };
      },
      mediaDevices: async () => {
        if (!nav.mediaDevices || typeof nav.mediaDevices.enumerateDevices !== 'function') return unsupported('此上下文未提供 mediaDevices.enumerateDevices；通常需要安全上下文');
        const devices = Array.from(await nav.mediaDevices.enumerateDevices(), (device) => ({ kind: device.kind, label: device.label, deviceId: device.deviceId, groupId: device.groupId }));
        const counts = { audioinput: 0, audiooutput: 0, videoinput: 0 };
        for (const device of devices) counts[device.kind] = (counts[device.kind] || 0) + 1;
        return { count: devices.length, counts, devices, permissionRequested: false, note: '仅枚举；未请求摄像头或麦克风权限，未打开设备。未授权时标签/ID/设备数量可能被限制。' };
      },
    };
    await Promise.all(Object.entries(tasks).map(async ([name, task]) => { result[name] = await measure(task); }));
    result.durationMs = Date.now() - started;
    result.notice = '哈希是当前测量值的摘要，仅用于比较；不是检测评分或通过证明。视口、权限、页面策略及上下文可能影响结果。';
    return result;
  };
});
