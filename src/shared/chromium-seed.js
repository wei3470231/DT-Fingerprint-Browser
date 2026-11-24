'use strict';

const { createHash } = require('node:crypto');

function isChromiumSeed(value) {
  return Number.isInteger(value) && value >= 0 && value <= 0xffffffff;
}

function chromiumSeed(fp) {
  if (isChromiumSeed(fp?.chromiumSeed)) return fp.chromiumSeed;
  if (!fp?.seed) return undefined;

  // Keep the launch value of profiles created before the Chromium seed was stored.
  return (createHash('sha256').update(String(fp.seed)).digest().readUInt32BE() & 0x7fffffff) || 1;
}

module.exports = { chromiumSeed, isChromiumSeed };
