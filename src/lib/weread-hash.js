/**
 * 微信读书 Web 端签名算法。
 *
 * - `_e(value)`：书籍/章节 ID 与时间戳的编码（bookHash、chapterHash、b、c、pc）。
 * - `sign(params)`：对章节内容接口的请求参数做签名 `s`。
 *
 * 两段算法均按微信读书网页版行为实现，并已用公开的测试向量交叉验证：
 *   _e('43208843') === 'c9c321c07293508bc9c79df'
 *   _e('2')        === 'c81322c012c81e728d9d180'
 *   _e('119')      === '07e323f027707e1cd7dc674'
 */
(function (root) {
  'use strict';

  const WRX = (root.__WRX__ = root.__WRX__ || {});

  /**
   * 微信读书 `_e` 编码。
   * @param {string|number} value
   * @returns {string}
   */
  function wereadEncode(value) {
    const s = String(value);
    const h = WRX.md5Hex(s);

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
      chunks = [Array.from(s).map((ch) => ch.codePointAt(0).toString(16)).join('')];
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

    if (result.length < 20) {
      result += h.slice(0, 20 - result.length);
    }

    result += WRX.md5Hex(result).slice(0, 3);
    return result;
  }

  /** JS 对象值 → 签名字符串里的写法（true/false/null 用小写）。 */
  function jsString(value) {
    if (value === true) return 'true';
    if (value === false) return 'false';
    if (value === null || value === undefined) return 'null';
    return String(value);
  }

  /**
   * 按 key 字典序拼接 query（值做 encodeURIComponent，和页面自身一致）。
   * @param {Record<string, unknown>} params
   * @returns {string}
   */
  function sortedQuery(params) {
    return Object.keys(params)
      .sort()
      .map((key) => key + '=' + encodeURIComponent(jsString(params[key])))
      .join('&');
  }

  /**
   * 请求签名算法。
   * @param {string} query
   * @returns {string}
   */
  function wereadSign(query) {
    let a = 0x15051505;
    let b = a;
    const length = query.length;
    let i = length - 1;

    while (i > 0) {
      a = (a ^ (query.charCodeAt(i) << ((length - i) % 30))) & 0x7fffffff;
      b = (b ^ (query.charCodeAt(i - 1) << (i % 30))) & 0x7fffffff;
      i -= 2;
    }

    return (a + b).toString(16).toLowerCase();
  }

  /**
   * 给参数对象补上签名字段 `s`（返回新对象，顺序与 key 无关）。
   * @param {Record<string, unknown>} params
   * @returns {Record<string, unknown>}
   */
  function signParams(params) {
    const signed = Object.assign({}, params);
    signed.s = wereadSign(sortedQuery(params));
    return signed;
  }

  /** 当前章节内容接口的请求参数。 */
  function buildContentParams(options) {
    const opts = options || {};
    const bookId = String(opts.bookId);
    const chapterUid = String(opts.chapterUid);
    const psvts = String(opts.psvts || '');
    const now = typeof opts.now === 'number' ? opts.now : Math.floor(Date.now() / 1000);

    if (!psvts) {
      throw new WRX.WeReadError('state', '缺少 psvts（页面会话参数），请刷新阅读页后重试。');
    }

    // 关键点：ct 必须是「当前」时间戳，pc = _e(ct)。
    // 若 _e(ct) 恰好等于 psvts，服务端会认为参数异常而返回空内容，因此顺延 1 秒。
    let ctValue = now;
    if (wereadEncode(ctValue) === psvts) ctValue += 1;

    const params = {
      b: wereadEncode(bookId),
      c: wereadEncode(chapterUid),
      ct: String(ctValue),
      pc: wereadEncode(ctValue),
      prevChapter: false,
      ps: psvts,
      r: String(Math.floor(10000 * Math.random()) ** 2),
      // 修复点：sc 必须为 1，服务端才会返回整章内容；sc=0 只会返回试读片段。
      sc: opts.sc === undefined ? 1 : opts.sc,
      st: opts.style ? 1 : 0,
    };

    return signParams(params);
  }

  WRX.wereadEncode = wereadEncode;
  WRX.wereadSign = wereadSign;
  WRX.sortedQuery = sortedQuery;
  WRX.signParams = signParams;
  WRX.buildContentParams = buildContentParams;
})(typeof globalThis !== 'undefined' ? globalThis : window);
