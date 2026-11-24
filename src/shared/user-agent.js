'use strict';

const { buildWindowsChromeUa } = require('../../fp-sdk/lib/fp-generator');

function effectiveUserAgent({ fp, customUa }) {
  if (customUa) return customUa;
  if (!fp.uaFormat && fp.ua?.fullVersion && fp.uaString === buildWindowsChromeUa(fp.ua.fullVersion, false)) {
    return buildWindowsChromeUa(fp.ua.fullVersion);
  }
  return fp.uaString;
}

module.exports = { effectiveUserAgent };
