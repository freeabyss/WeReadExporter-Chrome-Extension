import test from 'node:test';
import assert from 'node:assert/strict';

import { JSDOM } from 'jsdom';

import { CONTENT_FILES, readFile } from './helpers/load-libs.mjs';
import {
  createMockWeread,
  encodeRef,
  makeEpubChapterHtml,
  signRef,
} from './helpers/weread-mock.mjs';

const SETTINGS_KEY = 'wrx.settings.v1';

// ------------------------------------------------------------------ 测试数据

function makeChapters(count, format) {
  const chapters = [];
  for (let i = 1; i <= count; i += 1) {
    const paragraphs = [];
    for (let p = 1; p <= 6; p += 1) {
      paragraphs.push(
        `这是第${i}章的第${p}段正文。我们沿着小路慢慢前行，记下沿途的灯光、溪水和陌生人的问候。` +
          `每一次翻页，都能看见新的文字（${i}-${p}）。`
      );
    }
    const text = paragraphs.join('');
    chapters.push({
      uid: i,
      title: `第${i}章 测试章节`,
      wordCount: text.length,
      text: `【本章开头-${i}】` + text + `【本章结尾-${i}】`,
      html: makeEpubChapterHtml(
        `第${i}章 测试章节`,
        [`【本章开头-${i}】`].concat(paragraphs).concat([`【本章结尾-${i}】`])
      ),
      format,
    });
  }
  return chapters;
}

function pageHtml(book, psvts) {
  const state = {
    reader: {
      bookInfo: {
        bookId: book.bookId,
        title: book.title,
        author: book.author,
        format: book.format || 'epub',
      },
      psvts: psvts,
      pclts: 'pclts01',
      token: 'tokentoken01',
      currentChapter: { chapterUid: book.chapters[0].uid, chapterIdx: 1 },
      progress: { book: { chapterUid: book.chapters[0].uid } },
    },
    shelf: { books: [] },
  };

  return `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8">
    <title>${book.title} - 微信读书</title>
    <script>window.__INITIAL_STATE__ = ${JSON.stringify(state)}; (function(){ var x = { a: 1 }; })();</script>
    <script type="application/ld+json">${JSON.stringify({
      '@context': 'https://schema.org',
      '@type': 'Book',
      name: book.title,
      author: { '@type': 'Person', name: book.author },
    })}</script>
  </head>
  <body><div id="app"></div></body>
</html>`;
}

async function waitFor(check, options) {
  const opts = options || {};
  const timeout = opts.timeout === undefined ? 10000 : opts.timeout;
  const interval = opts.interval === undefined ? 20 : opts.interval;
  const startedAt = Date.now();
  let lastError = null;

  while (Date.now() - startedAt < timeout) {
    try {
      const value = await check();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, interval));
  }

  throw new Error(
    '等待超时：' + (opts.label || 'condition') + (lastError ? '（' + lastError.message + '）' : '')
  );
}

async function readBlobText(blob) {
  if (blob && typeof blob.text === 'function') return await blob.text();
  throw new Error('Blob 不支持 text()');
}

/** 启动一个隔离的 jsdom 环境，并注入扩展的全部 content scripts。 */
async function setup(options) {
  const book = options.book;
  const pagePsvts = options.pagePsvts || 'pspage0001';
  const mock = createMockWeread({
    book: book,
    pagePsvts: pagePsvts,
    freshPsvts: options.freshPsvts,
    truncateChapter: options.truncateChapter,
    notes: options.notes,
  });

  const bookHash = encodeRef(book.bookId);
  const chapterHash = encodeRef(book.chapters[0].uid);
  const url = `https://weread.qq.com/web/reader/${bookHash}k${chapterHash}`;

  const dom = new JSDOM(pageHtml(book, pagePsvts), {
    url: url,
    runScripts: 'dangerously',
    pretendToBeVisual: true,
  });

  const { window } = dom;
  window.fetch = (input, init) => mock.fetch(input, init);

  window.__blobs = [];
  window.__downloads = [];
  window.__clipboard = '';

  window.URL.createObjectURL = (blob) => {
    window.__blobs.push(blob);
    return 'blob:mock-' + window.__blobs.length;
  };
  window.URL.revokeObjectURL = () => {};
  window.HTMLAnchorElement.prototype.click = function click() {
    window.__downloads.push({ filename: this.download, href: this.href });
  };
  Object.defineProperty(window.navigator, 'clipboard', {
    configurable: true,
    value: {
      writeText: async (text) => {
        window.__clipboard = text;
      },
    },
  });

  window.localStorage.setItem(
    SETTINGS_KEY,
    JSON.stringify({
      format: 'md',
      delayMs: 0,
      maxAttempts: 3,
      refreshEvery: 40,
      frontMatter: true,
      ...(options.settings || {}),
    })
  );

  for (const file of CONTENT_FILES) {
    const script = window.document.createElement('script');
    script.textContent = readFile(file);
    window.document.head.appendChild(script);
  }

  const host = window.document.getElementById('wrx-host');
  assert.ok(host, '扩展 UI 应该挂载到页面');
  const root = host.shadowRoot;
  assert.ok(root, 'UI 应该使用 Shadow DOM');

  const ui = {
    root: root,
    exportButton: root.querySelector('[data-act="export"]'),
    resultEl: root.querySelector('.result'),
    exportBox: root.querySelector('.chapter-box'),
    bookTitle: root.querySelector('.book-title'),
    bookSub: root.querySelector('.book-sub'),
    chapterList: root.querySelector('.chapter-list'),
  };

  return { dom: dom, window: window, mock: mock, ui: ui, bookHash: bookHash };
}

function click(window, element) {
  element.dispatchEvent(new window.MouseEvent('click', { bubbles: true, composed: true }));
}

async function bootAndWaitReady(ctx) {
  await waitFor(() => !ctx.ui.exportButton.disabled, {
    label: '导出按钮可用',
    timeout: 12000,
  });
}

function contentRequests(mock) {
  return mock.state.requests.filter(
    (request) => request.path.startsWith('/web/book/chapter/') && request.method === 'POST'
  );
}

function assertRequestParams(mock, expected) {
  const allowedPsvts = Array.isArray(expected.psvts) ? expected.psvts : [expected.psvts];
  const requests = contentRequests(mock);
  assert.ok(requests.length >= expected.minRequests, '请求数量不足：' + requests.length);

  for (const request of requests) {
    const body = request.body;
    assert.ok(body, '请求体应该存在');

    if (request.path.startsWith('/web/book/chapter/e_0') && body.sc !== 1) {
      continue; // 被 validate 判定为 preview 的情况不会发生在我们的客户端
    }

    assert.equal(body.sc, 1, 'sc 必须为 1，否则只能拿到试读：' + request.path);
    assert.equal(body.prevChapter, false, 'prevChapter 必须是布尔 false：' + request.path);
    assert.equal(body.pc, encodeRef(String(body.ct)), 'pc 必须是当前 ct 的 _e 编码');
    assert.ok(allowedPsvts.includes(body.ps), 'ps 必须来自阅读器状态，实际为 ' + body.ps);

    const unsigned = Object.assign({}, body);
    delete unsigned.s;
    assert.equal(body.s, signRef(unsigned), '请求签名必须可被独立实现验证');
  }
}

// ------------------------------------------------------------------ 测试

test('EPUB 书籍：一键导出全文（不再只拿到试读片段）', async (t) => {
  const book = {
    bookId: '43208843',
    title: '山谷来信',
    author: '测试作者',
    format: 'epub',
    chapters: makeChapters(3, 'epub'),
  };

  const ctx = await setup({ book: book, settings: ONLY_BOOK });
  t.after(() => ctx.dom.window.close());

  await bootAndWaitReady(ctx);

  // 书名、作者、章节数
  assert.match(ctx.ui.bookTitle.textContent, /山谷来信/);
  assert.match(ctx.ui.bookSub.textContent, /测试作者/);
  assert.match(ctx.ui.bookSub.textContent, /共 3 章/);
  assert.equal(ctx.ui.chapterList.querySelectorAll('li').length, 3);

  click(ctx.window, ctx.ui.exportButton);

  await waitFor(() => !ctx.ui.resultEl.hidden, { label: '出现导出结果', timeout: 20000 });

  assert.equal(ctx.window.__blobs.length, 1, '应该自动下载一个文件');
  assert.equal(ctx.window.__downloads[0].filename, '山谷来信.md');

  const content = await readBlobText(ctx.window.__blobs[0]);

  // 关键断言：每一章的开头与结尾都在，证明拿到的是整章而不是试读。
  for (const chapter of book.chapters) {
    assert.ok(content.includes(`【本章开头-${chapter.uid}】`), '缺少第' + chapter.uid + '章开头');
    assert.ok(content.includes(`【本章结尾-${chapter.uid}】`), '缺少第' + chapter.uid + '章结尾');
  }
  assert.ok(!content.includes('试读'), '导出内容不应包含试读标记');
  assert.match(content, /^# 山谷来信/);
  assert.match(content, /共 3 章/);

  assert.match(ctx.ui.resultEl.textContent, /成功 3 章/);

  assertRequestParams(ctx.mock, { psvts: 'pspage0001', minRequests: 9 });

  // 章节列表状态应全部变为成功
  const statuses = Array.from(ctx.ui.chapterList.querySelectorAll('li')).map((li) =>
    li.getAttribute('data-status')
  );
  assert.deepEqual(statuses, ['ok', 'ok', 'ok']);
});

test('TXT 书籍：自动探测格式并改用 t_0/t_1（原脚本会抓不到内容）', async (t) => {
  const book = {
    bookId: '900001',
    title: '网文测试',
    author: '作者乙',
    format: 'txt',
    chapters: makeChapters(2, 'txt'),
  };

  const ctx = await setup({ book: book });
  t.after(() => ctx.dom.window.close());

  await bootAndWaitReady(ctx);
  click(ctx.window, ctx.ui.exportButton);

  await waitFor(() => !ctx.ui.resultEl.hidden, { label: '出现导出结果', timeout: 20000 });

  const content = await readBlobText(ctx.window.__blobs[0]);
  for (const chapter of book.chapters) {
    assert.ok(content.includes(`【本章开头-${chapter.uid}】`));
    assert.ok(content.includes(`【本章结尾-${chapter.uid}】`));
  }

  const paths = contentRequests(ctx.mock).map((request) => request.path);
  assert.ok(paths.some((path) => path.endsWith('/t_0')), '应该请求 t_0');
  assert.ok(paths.some((path) => path.endsWith('/t_1')), '应该请求 t_1');
  assert.ok(!paths.some((path) => path.endsWith('/e_1') || path.endsWith('/e_3')), '不应请求 EPUB 分片');
});

test('psvts 过期时自动刷新阅读页状态并重试成功', async (t) => {
  const book = {
    bookId: '26211970',
    title: '会话测试',
    author: '作者丙',
    format: 'epub',
    chapters: makeChapters(2, 'epub'),
  };

  const ctx = await setup({
    book: book,
    pagePsvts: 'psstale0001',
    freshPsvts: 'psfresh0002',
  });
  t.after(() => ctx.dom.window.close());

  await bootAndWaitReady(ctx);
  click(ctx.window, ctx.ui.exportButton);

  await waitFor(() => !ctx.ui.resultEl.hidden, { label: '出现导出结果', timeout: 20000 });

  const content = await readBlobText(ctx.window.__blobs[0]);
  for (const chapter of book.chapters) {
    assert.ok(content.includes(`【本章结尾-${chapter.uid}】`));
  }

  assert.ok(ctx.mock.state.readerRequests >= 1, '应重新拉取阅读页以刷新 psvts');

  const usedPsvts = contentRequests(ctx.mock).map((request) => request.body.ps);
  assert.ok(usedPsvts.includes('psfresh0002'), '刷新后必须使用新的 psvts');
  assertRequestParams(ctx.mock, { psvts: ['psstale0001', 'psfresh0002'], minRequests: 6 });
});

test('服务端返回残缺正文时：重试后在结果里明确告警，而不是静默成功', async (t) => {
  const book = {
    bookId: '123456',
    title: '残缺测试',
    author: '作者丁',
    format: 'epub',
    chapters: makeChapters(3, 'epub'),
  };

  const ctx = await setup({ book: book, truncateChapter: 2 });
  t.after(() => ctx.dom.window.close());

  await bootAndWaitReady(ctx);
  click(ctx.window, ctx.ui.exportButton);

  await waitFor(() => !ctx.ui.resultEl.hidden, { label: '出现导出结果', timeout: 30000 });

  const content = await readBlobText(ctx.window.__blobs[0]);
  assert.ok(content.includes('【本章结尾-3】'), '其他章节应正常导出');
  assert.match(content, /1 章内容可能不完整/, '导出文档头部应写明告警');

  const rows = Array.from(ctx.ui.chapterList.querySelectorAll('li'));
  const statuses = rows.map((li) => li.getAttribute('data-status'));
  assert.ok(statuses.includes('warning'), '残缺章节应标记为 warning');

  assert.match(ctx.ui.resultEl.textContent, /导出完成/);
});

test('章节列表：加载过的章节可直接复制（剪贴板内容为完整章节）', async (t) => {
  const book = {
    bookId: '888888',
    title: '复制测试',
    author: '作者戊',
    format: 'epub',
    chapters: makeChapters(2, 'epub'),
  };

  const ctx = await setup({ book: book });
  t.after(() => ctx.dom.window.close());

  await bootAndWaitReady(ctx);

  const firstRow = ctx.ui.chapterList.querySelector('li');
  const copyButton = firstRow.querySelector('[data-act="copy"]');
  click(ctx.window, copyButton);

  await waitFor(() => ctx.window.__clipboard && ctx.window.__clipboard.length > 0, {
    label: '剪贴板写入',
    timeout: 15000,
  });

  assert.ok(ctx.window.__clipboard.includes('【本章开头-1】'), '复制内容应包含章节开头');
  assert.ok(ctx.window.__clipboard.includes('【本章结尾-1】'), '复制内容应包含章节结尾（不是试读）');
  assert.equal(ctx.window.__clipboard.includes('【本章开头-2】'), false, '只复制当前章节');
});


// ------------------------------------------------------------------ 笔记与标注（独立功能）

function notesFixture() {
  return {
    highlights: [
      { chapterUid: 1, markText: '第一章的划线原文', range: '10-20', createTime: 1765000000 },
      { chapterUid: 2, markText: '第二章的划线原文', range: '30-40', createTime: 1765000100 },
    ],
    reviews: [
      { content: '对第一章划线的想法', range: '10-20', abstract: '第一章的划线原文', chapterUid: 1 },
      { content: '独立的读书感想', chapterUid: 2 },
    ],
    popular: [{ chapterUid: 1, markText: '大家都划的一句', totalCount: 88 }],
    notebooks: [
      { bookId: '43208843', title: '山谷来信', author: '测试作者', noteCount: 2, reviewCount: 2 },
      { bookId: '900002', title: '第二本书', author: '作者二', noteCount: 1, reviewCount: 0 },
    ],
  };
}

/** 只导出全文 */
const ONLY_BOOK = { exportFullText: true, exportNotes: false, includePopular: false };
/** 只导出笔记 */
const ONLY_NOTES = { exportFullText: false, exportNotes: true, includePopular: false };

function makeNotesBook() {
  return {
    bookId: '43208843',
    title: '山谷来信',
    author: '测试作者',
    format: 'epub',
    chapters: makeChapters(2, 'epub'),
  };
}

test('功能解耦：只勾「全文」时不含笔记，且不会请求任何笔记接口', async (t) => {
  const ctx = await setup({
    book: makeNotesBook(),
    notes: notesFixture(),
    settings: ONLY_BOOK,
  });
  t.after(() => ctx.dom.window.close());

  await bootAndWaitReady(ctx);
  click(ctx.window, ctx.ui.exportButton);
  await waitFor(() => !ctx.ui.resultEl.hidden, { label: '出现导出结果', timeout: 25000 });

  assert.equal(ctx.window.__blobs.length, 1, '全文导出只产生一个文件');
  assert.equal(ctx.window.__downloads[0].filename, '山谷来信.md');

  const content = await readBlobText(ctx.window.__blobs[0]);
  assert.ok(content.includes('【本章结尾-2】'), '正文完整');
  assert.equal(content.includes('笔记与标注'), false, '全文导出不含笔记小节');
  assert.equal(content.includes('第一章的划线原文'), false, '全文导出不含划线');

  const paths = ctx.mock.state.requests.map((r) => r.path);
  assert.equal(paths.some((p) => p.startsWith('/web/book/bookmarklist')), false, '未请求划线接口');
  assert.equal(paths.some((p) => p.startsWith('/web/review/list')), false, '未请求想法接口');
  assert.equal(paths.some((p) => p.startsWith('/web/book/bestbookmarks')), false, '未请求热门划线');
});

test('只勾「笔记」：产生独立笔记文件，按章节分组，不抓正文', async (t) => {
  const ctx = await setup({
    book: makeNotesBook(),
    notes: notesFixture(),
    settings: ONLY_NOTES,
  });
  t.after(() => ctx.dom.window.close());

  await bootAndWaitReady(ctx);
  const notesToggle = ctx.ui.root.querySelector('#wrx-export-notes');
  assert.ok(notesToggle, '应有「笔记」选项');
  assert.equal(notesToggle.checked, true, '默认勾选笔记');
  assert.equal(ctx.ui.root.querySelector('#wrx-include-notes'), null, '不应再有「附带笔记」主开关');
  assert.ok(ctx.ui.exportButton, '应只有一个「导出」按钮');
  assert.equal(ctx.ui.root.querySelectorAll('[data-act="export"]').length, 1);

  click(ctx.window, ctx.ui.exportButton);
  await waitFor(() => !ctx.ui.resultEl.hidden, { label: '出现导出结果', timeout: 25000 });

  assert.equal(ctx.window.__blobs.length, 1, '只产生一个笔记文件');
  assert.equal(ctx.window.__downloads[0].filename, '山谷来信 - 笔记与标注.md');

  const content = await readBlobText(ctx.window.__blobs[0]);
  assert.ok(content.includes('笔记与标注'), '含笔记标题');
  assert.ok(content.includes('第一章的划线原文'), '含第一章划线');
  assert.ok(content.includes('第二章的划线原文'), '含第二章划线');
  assert.ok(content.includes('对第一章划线的想法'), '含关联想法');
  assert.ok(content.includes('独立的读书感想'), '含独立想法');
  assert.equal(content.includes('【本章开头-1】'), false, '笔记文件不含正文');
  assert.equal(content.includes('大家都划的一句'), false, '未勾选热门划线时不含');

  assert.match(ctx.ui.resultEl.textContent, /笔记：我的划线 2 条 · 我的想法 2 条/);

  const paths = ctx.mock.state.requests.map((r) => r.path);
  assert.ok(paths.some((p) => p.startsWith('/web/book/bookmarklist')), '请求划线接口');
  assert.ok(paths.some((p) => p.startsWith('/web/review/list')), '请求想法接口（web 域 /web/review/list）');
  assert.equal(paths.some((p) => p.startsWith('/web/book/chapter/e_')), false, '导出笔记不抓正文分片');
});

test('勾选「全文」+「笔记」：一次点击下载两个独立文件', async (t) => {
  const ctx = await setup({
    book: makeNotesBook(),
    notes: notesFixture(),
    settings: { exportFullText: true, exportNotes: true, includePopular: false },
  });
  t.after(() => ctx.dom.window.close());

  await bootAndWaitReady(ctx);
  assert.equal(ctx.ui.root.querySelector('#wrx-export-full').checked, true);
  assert.equal(ctx.ui.root.querySelector('#wrx-export-notes').checked, true);

  click(ctx.window, ctx.ui.exportButton);
  await waitFor(() => ctx.window.__blobs.length === 2, { label: '两个文件都下载', timeout: 30000 });

  assert.deepEqual(
    ctx.window.__downloads.map((d) => d.filename),
    ['山谷来信.md', '山谷来信 - 笔记与标注.md'],
    '全文与笔记各一个文件，顺序为全文在前'
  );

  const bookContent = await readBlobText(ctx.window.__blobs[0]);
  const notesContent = await readBlobText(ctx.window.__blobs[1]);
  assert.ok(bookContent.includes('【本章开头-1】') && !bookContent.includes('笔记与标注'));
  assert.ok(notesContent.includes('第一章的划线原文') && !notesContent.includes('【本章开头-1】'));
});

test('导出笔记：热门划线为可选开关，勾选后才加入笔记文件', async (t) => {
  const ctx = await setup({
    book: makeNotesBook(),
    notes: notesFixture(),
    settings: { exportFullText: false, exportNotes: true, includePopular: true },
  });
  t.after(() => ctx.dom.window.close());

  await bootAndWaitReady(ctx);
  assert.equal(ctx.ui.root.querySelector('#wrx-include-popular').checked, true);

  click(ctx.window, ctx.ui.exportButton);
  await waitFor(() => !ctx.ui.resultEl.hidden, { label: '出现导出结果', timeout: 25000 });

  const content = await readBlobText(ctx.window.__blobs[0]);
  assert.ok(content.includes('大家都划的一句'), '含热门划线');
  assert.ok(content.includes('88 人划线'), '含划线人数');
  assert.match(ctx.ui.resultEl.textContent, /热门划线 1 条/);
});

test('导出笔记：接口不可用时笔记文件明确提示，全文导出不受影响', async (t) => {
  const ctx = await setup({
    book: makeNotesBook(),
    notes: { disableNotes: true, disableReviews: true, disablePopular: true },
    settings: ONLY_NOTES,
  });
  t.after(() => ctx.dom.window.close());

  await bootAndWaitReady(ctx);

  click(ctx.window, ctx.ui.exportButton);
  await waitFor(() => !ctx.ui.resultEl.hidden, { label: '出现导出结果', timeout: 25000 });

  const notesContent = await readBlobText(ctx.window.__blobs[0]);
  assert.ok(notesContent.includes('划线接口不可用'), '笔记文件内明确提示划线失败');
  assert.ok(notesContent.includes('未能读取个人想法'), '笔记文件内提示想法接口不可用（已尝试多个接口）');
  assert.ok(!notesContent.includes('个人想法接口不可用，本次未导出想法'), '不再使用旧的绝对化文案');
  assert.match(ctx.ui.resultEl.textContent, /导出完成/);

  // 再勾上「全文」，确认正文不受笔记接口失败影响
  ctx.ui.root.querySelector('#wrx-export-full').click();
  click(ctx.window, ctx.ui.exportButton);
  await waitFor(() => ctx.window.__blobs.length >= 2, { label: '全文导出完成', timeout: 25000 });
  assert.equal(ctx.window.__downloads[1].filename, '山谷来信.md', '第二次导出包含全文文件');
  const bookContent = await readBlobText(ctx.window.__blobs[1]);
  assert.ok(bookContent.includes('【本章结尾-2】'), '正文仍完整导出');
  assert.equal(bookContent.includes('划线接口不可用'), false, '正文文件不受笔记接口影响');
});

test('笔记：全书架批量导出生成一个文件、按书分组', async (t) => {
  const ctx = await setup({ book: makeNotesBook(), notes: notesFixture() });
  t.after(() => ctx.dom.window.close());

  await bootAndWaitReady(ctx);
  const shelfButton = ctx.ui.root.querySelector('[data-act="export-shelf"]');
  assert.equal(shelfButton.disabled, false, '初始化后全书架按钮可用');

  click(ctx.window, shelfButton);
  await waitFor(() => !ctx.ui.resultEl.hidden, { label: '出现导出结果', timeout: 30000 });

  assert.equal(ctx.window.__blobs.length, 1, '全书架只生成一个文件');
  assert.equal(ctx.window.__downloads[0].filename, '微信读书 - 全书架笔记合集.md');

  const content = await readBlobText(ctx.window.__blobs[0]);
  assert.ok(content.includes('微信读书 · 笔记合集'), '含合集标题');
  assert.ok(content.includes('共 2 本书'), '含汇总');
  assert.ok(content.includes('山谷来信'), '第一本书分组');
  assert.ok(content.includes('第二本书'), '第二本书分组');
  assert.ok(content.includes('第一章的划线原文'), '含笔记内容');
});
