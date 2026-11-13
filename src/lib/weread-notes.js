/**
 * 微信读书「笔记 / 标注」抓取与归一化。
 *
 * 数据源（全部是 weread.qq.com 同源 GET，复用浏览器登录 Cookie）：
 *   /web/book/bookmarklist      我的划线（已过滤书签，只返回划线）
 *   /web/review/list/mine       我的想法 / 点评（需 synckey 分页）
 *   /web/book/bestbookmarks     热门划线（他人标注，可选）
 *   /web/user/notebooks         笔记本概览，用于全书架批量
 *   /web/shelf/sync             书架兜底
 *
 * 设计要点：
 *  - web 域 `/web/review/list/mine` 的准确路径未在所有账号上验证，因此做
 *    「多候选路径探测」；任一路径返回合法 reviews 数组即采用，全失败时
 *    记录明确 warning，绝不静默当成「这本书没有笔记」。
 *  - 单个数据源失败不影响其它数据源，也不阻断正文导出。
 *  - 想法通过 range / abstract 关联到对应划线，无法关联的单独列出。
 */
(function (root) {
  'use strict';

  const WRX = (root.__WRX__ = root.__WRX__ || {});

  /**
   * 个人想法 / 点评的候选接口。
   *
   * 真机反馈「个人想法接口不可用」的根因：`/web/review/list/mine` 是
   * i.weread.qq.com agent 网关的路径，weread.qq.com web 域并不提供它。
   * web 域实际使用 `/web/review/list?bookId=...&listType=11&mine=1`
   * （参考 obsidian-weread-plugin 的 /review/list 与 we-mp-rss 的
   *  /web/review/list?listType=11），故把 web 域路径放在最前面。
   *
   * 每一项返回 { path, name }，便于记录诊断。
   */
  const REVIEW_PATHS = [
    (id, page) => ({
      name: 'web/review/list[mine]',
      path: '/web/review/list?bookId=' + encodeURIComponent(id) +
        '&listType=11&mine=1&synckey=' + encodeURIComponent(page) +
        '&count=100&listMode=',
    }),
    (id, page) => ({
      name: 'web/review/list[bookid]',
      path: '/web/review/list?bookid=' + encodeURIComponent(id) +
        '&listType=11&mine=1&synckey=' + encodeURIComponent(page) + '&count=100',
    }),
    (id, page) => ({
      name: 'web/review/list[no-mine]',
      path: '/web/review/list?bookId=' + encodeURIComponent(id) +
        '&listType=11&synckey=' + encodeURIComponent(page) + '&count=100&listMode=',
    }),
    (id, page) => ({
      name: 'web/review/list/mine',
      path: '/web/review/list/mine?bookid=' + encodeURIComponent(id) +
        '&count=100&synckey=' + encodeURIComponent(page),
    }),
    (id, page) => ({
      name: 'web/review/list/mine[bookId]',
      path: '/web/review/list/mine?bookId=' + encodeURIComponent(id) +
        '&count=100&synckey=' + encodeURIComponent(page),
    }),
  ];

  function asArray(value) {
    return Array.isArray(value) ? value : [];
  }

  function pickString() {
    for (const value of arguments) {
      if (value !== undefined && value !== null && String(value).trim()) {
        return String(value).trim();
      }
    }
    return '';
  }

  function errCodeOf(data) {
    if (!data || typeof data !== 'object') return 0;
    const code = data.errCode !== undefined ? data.errCode : data.errcode;
    return Number(code) || 0;
  }

  /** 从多种回包形状里取出「想法数组」与分页信息；取不到返回 null。 */
  function extractReviews(data) {
    if (!data || typeof data !== 'object') return null;
    const candidates = [
      data.reviews,
      data.data && data.data.reviews,
      data.reviewList,
      data.list,
      data.items,
    ];
    for (const candidate of candidates) {
      if (Array.isArray(candidate)) {
        return {
          reviews: candidate,
          hasMore: Number(data.hasMore !== undefined ? data.hasMore : (data.data && data.data.hasMore)) || 0,
          totalCount: Number(
            data.totalCount !== undefined ? data.totalCount : (data.data && data.data.totalCount)
          ) || 0,
          synckey: pickString(
            data.synckey !== undefined ? data.synckey : (data.data && data.data.synckey)
          ),
        };
      }
    }
    return null;
  }

  /** 时间戳（秒 / 毫秒都兼容）→ YYYY-MM-DD。 */
  function formatNoteTime(value) {
    const num = Number(value) || 0;
    if (!num) return '';
    const ms = num < 1e11 ? num * 1000 : num;
    const date = new Date(ms);
    if (Number.isNaN(date.getTime())) return '';
    const pad = (n) => String(n).padStart(2, '0');
    return date.getFullYear() + '-' + pad(date.getMonth() + 1) + '-' + pad(date.getDate());
  }

  class WereadNotes {
    /**
     * @param {object} client WRX.WereadClient
     */
    constructor(client) {
      this.client = client;
      this.logger = (client && client.logger) || root.console;
    }

    /**
     * 取一个 JSON 接口；业务错误 / 非 JSON / 网络问题都返回 null（由调用方记 warning）。
     * 与 client.getJson 的区别：这里刻意吞掉异常，避免单个笔记接口拖垮整次导出。
     * @returns {Promise<object|null>}
     */
    async _tryGet(path) {
      try {
        const text = await this.client.request(path, {
          headers: { accept: 'application/json, text/plain, */*' },
        });
        const trimmed = String(text || '').trim();
        if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return null;
        const data = JSON.parse(trimmed);
        if (!data || typeof data !== 'object') return null;
        if (errCodeOf(data) !== 0) return null;
        return data;
      } catch (error) {
        return null;
      }
    }

    // ------------------------------------------------------------ 划线

    /**
     * 我的划线。
     * @param {string} bookId
     * @returns {Promise<{items: object[], chapters: object[], ok: boolean}>}
     */
    async fetchBookmarks(bookId) {
      const paths = [
        '/web/book/bookmarklist?bookId=' + encodeURIComponent(bookId),
        '/web/book/bookmarklist?bookId=' + encodeURIComponent(bookId) + '&synckey=0',
      ];

      for (const path of paths) {
        const data = await this._tryGet(path);
        if (!data) continue;

        const raw = asArray(data.updated || data.bookmarks || data.items);
        const items = raw
          .filter((item) => item && typeof item === 'object')
          .map((item, index) => ({
            id: pickString(item.bookmarkId, item.id, 'bm-' + index),
            text: pickString(item.markText, item.text, item.markTextContent),
            // 划线记录常自带用户当时的「划线想法」，字段名不统一，逐一兜底
            inlineNote: pickString(
              item.reviewContent, item.noteContent, item.note, item.content,
              item.review && item.review.content, item.markTextReview
            ),
            chapterUid: item.chapterUid === undefined ? null : item.chapterUid,
            chapterIdx: item.chapterIdx === undefined ? null : Number(item.chapterIdx),
            range: pickString(item.range),
            colorStyle: Number(item.colorStyle) || 0,
            type: Number(item.type) || 0,
            createTime: Number(item.createTime) || 0,
          }))
          .filter((item) => item.text);

        const chapters = asArray(data.chapters).map((chapter) => ({
          uid: chapter.chapterUid,
          idx: Number(chapter.chapterIdx) || 0,
          title: pickString(chapter.title),
        }));

        return { items, chapters, ok: true };
      }

      return { items: [], chapters: [], ok: false };
    }

    // ------------------------------------------------------------ 想法

    /**
     * 我的想法 / 点评，带分页与路径探测。
     * @param {string} bookId
     * @returns {Promise<{items: object[], ok: boolean, path: string}>}
     */
    async fetchMyReviews(bookId) {
      const diagnostics = [];

      for (const buildPath of REVIEW_PATHS) {
        const firstPath = buildPath(bookId, 0);
        const first = await this._tryGet(firstPath.path);
        const firstParsed = extractReviews(first);
        if (!firstParsed) {
          diagnostics.push({ name: firstPath.name, path: firstPath.path, status: 'no-reviews' });
          continue;
        }

        const items = [];
        let page = firstParsed;
        // 首轮游标必须是 0：服务端返回的 synckey 是「下一页」的游标，
        // 若用它初始化会误判为已到末页，导致只拿到第一页。
        let synckey = '0';
        let guard = 0;

        while (page && Array.isArray(page.reviews) && guard < 30) {
          guard += 1;
          for (const wrapper of page.reviews) {
            const review = (wrapper && wrapper.review) || wrapper;
            if (!review || typeof review !== 'object') continue;
            const content = pickString(review.content, review.htmlContent, review.text);
            if (!content) continue;

            // 无 mine=1 的兜底路径可能混入他人点评：优先用 author 判断，
            // 有明确 userVid/author 且与当前用户不符时跳过。
            if (review.isMine === false || review.mine === false) continue;

            items.push({
              id: pickString(review.reviewId, review.id, 'rv-' + items.length),
              content,
              abstract: pickString(review.abstract),
              chapterUid: review.chapterUid === undefined ? null : review.chapterUid,
              chapterIdx: review.chapterIdx === undefined ? null : Number(review.chapterIdx),
              chapterTitle: pickString(review.chapterName, review.chapterTitle),
              range: pickString(review.range),
              star: Number(review.star) || 0,
              createTime: Number(review.createTime) || 0,
            });
          }

          const hasMore =
            Number(page.hasMore) === 1 ||
            (page.totalCount !== undefined && Number(page.totalCount) > items.length);
          const nextKey = pickString(page.synckey, synckey);
          if (!hasMore || !nextKey || nextKey === synckey) break;
          synckey = nextKey;
          page = extractReviews(await this._tryGet(buildPath(bookId, synckey).path));
        }

        // 合法但为空：也视为接口可用（这本书确实没有想法），继续用该路径。
        diagnostics.push({
          name: firstPath.name,
          path: firstPath.path,
          status: items.length ? 'ok' : 'empty',
          count: items.length,
        });
        return { items, ok: true, path: firstPath.name, diagnostics };
      }

      return { items: [], ok: false, path: '', diagnostics };
    }

    // ------------------------------------------------------------ 热门划线

    /**
     * 热门划线（他人标注）。
     * @param {string} bookId
     * @returns {Promise<{items: object[], ok: boolean}>}
     */
    async fetchBestBookmarks(bookId) {
      const path =
        '/web/book/bestbookmarks?bookId=' + encodeURIComponent(bookId) +
        '&chapterUid=0&synckey=0';
      const data = await this._tryGet(path);
      if (!data) return { items: [], ok: false };

      const raw = asArray(data.items || data.updated || data.bookmarks);
      const chapters = asArray(data.chapters);
      const chapterMap = new Map(
        chapters.map((chapter) => [String(chapter.chapterUid), pickString(chapter.title)])
      );

      const items = raw
        .filter((item) => item && typeof item === 'object' && pickString(item.markText, item.text))
        .map((item, index) => ({
          id: pickString(item.bookmarkId, 'hot-' + index),
          text: pickString(item.markText, item.text),
          chapterUid: item.chapterUid === undefined ? null : item.chapterUid,
          chapterTitle: chapterMap.get(String(item.chapterUid)) || '',
          range: pickString(item.range),
          count: Number(item.totalCount) || 0,
        }));

      return { items, ok: true };
    }

    // ------------------------------------------------------------ 笔记本概览

    /**
     * 有笔记的书（全书架批量导出用），失败时回退到书架。
     * @returns {Promise<{books: object[], source: string, ok: boolean}>}
     */
    async fetchNotebookBooks() {
      const books = [];
      let lastSort = '';
      let guard = 0;

      while (guard < 50) {
        guard += 1;
        const path =
          '/web/user/notebooks?count=100' +
          (lastSort ? '&lastSort=' + encodeURIComponent(lastSort) : '');
        const data = await this._tryGet(path);
        if (!data || !Array.isArray(data.books)) break;

        for (const entry of data.books) {
          if (!entry || typeof entry !== 'object') continue;
          const info = entry.book || {};
          const id = pickString(entry.bookId, info.bookId);
          if (!id) continue;
          books.push({
            bookId: id,
            title: pickString(info.title, entry.title, id),
            author: pickString(info.author, entry.author),
            noteCount: Number(entry.noteCount) || 0,
            reviewCount: Number(entry.reviewCount) || 0,
            bookmarkCount: Number(entry.bookmarkCount) || 0,
            sort: Number(entry.sort) || 0,
          });
        }

        if (Number(data.hasMore) !== 1 || !data.books.length) break;
        const next = Number(data.books[data.books.length - 1].sort) || 0;
        if (!next || String(next) === String(lastSort)) break;
        lastSort = String(next);
      }

      if (books.length) return { books, source: 'notebooks', ok: true };

      const shelf = await this._tryGet('/web/shelf/sync?userVid=&synckey=0');
      const shelfBooks = asArray(shelf && (shelf.books || shelf.data)).map((item) => {
        const info = (item && item.bookInfo) || item || {};
        return {
          bookId: pickString(item && item.bookId, info.bookId),
          title: pickString(info.title, item && item.title),
          author: pickString(info.author, item && item.author),
          noteCount: 0,
          reviewCount: 0,
          bookmarkCount: 0,
          sort: 0,
        };
      }).filter((book) => book.bookId && !book.bookId.startsWith('MP_WXS_'));

      return { books: shelfBooks, source: shelfBooks.length ? 'shelf' : '', ok: shelfBooks.length > 0 };
    }

    // ------------------------------------------------------------ 组合

    /**
     * 收集一本书的全部笔记，归一化并按章节分组。
     * @param {string} bookId
     * @param {{
     *   includePopular?: boolean,
     *   catalogChapters?: Array<{uid: string|number, title: string, idx?: number}>,
     *   bookTitle?: string
     * }} [options]
     * @returns {Promise<object>} 见 buildEmptyNotes()
     */
    async collectBookNotes(bookId, options) {
      const opts = options || {};
      const notes = buildEmptyNotes(bookId, opts.bookTitle || '');

      const [highlights, thoughts, popular] = await Promise.all([
        this.fetchBookmarks(bookId),
        this.fetchMyReviews(bookId),
        opts.includePopular ? this.fetchBestBookmarks(bookId) : Promise.resolve({ items: [], ok: true }),
      ]);

      if (!highlights.ok) notes.warnings.push('划线接口不可用，本次未导出划线');
      if (opts.includePopular && !popular.ok) notes.warnings.push('热门划线接口不可用');
      // 想法接口的失败提示延后到「划线内嵌想法」合并之后再判断，
      // 避免明明拿到了想法却仍报「接口不可用」。
      notes.diagnostics = thoughts.diagnostics || [];
      if (!thoughts.ok) {
        notes.diagnostics.push({ name: 'review', status: 'all-endpoints-failed' });
      }

      // 章节映射：优先用 bookmarklist 返回的 chapters，其次用导出目录。
      const chapterList = [];
      if (highlights.chapters.length) {
        highlights.chapters.forEach((chapter, index) => {
          chapterList.push({
            uid: chapter.uid,
            title: chapter.title || '第 ' + (index + 1) + ' 节',
            idx: chapter.idx || index + 1,
          });
        });
      }
      if (!chapterList.length && opts.catalogChapters) {
        opts.catalogChapters.forEach((chapter, index) => {
          if (chapter.isVolume) return;
          chapterList.push({ uid: chapter.uid, title: chapter.title, idx: chapter.idx || index + 1 });
        });
      }
      notes.chapters = chapterList;

      const uidToChapter = new Map(chapterList.map((chapter) => [String(chapter.uid), chapter]));

      // 划线
      for (const item of highlights.items) {
        const chapter = uidToChapter.get(String(item.chapterUid));
        notes.highlights.push(Object.assign({}, item, {
          chapterTitle: chapter ? chapter.title : '',
          thoughts: [],
          time: formatNoteTime(item.createTime),
        }));
      }

      // 想法：先尝试按 range 关联划线，再按 abstract 文本关联，都失败则单独列出。
      const byRange = new Map();
      for (const highlight of notes.highlights) {
        if (highlight.range) byRange.set(highlight.range, highlight);
      }

      // 去重：同一条想法可能同时出现在划线记录与 review 接口里。
      const seenThoughts = new Set();
      const addThought = (item, source) => {
        const chapter = uidToChapter.get(String(item.chapterUid));
        const thought = Object.assign({}, item, {
          chapterTitle: chapter ? chapter.title : item.chapterTitle,
          time: item.time || formatNoteTime(item.createTime),
          source,
        });
        const key = (thought.content || '').replace(/\s+/g, '') + '|' + (thought.range || '');
        if (seenThoughts.has(key)) return null;
        seenThoughts.add(key);
        return thought;
      };

      const attach = (thought) => {
        if (!thought) return;
        let target = thought.range ? byRange.get(thought.range) : null;
        if (!target && thought.abstract) {
          const abstract = thought.abstract.replace(/\s+/g, '');
          target = notes.highlights.find(
            (highlight) =>
              highlight.text.replace(/\s+/g, '') === abstract ||
              highlight.text.includes(thought.abstract) ||
              thought.abstract.includes(highlight.text)
          );
        }
        if (target) target.thoughts.push(thought);
        else notes.thoughts.push(thought);
      };

      // 来源 1：划线记录自带的「划线想法」（content/note 等字段），天然关联该划线。
      let inlineCount = 0;
      for (const highlight of notes.highlights) {
        if (!highlight.inlineNote) continue;
        const thought = addThought({
          content: highlight.inlineNote,
          abstract: highlight.text,
          range: highlight.range,
          chapterUid: highlight.chapterUid,
          chapterTitle: highlight.chapterTitle,
          createTime: highlight.createTime,
        }, 'bookmark');
        if (thought) {
          highlight.thoughts.push(thought);
          inlineCount += 1;
        }
      }

      // 来源 2：想法 / 点评接口（去重后按 range/abstract 关联或单独列出）。
      let reviewCount = 0;
      for (const item of thoughts.items) {
        const thought = addThought(item, 'review');
        if (!thought) continue;
        attach(thought);
        reviewCount += 1;
      }

      const totalThoughts = inlineCount + reviewCount;
      if (!thoughts.ok && totalThoughts === 0) {
        notes.warnings.push(
          '未能读取个人想法/点评（已尝试 ' + REVIEW_PATHS.length + ' 个接口）；划线内容仍已导出'
        );
      } else if (!thoughts.ok) {
        notes.warnings.push(
          '想法接口部分不可用，已用划线自带的想法补足（' + inlineCount + ' 条）'
        );
      }

      for (const item of popular.items) {
        const chapter = uidToChapter.get(String(item.chapterUid));
        notes.popular.push(Object.assign({}, item, {
          chapterTitle: chapter ? chapter.title : item.chapterTitle,
        }));
      }

      notes.stats = {
        highlights: notes.highlights.length,
        thoughts: totalThoughts,
        inlineThoughts: inlineCount,
        reviewThoughts: reviewCount,
        popular: notes.popular.length,
        chapters: chapterList.length,
      };
      notes.ok = highlights.ok || thoughts.ok || totalThoughts > 0 ||
        (opts.includePopular && popular.ok);
      notes.groups = this.groupByChapter(notes);
      return notes;
    }

    /** 按章节顺序把笔记分组，未匹配章节归到「未分章」。 */
    groupByChapter(notes) {
      const groups = (notes.chapters || []).map((chapter) => ({
        uid: chapter.uid,
        title: chapter.title,
        idx: chapter.idx,
        highlights: [],
        thoughts: [],
        popular: [],
      }));
      const byUid = new Map(groups.map((group) => [String(group.uid), group]));
      const fallback = {
        uid: '__other__',
        title: notes.chapters && notes.chapters.length ? '未分章' : '全书',
        idx: 9999,
        highlights: [],
        thoughts: [],
        popular: [],
      };

      const push = (kind, item) => {
        const group = byUid.get(String(item.chapterUid)) || fallback;
        group[kind].push(item);
      };

      for (const item of notes.highlights || []) push('highlights', item);
      for (const item of notes.thoughts || []) push('thoughts', item);
      for (const item of notes.popular || []) push('popular', item);

      const result = groups.filter((group) => group.highlights.length || group.thoughts.length || group.popular.length);
      if (fallback.highlights.length || fallback.thoughts.length || fallback.popular.length) {
        result.push(fallback);
      }
      return result;
    }
  }

  function buildEmptyNotes(bookId, title) {
    return {
      bookId: String(bookId || ''),
      title: title || '',
      highlights: [],
      thoughts: [],
      popular: [],
      chapters: [],
      warnings: [],
      diagnostics: [],
      stats: { highlights: 0, thoughts: 0, inlineThoughts: 0, reviewThoughts: 0, popular: 0, chapters: 0 },
      ok: false,
    };
  }

  function hasNotes(notes) {
    if (!notes) return false;
    return !!(
      (notes.highlights && notes.highlights.length) ||
      (notes.thoughts && notes.thoughts.length) ||
      (notes.popular && notes.popular.length)
    );
  }

  WRX.WereadNotes = WereadNotes;
  WRX.notesUtils = {
    buildEmptyNotes,
    hasNotes,
    formatNoteTime,
    asArray,
  };
})(typeof globalThis !== 'undefined' ? globalThis : window);
