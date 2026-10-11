'use strict';

/**
 * 内置常用近几代 macOS、Firefox、Chrome 浏览器 User-Agent 预设
 */
const UA_PRESETS = [
  {
    group: 'Chrome (macOS 近几代)',
    items: [
      {
        label: 'Chrome 134 · macOS (Sequoia / Sonoma)',
        ua: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36'
      },
      {
        label: 'Chrome 133 · macOS (Sequoia / Sonoma)',
        ua: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36'
      },
      {
        label: 'Chrome 132 · macOS (Sonoma / Ventura)',
        ua: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36'
      }
    ]
  },
  {
    group: 'Chrome (Windows 近几代)',
    items: [
      {
        label: 'Chrome 134 · Windows 10/11 x64',
        ua: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36'
      },
      {
        label: 'Chrome 133 · Windows 10/11 x64',
        ua: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36'
      },
      {
        label: 'Chrome 132 · Windows 10/11 x64',
        ua: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36'
      }
    ]
  },
  {
    group: 'Firefox (近几代 macOS & Win)',
    items: [
      {
        label: 'Firefox 135 · macOS (最新版)',
        ua: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:135.0) Gecko/20100101 Firefox/135.0'
      },
      {
        label: 'Firefox 134 · macOS',
        ua: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:134.0) Gecko/20100101 Firefox/134.0'
      },
      {
        label: 'Firefox 135 · Windows 10/11 x64 (最新版)',
        ua: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:135.0) Gecko/20100101 Firefox/135.0'
      },
      {
        label: 'Firefox 134 · Windows 10/11 x64',
        ua: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:134.0) Gecko/20100101 Firefox/134.0'
      }
    ]
  },
  {
    group: 'Safari (macOS 近几代)',
    items: [
      {
        label: 'Safari 18.2 · macOS Sequoia',
        ua: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.2 Safari/605.1.15'
      },
      {
        label: 'Safari 17.6 · macOS Sonoma',
        ua: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.6 Safari/605.1.15'
      }
    ]
  }
];

module.exports = { UA_PRESETS };
