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
    exportButton: root.querySelector('[data-act="export-book"]'),
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

  const ctx = await setup({ book: book });
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
