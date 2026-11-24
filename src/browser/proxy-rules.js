'use strict';

const { isIP } = require('node:net');
const { domainToASCII } = require('node:url');

const DEFAULT_PROXY_BYPASS = '<local>;localhost;127.0.0.1';

function canonicalIp(address) {
  return isIP(address) === 6 ? new URL(`http://[${address}]`).hostname.slice(1, -1) : address;
}

function proxyHostRules(input = '') {
  const hosts = new Set();
  for (const part of String(input).split(/[;,\n]/)) {
    const rule = part.trim().toLowerCase();
    if (rule === '<local>') {
      hosts.add(rule);
      continue;
    }
    const authority = rule.replace(/^[a-z][a-z\d+.-]*:\/\//, '').split(/[/?#]/, 1)[0];
    if (isIP(authority)) {
      hosts.add(canonicalIp(authority));
      continue;
    }
    const ipv6 = /^\[([a-f\d:.]+)\](?::\d+)?$/i.exec(authority);
    if (ipv6 && isIP(ipv6[1]) === 6) {
      hosts.add(canonicalIp(ipv6[1]));
      continue;
    }
    const host = authority.replace(/:\d+$/, '').replace(/\.$/, '');
    // Treat the legacy *domain* spelling as a domain rather than a URL substring.
    const pattern = domainToASCII(host.replace(/^\*([^./*]+\.[^/*]+)\*$/, '$1'));
    if (pattern && /^[a-z\d._*-]+$/.test(pattern)) hosts.add(pattern);
  }
  return [...hosts];
}

function buildRoutingPac({ rules = '', bypass = '', targets, fallback = 'DIRECT' }) {
  const proxyRules = proxyHostRules(rules);
  const directRules = proxyHostRules(bypass);

  return [
    'function FindProxyForURL(url, host) {',
    '  host = host.toLowerCase().replace(/\\.$/, "").replace(/^\\[|\\]$/g, "");',
    '  function matches(pattern) {',
    '    if (pattern === "<local>") return isPlainHostName(host) && host.indexOf(":") === -1;',
    '    if (pattern.indexOf("*") !== -1) return shExpMatch(host, pattern);',
    '    if (pattern.charAt(0) === ".") return dnsDomainIs(host, pattern);',
    '    return host === pattern || dnsDomainIs(host, "." + pattern);',
    '  }',
    '  var directRules = ' + JSON.stringify(directRules) + ';',
    '  for (var i = 0; i < directRules.length; i++) {',
    '    if (matches(directRules[i])) return "DIRECT";',
    '  }',
    '  var proxyRules = ' + JSON.stringify(proxyRules) + ';',
    '  var targets = ' + JSON.stringify(targets) + ';',
    '  for (var j = 0; j < proxyRules.length; j++) {',
    '    if (matches(proxyRules[j])) return targets[Math.floor(Math.random() * targets.length)];',
    '  }',
    '  return ' + JSON.stringify(fallback) + ';',
    '}',
  ].join('\n');
}

function pacDataUrl(script) {
  return 'data:application/x-ns-proxy-autoconfig;base64,' + Buffer.from(script).toString('base64');
}

module.exports = { DEFAULT_PROXY_BYPASS, proxyHostRules, buildRoutingPac, pacDataUrl };
