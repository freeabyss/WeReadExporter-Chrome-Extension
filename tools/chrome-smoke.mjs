#!/usr/bin/env node
/**
 * 真实 Chrome 冒烟测试。
 *
 * 做法：
 *  1. 复制一份扩展，把 matches 换成 http://127.0.0.1/*（内容脚本逻辑完全一致）；
 *  2. 用本地 HTTP 服务模拟微信读书的阅读页与章节接口；
 *  3. 以 --load-extension 启动真实 Chrome（headless），通过 CDP 打开页面、点击「导出全文」；
 *  4. 校验真实下载的 .md 文件里每一章的开头/结尾都在（即"全文"而不是试读片段）。
 *
 * 运行：node tools/chrome-smoke.mjs
 * 依赖：本机安装 Google Chrome。
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { createMockWeread, encodeRef, makeEpubChapterHtml, signRef } from '../tests/helpers/weread-mock.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CHROME =
  process.env.CHROME_PATH ||
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

const KEEP_TMP = !!process.env.WRX_KEEP_TMP;

function log(...args) {
  console.log('[chrome-smoke]', ...args);
}

function fail(message) {
  console.error('[chrome-smoke] ❌ ' + message);
  process.exit(1);
}

function assert(condition, message) {
  if (!condition) fail(message);
}

// ---------------------------------------------------------------- 测试数据

function makeChapters(count) {
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
      title: `第${i}章 真实浏览器测试`,
      wordCount: text.length,
      text: `【本章开头-${i}】` + text + `【本章结尾-${i}】`,
      html: makeEpubChapterHtml(
        `第${i}章 真实浏览器测试`,
        [`【本章开头-${i}】`].concat(paragraphs).concat([`【本章结尾-${i}】`])
      ),
    });
  }
  return chapters;
}

const book = {
  bookId: '43208843',
  title: '真实浏览器之书',
  author: '冒烟测试',
  format: 'epub',
  chapters: makeChapters(3),
};

const NOTES = {
  highlights: [
    { chapterUid: 1, markText: '真实浏览器第一句划线', range: '10-20', createTime: 1765000000 },
    { chapterUid: 2, markText: '真实浏览器第二句划线', range: '30-40', createTime: 1765000100 },
  ],
  reviews: [
    { content: '对第一句划线的真实想法', range: '10-20', abstract: '真实浏览器第一句划线', chapterUid: 1 },
    { content: '一条独立想法', chapterUid: 2 },
  ],
  popular: [{ chapterUid: 1, markText: '真实浏览器热门划线', totalCount: 66 }],
  notebooks: [
    { bookId: '43208843', title: '真实浏览器之书', author: '冒烟测试', noteCount: 2, reviewCount: 2 },
  ],
};

// ---------------------------------------------------------------- 扩展副本

async function prepareExtension() {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'wrx-ext-'));
  await fsp.cp(path.join(ROOT, 'src'), path.join(dir, 'src'), { recursive: true });
  await fsp.cp(path.join(ROOT, 'icons'), path.join(dir, 'icons'), { recursive: true });

  const manifest = JSON.parse(await fsp.readFile(path.join(ROOT, 'manifest.json'), 'utf8'));
  manifest.content_scripts[0].matches = ['http://127.0.0.1/*'];
  manifest.host_permissions = ['http://127.0.0.1/*'];
  await fsp.writeFile(path.join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2));
  return dir;
}

// ---------------------------------------------------------------- 本地服务

function startServer() {
  const mock = createMockWeread({ book: book, pagePsvts: 'pspage0001', notes: NOTES });

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://127.0.0.1');
      let body = null;
      if (req.method === 'POST') {
        const chunks = [];
        for await (const chunk of req) chunks.push(chunk);
        const raw = Buffer.concat(chunks).toString('utf8');
        try {
          body = raw ? JSON.parse(raw) : null;
        } catch (error) {
          body = null;
        }
      }

      const result = await mock.handle({ path: url.pathname + url.search, method: req.method, body });
      if (url.pathname === '/favicon.ico') {
        res.writeHead(204).end();
        return;
      }
      res.writeHead(result.status, { 'content-type': result.contentType });
      res.end(result.body);
    } catch (error) {
      console.error('[chrome-smoke] server error', error);
      res.writeHead(500).end('error');
    }
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({ server, port: server.address().port, mock });
    });
  });
}

// ---------------------------------------------------------------- CDP 客户端

class CDP {
  constructor(ws) {
    this.ws = new WebSocket(ws);
    this.nextId = 1;
    this.pending = new Map();
    this.ws.addEventListener('message', (event) => {
      const message = JSON.parse(event.data);
      if (message.id && this.pending.has(message.id)) {
        const { resolve, reject } = this.pending.get(message.id);
        this.pending.delete(message.id);
        if (message.error) reject(new Error(JSON.stringify(message.error)));
        else resolve(message.result);
      }
    });
  }

  async ready() {
    if (this.ws.readyState === WebSocket.OPEN) return;
    await new Promise((resolve, reject) => {
      this.ws.addEventListener('open', resolve, { once: true });
      this.ws.addEventListener('error', () => reject(new Error('WebSocket 连接失败')), { once: true });
    });
  }

  send(method, params, sessionId) {
    const id = this.nextId++;
    const payload = { id, method, params: params || {} };
    if (sessionId) payload.sessionId = sessionId;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify(payload));
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error('CDP 超时：' + method));
        }
      }, 30000);
    });
  }

  close() {
    try {
      this.ws.close();
    } catch (error) {
      /* ignore */
    }
  }
}

async function waitForFile(filePath, timeoutMs) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (fs.existsSync(filePath)) {
      const stats = await fsp.stat(filePath);
      if (stats.size > 0) return stats;
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  return null;
}

// ---------------------------------------------------------------- 主流程

async function main() {
  if (!fs.existsSync(CHROME)) fail('找不到 Chrome：' + CHROME);

  const tmpRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'wrx-smoke-'));
  const extDir = await prepareExtension();
  const profileDir = path.join(tmpRoot, 'profile');
  const downloadDir = path.join(tmpRoot, 'downloads');
  await fsp.mkdir(profileDir, { recursive: true });
  await fsp.mkdir(downloadDir, { recursive: true });

  const { server, port, mock } = await startServer();
  const bookHash = encodeRef(book.bookId);
  const chapterHash = encodeRef(book.chapters[0].uid);
  const pageUrl = `http://127.0.0.1:${port}/web/reader/${bookHash}k${chapterHash}`;
  log('测试页面：' + pageUrl);

  const chrome = spawn(
    CHROME,
    [
      '--headless=new',
      '--disable-gpu',
      '--no-sandbox',
      '--disable-breakpad',
      '--disable-crash-reporter',
      '--disable-dev-shm-usage',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-background-networking',
      '--disable-component-update',
      '--disable-sync',
      '--metrics-recording-only',
      '--mute-audio',
      '--remote-debugging-port=0',
      '--user-data-dir=' + profileDir,
      'about:blank',
    ],
    { stdio: ['ignore', 'pipe', 'pipe'] }
  );

  let chromeLog = '';
  chrome.stderr.on('data', (data) => {
    chromeLog += data.toString();
  });
  chrome.stdout.on('data', (data) => {
    chromeLog += data.toString();
  });

  let cdp = null;
  try {
    const portFile = path.join(profileDir, 'DevToolsActivePort');
    const started = Date.now();
    while (!fs.existsSync(portFile)) {
      if (Date.now() - started > 30000) {
        fail('Chrome 未能启动。日志：\n' + chromeLog.slice(-2000));
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    const cdpPort = Number((await fsp.readFile(portFile, 'utf8')).split('\n')[0]);
    log('Chrome 调试端口：' + cdpPort);

    const versionResponse = await fetch(`http://127.0.0.1:${cdpPort}/json/version`);
    const version = await versionResponse.json();
    log('Chrome：' + version.Browser);

    cdp = new CDP(version.webSocketDebuggerUrl);
    await cdp.ready();

    // Chrome 137+ 不再支持 --load-extension，改用 CDP 的 Extensions.loadUnpacked。
    const loaded = await cdp.send('Extensions.loadUnpacked', { path: extDir });
    log('扩展已加载：' + loaded.id);
    await new Promise((resolve) => setTimeout(resolve, 500));

    const { targetId } = await cdp.send('Target.createTarget', { url: pageUrl });
    const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });

    try {
      await cdp.send(
        'Browser.setDownloadBehavior',
        { behavior: 'allow', downloadPath: downloadDir, eventsEnabled: true },
        sessionId
      );
    } catch (error) {
      await cdp.send('Page.setDownloadBehavior', { behavior: 'allow', downloadPath: downloadDir }, sessionId);
    }

    await cdp.send('Runtime.enable', {}, sessionId);

    const evaluate = async (expression) => {
      const result = await cdp.send(
        'Runtime.evaluate',
        { expression, returnByValue: true, awaitPromise: true },
        sessionId
      );
      if (result.exceptionDetails) {
        throw new Error('页面脚本异常：' + JSON.stringify(result.exceptionDetails.exception));
      }
      return result.result.value;
    };

    // 等待扩展挂载 UI 并完成初始化
    const readyExpression = `(() => {
      const host = document.getElementById('wrx-host');
      if (!host || !host.shadowRoot) return { ready: false, why: 'no host' };
      const root = host.shadowRoot;
      const button = root.querySelector('[data-act="export-book"]');
      return {
        ready: !!(button && !button.disabled),
        title: root.querySelector('.book-title').textContent,
        sub: root.querySelector('.book-sub').textContent,
        chapters: root.querySelectorAll('.chapter-list li').length,
        notice: root.querySelector('.notice-slot').textContent,
      };
    })()`;

    let ready = null;
    const readyStart = Date.now();
    while (Date.now() - readyStart < 20000) {
      ready = await evaluate(readyExpression);
      if (ready && ready.ready) break;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    assert(ready && ready.ready, '扩展未就绪：' + JSON.stringify(ready));
    log('面板已就绪：' + ready.title + ' / ' + ready.sub);

    // 点击「导出全文」
    await evaluate(`(() => {
      const root = document.getElementById('wrx-host').shadowRoot;
      root.querySelector('[data-act="export-book"]').click();
      return true;
    })()`);

    const resultExpression = `(() => {
      const root = document.getElementById('wrx-host').shadowRoot;
      const result = root.querySelector('.result');
      return {
        done: !result.hidden,
        text: result.textContent,
        notice: root.querySelector('.notice-slot').textContent,
        progress: root.querySelector('.progress-text').textContent,
      };
    })()`;

    let state = null;
    const exportStart = Date.now();
    while (Date.now() - exportStart < 60000) {
      state = await evaluate(resultExpression);
      if (state && (state.done || state.notice)) break;
      await new Promise((resolve) => setTimeout(resolve, 300));
    }

    assert(state && state.done, '导出未完成：' + JSON.stringify(state));
    log('导出结果：' + state.text.replace(/\s+/g, ' ').slice(0, 160));

    // 校验真实下载的文件
    const expectedName = book.title + '.md';
    const filePath = path.join(downloadDir, expectedName);
    const stats = await waitForFile(filePath, 15000);
    assert(stats, '没有找到下载文件 ' + expectedName + '，目录：' + (await fsp.readdir(downloadDir)).join(','));

    const content = await fsp.readFile(filePath, 'utf8');
    assert(content.startsWith('# ' + book.title), 'Markdown 头部不正确');
    for (const chapter of book.chapters) {
      assert(
        content.includes(`【本章开头-${chapter.uid}】`) && content.includes(`【本章结尾-${chapter.uid}】`),
        '第 ' + chapter.uid + ' 章内容不完整（只导出了片段？）'
      );
    }
    assert(!content.includes('试读'), '导出内容不应包含试读标记');

    // 笔记与标注：默认勾选「附带我的划线与想法」，应与正文同处一个文件
    assert(content.includes('笔记与标注'), '下载文件应含「笔记与标注」小节');
    assert(content.includes('真实浏览器第一句划线'), '含第一章划线原文');
    assert(content.includes('真实浏览器第二句划线'), '含第二章划线原文');
    assert(content.includes('对第一句划线的真实想法'), '含关联到划线的想法');
    assert(content.includes('一条独立想法'), '含独立想法');
    assert(!content.includes('真实浏览器热门划线'), '热门划线默认关闭');
    log('笔记校验通过：同一文件内按章节分组，含 2 条划线 + 2 条想法');

    log('下载文件校验通过：' + expectedName + '（' + (content.length / 1024).toFixed(1) + ' KB）');

    // 校验接口参数：sc=1 + 签名正确
    const contentRequests = mock.state.requests.filter(
      (request) => request.path.startsWith('/web/book/chapter/') && request.method === 'POST'
    );
    assert(contentRequests.length >= book.chapters.length * 3, '章节请求数量不足');
    for (const request of contentRequests) {
      const body = request.body;
      assert(body.sc === 1, '请求没有使用 sc=1：' + request.path);
      assert(body.prevChapter === false, 'prevChapter 必须是布尔 false');
      assert(body.ps === 'pspage0001', 'ps 应来自页面状态');
      assert(body.pc === encodeRef(String(body.ct)), 'pc 应为 _e(ct)');
      const unsigned = Object.assign({}, body);
      delete unsigned.s;
      assert(body.s === signRef(unsigned), '签名不正确：' + request.path);
    }
    log('接口参数校验通过：' + contentRequests.length + ' 个章节分片请求');

    const notePaths = mock.state.requests.map((request) => request.path);
    assert(notePaths.some((p) => p.startsWith('/web/book/bookmarklist')), '应请求划线接口');
    assert(notePaths.some((p) => p.startsWith('/web/review/list/mine')), '应请求想法接口');
    assert(!notePaths.some((p) => p.startsWith('/web/book/bestbookmarks')), '未勾选时不应请求热门划线');
    log('笔记接口校验通过：划线 + 想法，未请求热门划线');

    // 复制章节：导出过程是异步的，此时已经没有用户手势，
    // 必须确认剪贴板兜底方案能正常工作。
    await evaluate(`(() => {
      const root = document.getElementById('wrx-host').shadowRoot;
      const button = root.querySelector('.chapter-list li [data-act="copy"]');
      if (button) button.click();
      return true;
    })()`);

    const toastExpression = `(() => {
      const root = document.getElementById('wrx-host').shadowRoot;
      return { toast: root.querySelector('.toast').textContent, visible: !root.querySelector('.toast').hidden };
    })()`;

    let copied = null;
    const copyStart = Date.now();
    while (Date.now() - copyStart < 15000) {
      copied = await evaluate(toastExpression);
      if (copied && copied.toast && /已复制|复制失败/.test(copied.toast)) break;
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    assert(copied && /已复制/.test(copied.toast), '复制章节失败：' + JSON.stringify(copied));
    log('剪贴板校验通过：' + copied.toast.replace(/\s+/g, ' ').slice(0, 80));

    // 可选：截图（用于 README / 人工检查）
    const screenshotPath = process.env.WRX_SCREENSHOT;
    if (screenshotPath) {
      await cdp.send(
        'Emulation.setDeviceMetricsOverride',
        { width: 1280, height: 900, deviceScaleFactor: 2, mobile: false },
        sessionId
      );
      // 打开面板并展开章节列表，让截图更有代表性
      await evaluate(`(() => {
        const host = document.getElementById('wrx-host');
        const root = host.shadowRoot;
        if (root.querySelector('.panel').hidden) root.querySelector('.fab').click();
        const toggle = root.querySelector('[data-act="toggle-chapters"]');
        if (toggle && toggle.getAttribute('aria-expanded') === 'false') toggle.click();
        return true;
      })()`);
      await new Promise((resolve) => setTimeout(resolve, 2800));
      const shot = await cdp.send('Page.captureScreenshot', { format: 'png' }, sessionId);
      await fsp.mkdir(path.dirname(screenshotPath), { recursive: true });
      await fsp.writeFile(screenshotPath, Buffer.from(shot.data, 'base64'));
      log('截图已保存：' + screenshotPath);
    }

    console.log('\n✅ 真实 Chrome 冒烟测试全部通过');
  } finally {
    if (cdp) cdp.close();
    chrome.kill('SIGKILL');
    server.close();
    if (!KEEP_TMP) {
      await fsp.rm(tmpRoot, { recursive: true, force: true }).catch(() => {});
      await fsp.rm(extDir, { recursive: true, force: true }).catch(() => {});
    } else {
      log('临时目录保留：' + tmpRoot + ' / ' + extDir);
    }
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
