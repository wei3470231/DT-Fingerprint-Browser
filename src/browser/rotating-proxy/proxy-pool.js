'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { parseProxyString } = require('../../manager/proxy-parser');

/**
 * 高性能内存动态代理池管理器
 * - 专门用于加载并维护大批量代理文档 (支持上千到数万行)
 * - 支持 4 种主流格式 (单行一个，自动解析与清洗)
 * - 提供 O(1) 毫秒级单次连接随机抽取与轮询抽取算法
 */
class RotatingProxyPool {
  constructor(options = {}) {
    this.filePath = options.filePath || '';
    this.rules = options.rules || ''; // 适用的多域名规则 (分号分隔)
    this.mode = options.mode || 'random'; // 'random' | 'round-robin'
    this.proxies = [];
    this.currentIndex = 0;
    this.lastLoadedTime = 0;
  }

  /**
   * 从本地文件加载并解析代理列表 (仅在浏览器启动/代理池初始化时执行一次)
   */
  loadFromFile(filePath = this.filePath) {
    if (!filePath) {
      this.proxies = [];
      return { success: false, count: 0, error: '未指定代理文档路径' };
    }

    const resolvedPath = path.resolve(filePath);
    if (!fs.existsSync(resolvedPath)) {
      this.proxies = [];
      return { success: false, count: 0, error: `代理文档文件不存在: ${resolvedPath}` };
    }

    try {
      const content = fs.readFileSync(resolvedPath, 'utf8');
      return this.loadFromString(content, resolvedPath);
    } catch (err) {
      this.proxies = [];
      return { success: false, count: 0, error: `读取代理文档失败: ${err.message}` };
    }
  }

  /**
   * 从原始文本内容批量解析
   */
  loadFromString(rawText, sourcePath = '') {
    if (!rawText || typeof rawText !== 'string') {
      this.proxies = [];
      return { success: false, count: 0, error: '代理内容为空' };
    }

    const lines = rawText.split(/\r?\n/);
    const parsedList = [];
    const seen = new Set();

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line || line.startsWith('#') || line.startsWith('//')) {
        continue; // 忽略空行与注释
      }

      const parsed = parseProxyString(line);
      if (parsed && parsed.host && parsed.port) {
        const key = `${parsed.type}://${parsed.username || ''}:${parsed.password || ''}@${parsed.host}:${parsed.port}`;
        if (!seen.has(key)) {
          seen.add(key);
          parsedList.push({
            id: `px_${parsedList.length + 1}`,
            type: (parsed.type || 'socks5').toLowerCase(),
            host: parsed.host,
            port: Number(parsed.port),
            username: parsed.username || '',
            password: parsed.password || '',
            raw: line
          });
        }
      }
    }

    this.proxies = parsedList;
    this.filePath = sourcePath || this.filePath;
    this.currentIndex = 0;
    this.lastLoadedTime = Date.now();

    console.log(`[RotatingProxyPool] 成功从 "${sourcePath || '文本'}" 加载 ${parsedList.length} 条有效代理 (去重后)`);
    return {
      success: true,
      count: parsedList.length,
      sample: parsedList.length > 0 ? `${parsedList[0].type}://${parsedList[0].host}:${parsedList[0].port}` : null
    };
  }

  /**
   * 每次新连接创建时抽取一条代理
   * 优先随机分配，实现“只要有新连接创建，每一次都切换任意一个代理”
   */
  getProxy() {
    if (this.proxies.length === 0) {
      return null;
    }

    if (this.proxies.length === 1) {
      return this.proxies[0];
    }

    if (this.mode === 'round-robin') {
      const proxy = this.proxies[this.currentIndex];
      this.currentIndex = (this.currentIndex + 1) % this.proxies.length;
      return proxy;
    }

    // 默认: 随机抽取
    const randomIndex = Math.floor(Math.random() * this.proxies.length);
    return this.proxies[randomIndex];
  }

  /**
   * 获取指定数量的不同代理候选项 (供故障自动重试挑选)
   * 采用 Fisher-Yates 洗牌算法，确保每次抽取的首选代理 (candidates[0]) 绝对随机！
   */
  getCandidates(count = 3) {
    if (this.proxies.length === 0) return [];
    if (this.proxies.length === 1) return [this.proxies[0]];

    // 复制索引并洗牌
    const indices = [];
    for (let i = 0; i < this.proxies.length; i++) {
      indices.push(i);
    }

    // 随机置换洗牌
    for (let i = indices.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      const temp = indices[i];
      indices[i] = indices[j];
      indices[j] = temp;
    }

    const actualCount = Math.min(count, this.proxies.length);
    const result = [];
    for (let i = 0; i < actualCount; i++) {
      result.push(this.proxies[indices[i]]);
    }
    return result;
  }

  getCount() {
    return this.proxies.length;
  }
}

module.exports = { RotatingProxyPool };
