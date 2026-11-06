/**
 * 微信读书 Web 接口客户端（运行在 content script 的 isolated world 中）。
 *
 * 只使用同源 fetch，依靠浏览器自动携带登录 Cookie，不读取/不发送任何 Cookie 值。
 */
(function (root) {
  'use strict';

  const WRX = (root.__WRX__ = root.__WRX__ || {});
  const WEREAD_ORIGIN = 'https://weread.qq.com';

  const JSON_HEADERS = {
    accept: 'application/json, text/plain, */*',
    'content-type': 'application/json;charset=UTF-8',
  };

  const TEXT_HEADERS = {
    accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  };

  function isJsonResponse(text) {
    const trimmed = String(text || '').trim();
    return trimmed.startsWith('{') || trimmed.startsWith('[');
  }

  function looksLikeCatalogJson(text) {
    const trimmed = String(text || '').trim();
    return trimmed.startsWith('{') && trimmed.includes('"bookId"');
  }

  /**
   * 章节内容请求客户端。
   */
  class WereadClient {
    /**
     * @param {{
     *   fetch?: typeof fetch,
     *   document?: Document,
     *   location?: Location,
     *   delayMs?: number,
     *   timeoutMs?: number,
     *   logger?: Console
     * }} [options]
     */
    constructor(options) {
      const opts = options || {};
      this.fetchImpl = opts.fetch || ((...args) => root.fetch(...args));
      this.document = opts.document || root.document;
      this.location = opts.location || root.location;
      this.logger = opts.logger || root.console;

      this.delayMs = opts.delayMs === undefined ? 260 : opts.delayMs;
      this.timeoutMs = opts.timeoutMs === undefined ? 45000 : opts.timeoutMs;

      this.state = null;
      this.catalog = null;
      this.book = null;
      this.detectedFormat = null;

      this.signal = null;
      this._lastRequestAt = 0;
      this._lastRefreshAt = 0;
      this._refreshPromise = null;
    }

    /** 设置取消信号（导出过程中可中断）。 */
    setSignal(signal) {
      this.signal = signal || null;
    }

    get bookId() {
      return this.state ? this.state.bookId : '';
    }

    // ---------------------------------------------------------------- 底层请求

    async _throttle() {
      if (!this.delayMs) return;
      const wait = this._lastRequestAt + this.delayMs - Date.now();
      if (wait > 0) await WRX.sleep(wait, this.signal);
      this._lastRequestAt = Date.now();
    }

    /**
     * 发起请求并返回文本。
     * @param {string} path
     * @param {{method?: string, body?: object, headers?: object, acceptJson?: boolean}} [options]
     * @returns {Promise<string>}
     */
    _requestUrl(path) {
      if (/^https?:\/\//.test(path)) return path;
      const origin = (this.location && this.location.origin) || WEREAD_ORIGIN;
      return origin + path;
    }

    async request(path, options) {
      const opts = options || {};
      const url = this._requestUrl(path);
      const method = opts.method || 'GET';
      const headers = Object.assign({}, opts.body ? JSON_HEADERS : TEXT_HEADERS, opts.headers || {});

      await this._throttle();

      const controller = new AbortController();
      const abortReason = (name) => new DOMException(name, name);
      const timer = setTimeout(() => {
        try {
          controller.abort(abortReason('TimeoutError'));
        } catch (e) {
          controller.abort();
        }
      }, this.timeoutMs);

      const onAbort = () => {
        try {
          controller.abort(abortReason('AbortError'));
        } catch (e) {
          controller.abort();
        }
      };
      if (this.signal) {
        if (this.signal.aborted) onAbort();
        else this.signal.addEventListener('abort', onAbort, { once: true });
      }

      try {
        const init = {
          method,
          headers,
          credentials: 'include',
          cache: 'no-store',
          signal: controller.signal,
        };
        if (opts.body !== undefined && opts.body !== null) {
          init.body = typeof opts.body === 'string' ? opts.body : JSON.stringify(opts.body);
        }

        const response = await this.fetchImpl(url, init);

        if (!response.ok) {
          const retryable = response.status >= 500 || response.status === 429;
          const code =
            response.status === 401 || response.status === 403
              ? WRX.ErrorCode.AUTH
              : WRX.ErrorCode.HTTP;
          throw new WRX.WeReadError(code, `请求失败（HTTP ${response.status}）`, {
            retryable,
            detail: { status: response.status },
          });
        }

        return await response.text();
      } catch (error) {
        if (error instanceof WRX.WeReadError) throw error;

        const name = error && error.name;
        if (name === 'AbortError' || name === 'TimeoutError') {
          if (this.signal && this.signal.aborted) {
            throw new WRX.WeReadError(WRX.ErrorCode.ABORTED, '已取消', { retryable: false });
          }
          throw new WRX.WeReadError(WRX.ErrorCode.NETWORK, '请求超时，请检查网络后重试。', {
            retryable: true,
            cause: error,
          });
        }

        throw new WRX.WeReadError(
          WRX.ErrorCode.NETWORK,
          '网络请求失败：' + ((error && error.message) || '未知错误'),
          { retryable: true, cause: error }
        );
      } finally {
        clearTimeout(timer);
        if (this.signal) this.signal.removeEventListener('abort', onAbort);
      }
    }

    async postJson(path, body) {
      const text = await this.request(path, { method: 'POST', body: body || {} });
      const data = this._parseJson(text);

      if (data && typeof data === 'object') {
        const code = data.errCode !== undefined ? data.errCode : data.errcode;
        if (code !== undefined && code !== 0) {
          const auth = code === -2012 || code === -2010;
          throw new WRX.WeReadError(
            auth ? WRX.ErrorCode.AUTH : WRX.ErrorCode.HTTP,
            data.errMsg || data.errmsg || `接口错误（${code}）`,
            { retryable: !auth, detail: data }
          );
        }
      }
      return data;
    }

    async getJson(path) {
      const text = await this.request(path);
      return this._parseJson(text);
    }

    _parseJson(text) {
      try {
        return JSON.parse(text);
      } catch (error) {
        throw new WRX.WeReadError(WRX.ErrorCode.FORMAT, '接口返回了无法解析的数据（可能登录已过期）。', {
          retryable: true,
          cause: error,
          detail: String(text || '').slice(0, 200),
        });
      }
    }

    // ------------------------------------------------------------ 阅读器状态

    /**
     * 定位阅读器状态：优先读页面内联 `__INITIAL_STATE__`，不足时再请求阅读页 HTML。
     * @param {{forceRemote?: boolean}} [options] forceRemote 时强制从阅读页 HTML 取新状态
     * @returns {Promise<object>}
     */
    async locateState(options) {
      const opts = options || {};
      const readerState = WRX.readerState;
      let state = readerState.extractFromDocument(this.document);

      const { bookHash } = readerState.parseReaderPath(this.location.pathname);
      const needMore = opts.forceRemote || !state.bookId || !state.psvts;

      if (needMore) {
        const hash = bookHash || (state.bookId ? WRX.wereadEncode(state.bookId) : '');
        if (hash) {
          try {
            const html = await this.request('/web/reader/' + hash);
            const fromHtml = readerState.extractFromText(html);
            if (opts.forceRemote) {
              // 远端状态优先：DOM 里的 psvts 可能已经过期。
              state = {
                bookId: fromHtml.bookId || state.bookId,
                title: fromHtml.title || state.title,
                author: fromHtml.author || state.author,
                format: fromHtml.format || state.format,
                psvts: fromHtml.psvts || state.psvts,
                pclts: fromHtml.pclts || state.pclts,
                token: fromHtml.token || state.token,
                currentChapter: fromHtml.currentChapter || state.currentChapter,
                progress: fromHtml.progress || state.progress,
              };
            } else {
              state = readerState.mergeStates(state, fromHtml);
            }
          } catch (error) {
            // 兜底失败不致命：只要页面状态够用就继续。
            this.logger.warn('[微信读书导出] 读取阅读页状态失败：', error);
          }
        }
      }

      if (!state.title || !state.author) {
        const ld = readerState.extractLdJson(this.document);
        if (ld) {
          if (!state.title && ld.name) state.title = String(ld.name);
          if (!state.author) {
            const author = ld.author;
            if (Array.isArray(author) && author.length) state.author = String(author[0].name || author[0]);
            else if (author && typeof author === 'object') state.author = String(author.name || '');
            else if (typeof author === 'string') state.author = author;
          }
        }
      }

      if (!state.bookId) {
        throw new WRX.WeReadError(
          WRX.ErrorCode.STATE,
          '没能读取到书籍信息。请先打开任意一章正文，再点击导出。',
          { retryable: false }
        );
      }

      return state;
    }

    async ensureState(options) {
      const opts = options || {};
      if (this.state && this.state.bookId && this.state.psvts && !opts.force) {
        return this.state;
      }
      const state = await this.locateState();
      this.state = state;
      return this.state;
    }

    /**
     * 刷新 psvts 等会话参数（被节流，避免频繁拉取阅读页）。
     * @param {boolean} [force]
     */
    async refreshState(force) {
      const now = Date.now();
      if (!force && now - this._lastRefreshAt < 8000) {
        if (this.state && this.state.psvts) return this.state;
      }
      if (this._refreshPromise) return this._refreshPromise;

      this._refreshPromise = (async () => {
        try {
          const state = await this.locateState({ forceRemote: true });
          this.state = state;
          this._lastRefreshAt = Date.now();
          return state;
        } finally {
          this._refreshPromise = null;
        }
      })();

      return this._refreshPromise;
    }

    async ensurePsvts() {
      const state = await this.ensureState();
      if (state.psvts) return state.psvts;
      const refreshed = await this.refreshState(true);
      if (!refreshed.psvts) {
        throw new WRX.WeReadError(
          WRX.ErrorCode.STATE,
          '缺少 psvts 会话参数，请刷新页面后重试。',
          { retryable: false }
        );
      }
      return refreshed.psvts;
    }

    // ---------------------------------------------------------------- 目录/进度

    /**
     * 获取书籍目录。
     * @param {string} bookId
     * @returns {Promise<{record: object, chapters: object[], book: object}>}
     */
    async getCatalog(bookId) {
      const id = String(bookId);
      if (this.catalog && this.catalog.bookId === id) return this.catalog;

      let payload = null;
      let picked = null;

      try {
        payload = await this.postJson('/web/book/chapterInfos', { bookIds: [id] });
        picked = pickBookRecord(payload, id);
      } catch (error) {
        this.logger.warn('[微信读书导出] chapterInfos 失败：', error);
      }

      if (!picked || !picked.chapters.length) {
        try {
          const alt = await this.postJson('/web/book/publicchapterInfos', { bookIds: [id] });
          const altPicked = pickBookRecord(alt, id);
          if (altPicked && altPicked.chapters.length) picked = altPicked;
        } catch (error) {
          this.logger.warn('[微信读书导出] publicchapterInfos 也失败：', error);
        }
      }

      if (!picked) {
        throw new WRX.WeReadError(
          WRX.ErrorCode.CATALOG,
          '获取目录失败：这本书可能在当前账号下不可用（或登录已过期）。',
          { retryable: true }
        );
      }

      const chapters = normalizeChapters(picked.chapters);
      const book = Object.assign({}, picked.record.book || {}, {
        bookId: id,
        title:
          (picked.record.book && picked.record.book.title) ||
          picked.record.title ||
          (this.state && this.state.title) ||
          '',
        author:
          (picked.record.book && picked.record.book.author) ||
          picked.record.author ||
          (this.state && this.state.author) ||
          '',
        format: (picked.record.book && picked.record.book.format) || (this.state && this.state.format) || '',
      });

      this.catalog = { bookId: id, record: picked.record, chapters: chapters, book: book };
      this.book = book;
      return this.catalog;
    }

    /** 读取阅读进度（用于兜底定位"当前章节"）。 */
    async getProgress(bookId) {
      try {
        return await this.getJson('/web/book/getProgress?bookId=' + encodeURIComponent(bookId));
      } catch (error) {
        this.logger.warn('[微信读书导出] getProgress 失败：', error);
        return null;
      }
    }

    // ---------------------------------------------------------------- 章节正文

    /**
     * 请求单个分片（原样返回，由调用方判断是正文还是错误 JSON）。
     * @param {string} endpoint 例如 e_0 / t_1
     * @param {string|number} chapterUid
     * @param {{psvts: string, style?: boolean, sc?: number}} options
     */
    async postShard(endpoint, chapterUid, options) {
      const opts = options || {};
      const params = WRX.buildContentParams({
        bookId: this.bookId,
        chapterUid: chapterUid,
        psvts: opts.psvts,
        style: opts.style,
        sc: opts.sc === undefined ? 1 : opts.sc,
      });

      return await this.request('/web/book/chapter/' + endpoint, {
        method: 'POST',
        body: params,
      });
    }

    /**
     * 抓取一章的全部分片。
     *
     * 关键修复：
     *  - 所有分片都用 `sc=1` 请求，服务端才会返回整章内容（`sc=0` 只给试读）；
     *  - 首次请求先探测书籍格式：e_0 如果返回目录 JSON，说明这是 TXT 书籍，
     *    改用 t_0/t_1（原脚本只看 book.format 字段，TXT 书籍会直接抓不到内容）；
     *  - 后续分片为空（EMPTY）时跳过，不当作失败。
     *
     * @param {string|number} chapterUid
     * @param {{format?: 'epub'|'txt'|'auto', sc?: number}} [options]
     * @returns {Promise<{format: 'epub'|'txt', shards: string[]}>}
     */
    async fetchChapterShards(chapterUid, options) {
      const opts = options || {};
      const psvts = await this.ensurePsvts();
      const sc = opts.sc === undefined ? 1 : opts.sc;
      let format = opts.format || 'auto';
      let firstShard = null;

      if (format === 'auto') format = this.detectedFormat || 'auto';

      if (format === 'auto') {
        const probe = await this.postShard('e_0', chapterUid, { psvts: psvts, sc: sc });

        if (looksLikeCatalogJson(probe)) {
          // TXT 书籍：e_* 端点返回的是目录型 JSON，正文要走 t_*。
          format = 'txt';
          this.detectedFormat = 'txt';
        } else {
          // 必须是可校验的密文分片；若返回 {} / 错误 JSON，说明会话参数失效，
          // 此时不能把书籍格式定死，留给上层刷新 psvts 后重试。
          WRX.verifyShard(probe);
          format = 'epub';
          this.detectedFormat = 'epub';
          firstShard = probe;
        }
      }

      const endpoints = WRX.SHARD_ENDPOINTS[format] || WRX.SHARD_ENDPOINTS.epub;
      const shards = [];

      for (let i = 0; i < endpoints.length; i++) {
        if (i === 0 && firstShard !== null) {
          shards.push(firstShard);
          continue;
        }
        const raw = await this.postShard(endpoints[i], chapterUid, { psvts: psvts, sc: sc });

        if (isJsonResponse(raw)) {
          // 首个分片是 JSON 多半是会话/权限问题；后续分片为空对象是正常的
          // （短章节的内容装不满所有分片），直接跳过即可。
          try {
            WRX.verifyShard(raw);
          } catch (error) {
            if (i > 0 && error && error.code === WRX.ErrorCode.EMPTY) continue;
            throw error;
          }
        }

        shards.push(raw);
      }

      return { format: format, shards: shards };
    }

    /** 尝试续期登录会话，失败也不抛出（仅作为一次自愈机会）。 */
    async renewSession() {
      try {
        const data = await this.postJson('/web/login/renewal', {
          rq: '%2Fweb%2Fbook%2Fread',
          ql: false,
        });
        return !!(data && data.succ);
      } catch (error) {
        this.logger.warn('[微信读书导出] 会话续期失败：', error);
        return false;
      }
    }
  }

  // ---------------------------------------------------------------- 工具函数

  function pickBookRecord(payload, bookId) {
    const candidates = Array.isArray(payload)
      ? payload
      : payload && Array.isArray(payload.data)
        ? payload.data
        : payload && Array.isArray(payload.books)
          ? payload.books
          : payload && typeof payload === 'object'
            ? [payload]
            : [];

    const matched = [];
    for (const item of candidates) {
      if (!item || typeof item !== 'object') continue;
      const id =
        item.bookId !== undefined ? item.bookId : item.book && item.book.bookId !== undefined
          ? item.book.bookId
          : undefined;
      const chapters = item.updated || item.chapterInfos || item.chapters || [];
      if (!Array.isArray(chapters) || !chapters.length) continue;
      if (id === undefined || String(id) === String(bookId)) {
        matched.push({ record: item, chapters: chapters });
      }
    }

    if (matched.length) {
      const exact = matched.find(
        (m) => m.record.bookId !== undefined && String(m.record.bookId) === String(bookId)
      );
      return exact || matched[0];
    }

    // 有些老接口直接返回单本书对象，没有 bookId 字段。
    if (candidates.length === 1 && candidates[0] && Array.isArray(candidates[0].updated)) {
      return { record: candidates[0], chapters: candidates[0].updated };
    }
    return null;
  }

  function normalizeChapters(chapters) {
    const list = [];
    let autoIndex = 0;

    for (const chapter of chapters) {
      if (!chapter || typeof chapter !== 'object') continue;
      const uid = chapter.chapterUid;
      if (uid === undefined || uid === null) continue;

      autoIndex += 1;
      const title = String(chapter.title || '').trim();
      list.push({
        uid: uid,
        idx: Number(chapter.chapterIdx) || autoIndex,
        title: title || '第 ' + autoIndex + ' 节',
        wordCount:
          chapter.wordCount === undefined || chapter.wordCount === null
            ? null
            : Number(chapter.wordCount) || 0,
        level: Number(chapter.level) || 2,
        price: chapter.price,
        paid: !!chapter.paid,
        tar: chapter.tar || '',
      });
    }

    return list;
  }

  WRX.WereadClient = WereadClient;
  WRX.wereadApiUtils = {
    pickBookRecord: pickBookRecord,
    normalizeChapters: normalizeChapters,
    looksLikeCatalogJson: looksLikeCatalogJson,
  };
})(typeof globalThis !== 'undefined' ? globalThis : window);
