import test from 'node:test';
import assert from 'node:assert/strict';

import { loadLibs } from './helpers/load-libs.mjs';
import { createMockWeread, makeEpubChapterHtml } from './helpers/weread-mock.mjs';

const WRX = loadLibs();

function makeBook() {
  const chapters = [1, 2].map((uid) => {
    const text = `这是第${uid}章的正文内容。`.repeat(12) + `【第${uid}章结尾】`;
    return {
      uid,
      title: `第${uid}章 测试`,
      wordCount: text.length,
      text,
      html: makeEpubChapterHtml(`第${uid}章 测试`, [text]),
    };
  });
  return { bookId: '900001', title: '笔记测试之书', author: '测试作者', format: 'epub', chapters };
}

function notesFixture() {
  return {
    highlights: [
      { chapterUid: 1, markText: '第一句划线原文', range: '10-20', createTime: 1765000000 },
      { chapterUid: 2, markText: '第二句划线原文', range: '30-40', createTime: 1765000100 },
    ],
    reviews: [
      { content: '对第一句的想法', range: '10-20', abstract: '第一句划线原文', chapterUid: 1 },
      { content: '一段独立的想法', abstract: '', chapterUid: 2, chapterName: '第2章 测试' },
      { content: '整本书的书评', abstract: '' },
      { content: '按摘要关联的想法', abstract: '第二句划线原文' },
    ],
    popular: [
      { chapterUid: 1, markText: '很多人划的一句', totalCount: 128 },
    ],
    notebooks: [
      { bookId: '900001', title: '笔记测试之书', author: '测试作者', noteCount: 2, reviewCount: 4 },
      { bookId: '900002', title: '第二本书', author: '作者二', noteCount: 1, reviewCount: 0 },
    ],
  };
}

/** 用 mock 包一个最小 client，只暴露 WereadNotes 需要的 request()。 */
function makeNotesClient(book, extra) {
  const mock = createMockWeread({ book, notes: notesFixture(), ...(extra || {}) });
  return {
    delayMs: 0,
    bookId: book.bookId,
    request: async (url) => {
      const parsed = new URL(String(url), 'http://127.0.0.1');
      const result = await mock.handle({ path: parsed.pathname + parsed.search, method: 'GET' });
      if (result.status >= 400) throw new Error('HTTP ' + result.status);
      return result.body;
    },
    mock,
  };
}

// ------------------------------------------------------------------ 抓取与归一化

test('collectBookNotes：抓取划线、想法、热门划线并按章节分组', async () => {
  const book = makeBook();
  const service = new WRX.WereadNotes(makeNotesClient(book));
  const notes = await service.collectBookNotes(book.bookId, {
    includePopular: true,
    catalogChapters: book.chapters.map((c) => ({ uid: c.uid, title: c.title, idx: c.uid })),
    bookTitle: book.title,
  });

  assert.equal(notes.ok, true);
  assert.equal(notes.stats.highlights, 2);
  assert.equal(notes.stats.thoughts, 4, '分页后应拿到全部 4 条想法');
  assert.equal(notes.stats.popular, 1);
  assert.equal(notes.warnings.length, 0);

  assert.equal(notes.groups.length, 3, '2 个章节组 + 1 个「未分章」组（整本书评）');
  assert.equal(notes.groups[0].highlights.length, 1);
  assert.equal(notes.groups[0].highlights[0].chapterTitle, '第1章 测试');
  assert.equal(notes.groups[0].popular.length, 1);
  assert.equal(notes.groups[2].title, '未分章');
});

test('collectBookNotes：想法通过 range 与 abstract 关联到划线，未关联的单独列出', async () => {
  const book = makeBook();
  const service = new WRX.WereadNotes(makeNotesClient(book));
  const notes = await service.collectBookNotes(book.bookId, { bookTitle: book.title });

  const attached = notes.highlights.reduce((n, h) => n + h.thoughts.length, 0);
  assert.equal(attached, 2, 'range 关联 1 条 + abstract 关联 1 条');
  assert.equal(notes.thoughts.length, 2, '其余 2 条独立想法单独列出');

  const first = notes.highlights.find((h) => h.text === '第一句划线原文');
  assert.equal(first.thoughts[0].content, '对第一句的想法');
  assert.match(first.time, /^\d{4}-\d{2}-\d{2}$/, '时间应格式化');
});

test('collectBookNotes：接口全不可用时记录明确 warning 与诊断，不静默当空笔记', async () => {
  const book = makeBook();
  const service = new WRX.WereadNotes(
    makeNotesClient(book, { notes: { disableNotes: true, disableReviews: true, disablePopular: true } })
  );
  const notes = await service.collectBookNotes(book.bookId, { includePopular: true });

  assert.equal(notes.stats.highlights, 0);
  assert.ok(notes.warnings.some((w) => /划线接口不可用/.test(w)));
  assert.ok(notes.warnings.some((w) => /未能读取个人想法\/点评/.test(w)), '提示应说明尝试过多个接口');
  assert.ok(!notes.warnings.some((w) => /个人想法接口不可用/.test(w)), '不应再出现旧的绝对化文案');
  assert.ok(notes.warnings.some((w) => /热门划线接口不可用/.test(w)));
  assert.ok(notes.diagnostics.some((d) => d.status === 'all-endpoints-failed'));
  assert.equal(notes.groups.length, 0);
});

test('真机复现：/web/review/list/mine 不可用时，web 域 /web/review/list 仍能拿到想法', async () => {
  const book = makeBook();
  const client = makeNotesClient(book, { notes: { ...notesFixture(), legacyMineFails: true } });
  const service = new WRX.WereadNotes(client);
  const notes = await service.collectBookNotes(book.bookId, { bookTitle: book.title });

  assert.equal(notes.stats.thoughts, 4, '4 条想法全部拿到');
  assert.equal(notes.warnings.length, 0, '不应再提示「个人想法接口不可用」');
  assert.equal(notes.diagnostics[0].status, 'ok');
  assert.match(notes.diagnostics[0].name, /web\/review\/list\[mine\]/);
  assert.ok(client.mock.state.requests.some((r) => r.path === '/web/review/list'),
    '第一个候选应是 web 域 /web/review/list');
});

test('想法回包形状兜底：flat 与 nested(data) 都能解析', async () => {
  for (const shape of ['flat', 'nested']) {
    const book = makeBook();
    const service = new WRX.WereadNotes(
      makeNotesClient(book, { notes: { ...notesFixture(), reviewShape: shape, legacyMineFails: true } })
    );
    const notes = await service.collectBookNotes(book.bookId, { bookTitle: book.title });
    assert.equal(notes.stats.thoughts, 4, shape + ' 应解析出 4 条想法');
  }
});

test('划线自带想法：review 接口全挂时也能导出想法，且不与接口想法重复', async () => {
  const book = makeBook();
  const fixture = notesFixture();
  const service = new WRX.WereadNotes(makeNotesClient(book, {
    notes: {
      ...fixture,
      disableReviews: true,
      inlineNotes: {
        '第一句划线原文': '划线时写下的想法',
        '第二句划线原文': '另一条划线想法',
      },
    },
  }));
  const notes = await service.collectBookNotes(book.bookId, { bookTitle: book.title });

  assert.equal(notes.stats.inlineThoughts, 2);
  assert.equal(notes.stats.thoughts, 2);
  assert.ok(notes.highlights[0].thoughts.some((t) => /划线时写下的想法/.test(t.content)));
  assert.ok(notes.warnings.some((w) => /已用划线自带的想法补足/.test(w)), '提示应为「已补足」而非「失败」');
  assert.ok(!notes.warnings.some((w) => /本次未导出想法/.test(w)));
});

test('collectBookNotes：热门划线为可选，默认不请求', async () => {
  const book = makeBook();
  const client = makeNotesClient(book);
  const service = new WRX.WereadNotes(client);
  const notes = await service.collectBookNotes(book.bookId, { includePopular: false });

  assert.equal(notes.stats.popular, 0);
  assert.equal(
    client.mock.state.requests.filter((r) => r.path.startsWith('/web/book/bestbookmarks')).length,
    0
  );
});

test('fetchNotebookBooks：游标分页与书架回退', async () => {
  const book = makeBook();
  const service = new WRX.WereadNotes(makeNotesClient(book));
  const listing = await service.fetchNotebookBooks();

  assert.equal(listing.source, 'notebooks');
  assert.equal(listing.books.length, 2);
  assert.equal(listing.books[0].title, '笔记测试之书');

  const fallback = new WRX.WereadNotes(makeNotesClient(book, { notes: {} }));
  const shelf = await fallback.fetchNotebookBooks();
  assert.equal(shelf.source, 'shelf');
  assert.equal(shelf.books.length, 1);
});

// ------------------------------------------------------------------ 文档组装

function sampleNotes() {
  return {
    bookId: '900001',
    title: '笔记测试之书',
    highlights: [
      { text: '第一句划线原文', chapterUid: 1, chapterTitle: '第1章', range: '10-20', time: '2026-01-02', thoughts: [
        { content: '对第一句的想法', time: '2026-01-03' },
      ] },
    ],
    thoughts: [{ content: '一段独立的想法', abstract: '另一段原文', chapterUid: 2, chapterTitle: '第2章' }],
    popular: [{ text: '很多人划的一句', count: 128, chapterUid: 1, chapterTitle: '第1章' }],
    groups: [
      { uid: 1, title: '第1章', idx: 1,
        highlights: [{ text: '第一句划线原文', time: '2026-01-02', thoughts: [{ content: '对第一句的想法', time: '2026-01-03' }] }],
        thoughts: [], popular: [{ text: '很多人划的一句', count: 128 }] },
      { uid: 2, title: '第2章', idx: 2,
        highlights: [], thoughts: [{ content: '一段独立的想法', abstract: '另一段原文' }], popular: [] },
    ],
    warnings: ['划线接口部分数据不可用'],
    stats: { highlights: 1, thoughts: 2, popular: 1, chapters: 2 },
  };
}

test('功能解耦：导出全文不含任何笔记内容', () => {
  const notes = sampleNotes();
  for (const format of ['md', 'html', 'txt']) {
    const content = WRX.formats.buildBook({
      format,
      book: { title: '笔记测试之书', author: '测试作者' },
      chapters: [{ uid: 1, title: '第1章', text: '正文内容。' }],
      notes, // 即使误传也会被忽略
    });
    assert.ok(content.includes('正文内容。'), format + ' 正文仍在');
    assert.equal(content.includes('笔记与标注'), false, format + ' 全文导出不含笔记小节');
    assert.equal(content.includes('第一句划线原文'), false, format + ' 全文导出不含划线');
    assert.equal(content.includes('对第一句的想法'), false, format + ' 全文导出不含想法');
  }
});

test('buildNotesDocument：单本书笔记独立文件，按章节分组', () => {
  const notes = sampleNotes();
  for (const format of ['md', 'html', 'txt']) {
    const content = WRX.formats.buildNotesDocument({
      format,
      book: { title: '笔记测试之书', author: '测试作者' },
      notes,
    });

    assert.ok(content.includes('笔记测试之书'), format + ' 含书名');
    assert.ok(content.includes('笔记与标注'), format + ' 含笔记标题');
    assert.ok(content.includes('第一句划线原文'), format + ' 含划线');
    assert.ok(content.includes('对第一句的想法'), format + ' 含关联想法');
    assert.ok(content.includes('一段独立的想法'), format + ' 含未关联想法');
    assert.ok(content.includes('很多人划的一句'), format + ' 含热门划线');
    assert.ok(content.includes('第1章') && content.includes('第2章'), format + ' 按章节分组');
    assert.ok(content.includes('划线接口部分数据不可用'), format + ' 显示 warning');
    assert.ok(!content.includes('正文内容。'), format + ' 笔记文件不含正文');
  }
});

test('buildShelfNotes：一个文件按书分组（一个书本一组）', () => {
  const notes = sampleNotes();
  for (const format of ['md', 'html', 'txt']) {
    const content = WRX.formats.buildShelfNotes({
      format,
      books: [
        { title: '第一本书', author: '作者甲', notes },
        { title: '第二本书', author: '作者乙', notes: WRX.notesUtils.buildEmptyNotes('2', '第二本书') },
      ],
      options: { warnings: ['书架回退提示'] },
    });

    assert.ok(content.includes('第一本书'), format + ' 第一本分组');
    assert.ok(content.includes('第二本书'), format + ' 第二本分组（无笔记也保留）');
    assert.ok(content.includes('第一句划线原文'), format + ' 含笔记内容');
    assert.ok(content.includes('共 2 本书'), format + ' 含汇总');
    assert.ok(content.includes('书架回退提示'), format + ' 含 warning');
  }
});

test('buildBook：不传 notes 时行为与旧版一致（无笔记小节）', () => {
  const content = WRX.formats.buildBook({
    format: 'md',
    book: { title: '无笔记之书' },
    chapters: [{ uid: 1, title: '第1章', text: '正文' }],
  });
  assert.equal(content.includes('笔记与标注'), false);
  assert.ok(content.startsWith('# 无笔记之书'));
});
