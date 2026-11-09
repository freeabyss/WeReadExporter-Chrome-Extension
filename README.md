# 微信读书导出助手 · Chrome 扩展

在**微信读书网页版**一键导出 **当前章节** 或 **整本书全文**，支持 **Markdown / HTML / TXT**。

本项目由 [WeReadExporter-Tampermonkey](https://github.com/henonguan1688-lab/WeReadExporter-Tampermonkey) 的油猴脚本改造为 **Chrome 扩展（Manifest V3）**，并修复了原脚本 **无法导出全文** 的问题。

> **公开仓库**：https://github.com/freeabyss/WeReadExporter-Chrome-Extension
> **下载 / Release**：https://github.com/freeabyss/WeReadExporter-Chrome-Extension/releases
> **上架 Chrome 网上应用店指南**：[docs/PUBLISH.md](docs/PUBLISH.md)（含审核政策风险、商店素材、可直接粘贴的文案）
> **隐私政策**：[PRIVACY.md](PRIVACY.md)

![面板截图](docs/panel.png)

---

## 一、这次修了什么

### 1. 「无法导出全文」的根因：`sc` 参数

原脚本在请求章节正文时用的是：

```js
sc: 0   // ← 只会返回一小段试读
```

微信读书的章节内容接口只有在 **`sc: 1`** 时才返回整章正文，`sc: 0` 只返回试读片段。
所以旧脚本复制出来的内容总是「半截」，整本书自然也无法导全。

同时还有几个叠加问题：

| # | 旧实现 | 后果 | 现在 |
|---|---|---|---|
| 1 | `pc` 取自页面「上一次请求」的旧值 | 会话参数过期 → 空内容 / 试读 | 每次请求都按 `pc = _e(ct)` 实时生成 |
| 2 | `prevChapter: "false"`（字符串） | 与签名约定不一致，可能被判非法 | 改为布尔 `false`，签名与请求体一致 |
| 3 | TXT 格式书籍（大量网文）按 EPUB 抓取 | `e_*` 接口返回目录 JSON，解码后为空 | 用 `e_0` 的返回值探测格式，自动改用 `t_0/t_1` |
| 4 | 短章节的 `e_1 / e_3` 返回 `{}` | `'{}'.slice(32)` 得到空串，**静默**产出残缺内容 | 校验 MD5、跳过空分片，内容明显偏短会重试 |
| 5 | `ps`（`psvts`）靠 XHR 钩子拦截 | 页面换用 fetch/提前渲染就失效；扩展 isolated world 里根本拦不到 | 直接读取页面内联 `__INITIAL_STATE__`，失效时自动拉阅读页刷新 |
| 6 | 没有整本导出 | README 宣传的「整本书全文」实际不存在 | 新增「导出全文」：逐章抓取、进度、取消、失败重试 |
| 7 | 未校验章节完整性 | 服务端返回试读也照单全收 | 用目录里的 `wordCount` 对比，异常自动重试并明确告警 |
| 8 | 当前章节兜底写成 `cid = c.chapterIdx` | 拿到错误的章节 | 修正为 `chapterUid`，并优先用 URL 中的章节 hash 精确匹配 |

### 2. 真正实现「导出全文」

- 读取目录后**逐章抓取**，实时显示 `已完成/总数 + 百分比 + 当前章节`；
- 可随时**取消**；已完成的章节会缓存在内存里，再次导出自动跳过；
- 每章校验 MD5 与字数，偏短（疑似试读/截断）会刷新会话参数并重试；
- 单章失败**不会中断**整本导出，结束后给出失败清单，一键「重试失败」；
- 导出完成后自动下载文件，同时在面板里提供「下载文件 / 复制全文」。

### 3. 从油猴脚本到 Chrome 扩展

- 不再依赖 jQuery 与远程 `@require`（Turndown 已本地内置，离线可用）；
- 面板使用 **Shadow DOM** 隔离样式，不再像旧脚本那样注入全局 `<style>` 污染页面；
- 不再依赖 XHR 钩子，改用页面内联状态 + 同源接口；
- 新增 popup（扩展图标）说明页、图标、拖拽记忆位置、深浅色适配。

---

## 二、安装

### 方式 A：直接加载本仓库（推荐用于开发调试）

1. 打开 `chrome://extensions/`；
2. 右上角打开 **开发者模式**；
3. 点击 **加载已解压的扩展程序**，选择本项目根目录（包含 `manifest.json` 的目录）；
4. 打开 <https://weread.qq.com/web/shelf> 并进入任意一本书的阅读页；
5. 页面右下角出现蓝色 **「导出」** 悬浮按钮。

### 方式 B：下载 Release（推荐给普通用户）

到 <https://github.com/freeabyss/WeReadExporter-Chrome-Extension/releases> 下载 `weread-exporter-v1.0.0.zip`，
解压后在 `chrome://extensions/` 中选择解压出来的目录加载即可。

### 方式 C：自行打包（开发用）

```bash
npm run package          # 给用户手动加载的完整 zip：dist/weread-exporter-v1.0.0.zip
npm run package:store    # 上传商店用的精简 zip：dist/weread-exporter-store-v1.0.0.zip
```

> 支持 Chrome / Edge 等 Chromium 内核浏览器（要求 Chrome 102+，实测 Chrome 156）。
> 上架 Chrome 网上应用店的完整流程（账号注册、素材、文案、权限说明、审核风险）见 [docs/PUBLISH.md](docs/PUBLISH.md)。

---

## 三、使用

1. 在阅读页点击右下角 **「导出」**；
2. 选择输出格式：**Markdown / HTML / TXT**；
3. 点 **「导出全文」**：
   - 进度条实时显示抓取进度，可点「取消导出」；
   - 完成后自动下载 `书名.md`（或 `.html` / `.txt`），并在面板里保留结果卡片；
   - 有章节失败时会列出失败清单，点「重试失败」补齐。
4. **当前章节**：「复制本章 / 下载本章」；
5. **章节列表**：点标题可跳转到该章；每章右侧可单独复制/下载；导出后显示 ✓ / ⚠ / ✕ 状态；
6. **高级设置**（可调）：
   - 请求间隔（默认 260ms，越大越稳）；
   - 失败重试次数（默认 3）；
   - 会话刷新间隔（默认每 40 章强制刷新一次 `psvts`）；
   - 是否附带「书名 / 作者 / 导出时间」。

### 输出效果

- **Markdown**：`# 书名` + 章节 `## 标题`，保留段落、图片、划线/注音处理；
- **HTML**：单文件，带目录、响应式排版、深浅色适配，可直接用浏览器打开；
- **TXT**：纯文本，适合任意阅读器。

---

## 四、权限与隐私

扩展只申请一个权限：

- `clipboardWrite`：把章节/全文写进剪贴板。

内容脚本仅在 `https://weread.qq.com/web/reader/*` 运行；**没有后台进程、不申请网络权限、不上传任何数据**。所有请求都是你在阅读页里对微信读书的同源请求，登录态由浏览器 Cookie 自动携带（扩展不会读取或导出 Cookie）。

---

## 五、已知限制

- **只能导出你当前账号有权阅读的章节**：未购买 / 非会员 / 已下架的章节无法获取，面板会列出来，不会静默变成空内容；
- **不支持公众号文章**（`MP_WXS_` 开头）：其接口与普通书籍完全不同，本项目未实现；
- **图片**：正文里的图片是微信读书 CDN 地址，离线打开 Markdown/HTML 时可能无法显示（需要登录态）；暂未把图片打包进导出文件；
- **速度**：默认每两次请求间隔 260ms，几百章的书需要几分钟；
- **会话有效期**：长时间导出时会自动刷新 `psvts` 并重试；若失败提示「登录状态已失效」，刷新页面重新登录后再次导出即可（已完成的章节有缓存）。
- 微信读书前端算法可能随时改版；签名、解码、接口均已拆成独立模块，便于后续更新。

---

## 六、项目结构

```text
├── manifest.json            # MV3 清单（仅内容脚本 + popup）
├── src/
│   ├── content.js           # 入口：装配 UI / 客户端 / 导出器，处理 SPA 路由
│   ├── ui.js                # 悬浮面板（原生 JS + Shadow DOM）
│   ├── popup.html / popup.js# 扩展图标弹出说明页
│   ├── lib/
│   │   ├── namespace.js     # 命名空间、错误类型、sleep
│   │   ├── md5.js           # 纯 JS MD5（UTF-8）
│   │   ├── weread-hash.js   # _e 编码 + 请求签名（修复 sc/pc/prevChapter）
│   │   ├── weread-decode.js # 分片 MD5 校验、字符交换还原、base64、UTF-8
│   │   ├── weread-state.js  # 从页面 __INITIAL_STATE__ 提取 bookId/psvts
│   │   ├── weread-api.js    # 目录、章节分片、格式探测、会话刷新
│   │   ├── formats.js       # Markdown / HTML / TXT 组装
│   │   └── exporter.js      # 整本导出、缓存、重试、完整性校验
│   └── vendor/turndown.js   # HTML → Markdown（MIT）
├── icons/                   # 16/32/48/128 图标（tools/make-icons.py 生成）
├── store/                   # Chrome 商店素材：截图 / 宣传图（tools/make-store-assets.py 生成）
├── tests/                   # Node 测试 + jsdom 集成测试 + 参考向量
├── tools/                   # 图标与素材生成、Chrome 冒烟测试、打包脚本
├── docs/
│   ├── panel.png            # 真实 Chrome 截图
│   └── PUBLISH.md           # 上架 Chrome 网上应用店完整指南
├── PRIVACY.md               # 隐私政策（商店审核用）
├── legacy/main.user.js      # 原油猴脚本（保留，便于对照）
└── README.md
```

---

## 七、开发与测试

```bash
npm install              # 仅测试需要 jsdom
npm test                 # 26 个单元 + 集成测试
npm run test:chrome      # 真实 Chrome（headless + CDP）端到端冒烟测试
npm run icons            # 重新生成图标（需要 Pillow）
npm run store:assets     # 重新生成商店截图与宣传图（需要 Pillow）
npm run package          # 打包给用户加载的完整 zip
npm run package:store    # 打包上传 Chrome 商店的精简 zip
```

测试覆盖：

- `_e` 编码、请求签名：与**独立的参考实现**交叉验证（golden 向量由另一份 Python 实现生成）；
- 分片解码：用参考实现的编码器生成密文，验证解码结果逐字节一致（含 emoji / 中文 / 长文本）；
- 页面状态解析、TXT/EPUB 格式探测、目录筛选、完整性判断；
- **jsdom 端到端**：模拟微信读书接口，真实点击「导出全文」，断言每一章的开头与结尾都出现在导出内容里（即全文而非试读），并校验 `sc=1`、`pc=_e(ct)`、签名正确、`psvts` 过期自动刷新；
- **真实 Chrome 端到端**：本地起模拟接口，headless Chrome 加载扩展、点击导出，校验真实下载的 `.md` 文件内容与请求参数（运行需本机安装 Chrome，可用 `CHROME_PATH` 指定路径）。

> 说明：本仓库的自动化测试跑的是本地模拟接口；算法与接口参数来自公开的逆向参考实现（[weread.koplugin API 文档](https://github.com/finlater/weread.koplugin/blob/main/docs/weread-api-reference.md)）。真实账号下的抓取请在你的浏览器登录后自行验证。

---

## 八、技术要点（便于后续维护）

- **目录**：`POST /web/book/chapterInfos`（`{bookIds:[bookId]}`），兜底 `publicchapterInfos`；
- **正文分片**：
  - EPUB：`e_0` + `e_1` + `e_3`；
  - TXT：`t_0` + `t_1`；
  - 探测方式：`e_0` 返回目录型 JSON（含 `bookId`）即 TXT 书；
- **请求参数**：
  ```js
  { b: _e(bookId), c: _e(chapterUid), r: random(0..9999)^2,
    ct: 当前秒级时间戳, pc: _e(ct), ps: reader.psvts,
    sc: 1, prevChapter: false, st: 0, s: sign(按字典序 + encodeURIComponent) }
  ```
- **签名** `_0x58fb1d`：对排序后的 query 做位运算摘要（见 `weread-hash.js`）；
- **解码**：每个分片 = 32 位 MD5 + 密文；拼接后去首字符 → 还原字符交换 → base64url → UTF-8；
- **会话参数**：`ps` 来自页面内联状态 `reader.psvts`，失效时 GET `/web/reader/{bookHash}` 刷新。

---

## 九、更新日志

### v1.0.0

- 由 Tampermonkey 脚本改造为 Chrome 扩展（Manifest V3，无 jQuery，Shadow DOM UI）；
- **修复无法导出全文**：`sc: 1`、实时 `pc`、布尔 `prevChapter`、TXT 书籍格式探测、空分片处理；
- 新增整本导出：逐章进度、取消、失败重试、内存缓存、失败清单；
- 新增章节完整性校验（`wordCount` 对比）与 MD5 校验；
- 修复当前章节定位错误（`chapterIdx` → `chapterUid`）；
- 新增 26 个自动化测试与真实 Chrome 冒烟测试。

---

## 十、免责声明

本项目仅供**个人备份自己合法购买或有权阅读的内容**使用。请遵守微信读书的用户协议与相关法律法规，**不要传播、批量分发或用于商业用途**。因使用本项目产生的任何后果由使用者自行承担。

原项目：[WeReadExporter-Tampermonkey](https://github.com/henonguan1688-lab/WeReadExporter-Tampermonkey)（MIT）。
