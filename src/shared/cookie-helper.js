'use strict';

/**
 * Cookie 格式处理助手：
 * - 支持标准 JSON 格式 (EditThisCookie / Cookie-Editor / Puppeteer / Playwright)
 * - 支持标准 Netscape HTTP Cookie 格式 (cURL / wget / 很多自动化批量格式)
 * - 转换为 Electron session.cookies.set() 标准参数
 */

/**
 * 自动嗅探或指定格式解析 Cookie 字符串 (JSON 或 Netscape)
 * @param {string} rawText 
 * @param {string} format 'auto' | 'json' | 'netscape'
 * @returns {Array<object>} 标准 cookie 列表 (同时兼容 { cookies, error } 解构)
 */
function parseCookies(rawText, format = 'auto') {
  const emptyRes = [];
  emptyRes.cookies = [];
  emptyRes.error = '内容为空';
  if (!rawText || typeof rawText !== 'string') return emptyRes;
  const trimmed = rawText.trim();
  if (!trimmed) return emptyRes;

  let cookies = [];
  try {
    if (format === 'json') {
      const parsed = JSON.parse(trimmed);
      const list = Array.isArray(parsed) ? parsed : [parsed];
      cookies = list.map(c => normalizeCookieObject(c)).filter(Boolean);
    } else if (format === 'netscape') {
      cookies = parseNetscapeCookies(trimmed);
    } else {
      // auto 智能检测
      if (trimmed.startsWith('[') || trimmed.startsWith('{')) {
        try {
          const parsed = JSON.parse(trimmed);
          const list = Array.isArray(parsed) ? parsed : [parsed];
          cookies = list.map(c => normalizeCookieObject(c)).filter(Boolean);
        } catch (_) {
          cookies = parseNetscapeCookies(trimmed);
        }
      } else {
        cookies = parseNetscapeCookies(trimmed);
      }
    }
  } catch (err) {
    const errRes = [];
    errRes.cookies = [];
    errRes.error = err.message;
    return errRes;
  }

  cookies.cookies = cookies;
  cookies.error = cookies.length > 0 ? null : '未能解析出有效Cookie';
  return cookies;
}

/**
 * 规范化单个 Cookie 对象为 Electron/标准字段
 */
function normalizeCookieObject(c) {
  if (!c || !c.name) return null;
  const name = String(c.name).trim();
  const value = String(c.value !== undefined ? c.value : '');
  let domain = String(c.domain || '').trim();
  let path = String(c.path || '/').trim();
  if (!path.startsWith('/')) path = '/' + path;

  let secure = Boolean(c.secure);
  let httpOnly = Boolean(c.httpOnly);
  
  // 过期时间统一换算为秒数 (Unix timestamp in seconds)
  let expirationDate = undefined;
  if (c.expirationDate !== undefined && c.expirationDate !== null) {
    expirationDate = Number(c.expirationDate);
    if (expirationDate > 1e11) expirationDate = Math.floor(expirationDate / 1000); // 毫秒转秒
  } else if (c.expires !== undefined && c.expires !== null) {
    const expNum = Number(c.expires);
    if (!isNaN(expNum) && expNum > 0) {
      expirationDate = expNum > 1e11 ? Math.floor(expNum / 1000) : expNum;
    } else {
      const parsedDate = Date.parse(c.expires);
      if (!isNaN(parsedDate)) expirationDate = Math.floor(parsedDate / 1000);
    }
  }

  let sameSite = 'unspecified';
  if (c.sameSite) {
    const s = String(c.sameSite).toLowerCase();
    if (s.includes('lax')) sameSite = 'lax';
    else if (s.includes('strict')) sameSite = 'strict';
    else if (s.includes('no')) sameSite = 'no_restriction';
  }

  return {
    name,
    value,
    domain,
    path,
    secure,
    httpOnly,
    expirationDate,
    sameSite
  };
}

/**
 * 解析 Netscape 格式文本
 * 每行格式: domain\tflag\tpath\tsecure\texpiration\tname\tvalue
 */
function parseNetscapeCookies(text) {
  const lines = text.split(/\r?\n/);
  const result = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    // 以 Tab 制表符分割，部分软件可能用空格，优先支持制表符，兜底多个空格
    let parts = line.split('\t');
    if (parts.length < 7) {
      parts = line.split(/\s+/);
    }

    if (parts.length >= 7) {
      const domain = parts[0].trim();
      const path = parts[2].trim() || '/';
      const secure = parts[3].trim().toUpperCase() === 'TRUE';
      let expirationDate = Number(parts[4].trim());
      if (isNaN(expirationDate) || expirationDate <= 0) expirationDate = undefined;
      else if (expirationDate > 1e11) expirationDate = Math.floor(expirationDate / 1000);

      const name = parts[5].trim();
      // value 取后续剩余所有内容，防止值中含分隔符
      const value = parts.slice(6).join('\t').trim();

      if (name) {
        result.push({
          name,
          value,
          domain,
          path,
          secure,
          httpOnly: false,
          expirationDate,
          sameSite: 'unspecified'
        });
      }
    }
  }

  return result;
}

/**
 * 将 Cookie 列表导出为美化的 JSON 字符串
 */
function exportAsJson(cookies) {
  if (!Array.isArray(cookies)) return '[]';
  const clean = cookies.map(c => ({
    name: c.name,
    value: c.value,
    domain: c.domain,
    path: c.path || '/',
    secure: Boolean(c.secure),
    httpOnly: Boolean(c.httpOnly),
    expirationDate: c.expirationDate,
    sameSite: c.sameSite || 'unspecified'
  }));
  return JSON.stringify(clean, null, 2);
}

/**
 * 将 Cookie 列表导出为标准 Netscape 格式文本
 */
function exportAsNetscape(cookies) {
  if (!Array.isArray(cookies)) return '';
  const lines = [
    '# Netscape HTTP Cookie File',
    '# https://curl.haxx.se/docs/http-cookies.html',
    '# Exported by DT-Fingerprint-Browser',
    '# Generated on ' + new Date().toISOString(),
    ''
  ];

  for (const c of cookies) {
    if (!c || !c.name) continue;
    let domain = c.domain || 'localhost';
    const flag = domain.startsWith('.') ? 'TRUE' : 'FALSE';
    const path = c.path || '/';
    const secure = c.secure ? 'TRUE' : 'FALSE';
    const expires = c.expirationDate ? Math.floor(c.expirationDate) : '0';
    const name = c.name;
    const value = c.value || '';

    lines.push([domain, flag, path, secure, expires, name, value].join('\t'));
  }

  return lines.join('\n');
}

/**
 * 根据 Cookie 的 domain 和 path 构造 Electron session.cookies.set() 必须的合法 URL
 */
function buildCookieUrl(cookie) {
  let domain = (cookie.domain || 'localhost').replace(/^\./, '');
  const proto = cookie.secure ? 'https://' : 'http://';
  let p = cookie.path || '/';
  if (!p.startsWith('/')) p = '/' + p;
  return proto + domain + p;
}

module.exports = {
  parseCookies,
  exportAsJson,
  exportAsNetscape,
  buildCookieUrl,
  normalizeCookieObject
};
