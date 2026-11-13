/**
 * 内容脚本入口：装配 UI、客户端与导出引擎。
 *
 * 该文件只做编排，具体能力分别在 lib/ 下的模块里：
 *   weread-api.js     同源请求（含目录、章节分片、会话参数刷新）
 *   weread-decode.js  分片校验与解码
 *   formats.js        Markdown / HTML / TXT 组装
 *   exporter.js       整本导出、重试、完整性校验
 *   ui.js             悬浮面板
 */
(function () {
  'use strict';

  const WRX = window.__WRX__;
  if (!WRX) {
    console.warn('[微信读书导出] 扩展脚本未正确加载。');
    return;
  }

  // 只处理顶层文档；iframe 里不挂 UI。
  if (window.top !== window) return;
  // SPA 场景下 content script 可能被重复注入，做一次幂等保护。
  if (window.__WRX_CONTENT_STARTED__) return;
  window.__WRX_CONTENT_STARTED__ = true;

  const READER_PATH = /^\/web\/reader\//;

  const client = new WRX.WereadClient({ document: document, location: location });
  const exporter = new WRX.BookExporter(client);

  let ui = null;
  let initialized = false;
  let booting = false;
  let exporting = false;
  let taskBusy = false;
  let currentController = null;
  let currentChapter = null;
  let bootError = null;

  // ------------------------------------------------------------------ 工具函数

  const MIME_BY_FORMAT = {
    md: 'text/markdown',
    html: 'text/html',
    txt: 'text/plain',
  };

  const EXT_BY_FORMAT = { md: 'md', html: 'html', txt: 'txt' };

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function buildFileName(book, format, chapterTitle) {
    const safeTitle = WRX.formats.sanitizeFileName((book && book.title) || '微信读书导出');
    const safeChapter = chapterTitle ? WRX.formats.sanitizeFileName(chapterTitle) : '';
    const base = safeChapter ? safeTitle + ' - ' + safeChapter : safeTitle;
    return base + '.' + (EXT_BY_FORMAT[format] || 'md');
  }

  const SHELF_NOTES_FILENAME_BASE = '微信读书 - 全书架笔记合集';

  function downloadText(text, filename, format) {
    const mime = (MIME_BY_FORMAT[format] || 'text/plain') + ';charset=utf-8';
    const blob = new Blob([text], { type: mime });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = filename;
    anchor.rel = 'noopener';
    anchor.style.display = 'none';
    (document.body || document.documentElement).appendChild(anchor);
    anchor.click();

    setTimeout(() => {
      try {
        anchor.remove();
        URL.revokeObjectURL(url);
      } catch (error) {
        /* ignore */
      }
    }, 30000);
  }

  async function copyText(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      try {
        await navigator.clipboard.writeText(text);
        return true;
      } catch (error) {
        // 无用户手势时浏览器会拒绝，走下面的兜底方案。
      }
    }

    const textarea = document.createElement('textarea');
    textarea.value = text;
    textarea.setAttribute('readonly', 'readonly');
    textarea.style.cssText = 'position:fixed;left:-9999px;top:0;opacity:0;';
    document.body.appendChild(textarea);
    textarea.select();
    textarea.setSelectionRange(0, textarea.value.length);

    let success = false;
    try {
      success = document.execCommand('copy');
    } catch (error) {
      success = false;
    }
    textarea.remove();

    if (!success) {
      throw new Error('复制失败，请改用「下载」按钮保存文件。');
    }
    return true;
  }

  function findChapterByUid(uid) {
    return exporter.chapters.find((chapter) => String(chapter.uid) === String(uid)) || null;
  }

  /** 通过 URL 中的章节 hash 定位当前章节（SPA 换章也准确）。 */
  function resolveCurrentChapterFromUrl() {
    const parsed = WRX.readerState.parseReaderPath(location.pathname);
    if (!parsed.chapterHash) return null;

    for (const chapter of exporter.chapters) {
      if (WRX.wereadEncode(chapter.uid) === parsed.chapterHash) return chapter;
    }
    return null;
  }

  /** 通过阅读器状态 / 阅读进度兜底定位当前章节。 */
  function resolveCurrentChapterFromState(state) {
    if (!exporter.chapters.length) return null;

    const candidates = [];
    if (state && state.currentChapter) candidates.push(state.currentChapter);
    if (state && state.progress && state.progress.book) candidates.push(state.progress.book);

    for (const candidate of candidates) {
      const uid = candidate && (candidate.chapterUid !== undefined ? candidate.chapterUid : candidate.chapterIdx);
      if (uid === undefined || uid === null) continue;
      const exact = findChapterByUid(uid);
      if (exact) return exact;

      if (candidate.chapterIdx !== undefined) {
        const byIndex = exporter.chapters.find(
          (chapter) => !chapter.isVolume && Number(chapter.idx) === Number(candidate.chapterIdx)
        );
        if (byIndex) return byIndex;
      }
    }
    return null;
  }

  function setCurrentChapter(chapter) {
    currentChapter = chapter || null;
    if (!ui) return;
    ui.setCurrentChapter(currentChapter);
    if (currentChapter) ui.setChapterStatus(currentChapter.uid, 'pending', currentChapter.title);
  }

  function ensureChapterForAction(uid) {
    if (uid !== undefined && uid !== null) {
      const chapter = findChapterByUid(uid);
      if (!chapter) throw new Error('找不到该章节，请刷新页面后重试。');
      if (chapter.isVolume) throw new Error('这一条是卷标题，没有正文。');
      return chapter;
    }
    if (!currentChapter) {
      throw new Error('还没定位到当前章节，请在左侧目录里点击任意一章后再试。');
    }
    return currentChapter;
  }

  // ------------------------------------------------------------------ 操作

  async function runTask(label, task) {
    if (taskBusy || exporting) {
      ui.toast('正在处理上一个任务，请稍候…');
      return;
    }
    taskBusy = true;
    ui.setBusy(true);
    try {
      await task();
    } catch (error) {
      if (error && error.code === WRX.ErrorCode.ABORTED) return;
      const message = (error && error.message) || String(error);
      ui.toast(label + '失败：' + message, 'error', 4200);
      console.warn('[微信读书导出] ' + label + '失败：', error);
    } finally {
      taskBusy = false;
      ui.setBusy(false);
      ui.setCurrentChapter(currentChapter);
    }
  }

  async function copyChapter(uid) {
    await runTask('复制章节', async () => {
      const chapter = ensureChapterForAction(uid);
      ui.toast('正在获取「' + chapter.title + '」…');
      const result = await exporter.exportChapter(chapter, {
        format: ui.getFormat(),
        frontMatter: false,
      });
      await copyText(result.content);
      const chars = WRX.formats.countChars(result.content);
      ui.toast('已复制「' + chapter.title + '」（约 ' + chars + ' 字）', 'success');
      if (String(chapter.uid) === String(currentChapter && currentChapter.uid)) {
        ui.setChapterStatus(chapter.uid, 'ok', chapter.title);
      }
    });
  }

  async function saveChapter(uid) {
    await runTask('下载章节', async () => {
      const chapter = ensureChapterForAction(uid);
      ui.toast('正在获取「' + chapter.title + '」…');
      const result = await exporter.exportChapter(chapter, {
        format: ui.getFormat(),
        frontMatter: false,
      });
      downloadText(
        result.content,
        buildFileName(exporter.book, ui.getFormat(), chapter.title),
        ui.getFormat()
      );
      ui.toast('已开始下载「' + chapter.title + '」', 'success');
      if (String(chapter.uid) === String(currentChapter && currentChapter.uid)) {
        ui.setChapterStatus(chapter.uid, 'ok', chapter.title);
      }
    });
  }

  /** 抓取并组装正文导出产物（不发下载、不改 UI 终态）。 */
  async function buildBookExport(options, signal, onProgress) {
    const result = await exporter.exportBook({
      format: options.format,
      frontMatter: options.frontMatter,
      signal: signal,
      onProgress: onProgress,
    });
    return {
      kind: 'book',
      filename: buildFileName(exporter.book, options.format),
      content: result.content,
      format: options.format,
      result: result,
      metaOverride: '',
    };
  }

  /** 抓取并组装笔记导出产物（不发下载、不改 UI 终态）。 */
  async function buildNotesExport(options, signal, onProgress) {
    const result = await exporter.exportNotes({
      format: options.format,
      frontMatter: options.frontMatter,
      includePopular: options.includePopular,
      signal: signal,
      onProgress: onProgress,
    });
    const noteStats = result.stats.notes;
    const metaOverride =
      String(options.format).toUpperCase() + ' · 笔记与标注 · 我的划线 ' +
      noteStats.highlights + ' 条 · 我的想法 ' + noteStats.thoughts + ' 条' +
      (noteStats.popular ? ' · 热门划线 ' + noteStats.popular + ' 条' : '');
    return {
      kind: 'notes',
      filename: buildFileName(exporter.book, options.format, '笔记与标注'),
      content: result.content,
      format: options.format,
      result: result,
      metaOverride: metaOverride,
    };
  }

  function downloadSilently(payload) {
    try {
      downloadText(payload.content, payload.filename, payload.format);
      return true;
    } catch (error) {
      console.warn('[微信读书导出] 自动下载失败，请点击「下载文件」：', error);
      return false;
    }
  }

  /**
   * 统一的「导出」入口：按三个选项的组合依次执行。
   * 全文与笔记各自产出独立文件；任一失败不影响另一个继续。
   */
  async function exportSelected() {
    if (exporting) {
      ui.toast('正在导出中…');
      return;
    }
    if (!initialized) {
      ui.toast(bootError ? '书籍信息尚未就绪：' + bootError : '正在读取书籍信息，请稍候…', 'error');
      return;
    }

    const options = ui.getOptions();
    const wantBook = !!options.exportFullText;
    const wantNotes = !!options.exportNotes;
    if (!wantBook && !wantNotes) {
      ui.toast('请至少勾选「全文」或「笔记」中的一项', 'error');
      return;
    }

    exporting = true;
    taskBusy = true;
    currentController = new AbortController();
    const signal = currentController.signal;
    client.setSignal(signal);

    exporter.setOptions({
      delayMs: options.delayMs,
      maxAttempts: options.maxAttempts,
      refreshEvery: options.refreshEvery,
    });

    const total = exporter.readableChapters.length;
    ui.startExport(wantBook ? total : 1, wantBook ? undefined : '准备读取笔记与标注…');
    ui.setRetryVisible(false);

    const done = [];
    const failures = [];

    try {
      if (wantBook) {
        try {
          const payload = await buildBookExport(options, signal, (info) => {
            if (info.phase === 'fetch' && info.chapter) {
              ui.setChapterStatus(info.chapter.uid, 'loading', info.chapter.title);
            } else if (info.phase === 'progress') {
              ui.updateProgress(info);
            }
          });

          for (const chapter of payload.result.chapters) {
            if (chapter.isVolume) continue;
            ui.setChapterStatus(
              chapter.uid,
              chapter.status === 'failed' ? 'failed' : chapter.warning ? 'warning' : 'ok',
              chapter.title
            );
          }
          done.push(payload);
        } catch (error) {
          if (error && error.code === WRX.ErrorCode.ABORTED) throw error;
          failures.push({ kind: '全文', error: error });
          console.warn('[微信读书导出] 全文导出失败：', error);

          for (const chapter of exporter.chapters) {
            if (chapter.isVolume) continue;
            const record = exporter.getCached(chapter.uid);
            if (record && record.status === 'ok') {
              ui.setChapterStatus(chapter.uid, record.warning ? 'warning' : 'ok', chapter.title);
            } else if (record && record.status === 'failed') {
              ui.setChapterStatus(chapter.uid, 'failed', chapter.title);
            }
          }
        }
      }

      if (wantNotes) {
        try {
          if (!wantBook) ui.startExport(1, '准备读取笔记与标注…');
          const payload = await buildNotesExport(options, signal, (info) => {
            if (info.phase === 'notes-start') {
              ui.updateProgress({ index: 0, total: 1, ok: 0, failed: 0, label: '正在读取我的划线与想法…' });
            } else if (info.phase === 'notes-progress') {
              ui.updateProgress({ index: 1, total: 1, ok: 1, failed: 0, label: '正在整理笔记…' });
            }
          });
          done.push(payload);
        } catch (error) {
          if (error && error.code === WRX.ErrorCode.ABORTED) throw error;
          failures.push({ kind: '笔记', error: error });
          console.warn('[微信读书导出] 笔记导出失败：', error);
        }
      }

      // 下载：每个产物一个文件
      let downloadBlocked = 0;
      for (const payload of done) {
        if (!downloadSilently(payload)) downloadBlocked += 1;
      }

      // 结果卡片：以最后一个产物为基准，附上本次成功导出的文件清单
      const primary = done[done.length - 1];
      if (primary) {
        const fileList = done.map((p) => p.filename);
        const kindLabel = done.length > 1
          ? '全文 + 笔记 · 共 ' + done.length + ' 个文件'
          : (primary.metaOverride ||
            String(primary.format).toUpperCase() + ' · 成功 ' + primary.result.stats.ok + ' 章');
        const view = Object.assign({}, primary.result, {
          filename: fileList.join(' + '),
          metaOverride: String(primary.format).toUpperCase() + ' · ' + kindLabel,
          files: fileList,
        });
        ui.finishExport(view);
      }

      // 提示
      const noteWarnings = [];
      for (const payload of done) {
        if (payload.kind === 'notes' && payload.result.notes && payload.result.notes.warnings) {
          noteWarnings.push.apply(noteWarnings, payload.result.notes.warnings);
        }
      }
      if (noteWarnings.length) ui.showNotice(noteWarnings.join('\n'), 'warn');

      if (failures.length) {
        const detail = failures
          .map((f) => f.kind + '：' + ((f.error && f.error.message) || '未知错误'))
          .join('\n');
        ui.showNotice('部分内容导出失败\n' + detail, 'error', { retry: true });
        ui.toast('导出完成，但「' + failures.map((f) => f.kind).join('、') + '」失败', 'error', 5200);
      } else {
        const names = done.map((p) => p.filename).join('、');
        ui.toast('导出完成：' + names, 'success', 4200);
      }

      if (downloadBlocked) {
        ui.toast('有 ' + downloadBlocked + ' 个文件被浏览器拦截，请点击结果里的「下载文件」', 'error', 5200);
      }

      const bookFailed = done.some((p) => p.kind === 'book' && p.result.stats.failed > 0);
      ui.setRetryVisible(bookFailed || exporter.getFailures().length > 0);
    } catch (error) {
      ui.hideProgress();
      ui.setBusy(false);
      const code = error && error.code;
      if (code === WRX.ErrorCode.ABORTED) {
        ui.toast('已取消导出。已完成的章节已缓存，再次导出会接着来。');
      } else {
        const message = (error && error.message) || String(error);
        ui.showNotice('导出失败：' + message, 'error', { retry: true });
        ui.toast('导出失败：' + message, 'error', 5200);
        console.warn('[微信读书导出] 导出失败：', error);
      }
    } finally {
      exporting = false;
      taskBusy = false;
      ui.setBusy(false);
      client.setSignal(null);
      currentController = null;
    }
  }

  async function exportShelfNotes() {
    if (exporting) {
      ui.toast('正在导出中…');
      return;
    }

    exporting = true;
    taskBusy = true;
    currentController = new AbortController();
    client.setSignal(currentController.signal);

    const options = ui.getOptions();
    ui.startExport(0, '准备读取书架与笔记本…');
    ui.setRetryVisible(false);

    try {
      const result = await exporter.exportShelfNotes({
        format: options.format,
        frontMatter: options.frontMatter,
        includePopular: options.includePopular,
        signal: currentController.signal,
        onProgress: (info) => {
          if (info.phase === 'shelf-start') {
            ui.updateProgress({
              index: 0, total: 1, ok: 0, failed: 0,
              label: '正在读取书架与笔记本…',
            });
          } else if (info.phase === 'shelf-fetch' || info.phase === 'shelf-progress') {
            ui.updateProgress({
              index: info.index || 0,
              total: info.total || 1,
              ok: info.ok || 0,
              failed: info.failed || 0,
              label: info.title ? '正在读取《' + info.title + '》的笔记…' : undefined,
            });
          }
        },
      });

      const filename = SHELF_NOTES_FILENAME_BASE + '.' + (EXT_BY_FORMAT[options.format] || 'md');
      const view = Object.assign({}, result, { filename: filename, unit: '本书' });
      ui.finishExport(view);
      ui.toast(
        '全书架笔记导出完成：' + result.stats.ok + ' 本书，' + filename,
        'success',
        4200
      );

      try {
        downloadText(result.content, filename, options.format);
      } catch (error) {
        console.warn('[微信读书导出] 自动下载失败，请点击「下载文件」：', error);
        ui.toast('自动下载被拦截，请点击结果里的「下载文件」', 'error', 5000);
      }
    } catch (error) {
      ui.hideProgress();
      ui.setBusy(false);
      const code = error && error.code;
      if (code === WRX.ErrorCode.ABORTED) {
        ui.toast('已取消导出');
      } else {
        const message = (error && error.message) || String(error);
        ui.showNotice('全书架笔记导出失败：' + message, 'error', { retry: false });
        ui.toast('全书架笔记导出失败：' + message, 'error', 5200);
        console.warn('[微信读书导出] 全书架笔记导出失败：', error);
      }
    } finally {
      exporting = false;
      taskBusy = false;
      ui.setBusy(false);
      client.setSignal(null);
      currentController = null;
    }
  }

  function cancelExport() {
    if (!currentController) return;
    ui.toast('正在取消…');
    try {
      currentController.abort();
    } catch (error) {
      /* ignore */
    }
  }

  function jumpToChapter(uid) {
    const chapter = findChapterByUid(uid);
    if (!chapter) return;
    const parsed = WRX.readerState.parseReaderPath(location.pathname);
    const bookHash = parsed.bookHash || WRX.wereadEncode(exporter.book.bookId);
    const chapterHash = WRX.wereadEncode(chapter.uid);
    location.assign(WRX.readerState.readerUrl(bookHash, chapterHash));
  }

  // ------------------------------------------------------------------ 启动

  async function boot() {
    if (booting) return;
    booting = true;
    ui.clearNotice();
    try {
      await bootOnce();
    } finally {
      booting = false;
    }
  }

  async function bootOnce() {
    let lastError = null;

    for (let attempt = 0; attempt < 12; attempt += 1) {
      if (attempt > 0) await sleep(700);
      try {
        const info = await exporter.init();
        const options = ui.getOptions();
        exporter.setOptions({
          delayMs: options.delayMs,
          maxAttempts: options.maxAttempts,
          refreshEvery: options.refreshEvery,
        });

        const chapters = exporter.chapters;
        ui.setBook({
          title: exporter.book.title,
          author: exporter.book.author,
          count: chapters.filter((chapter) => !chapter.isVolume).length,
        });
        ui.setChapters(chapters);
        ui.setRetryVisible(exporter.getFailures().length > 0);

        let chapter = resolveCurrentChapterFromUrl() || resolveCurrentChapterFromState(info.state);
        if (!chapter) {
          const progress = await client.getProgress(exporter.book.bookId);
          if (progress && progress.book) {
            chapter = resolveCurrentChapterFromState({ progress: progress });
          }
        }
        setCurrentChapter(chapter);
        // 初始化完成后再解除按钮禁用状态。
        ui.setBusy(false);

        initialized = true;
        bootError = null;
        ui.setShelfReady(true);
        if (ui.isPanelOpen()) ui.toast('已就绪：' + exporter.book.title, 'success');
        return;
      } catch (error) {
        lastError = error;
        console.warn('[微信读书导出] 初始化失败（第 ' + (attempt + 1) + ' 次）：', error);
        // 目录错误重试意义不大，直接跳出。
        if (error && (error.code === WRX.ErrorCode.CATALOG || error.code === WRX.ErrorCode.STATE)) {
          break;
        }
      }
    }

    bootError = (lastError && lastError.message) || '未知错误';
    ui.setBook(null);
    ui.setShelfReady(false);
    ui.showNotice(
      '无法读取书籍信息：' +
        bootError +
        '\n请确认已登录微信读书并打开一章正文，然后刷新页面重试。',
      'error',
      { retry: true }
    );
    ui.setCurrentChapter(null);
  }

  function resetForNewBook() {
    client.state = null;
    client.catalog = null;
    client.book = null;
    client.detectedFormat = null;
    exporter.cache.clear();
    exporter.chapters = [];
    exporter.book = null;
    exporter.detectedFormat = null;
    initialized = false;
    currentChapter = null;
    if (ui) ui.setShelfReady(false);
  }

  function handleUrlChange() {
    if (!READER_PATH.test(location.pathname)) {
      ui.setVisible(false);
      return;
    }
    ui.setVisible(true);

    const parsed = WRX.readerState.parseReaderPath(location.pathname);
    const currentBookHash = exporter.book ? WRX.wereadEncode(exporter.book.bookId) : '';

    // 站内切换到另一本书（SPA 路由）时，重新初始化。
    // 正在导出时不打断，等导出结束后用户再刷新即可。
    if (!exporting && parsed.bookHash && parsed.bookHash !== currentBookHash) {
      resetForNewBook();
      ui.clearResult();
      ui.setChapters([]);
      ui.setCurrentChapter(null);
      ui.setBook({ title: '正在读取书籍信息…', author: '', count: 0 });
      boot();
      return;
    }

    if (!initialized) return;

    const chapter = resolveCurrentChapterFromUrl();
    if (chapter) {
      setCurrentChapter(chapter);
    }
  }

  function mount() {
    const handlers = {
      onCopyCurrent: () => copyChapter(null),
      onSaveCurrent: () => saveChapter(null),
      onCopyChapter: (uid) => copyChapter(uid),
      onSaveChapter: (uid) => saveChapter(uid),
      onExport: () => {
        if (!initialized) {
          ui.toast('正在重新读取书籍信息…');
          boot();
          return;
        }
        exportSelected();
      },
      onExportShelfNotes: () => exportShelfNotes(),
      onCancel: () => cancelExport(),
      onJumpChapter: (uid) => jumpToChapter(uid),
      onRetryFailed: () => {
        exporter.clearFailed();
        exportBook();
      },
      onSettingsChange: (options) => {
        exporter.setOptions({
          delayMs: options.delayMs,
          maxAttempts: options.maxAttempts,
          refreshEvery: options.refreshEvery,
        });
      },
      onSaveResult: () => {
        if (!ui.result || !ui.result.content) return;
        downloadText(ui.result.content, ui.result.filename, ui.result.format);
        ui.toast('已开始下载', 'success');
      },
      onCopyResult: async () => {
        if (!ui.result || !ui.result.content) return;
        try {
          await copyText(ui.result.content);
          ui.toast('全文已复制到剪贴板', 'success');
        } catch (error) {
          ui.toast(error.message, 'error');
        }
      },
    };

    ui = new WRX.ExporterUI(handlers);
    ui.setVisible(READER_PATH.test(location.pathname));
    ui.mount();
    ui.setCurrentChapter(null);

    boot();

    let lastHref = location.href;
    setInterval(() => {
      if (location.href === lastHref) return;
      lastHref = location.href;
      handleUrlChange();
    }, 1200);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', mount, { once: true });
  } else {
    mount();
  }
})();
