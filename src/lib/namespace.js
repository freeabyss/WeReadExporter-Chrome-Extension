/**
 * 全局命名空间。
 *
 * 扩展的 content script 之间共享同一个 isolated world，因此可以像多个
 * <script> 一样按 manifest.json 中的顺序依次加载，通过 __WRX__ 互相访问。
 * 不使用 ES module，避免 MV3 content script 无法直接 import 的问题。
 */
(function (root) {
  'use strict';

  const WRX = (root.__WRX__ = root.__WRX__ || {});
  WRX.VERSION = '1.2.0';
  WRX.APP_NAME = '微信读书导出助手';
  WRX.HOME = 'https://weread.qq.com/';

  /** 错误类型，供 UI 决定提示文案与是否重试。 */
  WRX.ErrorCode = {
    NETWORK: 'network',
    HTTP: 'http',
    AUTH: 'auth',
    EMPTY: 'empty',
    CORRUPT: 'corrupt',
    SHORT: 'short',
    STATE: 'state',
    CATALOG: 'catalog',
    FORMAT: 'format',
    ABORTED: 'aborted',
    UNKNOWN: 'unknown',
  };

  class WeReadError extends Error {
    /**
     * @param {string} code 见 WRX.ErrorCode
     * @param {string} message 面向用户的中文提示
     * @param {{retryable?: boolean, cause?: unknown, detail?: unknown}} [options]
     */
    constructor(code, message, options) {
      super(message);
      const opts = options || {};
      this.name = 'WeReadError';
      this.code = code;
      this.retryable = opts.retryable === undefined ? defaultRetryable(code) : !!opts.retryable;
      if (opts.cause !== undefined) this.cause = opts.cause;
      if (opts.detail !== undefined) this.detail = opts.detail;
    }
  }

  function defaultRetryable(code) {
    return (
      code === WRX.ErrorCode.NETWORK ||
      code === WRX.ErrorCode.HTTP ||
      code === WRX.ErrorCode.EMPTY ||
      code === WRX.ErrorCode.CORRUPT ||
      code === WRX.ErrorCode.SHORT ||
      code === WRX.ErrorCode.UNKNOWN
    );
  }

  WRX.WeReadError = WeReadError;

  /** 简单的 sleep，支持 AbortSignal。 */
  WRX.sleep = function sleep(ms, signal) {
    return new Promise((resolve, reject) => {
      if (signal && signal.aborted) {
        reject(new DOMException('Aborted', 'AbortError'));
        return;
      }
      const timer = setTimeout(() => {
        if (signal) signal.removeEventListener('abort', onAbort);
        resolve();
      }, ms);
      function onAbort() {
        clearTimeout(timer);
        reject(new DOMException('Aborted', 'AbortError'));
      }
      if (signal) signal.addEventListener('abort', onAbort, { once: true });
    });
  };
})(typeof globalThis !== 'undefined' ? globalThis : window);
