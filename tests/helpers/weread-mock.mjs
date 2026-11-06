/**
 * 微信读书接口的本地模拟实现，用于端到端测试。
 *
 * 这里的 `_e` 编码、签名、分片编码都是按公开的 reference 实现*独立*重写的一份，
 * 不复用扩展里的代码，避免"自己验证自己"。
 */
import { createHash } from 'node:crypto';

const HEX = '0123456789abcdef';

export function md5Hex(value) {
  return createHash('md5').update(Buffer.from(String(value), 'utf8')).digest('hex');
}

/** 参考实现：_e 编码。 */
export function encodeRef(value) {
  const s = String(value);
  const h = md5Hex(s);
  let result = h.slice(0, 3);
  let chunks;
  let typeFlag;
  if (/^\d+$/.test(s)) {
    chunks = [];
    for (let i = 0; i < s.length; i += 9) {
      chunks.push(parseInt(s.slice(i, i + 9), 10).toString(16));
    }
    typeFlag = '3';
  } else {
    chunks = [Array.from(s).map((c) => c.codePointAt(0).toString(16)).join('')];
    typeFlag = '4';
  }
  result += typeFlag;
  result += '2' + h.slice(-2);
  chunks.forEach((chunk, idx) => {
    let lenHex = chunk.length.toString(16);
    if (lenHex.length === 1) lenHex = '0' + lenHex;
    result += lenHex + chunk;
    if (idx < chunks.length - 1) result += 'g';
  });
  if (result.length < 20) result += h.slice(0, 20 - result.length);
  result += md5Hex(result).slice(0, 3);
  return result;
}

function jsString(value) {
  if (value === true) return 'true';
  if (value === false) return 'false';
  if (value === null || value === undefined) return 'null';
  return String(value);
}

/** 参考实现：签名。 */
export function signRef(params) {
  const query = Object.keys(params)
    .sort()
    .map((key) => key + '=' + encodeURIComponent(jsString(params[key])))
    .join('&');

  let a = 0x15051505;
  let b = a;
  const length = query.length;
  let i = length - 1;
  while (i > 0) {
    a = (a ^ (query.charCodeAt(i) << ((length - i) % 30))) & 0x7fffffff;
    b = (b ^ (query.charCodeAt(i - 1) << (i % 30))) & 0x7fffffff;
    i -= 2;
  }
  return (a + b).toString(16);
}

/** 参考实现：交换位置。 */
export function swapPositionsRef(encoded) {
  const length = encoded.length;
  if (length < 4) return [];
  if (length < 11) return [0, 2];

  const n = Math.min(4, Math.ceil(length / 10));
  let tmp = '';
  for (let i = length - 1; i >= length - n; i--) {
    tmp += parseInt(encoded.charCodeAt(i).toString(2), 4).toString();
  }

  const arr = [];
  const m = length - n - 2;
  const step = String(m).length;
  let i = 0;
  while (arr.length < 10 && i + step < tmp.length) {
    arr.push(parseInt(tmp.slice(i, i + step), 10) % m);
    arr.push(parseInt(tmp.slice(i + 1, i + 1 + step), 10) % m);
    i += step;
  }
  return arr;
}

/** 参考实现：把文本编码成带 MD5 前缀的分片（升序交换，是解码器的逆运算）。 */
export function encodeShards(text, count) {
  const pieces = Math.max(1, count || 3);
  const encoded = Buffer.from(String(text), 'utf8')
    .toString('base64url')
    .replace(/=+$/, '');

  const chars = Array.from(encoded);
  const positions = swapPositionsRef(encoded);
  for (let i = 0; i < positions.length; i += 2) {
    for (const k of [0, 1]) {
      const left = positions[i] + k;
      const right = positions[i + 1] + k;
      const tmp = chars[left];
      chars[left] = chars[right];
      chars[right] = tmp;
    }
  }

  const body = '0' + chars.join('');
  const size = Math.max(1, Math.ceil(body.length / pieces));
  const parts = [];
  for (let i = 0; i < body.length; i += size) parts.push(body.slice(i, i + size));
  return parts.map((part) => md5Hex(part).toUpperCase() + part);
}

export function makeEpubChapterHtml(title, paragraphs) {
  return (
    '<html xmlns="http://www.w3.org/1999/xhtml"><head><title>' +
    title +
    '</title></head><body><h1 class="title">' +
    title +
    '</h1>\n' +
    paragraphs.map((p) => '<p>' + p + '</p>').join('\n') +
    '</body></html>'
  );
}

/**
 * 构造一个微信读书接口模拟器。
 * @param {{
 *   book: {bookId: string, title: string, author: string, format?: 'epub'|'txt',
 *          chapters: Array<{uid: number, title: string, wordCount: number, text: string, html?: string}>},
 *   pagePsvts?: string,
 *   freshPsvts?: string,
 *   truncateChapter?: number
 * }} options
 */
export function createMockWeread(options) {
  const book = options.book;
  // 服务端接受的 psvts：显式给出 freshPsvts 时用它（页面上的是过期值），否则与页面一致。
  const acceptedPsvts = options.freshPsvts || options.pagePsvts || 'pspage0001';
  const state = {
    psvts: acceptedPsvts,
    freshPsvts: options.freshPsvts || acceptedPsvts,
    requests: [],
    readerRequests: 0,
  };

  const bookFormat = book.format || 'epub';
  const truncateUid = options.truncateChapter;

  function chapterByEncoded(value) {
    return book.chapters.find((chapter) => encodeRef(chapter.uid) === value) || null;
  }

  function validate(body) {
    if (!body || typeof body !== 'object') return 'invalid';
    if (body.sc !== 1) return 'preview';
    if (body.prevChapter !== false) return 'invalid';
    if (body.b !== encodeRef(book.bookId)) return 'invalid';
    if (body.pc !== encodeRef(String(body.ct))) return 'invalid';

    const copy = Object.assign({}, body);
    delete copy.s;
    if (body.s !== signRef(copy)) return 'invalid';
    if (body.ps !== state.psvts) return 'stale';
    if (!chapterByEncoded(body.c)) return 'invalid';
    return null;
  }

  function chapterBody(chapter) {
    if (bookFormat === 'txt') return chapter.text;
    return chapter.html || makeEpubChapterHtml(chapter.title, [chapter.text]);
  }

  function truncated(text) {
    const cut = Math.max(10, Math.floor(text.length * 0.35));
    return text.slice(0, cut) + '……（试读）';
  }

  /**
   * 处理一个接口请求，返回 { status, contentType, body }。
   * @param {{path: string, method?: string, body?: object|null}} request
   */
  async function handle(request) {
    const path = request.path;
    const method = request.method || 'GET';
    const body = request.body === undefined ? null : request.body;
    state.requests.push({ path, method, body });

    if (path === '/web/book/chapterInfos') {
      return okJson({
        data: [
          {
            bookId: book.bookId,
            book: {
              bookId: book.bookId,
              title: book.title,
              author: book.author,
              format: bookFormat,
            },
            updated: book.chapters.map((chapter) => ({
              chapterUid: chapter.uid,
              chapterIdx: chapter.uid,
              title: chapter.title,
              wordCount: chapter.wordCount,
              level: 2,
            })),
          },
        ],
      });
    }

    if (path === '/web/book/publicchapterInfos') {
      return okJson({ data: [] });
    }

    if (path.startsWith('/web/reader/')) {
      state.readerRequests += 1;
      const fresh = state.freshPsvts || state.psvts;
      const initialState = {
        reader: {
          bookInfo: {
            bookId: book.bookId,
            title: book.title,
            author: book.author,
            format: bookFormat,
          },
          psvts: fresh,
          pclts: 'pclts01',
          token: 'tokentoken01',
          currentChapter: { chapterUid: book.chapters[0].uid, chapterIdx: 1 },
          progress: { book: { chapterUid: book.chapters[0].uid } },
        },
      };
      return okHtml(
        '<!doctype html><html><head><meta charset="utf-8">' +
          '<title>' + book.title + ' - 微信读书</title>' +
          '<script>window.__INITIAL_STATE__ = ' +
          JSON.stringify(initialState) +
          '; (function(){})()</script></head><body><div id="page"></div></body></html>'
      );
    }

    if (path === '/web/book/getProgress') {
      return okJson({
        book: { bookId: book.bookId, chapterUid: book.chapters[0].uid, chapterIdx: 1 },
      });
    }

    if (path === '/web/login/renewal') {
      return jsonResponse({ succ: 1 });
    }

    const endpointMatch = /^\/web\/book\/chapter\/([et]_[0-3])$/.exec(path);
    if (endpointMatch) {
      const endpoint = endpointMatch[1];
      const problem = validate(body);
      if (problem === 'preview') {
        const chapter = chapterByEncoded(body.c);
        const text = chapter ? truncated(chapterBody(chapter)) : '';
        return okText(encodeShards(text || ' ', 3)[0] || '{}');
      }
      if (problem) return okText('{}');

      const chapter = chapterByEncoded(body.c);

      if (bookFormat === 'txt') {
        if (endpoint.startsWith('e_')) {
          // 参考文档：TXT 书籍的 e_* 端点返回目录型 JSON。
          return okText(
            JSON.stringify({ bookId: book.bookId, chapterUid: chapter.uid, format: 'txt' })
          );
        }
        const index = Number(endpoint.slice(2));
        const parts = encodeShards(chapterBody(chapter), 2);
        return okText(parts[index] || '{}');
      }

      if (endpoint.startsWith('t_')) return okText('{}');
      if (endpoint === 'e_2') return okText('{}');

      const index = { e_0: 0, e_1: 1, e_3: 2 }[endpoint];
      let text = chapterBody(chapter);
      if (truncateUid && Number(chapter.uid) === Number(truncateUid)) {
        text = truncated(text);
      }
      const parts = encodeShards(text, 3);
      return okText(parts[index] || '{}');
    }

    return { status: 404, contentType: 'text/plain; charset=utf-8', body: '{}' };
  }

  /** 把 handle 包装成 fetch 兼容函数（jsdom 测试用）。 */
  async function fetchImpl(input, init) {
    const url = new URL(String(input));
    let body = null;
    if (init && init.body) {
      try {
        body = JSON.parse(init.body);
      } catch (error) {
        body = null;
      }
    }
    const result = await handle({
      path: url.pathname,
      method: (init && init.method) || 'GET',
      body: body,
    });
    return new Response(result.body, {
      status: result.status,
      headers: { 'content-type': result.contentType },
    });
  }

  return { fetch: fetchImpl, handle, state, book, bookFormat };
}

function okJson(payload) {
  return {
    status: 200,
    contentType: 'application/json; charset=utf-8',
    body: JSON.stringify(payload),
  };
}

function okHtml(payload) {
  return { status: 200, contentType: 'text/html; charset=utf-8', body: payload };
}

function okText(payload) {
  return { status: 200, contentType: 'text/plain; charset=utf-8', body: payload };
}

export { HEX };
