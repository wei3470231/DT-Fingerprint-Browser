'use strict';

/**
 * 自动识别 4 种常见代理格式：
 * 1. 代理服务器:端口:代理帳號:代理密碼 (host:port:user:pass)
 * 2. 代理服务器:端口@代理帳號:代理密碼 (host:port@user:pass)
 * 3. 代理帳號:代理密碼:代理服务器:端口 (user:pass:host:port)
 * 4. 代理帳號:代理密碼@代理服务器:端口 (user:pass@host:port)
 * 以及纯 host:port
 */
function parseProxyString(raw) {
  if (!raw || typeof raw !== 'string') return null;
  let str = raw.trim();
  if (!str) return null;

  // 1. 协议识别
  let type = 'socks5'; // 默认 SOCKS5（绝大多数指纹代理如 udealproxy 均为 socks5）
  if (/^socks5:\/\//i.test(str)) {
    type = 'socks5';
    str = str.replace(/^socks5:\/\//i, '');
  } else if (/^socks4:\/\//i.test(str)) {
    type = 'socks5';
    str = str.replace(/^socks4:\/\//i, '');
  } else if (/^https?:\/\//i.test(str)) {
    type = 'http';
    str = str.replace(/^https?:\/\//i, '');
  }

  let host = '', port = '', username = '', password = '';

  // 2. 带 @ 分隔符的情况：格式 2 或 格式 4
  if (str.includes('@')) {
    const atIndex = str.lastIndexOf('@');
    const partA = str.slice(0, atIndex).trim();
    const partB = str.slice(atIndex + 1).trim();

    // 检查哪一边是 host:port
    const aLastColon = partA.lastIndexOf(':');
    const bLastColon = partB.lastIndexOf(':');
    const aSuffix = aLastColon !== -1 ? partA.slice(aLastColon + 1) : '';
    const bSuffix = bLastColon !== -1 ? partB.slice(bLastColon + 1) : '';

    const aIsPort = /^\d{2,5}$/.test(aSuffix);
    const bIsPort = /^\d{2,5}$/.test(bSuffix);

    if (bIsPort && (!aIsPort || isLikelyHost(partB.slice(0, bLastColon)))) {
      // 格式 4: user:pass@host:port
      const uColon = partA.indexOf(':');
      username = uColon !== -1 ? partA.slice(0, uColon) : partA;
      password = uColon !== -1 ? partA.slice(uColon + 1) : '';
      host = partB.slice(0, bLastColon);
      port = bSuffix;
    } else {
      // 格式 2: host:port@user:pass
      host = partA.slice(0, aLastColon);
      port = aSuffix;
      const uColon = partB.indexOf(':');
      username = uColon !== -1 ? partB.slice(0, uColon) : partB;
      password = uColon !== -1 ? partB.slice(uColon + 1) : '';
    }
  } else {
    // 3. 只有冒号分隔的情况：格式 1、格式 3、3段格式 或 host:port
    const parts = str.split(':');
    if (parts.length === 2) {
      // host:port
      host = parts[0].trim();
      port = parts[1].trim();
    } else if (parts.length === 3) {
      // host:port:user 或 user:host:port
      const secondIsPort = /^\d{2,5}$/.test(parts[1].trim());
      const lastIsPort = /^\d{2,5}$/.test(parts[2].trim());
      if (secondIsPort) {
        host = parts[0].trim();
        port = parts[1].trim();
        username = parts[2].trim();
        password = '';
      } else if (lastIsPort) {
        username = parts[0].trim();
        host = parts[1].trim();
        port = parts[2].trim();
        password = '';
      }
    } else if (parts.length >= 4) {
      const secondIsPort = /^\d{2,5}$/.test(parts[1].trim());
      const lastIsPort = /^\d{2,5}$/.test(parts[parts.length - 1].trim());
      const firstIsHost = isLikelyHost(parts[0].trim());
      const secondLastIsHost = isLikelyHost(parts[parts.length - 2].trim());

      // 智能识别：若首字段具有明显 Host/IP 特征且第二字段为端口，即使密码为纯数字也严格判定为格式 1
      if (firstIsHost && secondIsPort && (!secondLastIsHost || !lastIsPort)) {
        host = parts[0].trim();
        port = parts[1].trim();
        username = parts[2].trim();
        password = parts.slice(3).join(':').trim();
      } else if (secondLastIsHost && lastIsPort && (!firstIsHost || !secondIsPort)) {
        // 格式 3: user:pass:host:port
        port = parts[parts.length - 1].trim();
        host = parts[parts.length - 2].trim();
        username = parts[0].trim();
        password = parts.slice(1, parts.length - 2).join(':').trim();
      } else if (secondIsPort) {
        // 兜底优先判定为通用格式 1 (host:port:user:pass)
        host = parts[0].trim();
        port = parts[1].trim();
        username = parts[2].trim();
        password = parts.slice(3).join(':').trim();
      } else if (lastIsPort) {
        port = parts[parts.length - 1].trim();
        host = parts[parts.length - 2].trim();
        username = parts[0].trim();
        password = parts.slice(1, parts.length - 2).join(':').trim();
      }
    }
  }

  if (!host || !port) return null;

  return {
    type,
    host,
    port: String(port),
    username,
    password
  };
}

function isLikelyHost(str) {
  if (!str) return false;
  return str.includes('.') || str.toLowerCase() === 'localhost' || /^\d+\.\d+\.\d+\.\d+$/.test(str) || str.includes('[');
}

module.exports = { parseProxyString };
