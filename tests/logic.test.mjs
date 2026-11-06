import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

import { loadLibs, loadVectors } from './helpers/load-libs.mjs';
import { encodeRef, signRef, encodeShards } from './helpers/weread-mock.mjs';

const WRX = loadLibs();
const vectors = loadVectors();

const md5 = (value) => crypto.createHash('md5').update(Buffer.from(value, 'utf8')).digest('hex');

// ---------------------------------------------------------------------- MD5

test('md5Hex 与 Node crypto 完全一致（ASCII / 中文 / emoji / 边界长度）', () => {
  const samples = [
    '',
    'a',
    'abc',
    '43208843',
    'x'.repeat(55),
    'x'.repeat(56),
    'x'.repeat(64),
    'x'.repeat(65),
    '中文测试',
    '窗外的风穿过树梢，带来远处山谷的回声。',
    '🌿emoji 与 surrogate pair 🌸',
  ];
  for (const sample of samples) {
    assert.equal(WRX.md5Hex(sample), md5(sample), 'input=' + JSON.stringify(sample));
  }
});

test('md5 Hex 输出为 32 位小写十六进制', () => {
  assert.match(WRX.md5Hex('微信读书'), /^[0-9a-f]{32}$/);
});

// ---------------------------------------------------------------------- _e

test('_e 编码与官方测试向量一致', () => {
  for (const item of vectors.encode) {
    assert.equal(WRX.wereadEncode(item.input), item.expected, 'input=' + item.input);
  }
});

test('_e 编码与独立参考实现一致（随机输入）', () => {
  const samples = ['1', '9', '999999999', '1234567890', '123456789012345', '26211970', 'abcdefg', 'MP_WXS_1'];
  for (const sample of samples) {
    assert.equal(WRX.wereadEncode(sample), encodeRef(sample), 'input=' + sample);
  }
});

// ---------------------------------------------------------------------- 签名

test('章节请求签名与 reference 实现一致（golden 向量）', () => {
  for (const item of vectors.sign) {
    const expected = item.expected;
    const params = {
      b: expected.b,
      c: expected.c,
      r: expected.r,
      ct: expected.ct,
      ps: expected.ps,
      pc: expected.pc,
      sc: expected.sc,
      prevChapter: expected.prevChapter,
      st: expected.st,
    };
    const signed = WRX.signParams(params);
    assert.equal(signed.s, expected.s, 'bookId=' + item.bookId);
    assert.deepEqual(signed, expected);
  }
});

test('buildContentParams 生成完整、可自校验的参数（sc=1 修复）', () => {
  const psvts = 'psdeadbeef';
  const now = 1765000123;
  const params = WRX.buildContentParams({
    bookId: '43208843',
    chapterUid: 36,
    psvts,
    now,
  });

  assert.equal(params.sc, 1, 'sc 必须是 1，否则服务端只返回试读');
  assert.equal(params.prevChapter, false, 'prevChapter 必须是布尔 false');
  assert.equal(params.st, 0);
  assert.equal(params.b, WRX.wereadEncode('43208843'));
  assert.equal(params.c, WRX.wereadEncode('36'));
  assert.equal(params.ct, String(now));
  assert.equal(params.pc, WRX.wereadEncode(now));
  assert.equal(params.ps, psvts);

  const unsigned = Object.assign({}, params);
  delete unsigned.s;
  assert.equal(params.s, signRef(unsigned), '签名必须能被独立实现验证');
});

test('buildContentParams：pc 与 psvts 相同时顺延 ct（避免返回空内容）', () => {
  const now = 1765000123;
  const psvts = WRX.wereadEncode(now);
  const params = WRX.buildContentParams({ bookId: '1', chapterUid: '2', psvts, now });

  assert.notEqual(params.pc, params.ps);
  assert.equal(params.ct, String(now + 1));
  assert.equal(params.pc, WRX.wereadEncode(now + 1));
});

test('buildContentParams：缺少 psvts 时抛出可识别的 state 错误', () => {
  assert.throws(
    () => WRX.buildContentParams({ bookId: '1', chapterUid: '2', psvts: '' }),
    (error) => error.name === 'WeReadError' && error.code === WRX.ErrorCode.STATE
  );
});

// ---------------------------------------------------------------------- 解码

test('decodeShards 能还原 reference 编码器生成的正文（golden 向量）', () => {
  for (const item of vectors.shards) {
    assert.equal(WRX.decodeShards(item.shards), item.expected);
  }
});

test('decodeShards 与独立编码器逐字节一致（含 emoji / 中英混排 / 长文本）', () => {
  const samples = [
    '你好，世界',
    '<p>窗外的风穿过树梢 🌿，带来远处山谷的回声。</p>',
    'a'.repeat(3000),
    '<html><body>' + '<p>长文本测试。</p>'.repeat(500) + '</body></html>',
  ];
  for (const sample of samples) {
    const shards = encodeShards(sample, 3);
    assert.equal(WRX.decodeShards(shards), sample);
  }
});

test('verifyShard 拒绝空响应、登录失效与 MD5 不匹配', () => {
  assert.throws(
    () => WRX.decodeShards(['{}']),
    (error) => error.code === WRX.ErrorCode.EMPTY
  );

  assert.throws(
    () => WRX.decodeShards([JSON.stringify({ errCode: -2012, errMsg: '登录超时' })]),
    (error) => error.code === WRX.ErrorCode.AUTH
  );

  const shards = encodeShards('<p>正文</p>', 1);
  const tampered = shards[0].slice(0, 40) + (shards[0][40] === 'A' ? 'B' : 'A') + shards[0].slice(41);
  assert.throws(
    () => WRX.decodeShards([tampered]),
    (error) => error.code === WRX.ErrorCode.CORRUPT
  );
});

test('verifyShard 兼容首尾空白（不同 CDN 的响应差异）', () => {
  const shards = encodeShards('<p>正文</p>', 1);
  assert.equal(WRX.decodeShards([shards[0] + '\n']), '<p>正文</p>');
});

test('UTF-8 手工解码覆盖 1~4 字节序列', () => {
  const enc = (str) => {
    const bytes = [];
    for (const ch of str) {
      const cp = ch.codePointAt(0);
      if (cp < 0x80) bytes.push(cp);
      else if (cp < 0x800) bytes.push(0xc0 | (cp >> 6), 0x80 | (cp & 0x3f));
      else if (cp < 0x10000) bytes.push(0xe0 | (cp >> 12), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f));
      else
        bytes.push(
          0xf0 | (cp >> 18),
          0x80 | ((cp >> 12) & 0x3f),
          0x80 | ((cp >> 6) & 0x3f),
          0x80 | (cp & 0x3f)
        );
    }
    return String.fromCharCode(...bytes);
  };

  for (const sample of ['abc', '中文', '🌿🌿', '混合 ascii 中文 🌸 end']) {
    assert.equal(WRX.utf8FromBinaryString(enc(sample)), sample);
  }
});

// ---------------------------------------------------------------------- 页面状态

test('解析 __INITIAL_STATE__（含嵌套花括号、字符串内的花括号、尾随 IIFE）', () => {
  const js =
    'window.__INITIAL_STATE__ = {"reader":{"bookInfo":{"bookId":"43208843","title":"书 {名}","author":"作者"},' +
    '"psvts":"ps1234","pclts":"pc5678","token":"tok","currentChapter":{"chapterUid":4}},"other":{"x":1}}; (function(){ var a = 1; })();';
  const state = WRX.readerState.extractFromText(js);

  assert.equal(state.bookId, '43208843');
  assert.equal(state.title, '书 {名}');
  assert.equal(state.author, '作者');
  assert.equal(state.psvts, 'ps1234');
  assert.equal(state.pclts, 'pc5678');
  assert.equal(state.currentChapter.chapterUid, 4);
});

test('页面状态缺失时用正则兜底提取 psvts / bookId', () => {
  const html =
    '<script>var cfg = {"reader":{"psvts":"psab12","pclts":"pccd34"}}; var meta = {"bookInfo":{"bookId":"900001"}};</script>';
  const state = WRX.readerState.extractFromText(html);
  assert.equal(state.psvts, 'psab12');
  assert.equal(state.pclts, 'pccd34');
  assert.equal(state.bookId, '900001');
});

test('解析阅读器路径与生成阅读器地址', () => {
  const parsed = WRX.readerState.parseReaderPath('/web/reader/c9c321c07293508bc9c79dfk07e323f027707e1cd7dc674');
  assert.equal(parsed.bookHash, 'c9c321c07293508bc9c79df');
  assert.equal(parsed.chapterHash, '07e323f027707e1cd7dc674');

  const onlyBook = WRX.readerState.parseReaderPath('/web/reader/c9c321c07293508bc9c79df');
  assert.equal(onlyBook.bookHash, 'c9c321c07293508bc9c79df');
  assert.equal(onlyBook.chapterHash, '');

  assert.equal(
    WRX.readerState.readerUrl('abc', 'def'),
    'https://weread.qq.com/web/reader/abckdef'
  );
});

// ---------------------------------------------------------------------- 目录筛选

test('selectChapters 过滤封面/目录，保留卷标题', () => {
  const chapters = [
    { uid: 0, title: '封面', wordCount: 0, level: 1, idx: 0 },
    { uid: 1, title: '目录', wordCount: 0, level: 1, idx: 1 },
    { uid: 2, title: '第一卷 起风', wordCount: 0, level: 1, idx: 2 },
    { uid: 3, title: '第一章', wordCount: 1200, level: 2, idx: 3 },
    { uid: 4, title: '第二章', wordCount: 0, level: 2, idx: 4 },
  ];

  const selected = WRX.selectChapters(chapters);
  assert.deepEqual(
    selected.map((c) => c.title),
    ['第一卷 起风', '第一章', '第二章']
  );
  assert.equal(selected[0].isVolume, true);
  assert.equal(selected[1].isVolume, false);
  assert.equal(selected[2].isVolume, true, 'wordCount=0 的章节作为标题保留，避免内容静默丢失');

  // 部分书籍目录不带 wordCount：不能因此把正文全丢掉
  const unknown = WRX.selectChapters([
    { uid: 1, title: '第一章', wordCount: null, level: 2, idx: 1 },
    { uid: 2, title: '第二章', level: 2, idx: 2 },
  ]);
  assert.equal(unknown.length, 2);
  assert.equal(unknown[0].isVolume, false);
  assert.equal(unknown[1].isVolume, false);
});

// ---------------------------------------------------------------------- 完整性校验

test('isTruncated 能识别试读片段（远短于目录字数）', () => {
  const exporter = new WRX.BookExporter({ delayMs: 0 }, { minRatio: 0.55 });

  assert.equal(exporter.isTruncated({ wordCount: 1000 }, 900), false);
  assert.equal(exporter.isTruncated({ wordCount: 1000 }, 549), true);
  assert.equal(exporter.isTruncated({ wordCount: 1000 }, 551), false);
  assert.equal(exporter.isTruncated({ wordCount: 30 }, 5), false, '极短章节不做判断');
  assert.equal(exporter.isTruncated({ wordCount: 0 }, 0), false);
});

// ---------------------------------------------------------------------- 导出组装

test('buildBook：Markdown 结构包含标题、章节与统计', () => {
  const content = WRX.formats.buildBook({
    format: 'md',
    book: { title: '测试之书', author: '测试作者' },
    chapters: [
      { uid: 1, title: '第一章', text: '第一段内容。\n第二段内容。' },
      { uid: 2, title: '第二章', text: '第二章内容。', warning: '内容可能不完整' },
      { uid: 3, title: '第三章', status: 'failed', error: '无权限' },
    ],
    options: { frontMatter: true },
  });

  assert.match(content, /^# 测试之书/);
  assert.match(content, /> 作者：测试作者/);
  assert.match(content, /共 3 章，1 章导出失败，1 章内容可能不完整/);
  assert.match(content, /## 第一章\n\n第一段内容/);
  assert.match(content, /## 第二章/);
  assert.doesNotMatch(content, /## 第三章/, '失败章节不应产出空标题');
});

test('buildBook：TXT 与 HTML 都能生成完整文档', () => {
  const chapters = [
    { uid: 1, title: '第一章', text: '第一段。' },
    { uid: 2, title: '第二章', text: '第二段。' },
  ];

  const txt = WRX.formats.buildBook({
    format: 'txt',
    book: { title: '测试之书', author: '作者' },
    chapters,
  });
  assert.match(txt, /测试之书/);
  assert.match(txt, /【第一章】\n\n第一段。/);
  assert.match(txt, /【第二章】\n\n第二段。/);

  const html = WRX.formats.buildBook({
    format: 'html',
    book: { title: '测试之书', author: '作者' },
    chapters,
  });
  assert.match(html, /<!DOCTYPE html>/);
  assert.match(html, /<title>测试之书<\/title>/);
  assert.match(html, /id="ch-1"[\s\S]*第一段。/);
  assert.match(html, /id="ch-2"[\s\S]*第二段。/);
});

test('sanitizeFileName 清理非法字符并限制长度', () => {
  assert.equal(WRX.formats.sanitizeFileName('a/b:c*?"<>|d'), 'a b c d');
  assert.equal(WRX.formats.sanitizeFileName('   '), '微信读书导出');
  assert.equal(WRX.formats.sanitizeFileName('x'.repeat(300)).length, 120);
});
