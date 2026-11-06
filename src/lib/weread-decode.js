/**
 * 微信读书章节内容分片的解码。
 *
 * 服务端返回的每个分片形如：`<32 位 MD5><密文>`，其中：
 *  1. 校验 MD5（防截断/防篡改）；
 *  2. 拼接分片后去掉首字符；
 *  3. 还原字符交换（swaps）；
 *  4. base64url → base64 → 二进制；
 *  5. 修复 UTF-8（浏览器 atob 得到的是 latin1 字节串）。
 *
 * EPUB 书籍：e_0 + e_1 + e_3；TXT 书籍：t_0 + t_1。
 * 旧脚本只做了 2~5 步且不校验 MD5，遇到空响应/试读片段时会"静默"产出残缺内容。
 */
(function (root) {
  'use strict';

  const WRX = (root.__WRX__ = root.__WRX__ || {});

  /**
   * 计算需要交换的字符位置。
   * @param {string} encoded
   * @returns {number[]}
   */
  function swapPositions(encoded) {
    const length = encoded.length;
    if (length < 4) return [];
    if (length < 11) return [0, 2];

    const n = Math.min(4, Math.ceil(length / 10));
    let tmp = '';
    for (let i = length - 1; i >= length - n; i--) {
      const binary = encoded.charCodeAt(i).toString(2);
      const parsed = parseInt(binary, 4);
      if (Number.isNaN(parsed)) return [];
      tmp += parsed.toString();
    }

    const arr = [];
    const m = length - n - 2;
    const step = String(m).length;
    let i = 0;
    while (arr.length < 10 && i + step < tmp.length) {
      const v1 = parseInt(tmp.slice(i, i + step), 10);
      const v2 = parseInt(tmp.slice(i + 1, i + 1 + step), 10);
      if (Number.isNaN(v1) || Number.isNaN(v2)) break;
      arr.push(v1 % m);
      arr.push(v2 % m);
      i += step;
    }
    return arr;
  }

  /**
   * 反向还原字符交换（该变换是自逆的）。
   * @param {string} encoded
   * @param {number[]} positions
   * @returns {string}
   */
  function reverseSwaps(encoded, positions) {
    const chars = encoded.split('');
    for (let i = positions.length - 1; i >= 0; i -= 2) {
      for (const k of [1, 0]) {
        const left = positions[i] + k;
        const right = positions[i - 1] + k;
        if (
          !Number.isFinite(left) ||
          !Number.isFinite(right) ||
          left < 0 ||
          right < 0 ||
          left >= chars.length ||
          right >= chars.length
        ) {
          continue;
        }
        const tmp = chars[left];
        chars[left] = chars[right];
        chars[right] = tmp;
      }
    }
    return chars.join('');
  }

  /** base64url → 标准 base64（并补齐 padding）。 */
  function base64UrlToBase64(value) {
    let out = String(value)
      .replace(/-/g, '+')
      .replace(/_/g, '/')
      .replace(/[^A-Za-z0-9+/]/g, '');
    const mod = out.length % 4;
    if (mod === 1) out = out.slice(0, -1);
    else if (mod === 2) out += '==';
    else if (mod === 3) out += '=';
    return out;
  }

  /**
   * latin1 字节串 → UTF-8 字符串。
   * 浏览器没有内置「把二进制字符串按 UTF-8 解码」的 API，这里手写一遍，
   * 支持 1~4 字节序列（含 emoji 等代理对）。
   * @param {string} binary
   * @returns {string}
   */
  function utf8FromBinaryString(binary) {
    let out = '';
    let i = 0;
    const len = binary.length;

    while (i < len) {
      const b0 = binary.charCodeAt(i);

      if (b0 < 0x80) {
        out += binary[i];
        i += 1;
        continue;
      }

      if (b0 >= 0xc0 && b0 <= 0xdf && i + 1 < len) {
        const b1 = binary.charCodeAt(i + 1);
        if (b1 >= 0x80 && b1 <= 0xbf) {
          out += String.fromCharCode(((b0 & 0x1f) << 6) | (b1 & 0x3f));
          i += 2;
          continue;
        }
      } else if (b0 >= 0xe0 && b0 <= 0xef && i + 2 < len) {
        const b1 = binary.charCodeAt(i + 1);
        const b2 = binary.charCodeAt(i + 2);
        if (b1 >= 0x80 && b1 <= 0xbf && b2 >= 0x80 && b2 <= 0xbf) {
          out += String.fromCharCode(((b0 & 0x0f) << 12) | ((b1 & 0x3f) << 6) | (b2 & 0x3f));
          i += 3;
          continue;
        }
      } else if (b0 >= 0xf0 && b0 <= 0xf7 && i + 3 < len) {
        const b1 = binary.charCodeAt(i + 1);
        const b2 = binary.charCodeAt(i + 2);
        const b3 = binary.charCodeAt(i + 3);
        if (
          b1 >= 0x80 &&
          b1 <= 0xbf &&
          b2 >= 0x80 &&
          b2 <= 0xbf &&
          b3 >= 0x80 &&
          b3 <= 0xbf
        ) {
          let cp = ((b0 & 0x07) << 18) | ((b1 & 0x3f) << 12) | ((b2 & 0x3f) << 6) | (b3 & 0x3f);
          cp -= 0x10000;
          out += String.fromCharCode(0xd800 + (cp >> 10), 0xdc00 + (cp & 0x3ff));
          i += 4;
          continue;
        }
      }

      // 非法字节：原样保留，避免整段内容丢失。
      out += binary[i];
      i += 1;
    }

    return out;
  }

  /**
   * 校验单个分片并去掉 32 位 MD5 前缀。
   * @param {string} raw
   * @returns {string} 密文正文
   */
  function verifyShard(raw) {
    const text = typeof raw === 'string' ? raw : '';
    if (!text) {
      throw new WRX.WeReadError(WRX.ErrorCode.EMPTY, '服务端返回了空内容');
    }

    const trimmed = text.trim();

    if (trimmed.startsWith('{')) {
      let payload = null;
      try {
        payload = JSON.parse(trimmed);
      } catch (e) {
        // 不是合法 JSON，继续按密文处理
      }
      if (payload && typeof payload === 'object') {
        const code = payload.errCode !== undefined ? payload.errCode : payload.errcode;
        if (code === -2012 || code === -2010) {
          throw new WRX.WeReadError(
            WRX.ErrorCode.AUTH,
            payload.errMsg || payload.errmsg || '登录状态已过期，请刷新页面重新登录。',
            { retryable: false, detail: payload }
          );
        }
        if (payload.bookId || payload.chapterUid || Object.keys(payload).length > 0) {
          throw new WRX.WeReadError(
            WRX.ErrorCode.EMPTY,
            '服务端未返回正文（可能需要购买/会员，或会话参数失效）。',
            { detail: payload }
          );
        }
      }
    }

    if (trimmed.length <= 32) {
      throw new WRX.WeReadError(WRX.ErrorCode.EMPTY, '服务端返回的正文为空（可能是试读或未解锁章节）。');
    }

    const candidates = [text, trimmed];
    for (const candidate of candidates) {
      const expected = candidate.slice(0, 32).toUpperCase();
      const body = candidate.slice(32);
      if (/^[0-9a-f]{32}$/i.test(expected) && WRX.md5Hex(body).toUpperCase() === expected) {
        return body;
      }
    }

    throw new WRX.WeReadError(
      WRX.ErrorCode.CORRUPT,
      '正文校验失败（MD5 不匹配），内容可能被截断，正在重试…'
    );
  }

  /**
   * 解码拼接后的密文。
   * @param {string} payload
   * @returns {string}
   */
  function decodePayload(payload) {
    if (!payload) return '';

    const encoded = payload.slice(1);
    if (!encoded) return '';

    const reordered = reverseSwaps(encoded, swapPositions(encoded));
    const b64 = base64UrlToBase64(reordered);

    let binary;
    try {
      binary = atob(b64);
    } catch (e) {
      throw new WRX.WeReadError(WRX.ErrorCode.CORRUPT, '正文解码失败（base64 非法）。', { cause: e });
    }

    return utf8FromBinaryString(binary);
  }

  /**
   * 解码一组分片。
   * @param {string[]} shards 原始分片（含 MD5 前缀，按服务端顺序）
   * @returns {string} XHTML 或纯文本
   */
  function decodeShards(shards) {
    const bodies = [];
    for (const raw of shards || []) {
      if (raw === undefined || raw === null) continue;
      bodies.push(verifyShard(raw));
    }
    if (!bodies.length) {
      throw new WRX.WeReadError(WRX.ErrorCode.EMPTY, '没有可解码的内容。');
    }
    const decoded = decodePayload(bodies.join(''));
    if (!decoded.trim()) {
      throw new WRX.WeReadError(WRX.ErrorCode.CORRUPT, '解码结果为空。');
    }
    return decoded;
  }

  /** 章节分片端点。 */
  WRX.SHARD_ENDPOINTS = {
    epub: ['e_0', 'e_1', 'e_3'],
    txt: ['t_0', 't_1'],
  };

  WRX.decodeShards = decodeShards;
  WRX.decodePayload = decodePayload;
  WRX.verifyShard = verifyShard;
  WRX.base64UrlToBase64 = base64UrlToBase64;
  WRX.utf8FromBinaryString = utf8FromBinaryString;
  WRX.swapPositions = swapPositions;
  WRX.reverseSwaps = reverseSwaps;
})(typeof globalThis !== 'undefined' ? globalThis : window);
