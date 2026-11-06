/**
 * 从页面读取微信读书阅读器状态。
 *
 * 阅读器页面会内联 `window.__INITIAL_STATE__ = {...}`，其中
 * `reader.psvts / reader.pclts / reader.bookInfo.bookId` 是请求章节正文的必要参数。
 *
 * 原脚本依赖 XHR 钩子从页面自己的请求里"偷" pc/ps，这既脆弱（页面换成 fetch
 * 或提前渲染就失效），在 Chrome 扩展的 isolated world 里也根本拦截不到页面请求。
 * 这里改为直接读取页面内联状态，并结合 `/web/reader/{bookHash}` 兜底刷新。
 */
(function (root) {
  'use strict';

  const WRX = (root.__WRX__ = root.__WRX__ || {});

  /**
   * 从 `{` 开始找到与之配对的 `}`（正确处理字符串与转义）。
   * @param {string} text
   * @param {number} start
   * @returns {number} 结束位置（不含），找不到返回 -1
   */
  function findJsonObjectEnd(text, start) {
    let depth = 0;
    let inString = false;
    let escaped = false;

    for (let i = start; i < text.length; i++) {
      const ch = text[i];
      if (inString) {
        if (escaped) escaped = false;
        else if (ch === '\\') escaped = true;
        else if (ch === '"') inString = false;
        continue;
      }
      if (ch === '"') inString = true;
      else if (ch === '{') depth += 1;
      else if (ch === '}') {
        depth -= 1;
        if (depth === 0) return i + 1;
      }
    }
    return -1;
  }

  /**
   * 解析文本中的 `window.__INITIAL_STATE__`。
   * @param {string} text
   * @returns {object|null}
   */
  function parseInitialState(text) {
    const marker = '__INITIAL_STATE__';
    let index = text.indexOf(marker);

    while (index !== -1) {
      const eq = text.indexOf('=', index + marker.length);
      if (eq !== -1 && eq - index < 80) {
        const start = text.indexOf('{', eq);
        if (start !== -1 && start - eq < 80) {
          const end = findJsonObjectEnd(text, start);
          if (end > start) {
            try {
              return JSON.parse(text.slice(start, end));
            } catch (e) {
              // 继续尝试下一个出现位置
            }
          }
        }
      }
      index = text.indexOf(marker, index + marker.length);
    }
    return null;
  }

  function emptyReaderState() {
    return {
      bookId: '',
      title: '',
      author: '',
      format: '',
      psvts: '',
      pclts: '',
      token: '',
      currentChapter: null,
      progress: null,
    };
  }

  /**
   * 从 `__INITIAL_STATE__` 中提取阅读器状态。
   * @param {object|null} initialState
   * @returns {object}
   */
  function readReaderState(initialState) {
    const state = emptyReaderState();
    if (!initialState || typeof initialState !== 'object') return state;

    const reader = initialState.reader || {};
    const bookInfo = reader.bookInfo || {};

    if (bookInfo.bookId !== undefined && bookInfo.bookId !== null) {
      state.bookId = String(bookInfo.bookId);
    }
    state.title = bookInfo.title || '';
    state.author = bookInfo.author || '';
    state.format = bookInfo.format || '';
    state.psvts = reader.psvts || '';
    state.pclts = reader.pclts || '';
    state.token = reader.token || '';
    state.currentChapter = reader.currentChapter || null;
    state.progress = reader.progress || null;
    return state;
  }

  function mergeStates(base, extra) {
    const merged = Object.assign(emptyReaderState(), base || {});
    if (!extra) return merged;
    for (const key of ['bookId', 'title', 'author', 'format', 'psvts', 'pclts', 'token']) {
      if (!merged[key] && extra[key]) merged[key] = extra[key];
    }
    if (!merged.currentChapter && extra.currentChapter) merged.currentChapter = extra.currentChapter;
    if (!merged.progress && extra.progress) merged.progress = extra.progress;
    return merged;
  }

  /**
   * 从一段 HTML / JS 文本中提取状态（含正则兜底）。
   * @param {string} text
   * @returns {object}
   */
  function extractFromText(text) {
    if (!text || typeof text !== 'string') return emptyReaderState();

    const state = readReaderState(parseInitialState(text));

    if (!state.psvts) {
      const match = /"psvts"\s*:\s*"([^"]*)"/.exec(text);
      if (match && match[1]) state.psvts = match[1];
    }
    if (!state.pclts) {
      const match = /"pclts"\s*:\s*"([^"]*)"/.exec(text);
      if (match && match[1]) state.pclts = match[1];
    }
    if (!state.token) {
      const match = /"token"\s*:\s*"([^"]{8,})"/.exec(text);
      if (match && match[1]) state.token = match[1];
    }
    if (!state.bookId) {
      const match = /"bookInfo"\s*:\s*\{[^}]*?"bookId"\s*:\s*"?([A-Za-z0-9_]+)"?/.exec(text);
      if (match && match[1]) state.bookId = match[1];
    }
    return state;
  }

  /**
   * 扫描页面内联脚本，拼出可用的阅读器状态。
   * @param {Document} doc
   * @returns {object}
   */
  function extractFromDocument(doc) {
    let merged = emptyReaderState();
    const scripts = doc.querySelectorAll('script:not([src])');
    const MAX_TEXT = 8 * 1024 * 1024;

    for (const script of scripts) {
      const text = script.textContent || '';
      if (!text || text.length > MAX_TEXT) continue;
      if (
        text.indexOf('psvts') === -1 &&
        text.indexOf('__INITIAL_STATE__') === -1 &&
        text.indexOf('bookInfo') === -1
      ) {
        continue;
      }
      merged = mergeStates(merged, extractFromText(text));
      if (merged.bookId && merged.psvts) break;
    }

    return merged;
  }

  /**
   * 读取页面上的 ld+json（用于兜底书名/作者）。
   * @param {Document} doc
   * @returns {object|null}
   */
  function extractLdJson(doc) {
    const el = doc.querySelector('script[type="application/ld+json"]');
    if (!el) return null;
    try {
      return JSON.parse(el.textContent || '');
    } catch (e) {
      return null;
    }
  }

  /** 从 pathname 解析 bookHash / chapterHash。 */
  function parseReaderPath(pathname) {
    const parts = String(pathname || '').split('/').filter(Boolean);
    const readerIndex = parts.lastIndexOf('reader');
    const segment = readerIndex >= 0 ? parts[readerIndex + 1] : parts[parts.length - 1] || '';
    const kIndex = segment.indexOf('k');
    if (kIndex === -1) {
      return { bookHash: segment, chapterHash: '' };
    }
    return { bookHash: segment.slice(0, kIndex), chapterHash: segment.slice(kIndex + 1) };
  }

  /** 生成阅读器地址。 */
  function readerUrl(bookHash, chapterHash) {
    return (
      'https://weread.qq.com/web/reader/' +
      bookHash +
      (chapterHash ? 'k' + chapterHash : '')
    );
  }

  WRX.readerState = {
    empty: emptyReaderState,
    parseInitialState,
    readReaderState,
    extractFromText,
    extractFromDocument,
    extractLdJson,
    mergeStates,
    parseReaderPath,
    readerUrl,
  };
})(typeof globalThis !== 'undefined' ? globalThis : window);
