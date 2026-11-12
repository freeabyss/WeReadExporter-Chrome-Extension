/**
 * 悬浮面板 UI（原生 JS + Shadow DOM，无 jQuery）。
 *
 * Shadow DOM 可以完全隔离微信读书页面的样式，避免像旧脚本那样注入全局 <style>
 * 与页面互相污染；同时保留拖拽、记忆位置、快捷键等交互。
 */
(function (root) {
  'use strict';

  const WRX = (root.__WRX__ = root.__WRX__ || {});

  const STORAGE_KEYS = {
    settings: 'wrx.settings.v1',
    panelPos: 'wrx.panel.pos.v1',
    fabPos: 'wrx.fab.pos.v1',
  };

  const DEFAULT_SETTINGS = {
    format: 'md',
    delayMs: 260,
    maxAttempts: 3,
    refreshEvery: 40,
    frontMatter: true,
    includeNotes: true,
    includePopular: false,
  };

  const STATUS_TEXT = {
    pending: '',
    loading: '⏳',
    ok: '✓',
    warning: '⚠',
    failed: '✕',
  };

  const STYLE = `
    :host {
      all: initial;
      --wrx-primary: #2f6bff;
      --wrx-primary-2: #1e54d6;
      --wrx-bg: #ffffff;
      --wrx-bg-soft: #f6f7f9;
      --wrx-text: #1f2328;
      --wrx-muted: #6b7280;
      --wrx-border: #e5e7eb;
      --wrx-success: #1a7f37;
      --wrx-danger: #cf222e;
      --wrx-warning: #9a6700;
      --wrx-shadow: 0 18px 46px rgba(15, 23, 42, .22);
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif;
      font-size: 13px;
      line-height: 1.5;
      color: var(--wrx-text);
    }
    * { box-sizing: border-box; }
    button { font: inherit; cursor: pointer; }
    .host { position: fixed; inset: 0; z-index: 2147483000; pointer-events: none; color: var(--wrx-text); }
    .host > * { pointer-events: auto; }

    /* 浮动按钮 */
    .fab {
      position: absolute; right: 22px; bottom: 24px;
      display: inline-flex; align-items: center; gap: 6px;
      padding: 9px 15px;
      border: 1px solid rgba(255,255,255,.28);
      border-radius: 999px;
      color: #fff;
      background: linear-gradient(135deg, #4c84ff 0%, var(--wrx-primary) 55%, var(--wrx-primary-2) 100%);
      box-shadow: 0 10px 24px rgba(47, 107, 255, .38);
      font-size: 13px; font-weight: 600;
      user-select: none; touch-action: none;
      transition: transform .16s ease, box-shadow .16s ease;
    }
    .fab:hover { transform: translateY(-1px); box-shadow: 0 14px 30px rgba(47, 107, 255, .45); }
    .fab:active { transform: translateY(0) scale(.98); }
    .fab .dot { width: 8px; height: 8px; border-radius: 50%; background: #7CFFB2; box-shadow: 0 0 0 3px rgba(124,255,178,.28); }

    /* 面板 */
    .panel {
      position: absolute; right: 22px; bottom: 76px;
      width: 344px; max-height: min(78vh, 760px);
      display: flex; flex-direction: column;
      background: var(--wrx-bg);
      border: 1px solid var(--wrx-border);
      border-radius: 16px;
      box-shadow: var(--wrx-shadow);
      overflow: hidden;
      animation: wrx-pop .18s ease-out;
    }
    .panel[hidden] { display: none; }
    @keyframes wrx-pop { from { opacity: 0; transform: translateY(8px) scale(.985); } to { opacity: 1; transform: none; } }

    .panel-head {
      display: flex; align-items: center; justify-content: space-between;
      gap: 10px; padding: 12px 14px;
      background: linear-gradient(180deg, rgba(47,107,255,.09), rgba(47,107,255,0));
      border-bottom: 1px solid var(--wrx-border);
      cursor: grab; user-select: none; touch-action: none;
    }
    .panel-head:active { cursor: grabbing; }
    .brand { display: flex; align-items: center; gap: 9px; min-width: 0; }
    .brand .logo {
      width: 30px; height: 30px; border-radius: 9px; flex: 0 0 auto;
      display: grid; place-items: center; font-size: 15px;
      background: rgba(47,107,255,.12);
    }
    .brand b { display: block; font-size: 13.5px; font-weight: 700; letter-spacing: .2px; }
    .brand small { display: block; color: var(--wrx-muted); font-size: 10.5px; }
    .icon-btn {
      width: 26px; height: 26px; display: grid; place-items: center;
      border: none; border-radius: 8px; background: transparent; color: var(--wrx-muted);
      font-size: 15px; line-height: 1;
    }
    .icon-btn:hover { background: var(--wrx-bg-soft); color: var(--wrx-text); }

    .panel-body { overflow-y: auto; padding: 12px 14px 14px; overscroll-behavior: contain; }
    .panel-foot {
      padding: 8px 14px; color: var(--wrx-muted); font-size: 10.5px;
      border-top: 1px solid var(--wrx-border); background: var(--wrx-bg-soft);
      display: flex; justify-content: space-between; gap: 8px;
    }

    .book { padding: 2px 2px 10px; }
    .book-title { font-size: 14.5px; font-weight: 700; line-height: 1.4; word-break: break-word; }
    .book-sub { color: var(--wrx-muted); font-size: 11.5px; margin-top: 3px; }

    .section { border-top: 1px solid var(--wrx-border); padding: 11px 0 2px; }
    .row-label { color: var(--wrx-muted); font-size: 11px; font-weight: 600; letter-spacing: .4px; margin-bottom: 6px; }
    .current-title {
      font-size: 12.5px; padding: 8px 10px; border-radius: 9px;
      background: var(--wrx-bg-soft); border: 1px solid var(--wrx-border);
      overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    }
    .btn-row { display: flex; gap: 8px; margin-top: 8px; }
    .btn-row > button { flex: 1; }

    button.action {
      padding: 7px 10px; border-radius: 9px;
      border: 1px solid var(--wrx-border); background: var(--wrx-bg);
      color: var(--wrx-text); font-size: 12.5px; font-weight: 500;
      transition: background .14s ease, border-color .14s ease, color .14s ease;
    }
    button.action:hover:not(:disabled) { background: var(--wrx-bg-soft); border-color: #d5d9df; }
    button.action:disabled { opacity: .5; cursor: not-allowed; }

    button.primary {
      width: 100%; padding: 9px 12px; margin-top: 8px;
      border: none; border-radius: 10px;
      background: linear-gradient(135deg, #4c84ff, var(--wrx-primary) 60%, var(--wrx-primary-2));
      color: #fff; font-size: 13px; font-weight: 600;
      box-shadow: 0 6px 16px rgba(47,107,255,.28);
    }
    button.primary:hover:not(:disabled) { filter: brightness(1.04); }
    button.primary:disabled { opacity: .55; cursor: not-allowed; box-shadow: none; }
    button.danger { color: var(--wrx-danger); border-color: rgba(207,34,46,.35); }
    button.danger:hover:not(:disabled) { background: rgba(207,34,46,.06); }

    .seg { display: flex; gap: 6px; padding: 3px; background: var(--wrx-bg-soft); border-radius: 10px; }
    .seg button {
      flex: 1; padding: 6px 4px; border: none; border-radius: 8px;
      background: transparent; color: var(--wrx-muted); font-size: 12px; font-weight: 600;
    }
    .seg button[aria-checked="true"] {
      background: var(--wrx-bg); color: var(--wrx-primary);
      box-shadow: 0 1px 3px rgba(15,23,42,.12);
    }

    .progress { margin-top: 8px; }
    .bar { height: 6px; border-radius: 999px; background: var(--wrx-bg-soft); overflow: hidden; }
    .bar > i {
      display: block; height: 100%; width: 0%;
      background: linear-gradient(90deg, #4c84ff, var(--wrx-primary));
      border-radius: inherit; transition: width .25s ease;
    }
    .progress-text { color: var(--wrx-muted); font-size: 11px; margin-top: 5px; word-break: break-all; }
    .progress-actions { display: flex; gap: 8px; margin-top: 7px; }

    .disclosure {
      width: 100%; display: flex; align-items: center; gap: 8px;
      padding: 4px 2px; border: none; background: transparent; color: var(--wrx-text);
      font-size: 12.5px; font-weight: 600;
    }
    .disclosure .count {
      font-size: 10.5px; font-weight: 600; color: var(--wrx-primary);
      background: rgba(47,107,255,.1); border-radius: 999px; padding: 1px 7px;
    }
    .disclosure .chev { margin-left: auto; color: var(--wrx-muted); transition: transform .16s ease; }
    .disclosure[aria-expanded="true"] .chev { transform: rotate(180deg); }

    .chapter-tools { display: flex; gap: 8px; margin: 6px 0 4px; }
    .chapter-tools input {
      flex: 1; min-width: 0; padding: 6px 9px; font: inherit; font-size: 12px;
      color: var(--wrx-text); background: var(--wrx-bg-soft);
      border: 1px solid var(--wrx-border); border-radius: 8px; outline: none;
    }
    .chapter-tools input:focus { border-color: var(--wrx-primary); background: var(--wrx-bg); }
    .chapter-tools button { white-space: nowrap; }

    .chapter-list { list-style: none; margin: 0; padding: 0; max-height: 260px; overflow-y: auto; overscroll-behavior: contain; }
    .chapter-list li {
      display: flex; align-items: center; gap: 6px;
      padding: 4px 2px 4px 4px; border-radius: 8px;
    }
    .chapter-list li:hover { background: var(--wrx-bg-soft); }
    .chapter-list li[data-volume="true"] .ch-title { font-weight: 700; color: var(--wrx-muted); }
    .ch-title {
      flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
      border: none; background: transparent; color: var(--wrx-text);
      text-align: left; font-size: 12px; padding: 2px 0;
    }
    .ch-title:hover { color: var(--wrx-primary); }
    .ch-badge { width: 14px; text-align: center; font-size: 11px; flex: 0 0 auto; }
    .chapter-list li[data-status="ok"] .ch-badge { color: var(--wrx-success); }
    .chapter-list li[data-status="failed"] .ch-badge { color: var(--wrx-danger); }
    .chapter-list li[data-status="warning"] .ch-badge { color: var(--wrx-warning); }
    .ch-btn {
      flex: 0 0 auto; padding: 3px 7px; border-radius: 7px;
      border: 1px solid var(--wrx-border); background: var(--wrx-bg);
      color: var(--wrx-muted); font-size: 10.5px;
    }
    .ch-btn:hover:not(:disabled) { color: var(--wrx-primary); border-color: rgba(47,107,255,.45); }
    .ch-btn:disabled { opacity: .45; cursor: not-allowed; }
    .chapter-empty { color: var(--wrx-muted); font-size: 11.5px; padding: 8px 2px; }

    .advanced-box { display: grid; gap: 7px; margin-top: 8px; }
    .advanced-box label { display: flex; align-items: center; justify-content: space-between; gap: 8px; font-size: 11.5px; color: var(--wrx-muted); }
    .advanced-box input[type="number"] {
      width: 74px; padding: 4px 6px; font: inherit; font-size: 12px;
      color: var(--wrx-text); background: var(--wrx-bg-soft); border: 1px solid var(--wrx-border);
      border-radius: 7px; text-align: right; outline: none;
    }
    .advanced-box input[type="number"]:focus { border-color: var(--wrx-primary); background: var(--wrx-bg); }
    .advanced-box label.check { justify-content: flex-start; gap: 7px; }
    .advanced-box .hint { margin: 2px 0 0; font-size: 10.5px; color: var(--wrx-muted); line-height: 1.5; }

    .notice {
      margin-top: 9px; padding: 9px 10px; border-radius: 9px;
      font-size: 11.5px; line-height: 1.6;
      background: rgba(207,34,46,.07); border: 1px solid rgba(207,34,46,.28);
      color: #8b1a24; white-space: pre-wrap; word-break: break-word;
    }
    .notice.info { background: rgba(47,107,255,.06); border-color: rgba(47,107,255,.25); color: #1e4bb8; }
    .notice.warn { background: rgba(154,103,0,.07); border-color: rgba(154,103,0,.28); color: #7a5200; }

    .result {
      margin-top: 10px; padding: 10px; border-radius: 10px;
      border: 1px solid rgba(26,127,55,.3); background: rgba(26,127,55,.06);
    }
    .result-head { font-size: 12.5px; font-weight: 700; color: var(--wrx-success); }
    .result-meta { margin-top: 3px; font-size: 11px; color: var(--wrx-muted); word-break: break-word; }
    .result .btn-row { margin-top: 9px; }
    .result details { margin-top: 7px; font-size: 11px; color: var(--wrx-muted); }
    .result details summary { cursor: pointer; color: var(--wrx-warning); }
    .result details ul { margin: 5px 0 0; padding-left: 16px; max-height: 140px; overflow: auto; }

    .toast {
      position: absolute; left: 50%; bottom: 96px; transform: translateX(-50%) translateY(6px);
      max-width: min(78vw, 460px);
      padding: 9px 14px; border-radius: 10px;
      background: rgba(17, 24, 39, .92); color: #fff;
      font-size: 12px; line-height: 1.5; white-space: pre-wrap; word-break: break-word;
      box-shadow: 0 10px 28px rgba(15,23,42,.3);
      opacity: 0; pointer-events: none; transition: opacity .2s ease, transform .2s ease;
    }
    .toast.show { opacity: 1; transform: translateX(-50%) translateY(0); }
    .toast.error { background: rgba(185, 28, 28, .95); }
    .toast.success { background: rgba(21, 128, 61, .95); }

    /* 笔记与标注选项：原生 checkbox + fieldset/legend，保留键盘与辅助技术支持 */
    fieldset.notes-opts {
      margin: 10px 0 0; padding: 8px 10px 10px;
      border: 1px solid var(--wrx-border); border-radius: 10px;
      min-width: 0;
    }
    fieldset.notes-opts legend {
      padding: 0 5px; font-size: 11px; font-weight: 600;
      letter-spacing: .4px; color: var(--wrx-muted);
    }
    fieldset.notes-opts label.check {
      display: flex; align-items: center; gap: 8px;
      min-height: 32px; font-size: 12px; color: var(--wrx-text);
      cursor: pointer;
    }
    fieldset.notes-opts input[type="checkbox"] {
      flex: 0 0 auto; width: 15px; height: 15px; margin: 0;
      accent-color: var(--wrx-primary); cursor: pointer;
    }
    fieldset.notes-opts input[type="checkbox"]:disabled { cursor: not-allowed; opacity: .5; }
    fieldset.notes-opts input[type="checkbox"]:focus-visible {
      outline: 2px solid var(--wrx-primary); outline-offset: 2px;
    }
    fieldset.notes-opts .hint { margin: 4px 0 0; font-size: 10.5px; line-height: 1.5; color: var(--wrx-muted); }
    button.shelf-btn {
      width: 100%; margin-top: 7px; padding: 7px 10px;
      border-radius: 9px; border: 1px dashed var(--wrx-border);
      background: transparent; color: var(--wrx-muted); font-size: 12px;
    }
    button.shelf-btn:hover:not(:disabled) { color: var(--wrx-primary); border-color: rgba(47,107,255,.5); background: rgba(47,107,255,.04); }
    button.shelf-btn:disabled { opacity: .5; cursor: not-allowed; }
    .result-notes { margin-top: 3px; font-size: 11px; color: var(--wrx-primary); }

    .visually-hidden { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); }

    @media (prefers-color-scheme: dark) {
      :host {
        --wrx-bg: #1b1f27;
        --wrx-bg-soft: #232833;
        --wrx-text: #e6edf3;
        --wrx-muted: #9aa4b2;
        --wrx-border: #303643;
        --wrx-shadow: 0 18px 46px rgba(0, 0, 0, .55);
      }
      .panel-head { background: linear-gradient(180deg, rgba(76,132,255,.14), rgba(76,132,255,0)); }
      .notice { color: #ffb4ba; }
      .notice.info { color: #a9c2ff; }
      .notice.warn { color: #ffd28a; }
    }
  `;

  function clamp(value, min, max) {
    return Math.min(Math.max(value, min), max);
  }

  function readStorage(key) {
    try {
      const raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : null;
    } catch (error) {
      return null;
    }
  }

  function writeStorage(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch (error) {
      /* 忽略隐私模式下的写入失败 */
    }
  }

  function loadSettings() {
    const saved = readStorage(STORAGE_KEYS.settings) || {};
    const settings = Object.assign({}, DEFAULT_SETTINGS, saved);
    if (!['md', 'html', 'txt'].includes(settings.format)) settings.format = 'md';
    settings.delayMs = clamp(Number(settings.delayMs) || 0, 0, 3000);
    settings.maxAttempts = clamp(Number(settings.maxAttempts) || 3, 1, 5);
    settings.refreshEvery = clamp(Number(settings.refreshEvery) || 0, 0, 500);
    settings.frontMatter = settings.frontMatter !== false;
    settings.includeNotes = settings.includeNotes !== false;
    settings.includePopular = settings.includePopular === true;
    return settings;
  }

  class ExporterUI {
    /**
     * @param {{
     *   onCopyCurrent?: Function,
     *   onSaveCurrent?: Function,
     *   onCopyChapter?: Function,
     *   onSaveChapter?: Function,
     *   onExportBook?: Function,
     *   onCancel?: Function,
     *   onJumpChapter?: Function,
     *   onSettingsChange?: Function,
     *   onRetryFailed?: Function,
     *   onTogglePanel?: Function
     * }} handlers
     */
    constructor(handlers) {
      this.handlers = handlers || {};
      this.settings = loadSettings();
      this.chapters = [];
      this.chapterRows = new Map();
      this.book = null;
      this.currentChapter = null;
      this.busy = false;
      this.result = null;
      this.mounted = false;
      this.shelfReady = false;
      this._toastTimer = null;
      this._lastFocus = null;
    }

    // ------------------------------------------------------------- 生命周期

    mount() {
      if (this.mounted) return;
      this.mounted = true;

      const container = document.createElement('div');
      container.id = 'wrx-host';
      container.style.all = 'initial';
      const shadow = container.attachShadow({ mode: 'open' });
      this.root = shadow;

      const style = document.createElement('style');
      style.textContent = STYLE;
      shadow.appendChild(style);

      const host = document.createElement('div');
      host.className = 'host';
      host.innerHTML = this._template();
      shadow.appendChild(host);

      this.host = host;
      this.fab = host.querySelector('.fab');
      this.panel = host.querySelector('.panel');
      this.body = host.querySelector('.panel-body');
      this.toastEl = host.querySelector('.toast');
      this.progressEl = host.querySelector('.progress');
      this.barEl = host.querySelector('.bar > i');
      this.progressTextEl = host.querySelector('.progress-text');
      this.resultEl = host.querySelector('.result');
      this.noticeEl = host.querySelector('.notice-slot');
      this.currentTitleEl = host.querySelector('.current-title');
      this.bookTitleEl = host.querySelector('.book-title');
      this.bookSubEl = host.querySelector('.book-sub');
      this.countEl = host.querySelector('.disclosure .count');
      this.chapterListEl = host.querySelector('.chapter-list');
      this.filterEl = host.querySelector('.chapter-tools input');

      document.documentElement.appendChild(container);

      this._bindEvents();
      this._restorePosition(this.fab, STORAGE_KEYS.fabPos);
      this._restorePosition(this.panel, STORAGE_KEYS.panelPos);
      this._enableDrag(this.fab, this.fab, STORAGE_KEYS.fabPos);
      this._enableDrag(this.panel, host.querySelector('.panel-head'), STORAGE_KEYS.panelPos);
      this._syncFormatButtons();
      this._syncOptionInputs();
      this._syncNotesOptions();
      this._setPanelOpen(false);
    }

    setVisible(visible) {
      if (!this.host) return;
      this.host.style.display = visible ? '' : 'none';
    }

    destroy() {
      const node = document.getElementById('wrx-host');
      if (node) node.remove();
      this.mounted = false;
    }

    _template() {
      const version = WRX.VERSION || '1.0.0';
      return `
        <button class="fab" data-act="toggle-panel" title="微信读书导出助手">
          <span class="dot"></span><span>导出</span>
        </button>

        <section class="panel" hidden role="dialog" aria-label="微信读书导出面板">
          <header class="panel-head">
            <div class="brand">
              <span class="logo">📚</span>
              <div><b>微信读书导出</b><small>全文 · Markdown / HTML / TXT</small></div>
            </div>
            <button class="icon-btn" data-act="toggle-panel" title="收起面板">✕</button>
          </header>

          <div class="panel-body">
            <div class="book">
              <div class="book-title">正在读取书籍信息…</div>
              <div class="book-sub">请在阅读页停留片刻</div>
            </div>

            <div class="section">
              <div class="row-label">当前章节</div>
              <div class="current-title">—</div>
              <div class="btn-row">
                <button class="action" data-act="copy-current" disabled>复制本章</button>
                <button class="action" data-act="save-current" disabled>下载本章</button>
              </div>
            </div>

            <div class="section">
              <div class="row-label">导出格式</div>
              <div class="seg" role="radiogroup" aria-label="导出格式">
                <button data-fmt="md" role="radio" aria-checked="true">Markdown</button>
                <button data-fmt="html" role="radio" aria-checked="false">HTML</button>
                <button data-fmt="txt" role="radio" aria-checked="false">TXT</button>
              </div>
              <fieldset class="notes-opts" aria-describedby="wrx-notes-help">
                <legend>笔记与标注</legend>
                <label class="check">
                  <input type="checkbox" data-opt="includeNotes" id="wrx-include-notes">
                  <span>附带我的划线与想法</span>
                </label>
                <label class="check">
                  <input type="checkbox" data-opt="includePopular" id="wrx-include-popular" aria-describedby="wrx-popular-help">
                  <span>附带热门划线（他人标注）</span>
                </label>
                <p class="hint" id="wrx-notes-help">笔记按章节分组附在本次导出文件末尾，不单独生成文件；热门划线可选。</p>
                <p class="hint" id="wrx-popular-help">热门划线为公开内容，服务端固定返回前 20 条。</p>
              </fieldset>
              <button class="primary" data-act="export-book" disabled>导出全文</button>
              <button class="shelf-btn" data-act="export-shelf" disabled>导出全书架笔记（按书分组，可选）</button>
              <div class="progress" hidden>
                <div class="bar"><i></i></div>
                <div class="progress-text">准备中…</div>
                <div class="progress-actions">
                  <button class="action danger" data-act="cancel">取消导出</button>
                </div>
              </div>
              <div class="notice-slot"></div>
              <div class="result" hidden></div>
            </div>

            <div class="section">
              <button class="disclosure" data-act="toggle-chapters" aria-expanded="false">
                <span>章节列表</span><span class="count">0</span><span class="chev">▾</span>
              </button>
              <div class="chapter-box" hidden>
                <div class="chapter-tools">
                  <input type="search" placeholder="筛选章节标题…" aria-label="筛选章节标题">
                  <button class="action" data-act="retry-failed" hidden>重试失败</button>
                </div>
                <ul class="chapter-list"></ul>
              </div>
            </div>

            <div class="section">
              <button class="disclosure" data-act="toggle-advanced" aria-expanded="false">
                <span>高级设置</span><span class="chev">▾</span>
              </button>
              <div class="advanced-box" hidden>
                <label>请求间隔 <span><input type="number" data-opt="delayMs" min="0" max="3000" step="50"> ms</span></label>
                <label>失败重试 <span><input type="number" data-opt="maxAttempts" min="1" max="5"> 次</span></label>
                <label>会话刷新 <span><input type="number" data-opt="refreshEvery" min="0" max="500"> 章/次</span></label>
                <label class="check"><input type="checkbox" data-opt="frontMatter"> 附带书名 / 作者 / 导出时间</label>
                <p class="hint">间隔越小越快；遇到限流或正文缺失时，可适当调大间隔并提高重试次数。</p>
              </div>
            </div>
          </div>

          <footer class="panel-foot">
            <span>v${version}</span>
            <span>仅供导出你有权阅读的内容</span>
          </footer>
        </section>

        <div class="toast" role="status" aria-live="polite"></div>
      `;
    }

    // --------------------------------------------------------------- 事件绑定

    _bindEvents() {
      this.root.addEventListener('click', (event) => {
        const formatButton = event.target.closest && event.target.closest('[data-fmt]');
        if (formatButton) {
          this._setFormat(formatButton.getAttribute('data-fmt'));
          return;
        }

        const trigger = event.target.closest && event.target.closest('[data-act]');
        if (!trigger) return;

        const action = trigger.getAttribute('data-act');
        const uid = trigger.getAttribute('data-uid');
        this._dispatch(action, trigger, uid);
      });

      this.filterEl.addEventListener('input', () => this._applyFilter());

      this.root.addEventListener('change', (event) => {
        const input = event.target;
        if (!input || !input.getAttribute || !input.getAttribute('data-opt')) return;
        const key = input.getAttribute('data-opt');
        if (input.type === 'checkbox') {
          this.settings[key] = !!input.checked;
        } else {
          const value = Number(input.value);
          if (!Number.isFinite(value)) return;
          this.settings[key] = clamp(
            Math.round(value),
            Number(input.min) || 0,
            Number(input.max) || 9999
          );
        }
        writeStorage(STORAGE_KEYS.settings, this.settings);
        this._syncNotesOptions();
        if (typeof this.handlers.onSettingsChange === 'function') {
          this.handlers.onSettingsChange(this.getOptions());
        }
      });

      document.addEventListener('keydown', (event) => {
        if (event.key === 'Escape' && this.isPanelOpen()) this._setPanelOpen(false);
      });
    }

    _dispatch(action, trigger, uid) {
      const handler = this.handlers;
      switch (action) {
        case 'toggle-panel':
          this._setPanelOpen(!this.isPanelOpen());
          break;
        case 'copy-current':
          if (handler.onCopyCurrent) handler.onCopyCurrent();
          break;
        case 'save-current':
          if (handler.onSaveCurrent) handler.onSaveCurrent();
          break;
        case 'export-book':
          if (handler.onExportBook) handler.onExportBook();
          break;
        case 'export-shelf':
          if (handler.onExportShelfNotes) handler.onExportShelfNotes();
          break;
        case 'cancel':
          if (handler.onCancel) handler.onCancel();
          break;
        case 'copy':
          if (handler.onCopyChapter && uid !== null) handler.onCopyChapter(uid);
          break;
        case 'save':
          if (handler.onSaveChapter && uid !== null) handler.onSaveChapter(uid);
          break;
        case 'jump':
          if (handler.onJumpChapter && uid !== null) handler.onJumpChapter(uid);
          break;
        case 'toggle-chapters':
          this._toggleDisclosure(trigger, '.chapter-box');
          break;
        case 'toggle-advanced':
          this._toggleDisclosure(trigger, '.advanced-box');
          break;
        case 'retry-failed':
          if (handler.onRetryFailed) handler.onRetryFailed();
          break;
        case 'save-result':
          if (handler.onSaveResult) handler.onSaveResult();
          break;
        case 'copy-result':
          if (handler.onCopyResult) handler.onCopyResult();
          break;
        case 'retry-export':
          if (handler.onExportBook) handler.onExportBook();
          break;
        default:
          break;
      }
    }

    _toggleDisclosure(button, selector) {
      const box = this.root.querySelector(selector);
      if (!box) return;
      const open = button.getAttribute('aria-expanded') === 'true';
      button.setAttribute('aria-expanded', open ? 'false' : 'true');
      box.hidden = open;
    }

    // --------------------------------------------------------------- 拖拽

    _restorePosition(element, key) {
      const saved = readStorage(key);
      if (!saved || typeof saved.left !== 'number' || typeof saved.top !== 'number') return;

      const apply = () => {
        const rect = element.getBoundingClientRect();
        const maxLeft = Math.max(window.innerWidth - rect.width - 8, 8);
        const maxTop = Math.max(window.innerHeight - rect.height - 8, 8);
        element.style.left = clamp(saved.left, 8, maxLeft) + 'px';
        element.style.top = clamp(saved.top, 8, maxTop) + 'px';
        element.style.right = 'auto';
        element.style.bottom = 'auto';
      };
      requestAnimationFrame(apply);
    }

    _enableDrag(element, handle, storageKey) {
      if (!handle) return;
      let dragging = false;
      let startX = 0;
      let startY = 0;
      let startLeft = 0;
      let startTop = 0;
      let moved = false;

      const onPointerDown = (event) => {
        if (event.button !== 0 && event.pointerType === 'mouse') return;
        const rect = element.getBoundingClientRect();
        startX = event.clientX;
        startY = event.clientY;
        startLeft = rect.left;
        startTop = rect.top;
        dragging = true;
        moved = false;
        element.style.left = rect.left + 'px';
        element.style.top = rect.top + 'px';
        element.style.right = 'auto';
        element.style.bottom = 'auto';
        handle.setPointerCapture(event.pointerId);
        event.preventDefault();
      };

      const onPointerMove = (event) => {
        if (!dragging) return;
        const dx = event.clientX - startX;
        const dy = event.clientY - startY;
        if (Math.abs(dx) + Math.abs(dy) > 2) moved = true;

        const rect = element.getBoundingClientRect();
        const maxLeft = Math.max(window.innerWidth - rect.width - 8, 8);
        const maxTop = Math.max(window.innerHeight - rect.height - 8, 8);
        element.style.left = clamp(startLeft + dx, 8, maxLeft) + 'px';
        element.style.top = clamp(startTop + dy, 8, maxTop) + 'px';
      };

      const onPointerUp = (event) => {
        if (!dragging) return;
        dragging = false;
        try {
          handle.releasePointerCapture(event.pointerId);
        } catch (error) {
          /* ignore */
        }
        if (moved) {
          const rect = element.getBoundingClientRect();
          writeStorage(storageKey, { left: Math.round(rect.left), top: Math.round(rect.top) });
        }
      };

      handle.addEventListener('pointerdown', onPointerDown);
      handle.addEventListener('pointermove', onPointerMove);
      handle.addEventListener('pointerup', onPointerUp);
      handle.addEventListener('pointercancel', onPointerUp);

      // 拖拽结束时不要触发按钮点击
      element.addEventListener(
        'click',
        (event) => {
          if (moved) {
            event.stopPropagation();
            event.preventDefault();
            moved = false;
          }
        },
        true
      );
    }

    // --------------------------------------------------------------- 面板状态

    isPanelOpen() {
      return !!(this.panel && !this.panel.hidden);
    }

    _setPanelOpen(open) {
      if (!this.panel) return;
      this.panel.hidden = !open;
      if (open) {
        this._restorePosition(this.panel, STORAGE_KEYS.panelPos);
        if (this.book) this.body.scrollTop = 0;
      }
      if (typeof this.handlers.onTogglePanel === 'function') {
        this.handlers.onTogglePanel(open);
      }
    }

    // --------------------------------------------------------------- 书籍信息

    setBook(book) {
      this.book = book || null;
      if (!this.bookTitleEl) return;
      if (!book) {
        this.bookTitleEl.textContent = '未识别到书籍';
        this.bookSubEl.textContent = '请打开一章正文后再试';
        return;
      }
      this.bookTitleEl.textContent = book.title || '未知书名';
      const parts = [];
      if (book.author) parts.push(book.author);
      if (book.count) parts.push('共 ' + book.count + ' 章');
      this.bookSubEl.textContent = parts.join(' · ') || '微信读书';
    }

    setCurrentChapter(chapter) {
      this.currentChapter = chapter || null;
      if (!this.currentTitleEl) return;
      const title = chapter ? chapter.title : '';
      this.currentTitleEl.textContent = title || '未能定位当前章节';
      this.currentTitleEl.title = title || '';
      const disabled = !chapter || this.busy;
      this._setDisabled('[data-act="copy-current"]', disabled);
      this._setDisabled('[data-act="save-current"]', disabled);
    }

    setChapters(chapters) {
      this.chapters = chapters || [];
      this.chapterRows = new Map();
      if (!this.chapterListEl) return;

      this.chapterListEl.innerHTML = '';
      if (!this.chapters.length) {
        this.chapterListEl.innerHTML = '<li class="chapter-empty">暂无章节数据</li>';
        this.countEl.textContent = '0';
        return;
      }

      const fragment = document.createDocumentFragment();
      for (const chapter of this.chapters) {
        const li = document.createElement('li');
        li.setAttribute('data-uid', String(chapter.uid));
        li.setAttribute('data-status', chapter.isVolume ? 'volume' : 'pending');
        li.setAttribute('data-volume', chapter.isVolume ? 'true' : 'false');

        const title = document.createElement('button');
        title.className = 'ch-title';
        title.setAttribute('data-act', 'jump');
        title.setAttribute('data-uid', String(chapter.uid));
        title.title = '点击跳转到该章节';
        title.textContent = chapter.title;

        const badge = document.createElement('span');
        badge.className = 'ch-badge';
        badge.textContent = chapter.isVolume ? '' : STATUS_TEXT.pending;

        const copyButton = document.createElement('button');
        copyButton.className = 'ch-btn';
        copyButton.setAttribute('data-act', 'copy');
        copyButton.setAttribute('data-uid', String(chapter.uid));
        copyButton.title = '复制本章';
        copyButton.textContent = '复制';
        copyButton.disabled = !!chapter.isVolume;

        const saveButton = document.createElement('button');
        saveButton.className = 'ch-btn';
        saveButton.setAttribute('data-act', 'save');
        saveButton.setAttribute('data-uid', String(chapter.uid));
        saveButton.title = '下载本章';
        saveButton.textContent = '下载';
        saveButton.disabled = !!chapter.isVolume;

        li.appendChild(title);
        li.appendChild(badge);
        li.appendChild(copyButton);
        li.appendChild(saveButton);
        fragment.appendChild(li);
        this.chapterRows.set(String(chapter.uid), li);
      }

      this.chapterListEl.appendChild(fragment);
      this.countEl.textContent = String(this.chapters.filter((c) => !c.isVolume).length);
      this._applyFilter();
    }

    setChapterStatus(uid, status, title) {
      const row = this.chapterRows.get(String(uid));
      if (!row) return;
      row.setAttribute('data-status', status);
      const badge = row.querySelector('.ch-badge');
      if (badge) badge.textContent = STATUS_TEXT[status] || '';
      if (title) {
        const titleButton = row.querySelector('.ch-title');
        if (titleButton) titleButton.textContent = title;
      }
    }

    _applyFilter() {
      const keyword = (this.filterEl.value || '').trim().toLowerCase();
      for (const chapter of this.chapters) {
        const row = this.chapterRows.get(String(chapter.uid));
        if (!row) continue;
        if (!keyword) {
          row.hidden = false;
          continue;
        }
        row.hidden = !String(chapter.title || '').toLowerCase().includes(keyword);
      }
    }

    // --------------------------------------------------------------- 交互状态

    setBusy(busy) {
      this.busy = !!busy;
      this._setDisabled('[data-act="export-book"]', this.busy);
      this._setDisabled('[data-act="export-shelf"]', this.busy || !this.shelfReady);
      this._setDisabled('[data-act="copy-current"]', this.busy || !this.currentChapter);
      this._setDisabled('[data-act="save-current"]', this.busy || !this.currentChapter);
      this._setDisabled('[data-act="retry-failed"]', this.busy);

      this.root.querySelectorAll('.ch-btn').forEach((button) => {
        const uid = button.getAttribute('data-uid');
        const row = uid ? this.chapterRows.get(uid) : null;
        button.disabled = this.busy || !!(row && row.getAttribute('data-volume') === 'true');
      });

      const cancelButton = this.root.querySelector('[data-act="cancel"]');
      if (cancelButton) cancelButton.disabled = !busy;
    }

    startExport(total, label) {
      this.clearNotice();
      this.resultEl.hidden = true;
      this.resultEl.innerHTML = '';
      this.result = null;
      this.setBusy(true);
      this.progressEl.hidden = false;
      this._setProgress(0, label || '准备抓取目录…（共 ' + total + ' 章）');
    }

    updateProgress(info) {
      const total = Math.max(info.total || 1, 1);
      const index = Math.min(info.index || 0, total);
      const percent = Math.min(100, Math.round((index / total) * 100));

      const chapterTitle = info.chapter ? '：' + info.chapter.title : '';
      const failedText = info.failed ? '，失败 ' + info.failed : '';
      const text = info.label
        ? info.label + '（' + index + '/' + total + '，' + percent + '%）' + failedText
        : '正在获取 ' + index + '/' + total + '（' + percent + '%）' + chapterTitle + failedText;
      this._setProgress(percent, text);
    }

    finishExport(result) {
      this.progressEl.hidden = true;
      this.setBusy(false);
      this.showResult(result);
    }

    hideProgress() {
      if (this.progressEl) this.progressEl.hidden = true;
      if (this.barEl) this.barEl.style.width = '0%';
    }

    /** 清空导出结果卡片（切换书籍 / 重新导出时调用）。 */
    clearResult() {
      this.result = null;
      if (this.resultEl) {
        this.resultEl.hidden = true;
        this.resultEl.innerHTML = '';
      }
      this.hideProgress();
    }

    /** 全书架笔记按钮是否可用（初始化完成后解锁）。 */
    setShelfReady(ready) {
      this.shelfReady = !!ready;
      this._setDisabled('[data-act="export-shelf"]', this.busy || !this.shelfReady);
    }

    /** 显示/隐藏「重试失败」按钮。 */
    setRetryVisible(visible) {
      const button = this.root && this.root.querySelector('[data-act="retry-failed"]');
      if (!button) return;
      button.hidden = !visible;
      button.disabled = !!this.busy;
    }

    _setProgress(percent, text) {
      if (this.barEl) this.barEl.style.width = percent + '%';
      if (this.progressTextEl) this.progressTextEl.textContent = text;
    }

    showResult(result) {
      if (!this.resultEl) return;
      this.result = result;
      const stats = result.stats || {};
      const failedList =
        result.failures || (result.chapters || []).filter((c) => c && c.status === 'failed');
      const failed = failedList.filter((c) => c && c.title);
      const sizeKb = Math.max(1, Math.round((result.content || '').length / 1024));
      const label = String(result.format || 'md').toUpperCase();
      const unit = result.unit || '章';

      const head = document.createElement('div');
      head.className = 'result-head';
      head.textContent = failed.length ? '⚠️ 导出完成（有章节失败）' : '✅ 导出完成';

      const meta = document.createElement('div');
      meta.className = 'result-meta';
      meta.textContent =
        label +
        ' · 成功 ' +
        (stats.ok || 0) +
        ' ' + unit +
        (stats.failed ? ' · 失败 ' + stats.failed + ' ' + unit : '') +
        ' · 约 ' +
        sizeKb +
        ' KB' +
        (result.filename ? ' · ' + result.filename : '');

      const actions = document.createElement('div');
      actions.className = 'btn-row';

      const saveButton = document.createElement('button');
      saveButton.className = 'primary';
      saveButton.style.marginTop = '0';
      saveButton.setAttribute('data-act', 'save-result');
      saveButton.textContent = '下载文件';

      const copyButton = document.createElement('button');
      copyButton.className = 'action';
      copyButton.setAttribute('data-act', 'copy-result');
      copyButton.textContent = '复制全文';

      actions.appendChild(saveButton);
      actions.appendChild(copyButton);

      const noteStats = result.stats && result.stats.notes;
      const notesLine = document.createElement('div');
      if (noteStats) {
        notesLine.className = 'result-notes';
        notesLine.textContent =
          '笔记：我的划线 ' + (noteStats.highlights || 0) + ' 条 · 我的想法 ' +
          (noteStats.thoughts || 0) + ' 条' +
          (noteStats.popular ? ' · 热门划线 ' + noteStats.popular + ' 条' : '') +
          (noteStats.warnings ? ' · 提示 ' + noteStats.warnings + ' 条' : '');
      }

      this.resultEl.innerHTML = '';
      this.resultEl.appendChild(head);
      this.resultEl.appendChild(meta);
      if (noteStats) this.resultEl.appendChild(notesLine);
      this.resultEl.appendChild(actions);

      if (failed.length) {
        const details = document.createElement('details');
        const summary = document.createElement('summary');
        summary.textContent = '查看失败章节（' + failed.length + '）';
        const list = document.createElement('ul');
        for (const chapter of failed.slice(0, 200)) {
          const item = document.createElement('li');
          item.textContent = chapter.title + '：' + (chapter.error || '未知错误');
          list.appendChild(item);
        }
        details.appendChild(summary);
        details.appendChild(list);
        this.resultEl.appendChild(details);
      }

      this.resultEl.hidden = false;
    }

    clearNotice() {
      if (this.noticeEl) this.noticeEl.innerHTML = '';
    }

    /**
     * @param {string} message
     * @param {'error'|'info'|'warn'} [kind]
     * @param {{retry?: boolean}} [options]
     */
    showNotice(message, kind, options) {
      if (!this.noticeEl) return;
      const opts = options || {};
      this.noticeEl.innerHTML = '';
      const box = document.createElement('div');
      box.className = 'notice' + (kind && kind !== 'error' ? ' ' + kind : '');
      box.textContent = message;
      this.noticeEl.appendChild(box);

      if (opts.retry) {
        const actions = document.createElement('div');
        actions.className = 'btn-row';
        const retry = document.createElement('button');
        retry.className = 'action';
        retry.setAttribute('data-act', 'retry-export');
        retry.textContent = '重试导出';
        actions.appendChild(retry);
        this.noticeEl.appendChild(actions);
      }
    }

    toast(message, kind, duration) {
      if (!this.toastEl) return;
      const ms = duration || 2600;
      this.toastEl.textContent = message;
      this.toastEl.className = 'toast' + (kind ? ' ' + kind : '');
      this.toastEl.hidden = false;
      requestAnimationFrame(() => {
        this.toastEl.className = 'toast show' + (kind ? ' ' + kind : '');
      });
      clearTimeout(this._toastTimer);
      this._toastTimer = setTimeout(() => {
        this.toastEl.className = 'toast' + (kind ? ' ' + kind : '');
        this.toastEl.hidden = true;
      }, ms);
    }

    // --------------------------------------------------------------- 设置

    getFormat() {
      return this.settings.format;
    }

    getOptions() {
      return {
        format: this.settings.format,
        delayMs: this.settings.delayMs,
        maxAttempts: this.settings.maxAttempts,
        refreshEvery: this.settings.refreshEvery,
        frontMatter: this.settings.frontMatter,
        includeNotes: this.settings.includeNotes,
        includePopular: this.settings.includePopular,
      };
    }

    _setFormat(format) {
      if (!['md', 'html', 'txt'].includes(format)) return;
      this.settings.format = format;
      writeStorage(STORAGE_KEYS.settings, this.settings);
      this._syncFormatButtons();
      if (typeof this.handlers.onSettingsChange === 'function') {
        this.handlers.onSettingsChange(this.getOptions());
      }
    }

    _syncFormatButtons() {
      this.root.querySelectorAll('[data-fmt]').forEach((button) => {
        const checked = button.getAttribute('data-fmt') === this.settings.format;
        button.setAttribute('aria-checked', checked ? 'true' : 'false');
      });
    }

    _syncOptionInputs() {
      this.root.querySelectorAll('[data-opt]').forEach((input) => {
        const key = input.getAttribute('data-opt');
        if (input.type === 'checkbox') input.checked = !!this.settings[key];
        else input.value = this.settings[key];
      });
      this._syncNotesOptions();
    }

    /** 热门划线依赖「附带笔记」：未启用笔记时禁用并给出提示。 */
    _syncNotesOptions() {
      const popular = this.root.querySelector('#wrx-include-popular');
      if (!popular) return;
      popular.disabled = !this.settings.includeNotes;
      const label = popular.closest('label');
      if (label) label.title = this.settings.includeNotes ? '' : '请先勾选「附带我的划线与想法」';
    }

    _setDisabled(selector, disabled) {
      this.root.querySelectorAll(selector).forEach((element) => {
        element.disabled = !!disabled;
      });
    }
  }

  WRX.ExporterUI = ExporterUI;
  WRX.DEFAULT_SETTINGS = DEFAULT_SETTINGS;
})(typeof globalThis !== 'undefined' ? globalThis : window);
