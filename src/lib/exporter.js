/**
 * 导出引擎：抓取单章 / 整本书，缓存成功结果，失败自动重试。
 *
 * 修复的要点：
 *  - 读取目录后逐章抓取，真正支持「导出全文」；
 *  - 每章内容与目录 wordCount 对比，明显偏短（试读/截断）会自动刷新会话参数重试；
 *  - 失败章节不影响其他章节，导出结束给出失败清单；
 *  - 成功章节缓存在内存中，中断后再次导出会跳过已完成的章节。
 */
(function (root) {
  'use strict';

  const WRX = (root.__WRX__ = root.__WRX__ || {});
  const C = WRX.ErrorCode;

  const SKIP_TITLES = ['封面', '目录', 'cover', 'table of contents'];

  function throwIfAborted(signal) {
    if (signal && signal.aborted) {
      throw new WRX.WeReadError(C.ABORTED, '已取消', { retryable: false });
    }
  }

  function backoffMs(attempt) {
    return Math.min(800 * Math.pow(2, attempt - 1), 6000);
  }

  /**
   * 从目录中挑出要导出的条目。
   * @param {object[]} chapters client.getCatalog().chapters
   * @param {{includeVolumes?: boolean}} [options]
   */
  function selectChapters(chapters, options) {
    const opts = options || {};
    const includeVolumes = opts.includeVolumes !== false;
    const selected = [];

    for (const chapter of chapters || []) {
      const normalized = String(chapter.title || '')
        .replace(/[\s\u3000]+/g, '')
        .toLowerCase();
      if (SKIP_TITLES.includes(normalized)) continue;

      const wordCount = chapter.wordCount;
      const unknownWordCount = wordCount === undefined || wordCount === null;

      // 字数未知的条目先按正文处理（部分书籍目录不带 wordCount）；
      // 明确为 0 的条目通常是卷名/分隔页，只作为标题保留。
      if (unknownWordCount || wordCount > 0) {
        selected.push(Object.assign({}, chapter, { isVolume: false }));
      } else if (includeVolumes) {
        // 卷/分节标题没有正文，作为标题保留，避免导出后结构丢失。
        selected.push(Object.assign({}, chapter, { isVolume: true }));
      }
    }

    return selected;
  }

  class BookExporter {
    /**
     * @param {any} client WRX.WereadClient
     * @param {{maxAttempts?: number, refreshEvery?: number, minRatio?: number, includeVolumes?: boolean}} [options]
     */
    constructor(client, options) {
      const opts = options || {};
      this.client = client;
      this.options = {
        maxAttempts: opts.maxAttempts === undefined ? 3 : opts.maxAttempts,
        refreshEvery: opts.refreshEvery === undefined ? 40 : opts.refreshEvery,
        minRatio: opts.minRatio === undefined ? 0.55 : opts.minRatio,
        includeVolumes: opts.includeVolumes !== false,
      };

      this.cache = new Map();
      this.book = null;
      this.chapters = [];
      this.detectedFormat = null;
      this.lastCatalogAt = 0;
    }

    /** 缓存 key 带上 bookId，切换书籍时不会串内容。 */
    chapterKey(uid) {
      const bookId = (this.book && this.book.bookId) || (this.client && this.client.bookId) || '';
      return String(bookId) + ':' + String(uid);
    }

    getCached(uid) {
      return this.cache.get(this.chapterKey(uid)) || null;
    }

    setOptions(next) {
      Object.assign(this.options, next || {});
      if (next && next.delayMs !== undefined) this.client.delayMs = next.delayMs;
    }

    get readableChapters() {
      return this.chapters.filter((chapter) => !chapter.isVolume);
    }

    /** 已缓存的成功章节数。 */
    get cachedCount() {
      let count = 0;
      for (const record of this.cache.values()) {
        if (record && record.status === 'ok') count += 1;
      }
      return count;
    }

    /**
     * 读取书籍信息与目录。
     * @param {{force?: boolean}} [options]
     */
    async init(options) {
      const opts = options || {};
      const state = await this.client.ensureState({ force: !!opts.force });
      const catalog = await this.client.getCatalog(state.bookId);

      this.book = Object.assign({}, catalog.book);
      if (!this.book.title && state.title) this.book.title = state.title;
      if (!this.book.author && state.author) this.book.author = state.author;

      this.chapters = selectChapters(catalog.chapters, {
        includeVolumes: this.options.includeVolumes,
      });
      this.lastCatalogAt = Date.now();

      if (!this.readableChapters.length) {
        throw new WRX.WeReadError(
          C.CATALOG,
          '目录里没有可导出的章节（可能需要购买/会员，或这本书是公众号文章）。',
          { retryable: false }
        );
      }

      return { state: state, book: this.book, chapters: this.chapters };
    }

    /**
     * 判断解码后的内容是否明显不完整。
     * @param {object} chapter
     * @param {number} chars
     */
    isTruncated(chapter, chars) {
      const wordCount = Number(chapter.wordCount) || 0;
      if (wordCount < 60) return false;
      return chars < wordCount * this.options.minRatio;
    }

    /** 把解码结果整理成 html + text。 */
    normalizeContent(chapter, format, decoded) {
      const formats = WRX.formats;
      if (format === 'txt') {
        const text = String(decoded).replace(/\r\n?/g, '\n').trim();
        return {
          format: 'txt',
          text: text,
          html: formats.textToHtml(text),
        };
      }

      const html = formats.extractBodyHtml(decoded, { title: chapter.title });
      return {
        format: 'epub',
        html: html,
        text: formats.htmlToPlainText(html),
      };
    }

    /**
     * 抓取并解码一章（带重试与缓存）。
     * @param {object} chapter
     * @param {{signal?: AbortSignal, force?: boolean, onAttempt?: Function}} [options]
     */
    async fetchChapter(chapter, options) {
      const opts = options || {};
      const signal = opts.signal;
      const key = this.chapterKey(chapter.uid);
      const cached = this.cache.get(key);

      if (cached && cached.status === 'ok' && !opts.force) return cached;

      const maxAttempts = this.options.maxAttempts;
      let lastError = null;

      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        throwIfAborted(signal);
        if (opts.onAttempt) opts.onAttempt({ chapter: chapter, attempt: attempt, error: lastError });

        try {
          const result = await this.client.fetchChapterShards(chapter.uid, {
            format: this.detectedFormat || 'auto',
          });
          this.detectedFormat = result.format;

          const decoded = WRX.decodeShards(result.shards);
          const content = this.normalizeContent(chapter, result.format, decoded);
          const chars = WRX.formats.countChars(content.text || '');

          if (!chars) {
            throw new WRX.WeReadError(C.EMPTY, '本章没有解析到正文。', { retryable: true });
          }

          const truncated = this.isTruncated(chapter, chars);
          if (truncated && attempt < maxAttempts) {
            throw new WRX.WeReadError(
              C.SHORT,
              '本章内容疑似不完整（' + chars + '/' + chapter.wordCount + ' 字），正在重试…',
              { retryable: true }
            );
          }

          const record = {
            uid: chapter.uid,
            idx: chapter.idx,
            title: chapter.title,
            level: chapter.level,
            isVolume: false,
            status: 'ok',
            format: content.format,
            html: content.html,
            text: content.text,
            chars: chars,
            warning: truncated ? '内容可能不完整（' + chars + '/' + chapter.wordCount + ' 字）' : '',
            attempts: attempt,
          };
          this.cache.set(key, record);
          return record;
        } catch (error) {
          lastError = error;
          const code = error && error.code;

          if (code === C.ABORTED) throw error;

          let retryable = error && error.retryable !== false;

          if (code === C.AUTH) {
            // 登录态过期：先尝试续期，再刷新 psvts；续期成功才再试一次。
            const renewed = await this.client.renewSession();
            await this.client.refreshState(true).catch(() => {});
            retryable = renewed && attempt < 2;
          } else if (code === C.EMPTY || code === C.CORRUPT || code === C.SHORT) {
            // 会话参数失效是最常见原因，强制刷新后再试。
            await this.client.refreshState(true).catch(() => {});
          }

          if (!retryable) break;

          await WRX.sleep(backoffMs(attempt), signal);
        }
      }

      const failure = {
        uid: chapter.uid,
        idx: chapter.idx,
        title: chapter.title,
        isVolume: false,
        status: 'failed',
        error: (lastError && lastError.message) || '未知错误',
        code: (lastError && lastError.code) || C.UNKNOWN,
      };
      this.cache.set(key, failure);
      throw Object.assign(lastError || new Error(failure.error), { chapter: chapter });
    }

    /**
     * 导出整本书。
     * @param {{
     *   format?: 'md'|'html'|'txt',
     *   signal?: AbortSignal,
     *   onProgress?: Function,
     *   frontMatter?: boolean,
     *   chapters?: object[]
     * }} [options]
     */
    async exportBook(options) {
      const opts = options || {};
      const format = opts.format || 'md';
      const signal = opts.signal;
      const onProgress = typeof opts.onProgress === 'function' ? opts.onProgress : function () {};
      const chapters = opts.chapters || this.chapters;

      // 检测书籍格式（epub/txt），顺便抓第一本可读章节。
      const readable = chapters.filter((chapter) => !chapter.isVolume);
      const total = readable.length;
      const items = [];
      let ok = 0;
      let failed = 0;
      let consecutiveEmpty = 0;
      let lastWarnings = 0;

      onProgress({ phase: 'start', total: total, ok: ok, failed: failed });

      for (const chapter of chapters) {
        throwIfAborted(signal);

        if (chapter.isVolume) {
          items.push({
            uid: chapter.uid,
            title: chapter.title,
            level: chapter.level,
            isVolume: true,
          });
          continue;
        }

        onProgress({
          phase: 'fetch',
          index: Math.min(ok + failed + 1, total),
          total: total,
          ok: ok,
          failed: failed,
          chapter: chapter,
        });

        try {
          const record = await this.fetchChapter(chapter, { signal: signal });
          items.push(record);
          ok += 1;
          consecutiveEmpty = 0;
          if (record.warning) lastWarnings += 1;
        } catch (error) {
          const code = error && error.code;
          if (code === C.ABORTED) throw error;
          if (code === C.AUTH || code === C.STATE) {
            throw new WRX.WeReadError(
              code,
              '登录状态已失效或会话参数异常，已停止导出。已完成的 ' +
                ok +
                ' 章已缓存，刷新页面后重新点击「导出全文」会接着导出。',
              { retryable: false, cause: error }
            );
          }

          failed += 1;
          items.push({
            uid: chapter.uid,
            title: chapter.title,
            level: chapter.level,
            isVolume: false,
            status: 'failed',
            error: (error && error.message) || '未知错误',
            code: code || C.UNKNOWN,
          });

          if (code === C.EMPTY) consecutiveEmpty += 1;
          else consecutiveEmpty = 0;

          if (consecutiveEmpty >= 8) {
            throw new WRX.WeReadError(
              C.EMPTY,
              '连续 8 章都无法获取正文：可能是账号无权阅读本书，或登录状态已失效。已完成的章节已缓存。',
              { retryable: false }
            );
          }
        }

        onProgress({
          phase: 'progress',
          index: Math.min(ok + failed, total),
          total: total,
          ok: ok,
          failed: failed,
          chapter: chapter,
        });

        // 周期性刷新会话参数，避免长任务中途失效。
        if (this.options.refreshEvery > 0 && ok > 0 && ok % this.options.refreshEvery === 0) {
          await this.client.refreshState(true).catch(() => {});
        }
      }

      const content = WRX.formats.buildBook({
        format: format,
        book: this.book || {},
        chapters: items,
        options: {
          frontMatter: opts.frontMatter !== false,
          toc: true,
        },
      });

      const result = {
        format: format,
        content: content,
        book: this.book,
        chapters: items,
        stats: {
          total: total,
          ok: ok,
          failed: failed,
          warnings: lastWarnings,
          chars: WRX.formats.countChars(content),
          cached: this.cachedCount,
        },
      };

      onProgress({ phase: 'done', total: total, ok: ok, failed: failed, result: result });
      return result;
    }

    /** 单章导出（用于「当前页」与章节列表）。 */
    async exportChapter(chapter, options) {
      const opts = options || {};
      const record = await this.fetchChapter(chapter, {
        signal: opts.signal,
        force: opts.force,
      });
      const content = WRX.formats.buildBook({
        format: opts.format || 'md',
        book: this.book || {},
        chapters: [record],
        options: { frontMatter: opts.frontMatter !== false, toc: false },
      });
      return { content: content, record: record, format: opts.format || 'md' };
    }

    /** 清空失败缓存，方便重试。 */
    clearFailed() {
      for (const [key, record] of Array.from(this.cache.entries())) {
        if (!record || record.status !== 'ok') this.cache.delete(key);
      }
    }

    getFailures() {
      const failures = [];
      for (const record of this.cache.values()) {
        if (record && record.status === 'failed') failures.push(record);
      }
      return failures;
    }
  }

  WRX.BookExporter = BookExporter;
  WRX.selectChapters = selectChapters;
})(typeof globalThis !== 'undefined' ? globalThis : window);
