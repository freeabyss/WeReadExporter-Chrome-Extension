/**
 * 内容格式化：把解码后的 XHTML / 纯文本整理为 Markdown、HTML、TXT。
 */
(function (root) {
  'use strict';

  const WRX = (root.__WRX__ = root.__WRX__ || {});
  let turndownService = null;

  // ------------------------------------------------------------------ 基础工具

  function escapeHtml(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function parseHtml(html) {
    const parser = new DOMParser();
    return parser.parseFromString(String(html || ''), 'text/html');
  }

  function normalizeTitleText(value) {
    return String(value || '')
      .replace(/[\s\u3000]+/g, '')
      .replace(/[《》「」『』“”"'’‘·•\-—_.,，。:：;；!！?？()（）[\]]/g, '')
      .toLowerCase();
  }

  /** 移除脚本、样式、事件属性等不安全内容。 */
  function sanitizeDocument(doc) {
    doc.querySelectorAll('script, style, link, iframe, noscript, object, embed').forEach((el) => {
      el.remove();
    });

    doc.querySelectorAll('*').forEach((el) => {
      const attributes = Array.from(el.attributes || []);
      for (const attr of attributes) {
        const name = attr.name.toLowerCase();
        if (name.startsWith('on')) {
          el.removeAttribute(attr.name);
        } else if ((name === 'href' || name === 'src') && /^\s*javascript:/i.test(attr.value)) {
          el.removeAttribute(attr.name);
        }
      }
    });
  }

  /**
   * 若正文开头重复了章节标题（微信读书 XHTML 常见），去掉重复的标题节点。
   * @param {HTMLElement} container
   * @param {string} title
   */
  function stripDuplicateHeading(container, title) {
    const target = normalizeTitleText(title);
    if (!target) return;

    const first = container.firstElementChild;
    if (!first) return;

    const isHeading = /^H[1-6]$/.test(first.tagName);
    const isTitleLike = /(^|\s|[-_])title(\s|$|[-_])/i.test(first.className || '');
    if (!isHeading && !isTitleLike) return;

    const text = normalizeTitleText(first.textContent);
    if (!text) return;

    if (text === target || target.includes(text) || text.includes(target)) {
      first.remove();
    }
  }

  /**
   * 把章节 XHTML 处理成安全的 body 片段。
   * @param {string} raw html 字符串
   * @param {{title?: string}} [options]
   * @returns {string}
   */
  function extractBodyHtml(raw, options) {
    const opts = options || {};
    const doc = parseHtml(raw);
    sanitizeDocument(doc);

    const body = doc.body;
    if (!body) return '';

    stripDuplicateHeading(body, opts.title || '');

    return body.innerHTML.trim();
  }

  /**
   * 纯文本 → 段落 HTML。
   * @param {string} text
   * @returns {string}
   */
  function textToHtml(text) {
    const lines = String(text || '')
      .replace(/\r\n?/g, '\n')
      .split('\n');

    const paragraphs = [];
    for (const line of lines) {
      const cleaned = line.replace(/^[\s\u3000]+|[\s\u3000]+$/g, '');
      if (!cleaned) continue;
      paragraphs.push('<p>' + escapeHtml(cleaned) + '</p>');
    }
    return paragraphs.join('\n');
  }

  // ------------------------------------------------------------------ Markdown

  function getTurndown() {
    if (turndownService) return turndownService;

    const TurndownService = root.TurndownService;
    if (!TurndownService) {
      throw new WRX.WeReadError(WRX.ErrorCode.FORMAT, 'Markdown 转换组件未加载，请重新加载扩展。');
    }

    turndownService = new TurndownService({
      headingStyle: 'atx',
      hr: '---',
      bulletListMarker: '-',
      codeBlockStyle: 'fenced',
      emDelimiter: '*',
      strongDelimiter: '**',
      linkStyle: 'inlined',
      br: '\n',
    });

    // 注音（ruby/rt）：只保留基字，避免正文重复出现拼音。
    turndownService.addRule('wereadRuby', {
      filter: (node) => node.nodeName === 'RUBY',
      replacement: (content, node) => {
        let out = '';
        for (const child of node.childNodes) {
          if (child.nodeName === 'RT' || child.nodeName === 'RP') continue;
          out += child.textContent || '';
        }
        return out || content;
      },
    });

    // 图片：保留远程地址，便于在有登录态的环境里直接查看。
    turndownService.addRule('wereadImage', {
      filter: 'img',
      replacement: (content, node) => {
        const src = node.getAttribute('src') || '';
        if (!src) return '';
        const alt = node.getAttribute('alt') || '图片';
        return '![' + alt + '](' + src + ')';
      },
    });

    // 微信读书的划线/想法。
    turndownService.addRule('wereadMark', {
      filter: (node) =>
        node.nodeName === 'SPAN' && /(^|\s)(highlight|mark)(\s|$)/i.test(node.className || ''),
      replacement: (content) => '**' + content + '**',
    });

    // 空段落不要留成空格行。
    turndownService.addRule('emptyParagraph', {
      filter: (node) =>
        node.nodeName === 'P' && !String(node.textContent || '').replace(/[\s\u3000]/g, ''),
      replacement: () => '',
    });

    return turndownService;
  }

  /**
   * body HTML 片段 → Markdown。
   * @param {string} html
   * @returns {string}
   */
  function htmlToMarkdown(html) {
    if (!String(html || '').trim()) return '';
    const service = getTurndown();
    let md = '';
    try {
      md = service.turndown(html);
    } catch (error) {
      throw new WRX.WeReadError(WRX.ErrorCode.FORMAT, 'Markdown 转换失败：' + error.message, {
        cause: error,
      });
    }
    return md
      .replace(/[ \t]+\n/g, '\n')
      .replace(/\\\[\]/g, '[]')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }

  // ------------------------------------------------------------------ 纯文本

  /**
   * body HTML 片段 → 纯文本（每个块级元素一行）。
   * @param {string} html
   * @returns {string}
   */
  function htmlToPlainText(html) {
    if (!String(html || '').trim()) return '';
    const doc = parseHtml(html);
    sanitizeDocument(doc);

    doc.querySelectorAll('br').forEach((br) => {
      br.replaceWith(doc.createTextNode('\n'));
    });

    const blocks =
      'p,div,h1,h2,h3,h4,h5,h6,li,blockquote,section,article,tr,dd,dt,figcaption,pre';
    doc.querySelectorAll(blocks).forEach((el) => {
      el.appendChild(doc.createTextNode('\n'));
    });
    doc.querySelectorAll('img').forEach((img) => {
      const src = img.getAttribute('src') || '';
      if (src) img.replaceWith(doc.createTextNode('［图片：' + src + '］\n'));
      else img.remove();
    });

    const text = (doc.body && doc.body.textContent) || '';
    const lines = text.replace(/\r\n?/g, '\n').split('\n').map((line) => line.trim());

    const output = [];
    for (const line of lines) {
      if (!line && output.length && output[output.length - 1] === '') continue;
      output.push(line);
    }
    return output.join('\n').trim();
  }

  // ------------------------------------------------------------------ 组装成书

  function formatDate(date) {
    const d = date || new Date();
    const pad = (n) => String(n).padStart(2, '0');
    return (
      d.getFullYear() +
      '-' +
      pad(d.getMonth() + 1) +
      '-' +
      pad(d.getDate()) +
      ' ' +
      pad(d.getHours()) +
      ':' +
      pad(d.getMinutes())
    );
  }

  /**
   * 章节的 Markdown 标题层级：卷标题用 ##，普通章节用 ##（保持一致，避免目录错乱）。
   * @param {{level?: number}} chapter
   */
  function chapterHeading(chapter) {
    return '##';
  }

  const HTML_STYLE = [
    ':root { color-scheme: light dark; }',
    'body { margin: 0; padding: 32px 18px 64px; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", serif; line-height: 1.85; color: #1f2328; background: #ffffff; }',
    '.wrap { max-width: 46em; margin: 0 auto; }',
    'h1.book-title { font-size: 1.85em; margin: 0 0 .3em; line-height: 1.35; }',
    '.book-meta { color: #6b7280; font-size: .9em; margin: 0 0 2em; }',
    '.toc { border: 1px solid #e5e7eb; border-radius: 10px; padding: 14px 22px; margin: 0 0 2.5em; }',
    '.toc h2 { font-size: 1em; margin: 0 0 .6em; }',
    '.toc ol { margin: 0; padding-left: 1.4em; }',
    '.toc a { color: #2563eb; text-decoration: none; }',
    'section.chapter { margin: 0 0 3em; padding-top: .5em; border-top: 1px dashed #e5e7eb; }',
    'section.chapter:first-of-type { border-top: none; }',
    'section.chapter > h2 { font-size: 1.3em; margin: 0 0 1em; line-height: 1.45; }',
    'p { margin: 0 0 .85em; text-indent: 2em; }',
    'h1, h2, h3, h4, h5, h6 { line-height: 1.45; }',
    'img { max-width: 100%; height: auto; display: block; margin: 1em auto; }',
    'blockquote { margin: 1em 0; padding: .2em 1em; border-left: 3px solid #d1d5db; color: #4b5563; }',
    'ruby rt { font-size: .55em; color: #6b7280; }',
    /* 笔记与标注 */
    'section.notes { margin: 3em 0 0; padding-top: 1.2em; border-top: 2px solid #e5e7eb; }',
    'section.notes > h2 { margin: 0 0 .4em; }',
    '.notes-summary { color: #6b7280; font-size: .9em; text-indent: 0; margin: 0 0 1.5em; }',
    '.note-chapter { margin: 0 0 2em; }',
    '.note-chapter > h3 { font-size: 1.05em; color: #374151; margin: 0 0 .8em; }',
    '.highlight-item, .popular-item { margin: 0 0 1.1em; }',
    'blockquote.highlight { margin: 0; padding: .3em 1em; border-left: 3px solid #2f6bff; background: rgba(47,107,255,.05); }',
    'blockquote.highlight p { text-indent: 0; margin: 0; }',
    '.note-time, .popular-count { text-indent: 0; margin: .35em 0 0; font-size: .8em; color: #6b7280; }',
    'p.thought { text-indent: 0; margin: .4em 0 0 1em; padding-left: .7em; border-left: 2px solid #f59e0b; }',
    '.thought-label { color: #b45309; font-weight: 600; }',
    '.notes-warning { color: #9a6700; background: rgba(154,103,0,.07); padding: .6em .9em; border-radius: 8px; text-indent: 0; font-size: .9em; }',
    '.shelf-book { margin: 0 0 3em; padding-bottom: 2em; border-bottom: 1px solid #e5e7eb; }',
    '.shelf-book > h2 { margin: 0 0 .2em; }',
    '.shelf-meta { color: #6b7280; font-size: .9em; text-indent: 0; margin: 0 0 1em; }',
    '@media (prefers-color-scheme: dark) {',
    '  body { color: #e6e6e6; background: #16181d; }',
    '  .book-meta { color: #9ca3af; }',
    '  .toc { border-color: #2d3139; }',
    '  .toc a { color: #7aa2ff; }',
    '  section.chapter { border-top-color: #2d3139; }',
    '  blockquote { border-left-color: #3f4650; color: #b3b9c4; }',
    '  section.notes { border-top-color: #2d3139; }',
    '  .note-chapter > h3 { color: #c9d1d9; }',
    '  .notes-summary, .note-time, .popular-count, .shelf-meta { color: #9aa4b2; }',
    '  blockquote.highlight { background: rgba(76,132,255,.09); }',
    '  .shelf-book { border-bottom-color: #2d3139; }',
    '}',
  ].join('\n');

  /**
   * 组装整本书。
   * @param {{
   *   format: 'md'|'html'|'txt',
   *   book: {title?: string, author?: string, bookId?: string},
   *   chapters: Array<{uid: string|number, title: string, level?: number, html?: string, text?: string, isVolume?: boolean}>,
   *   options?: {frontMatter?: boolean, toc?: boolean, now?: Date, total?: number, failed?: number}
   * }} input
   * @returns {string}
   */
  // ------------------------------------------------------------------ 笔记与标注

  function notesSummary(notes) {
    const stats = (notes && notes.stats) || {};
    const parts = [];
    parts.push('我的划线 ' + (stats.highlights || 0) + ' 条');
    parts.push('我的想法 ' + (stats.thoughts || 0) + ' 条');
    if (stats.popular) parts.push('热门划线 ' + stats.popular + ' 条');
    return parts.join(' · ');
  }

  function notesGroups(notes) {
    if (notes && Array.isArray(notes.groups) && notes.groups.length) return notes.groups;
    // 兜底：调用方没预分组时，把所有笔记归入一组，不丢内容。
    if (notes && ((notes.highlights || []).length || (notes.thoughts || []).length || (notes.popular || []).length)) {
      return [{
        uid: '__all__',
        title: (notes.chapters && notes.chapters.length) ? '全书' : '笔记',
        idx: 0,
        highlights: notes.highlights || [],
        thoughts: notes.thoughts || [],
        popular: notes.popular || [],
      }];
    }
    return [];
  }

  function oneLine(text) {
    return String(text || '').replace(/[\r\n]+/g, ' ').replace(/\s+/g, ' ').trim();
  }

  /** 渲染「笔记与标注」主体（不含文档外壳）。 */
  function renderNotesBody(notes, format, level) {
    const groups = notesGroups(notes);
    const warnings = (notes && notes.warnings) || [];
    if (format === 'html') return renderNotesHtml(notes, groups, warnings, level);
    if (format === 'txt') return renderNotesTxt(notes, groups, warnings, level);
    return renderNotesMarkdown(notes, groups, warnings, level);
  }

  function renderNotesMarkdown(notes, groups, warnings, level) {
    const out = [];
    out.push('> ' + notesSummary(notes));
    for (const warning of warnings) out.push('> ⚠️ ' + warning);
    if (!groups.length) {
      out.push('> 暂无可导出的笔记与标注。');
      return out.join('\n');
    }

    const heading = (n, text) => '#'.repeat(Math.min(n, 6)) + ' ' + text;

    for (const group of groups) {
      const block = [];
      block.push(heading(level + 1, group.title));

      for (const item of group.highlights) {
        const lines = ['> ' + oneLine(item.text)];
        if (item.time) lines.push('> — ' + item.time);
        block.push(lines.join('\n'));
        for (const thought of item.thoughts || []) {
          block.push(
            '💬 **我的想法**：' + oneLine(thought.content) +
              (thought.time ? '（' + thought.time + '）' : '')
          );
        }
      }

      for (const thought of group.thoughts) {
        const prefix = thought.abstract ? '> ' + oneLine(thought.abstract) + '\n\n' : '';
        block.push(prefix + '💬 **我的想法**：' + oneLine(thought.content) +
          (thought.time ? '（' + thought.time + '）' : ''));
      }

      if (group.popular.length) {
        block.push('**热门划线（他人标注）**');
        for (const item of group.popular) {
          block.push('> ' + oneLine(item.text) + (item.count ? '（' + item.count + ' 人划线）' : ''));
        }
      }

      out.push(block.join('\n\n'));
    }
    return out.join('\n\n');
  }

  function renderNotesTxt(notes, groups, warnings, level) {
    const out = ['【' + notesSummary(notes) + '】'];
    for (const warning of warnings) out.push('⚠️ ' + warning);
    if (!groups.length) {
      out.push('暂无可导出的笔记与标注。');
      return out.join('\n');
    }

    for (const group of groups) {
      out.push('');
      out.push('— ' + group.title + ' —');
      for (const item of group.highlights) {
        out.push('  > ' + oneLine(item.text) + (item.time ? '  ' + item.time : ''));
        for (const thought of item.thoughts || []) {
          out.push('  💬 想法：' + oneLine(thought.content));
        }
      }
      for (const thought of group.thoughts) {
        if (thought.abstract) out.push('  > ' + oneLine(thought.abstract));
        out.push('  💬 想法：' + oneLine(thought.content));
      }
      if (group.popular.length) {
        out.push('  热门划线（他人标注）：');
        for (const item of group.popular) {
          out.push('  > ' + oneLine(item.text) + (item.count ? '（' + item.count + ' 人划线）' : ''));
        }
      }
    }
    return out.join('\n');
  }

  function renderNotesHtml(notes, groups, warnings, level) {
    const out = [];
    out.push('<p class="notes-summary">' + escapeHtml(notesSummary(notes)) + '</p>');
    for (const warning of warnings) {
      out.push('<p class="notes-warning">⚠️ ' + escapeHtml(warning) + '</p>');
    }
    if (!groups.length) {
      out.push('<p class="notes-summary">暂无可导出的笔记与标注。</p>');
      return out.join('\n');
    }

    for (const group of groups) {
      const block = [];
      block.push('<section class="note-chapter">');
      block.push('<h3>' + escapeHtml(group.title) + '</h3>');

      for (const item of group.highlights) {
        block.push('<div class="highlight-item">');
        block.push('<blockquote class="highlight"><p>' + escapeHtml(oneLine(item.text)) + '</p></blockquote>');
        if (item.time) block.push('<p class="note-time">' + escapeHtml(item.time) + '</p>');
        block.push('</div>');
        for (const thought of item.thoughts || []) {
          block.push(
            '<p class="thought"><span class="thought-label">💬 我的想法</span> ' +
              escapeHtml(oneLine(thought.content)) +
              (thought.time ? ' <small>' + escapeHtml(thought.time) + '</small>' : '') +
              '</p>'
          );
        }
      }

      for (const thought of group.thoughts) {
        if (thought.abstract) {
          block.push('<div class="highlight-item"><blockquote class="highlight"><p>' +
            escapeHtml(oneLine(thought.abstract)) + '</p></blockquote></div>');
        }
        block.push('<p class="thought"><span class="thought-label">💬 我的想法</span> ' +
          escapeHtml(oneLine(thought.content)) + '</p>');
      }

      if (group.popular.length) {
        block.push('<h4>热门划线（他人标注）</h4>');
        for (const item of group.popular) {
          block.push('<div class="popular-item">');
          block.push('<blockquote class="highlight"><p>' + escapeHtml(oneLine(item.text)) + '</p></blockquote>');
          if (item.count) block.push('<p class="popular-count">' + item.count + ' 人划线</p>');
          block.push('</div>');
        }
      }

      block.push('</section>');
      out.push(block.join('\n'));
    }
    return out.join('\n');
  }

  /**
   * 生成「笔记与标注」小节（追加到书籍导出文档末尾）。
   * @param {object} notes collectBookNotes() 的返回值
   * @param {'md'|'html'|'txt'} format
   * @param {{level?: number}} [options]
   */
  function buildNotesSection(notes, format, options) {
    const opts = options || {};
    const level = opts.level === undefined ? 2 : opts.level;
    const title = '笔记与标注';
    const body = renderNotesBody(notes, format, level);

    if (format === 'html') {
      return [
        '<section class="notes" id="notes">',
        '<h' + Math.min(level, 6) + '>' + title + '</h' + Math.min(level, 6) + '>',
        body,
        '</section>',
      ].join('\n');
    }
    if (format === 'txt') {
      return ['【' + title + '】', body].join('\n');
    }
    return ['#'.repeat(Math.min(level, 6)) + ' ' + title, body].join('\n\n');
  }

  /**
   * 全书架批量导出：一个文件，按书分组（一个书本一组）。
   * @param {{
   *   format: 'md'|'html'|'txt',
   *   books: Array<{title: string, author?: string, notes: object}>,
   *   options?: {frontMatter?: boolean, now?: Date, warnings?: string[]}
   * }} input
   */
  function buildShelfNotes(input) {
    const format = input.format || 'md';
    const books = (input.books || []).filter((book) => book && book.notes);
    const options = input.options || {};
    const now = formatDate(options.now || new Date());
    const totalHighlights = books.reduce((n, b) => n + ((b.notes.stats && b.notes.stats.highlights) || 0), 0);
    const totalThoughts = books.reduce((n, b) => n + ((b.notes.stats && b.notes.stats.thoughts) || 0), 0);
    const summary = '共 ' + books.length + ' 本书 · 我的划线 ' + totalHighlights + ' 条 · 我的想法 ' + totalThoughts + ' 条';

    if (format === 'html') {
      const sections = books.map((book) => [
        '<section class="shelf-book">',
        '<h2>' + escapeHtml(book.title || '未知书名') + '</h2>',
        book.author ? '<p class="shelf-meta">作者：' + escapeHtml(book.author) + '</p>' : '',
        renderNotesHtml(book.notes, notesGroups(book.notes), book.notes.warnings || [], 2),
        '</section>',
      ].filter(Boolean).join('\n'));

      const warnings = (options.warnings || []).map((w) =>
        '<p class="notes-warning">⚠️ ' + escapeHtml(w) + '</p>'
      );

      return [
        '<!DOCTYPE html>',
        '<html lang="zh-CN">',
        '<head>',
        '<meta charset="utf-8">',
        '<meta name="viewport" content="width=device-width, initial-scale=1">',
        '<title>微信读书 · 笔记合集</title>',
        '<style>',
        HTML_STYLE,
        '</style>',
        '</head>',
        '<body>',
        '<div class="wrap">',
        options.frontMatter !== false
          ? '<header><h1 class="book-title">微信读书 · 笔记合集</h1><p class="book-meta">导出自微信读书 · ' +
              escapeHtml(now) + ' · ' + escapeHtml(summary) + '</p></header>'
          : '',
        ...warnings,
        ...sections,
        '</div>',
        '</body>',
        '</html>',
        '',
      ].filter(Boolean).join('\n');
    }

    if (format === 'txt') {
      const parts = [];
      if (options.frontMatter !== false) {
        parts.push(['微信读书 · 笔记合集', '导出自微信读书 · ' + now, summary, '='.repeat(24)].join('\n'));
      }
      for (const warning of options.warnings || []) parts.push('⚠️ ' + warning);
      for (const book of books) {
        const block = ['', '【' + (book.title || '未知书名') + '】'];
        if (book.author) block.push('作者：' + book.author);
        block.push(renderNotesBody(book.notes, 'txt', 3));
        parts.push(block.join('\n'));
      }
      return parts.join('\n\n').replace(/\n{3,}/g, '\n\n').trim() + '\n';
    }

    const parts = [];
    if (options.frontMatter !== false) {
      parts.push('# 微信读书 · 笔记合集');
      parts.push('> 导出自微信读书 · ' + now + '\n> ' + summary);
      parts.push('---');
    }
    for (const warning of options.warnings || []) parts.push('> ⚠️ ' + warning);
    for (const book of books) {
      const block = ['## ' + (book.title || '未知书名')];
      if (book.author) block.push('> 作者：' + book.author);
      block.push(renderNotesBody(book.notes, 'md', 3));
      parts.push(block.join('\n\n'));
    }
    return parts.join('\n\n').replace(/\n{3,}/g, '\n\n').trim() + '\n';
  }

  /**
   * 单本书「笔记与标注」独立文档（与全文导出是两个不同功能、两个文件）。
   * @param {{
   *   format: 'md'|'html'|'txt',
   *   book: {title?: string, author?: string},
   *   notes: object,
   *   options?: {frontMatter?: boolean, now?: Date}
   * }} input
   */
  function buildNotesDocument(input) {
    const format = input.format || 'md';
    const book = input.book || {};
    const notes = input.notes || WRX.notesUtils.buildEmptyNotes('', book.title || '');
    const options = input.options || {};
    const now = formatDate(options.now || new Date());
    const includeFrontMatter = options.frontMatter !== false;
    const title = (book.title || '微信读书') + ' · 笔记与标注';
    const summary = notesSummary(notes);
    const warnings = notes.warnings || [];

    if (format === 'html') {
      const warningHtml = warnings.map((w) =>
        '<p class="notes-warning">⚠️ ' + escapeHtml(w) + '</p>'
      );
      return [
        '<!DOCTYPE html>',
        '<html lang="zh-CN">',
        '<head>',
        '<meta charset="utf-8">',
        '<meta name="viewport" content="width=device-width, initial-scale=1">',
        '<title>' + escapeHtml(title) + '</title>',
        '<style>',
        HTML_STYLE,
        '</style>',
        '</head>',
        '<body>',
        '<div class="wrap">',
        includeFrontMatter
          ? '<header><h1 class="book-title">' + escapeHtml(title) + '</h1>' +
            '<p class="book-meta">' +
            (book.author ? '作者：' + escapeHtml(book.author) + ' · ' : '') +
            '导出自微信读书 · ' + escapeHtml(now) + '</p></header>'
          : '',
        '<section class="notes" id="notes">',
        '<h2>笔记与标注</h2>',
        renderNotesBody(notes, 'html', 2),
        '</section>',
        ...warningHtml,
        '</div>',
        '</body>',
        '</html>',
        '',
      ].filter(Boolean).join('\n');
    }

    if (format === 'txt') {
      const parts = [];
      if (includeFrontMatter) {
        parts.push([title, book.author ? '作者：' + book.author : '', '导出自微信读书 · ' + now, summary, '='.repeat(24)].filter(Boolean).join('\n'));
      }
      for (const warning of warnings) parts.push('⚠️ ' + warning);
      parts.push(renderNotesBody(notes, 'txt', 2));
      return parts.join('\n\n').replace(/\n{3,}/g, '\n\n').trim() + '\n';
    }

    const parts = [];
    if (includeFrontMatter) {
      parts.push('# ' + title);
      parts.push(
        (book.author ? '> 作者：' + book.author + '\n' : '') +
        '> 导出自微信读书 · ' + now + '\n> ' + summary
      );
      parts.push('---');
    }
    for (const warning of warnings) parts.push('> ⚠️ ' + warning);
    parts.push(renderNotesBody(notes, 'md', 2));
    return parts.join('\n\n').replace(/\n{3,}/g, '\n\n').trim() + '\n';
  }

  function buildBook(input) {
    const format = input.format || 'md';
    const book = input.book || {};
    const options = input.options || {};
    const allChapters = input.chapters || [];
    const chapters = allChapters.filter((chapter) => {
      if (chapter.isVolume) return true;
      return !!(chapter.html || chapter.text);
    });

    const title = book.title || '微信读书导出';
    const author = book.author || '';
    const now = formatDate(options.now || new Date());
    const readable = allChapters.filter((chapter) => !chapter.isVolume);
    const failed = allChapters.filter((chapter) => chapter.status === 'failed').length;
    const warned = allChapters.filter((chapter) => chapter.warning).length;

    let stats = '共 ' + readable.length + ' 章';
    if (failed) stats += '，' + failed + ' 章导出失败';
    if (warned) stats += '，' + warned + ' 章内容可能不完整';

    const meta = {
      title: title,
      author: author,
      now: now,
      stats: stats,
      chapters: chapters,
      options: options,
    };

    if (format === 'html') {
      return buildHtml(meta);
    }
    if (format === 'txt') {
      return buildTxt(meta);
    }
    return buildMarkdown(meta);
  }

  function frontMatterLines(meta) {
    const lines = [];
    if (meta.author) lines.push('> 作者：' + meta.author);
    lines.push('> 导出自微信读书 · ' + meta.now);
    if (meta.stats) lines.push('> ' + meta.stats);
    return lines;
  }

  function buildMarkdown(meta) {
    const parts = [];
    const options = meta.options || {};

    if (options.frontMatter !== false) {
      parts.push('# ' + meta.title);
      parts.push(frontMatterLines(meta).join('\n'));
      parts.push('---');
    }

    for (const chapter of meta.chapters) {
      if (chapter.isVolume) {
        parts.push('## ' + chapter.title);
        continue;
      }
      const heading = chapterHeading(chapter) + ' ' + chapter.title;
      let body = '';
      if (chapter.html) {
        body = htmlToMarkdown(chapter.html);
      } else if (chapter.text) {
        body = String(chapter.text).trim();
      }
      parts.push(heading);
      if (body) parts.push(body);
    }

    return parts.join('\n\n').replace(/\n{3,}/g, '\n\n').trim() + '\n';
  }

  function buildTxt(meta) {
    const parts = [];
    const options = meta.options || {};

    if (options.frontMatter !== false) {
      const header = [meta.title];
      if (meta.author) header.push('作者：' + meta.author);
      header.push('导出自微信读书 · ' + meta.now);
      parts.push(header.join('\n'));
      parts.push('='.repeat(24));
    }

    for (const chapter of meta.chapters) {
      if (chapter.isVolume) {
        parts.push(chapter.title);
        continue;
      }
      let body = '';
      if (chapter.text) {
        body = String(chapter.text).replace(/\r\n?/g, '\n').trim();
      } else if (chapter.html) {
        body = htmlToPlainText(chapter.html);
      }
      parts.push('【' + chapter.title + '】');
      if (body) parts.push(body);
    }

    return parts.join('\n\n').replace(/\n{3,}/g, '\n\n').trim() + '\n';
  }

  function buildHtml(meta) {
    const options = meta.options || {};
    const includeFrontMatter = options.frontMatter !== false;
    const includeToc = options.toc !== false && meta.chapters.length > 1;

    const contentChapters = meta.chapters.filter((c) => !c.isVolume);
    const tocHtml = includeToc
      ? [
          '<nav class="toc">',
          '<h2>目录</h2>',
          '<ol>',
          ...contentChapters.map(
            (chapter, index) =>
              '<li><a href="#ch-' + (index + 1) + '">' + escapeHtml(chapter.title) + '</a></li>'
          ),
          '</ol>',
          '</nav>',
        ].join('\n')
      : '';

    const headerHtml = includeFrontMatter
      ? [
          '<header>',
          '<h1 class="book-title">' + escapeHtml(meta.title) + '</h1>',
          '<p class="book-meta">' +
            (meta.author ? '作者：' + escapeHtml(meta.author) + ' · ' : '') +
            '导出自微信读书 · ' +
            escapeHtml(meta.now) +
            (meta.stats ? ' · ' + escapeHtml(meta.stats) : '') +
            '</p>',
          '</header>',
        ].join('\n')
      : '';

    let chapterIndex = 0;
    const sections = [];
    for (const chapter of meta.chapters) {
      if (chapter.isVolume) {
        sections.push(
          '<h2 class="volume">' + escapeHtml(chapter.title) + '</h2>'
        );
        continue;
      }
      chapterIndex += 1;
      const body = chapter.html || textToHtml(chapter.text || '');
      sections.push(
        [
          '<section class="chapter" id="ch-' + chapterIndex + '">',
          '<h2>' + escapeHtml(chapter.title) + '</h2>',
          body,
          '</section>',
        ].join('\n')
      );
    }

    return [
      '<!DOCTYPE html>',
      '<html lang="zh-CN">',
      '<head>',
      '<meta charset="utf-8">',
      '<meta name="viewport" content="width=device-width, initial-scale=1">',
      '<title>' + escapeHtml(meta.title) + '</title>',
      '<style>',
      HTML_STYLE,
      '</style>',
      '</head>',
      '<body>',
      '<div class="wrap">',
      headerHtml,
      tocHtml,
      ...sections,
      '</div>',
      '</body>',
      '</html>',
      '',
    ].join('\n');
  }

  /** 文件名清洗。 */
  function sanitizeFileName(name, fallback) {
    const cleaned = String(name || '')
      .replace(/[\\/:*?"<>|\u0000-\u001f]/g, ' ')
      .replace(/\s+/g, ' ')
      .replace(/^[.\s]+|[.\s]+$/g, '')
      .slice(0, 120)
      .trim();
    return cleaned || fallback || '微信读书导出';
  }

  /** 统计中文字符数（用于「是否完整」的判断）。 */
  function countChars(text) {
    return String(text || '').replace(/\s+/g, '').length;
  }

  WRX.formats = {
    escapeHtml,
    extractBodyHtml,
    textToHtml,
    htmlToMarkdown,
    htmlToPlainText,
    buildBook,
    buildNotesDocument,
    buildNotesSection,
    buildShelfNotes,
    renderNotesBody,
    sanitizeFileName,
    countChars,
    formatDate,
  };
})(typeof globalThis !== 'undefined' ? globalThis : window);
