# 发布到 Chrome 网上应用店（Chrome Web Store）

> 本文是**操作指南**。GitHub 上的公开仓库与 Release 已经就绪；上架 Chrome Web Store 需要你本人完成开发者账号注册与审核提交（涉及 Google 账号、$5 注册费、内容审核，Agent 无法代做）。

---

## 0. 先搞清楚：三种"发布"的区别

| 方式 | 是否需要审核 | 用户安装方式 | 适用场景 |
|---|---|---|---|
| **GitHub Release**（已完成） | 不需要 | 下载 zip → 解压 → `chrome://extensions` → 开发者模式 → 加载已解压的扩展程序 | 现在就能用，开源分发 |
| **Chrome 网上应用店 Public** | 需要（Google 人工 + 自动审核） | 商店一键安装 | 面向所有用户 |
| **商店 Unlisted（不公开列出）** | 需要 | 持链接可安装，搜索不到 | 小范围分发 |

> ⚠️ **重要的政策风险**：本扩展的功能是导出微信读书的书籍内容。Chrome Web Store 的[政策](https://developer.chrome.com/docs/webstore/program-policies)禁止"帮助未经授权获取第三方网站内容 / 侵犯知识产权"的产品，且名称中的"微信"属于他人商标。**上架审核有可能被拒**，也可能上架后因权利人投诉被下架。建议：
> - 名称与描述明确强调"仅供导出你本人已购买/有权阅读的内容，个人本地备份"；
> - 不要在名称里堆砌关键词；必要时改用中性名称（如 `WeRead 读书笔记导出`）；
> - 准备好[免责声明与隐私政策](../PRIVACY.md)；
> - 若被拒，优先采用 **GitHub Release + 加载已解压** 或 **Edge 加载项商店**（见第 7 节）。

---

## 1. 准备材料（本仓库已全部生成）

### 1.1 上传用 ZIP

```bash
npm run package -- --store
# → dist/weread-exporter-store-v1.2.0.zip
```

商店包**只包含运行时文件**（`manifest.json` 在 zip 根目录、`src/`、`icons/`），不含 docs/测试/README，符合商店对包体的要求。

> 另一个 `npm run package` 生成的是**给用户手动加载**的完整 zip（含文档），不要传它到商店。

### 1.2 商店图片素材

```bash
npm run icons                                   # 需要时重做图标
python3 tools/make-store-assets.py              # 需要 Pillow
```

| 素材 | 尺寸 | 是否必需 | 文件 |
|---|---|---|---|
| 扩展图标 | 128×128 PNG | **必需**（放在 zip 内 `icons/icon128.png`） | [icons/icon128.png](../icons/icon128.png) |
| 截图 1 | 1280×800 | **至少 1 张** | [store/screenshot-1-1280x800.png](../store/screenshot-1-1280x800.png) |
| 截图 2 | 1280×800 | 可选 | [store/screenshot-2-1280x800.png](../store/screenshot-2-1280x800.png) |
| 小型宣传图 | 440×280 | 强烈建议（不提供会排后） | [store/small-promo-440x280.png](../store/small-promo-440x280.png) |
| 横幅宣传图 | 1400×560 | 可选（用于精选展示） | [store/marquee-1400x560.png](../store/marquee-1400x560.png) |

尺寸依据官方 [Supplying Images](https://developer.chrome.com/docs/webstore/images) 文档：截图要求 1280×800 或 640×400、直角无留边；宣传图 Small 440×280、Marquee 1400×560。图标按规范做成 96×96 图案 + 四边各 16px 透明边距。

### 1.3 隐私政策 URL

公开可访问即可，直接用本仓库文件：

```
https://github.com/freeabyss/WeReadExporter-Chrome-Extension/blob/main/PRIVACY.md
```

内容与权限说明见 [PRIVACY.md](../PRIVACY.md)。

---

## 2. 注册开发者账号（一次性）

1. 打开 **Chrome Web Store Developer Dashboard**：<https://chromewebstore.google.com/devconsole>
   （旧地址 `chrome.google.com/webstore/developer/dashboard` 会跳转）
2. 用 Google 账号登录 → 同意《开发者协议》与政策 → 支付 **一次性 5 美元注册费**（Google Payments，需支持的国家或地区；中国大陆在官方支持列表内，但付款方式需自行确认）。
3. 填写 **Publisher display name**（发布者名称，会公开显示）、验证邮箱。
4. 注意：注册邮箱创建后不可更改；建议专门用一个邮箱。

官方步骤：[Register your developer account](https://developer.chrome.com/docs/webstore/register)、[Set up your developer account](https://developer.chrome.com/docs/webstore/set-up-account)。

---

## 3. 新建商品并上传包

1. Dashboard → **「Add new item / 新增商品」** → 上传 `dist/weread-exporter-store-v1.2.0.zip`。
2. 上传成功后会进入编辑页，左侧有 4 个标签：**商品信息 / 隐私权 / 分发 / 测试说明**。
3. 上传前 Google 会自动做一次静态检查（Manifest 合法性、远程代码、混淆等）。本扩展是 **Manifest V3**、所有依赖本地打包（无 CDN 远程代码）、只申请 `clipboardWrite` 与 `weread.qq.com` 主机访问，通常能顺利通过。

> 如果改过代码要更新版本：修改 `manifest.json` 的 `version`，重新 `npm run package -- --store`，在 Dashboard 里「上传新软件包」即可；版本号必须递增。

---

## 4. 填写「商品信息」(Store listing)

以下文案可直接复制粘贴。

**名称**（≤75 字符）

```
微信读书导出助手
```

**简短说明**（≤132 字符）

```
在微信读书网页版一键导出章节与整本书全文，支持 Markdown / HTML / TXT；本地运行，不收集任何数据。
```

**详细说明**

```
微信读书导出助手是一个开源、本地运行的 Chrome 扩展，帮助你在微信读书网页版里把「自己有权阅读」的内容保存到本地，方便归档、检索与二次整理。

功能
· 当前章节：复制本章 / 下载本章
· 整本书全文：逐章抓取，实时显示进度，可随时取消；失败章节自动重试并列出清单
· 三种格式：Markdown（.md）、单文件 HTML（.html，带目录与深浅色适配）、纯文本 TXT（.txt）
· 章节列表：点击标题跳转，逐章复制/下载，导出后显示成功 / 内容可能不完整 / 失败状态
· 高级设置：请求间隔、重试次数、会话刷新频率、是否附带书名与作者
· 面板可拖拽，位置与偏好本地记忆，支持深色模式

隐私与权限
· 不收集、不存储、不传输任何个人数据；无统计、无后台进程、无远程代码
· 仅申请 clipboardWrite（复制按钮）与 weread.qq.com 阅读页的主机访问
· 所有请求都是向微信读书同源接口发起，登录态由浏览器自行携带，扩展不读取 Cookie
· 完整说明：https://github.com/freeabyss/WeReadExporter-Chrome-Extension/blob/main/PRIVACY.md

注意
· 只能导出你当前账号已购买 / 已解锁的章节，未购买章节会被标为失败，不会被静默替换成空内容
· 公众号文章（MP_WXS_ 开头）暂不支持
· 仅供个人备份合法阅读的内容，请遵守微信读书用户协议及相关法律法规，请勿传播或用于商业用途

开源
· 仓库：https://github.com/freeabyss/WeReadExporter-Chrome-Extension
· 原项目：https://github.com/henonguan1688-lab/WeReadExporter-Tampermonkey（MIT）
```

**其他字段**

| 字段 | 建议值 |
|---|---|
| 类别 Category | `Productivity`（或 `Utilities`） |
| 语言 Language | `中文（简体）` 为主，可再加 `English` |
| 图标 | 自动取 zip 里的 128×128，无需另传 |
| 截图 | 上传 `store/screenshot-1-*.png`、`screenshot-2-*.png` |
| 小型宣传图 | 上传 `store/small-promo-440x280.png` |
| 横幅宣传图 | 上传 `store/marquee-1400x560.png` |
| 网站 / 支持网址 | `https://github.com/freeabyss/WeReadExporter-Chrome-Extension` / `/issues` |

---

## 5. 填写「隐私权」(Privacy) —— 最容易卡审核的一页

**单项用途 / Single purpose**

```
在用户已登录的微信读书网页版中，把用户本人有权阅读的章节内容导出为 Markdown、HTML 或 TXT 文件，供个人本地备份与整理。
```

**权限理由 / Permission justification**

| 权限 | 理由 |
|---|---|
| `clipboardWrite` | 用于「复制本章 / 复制全文」按钮把导出文本写入系统剪贴板，仅在用户主动点击时调用。 |
| 主机访问 `https://weread.qq.com/web/reader/*` | 内容脚本只在该阅读页注入悬浮面板；导出时读取页面内联的阅读状态参数，并向微信读书同源接口请求用户当前账号已解锁的章节内容。启用「笔记与标注」时，额外读取用户本人的划线与想法（可选热门划线）；使用「全书架笔记」时读取笔记本概览/书架列表以枚举书籍。全部为同源 GET，不会访问其他站点。 |

**数据使用声明 / Data usage**

- 是否收集用户个人数据 → **否 / No**
- 是否传输数据到第三方 → **否**
- 是否使用数据用于与扩展单一用途无关的目的 → **否**
- 勾选「Limited Use」相关认证（如页面要求）
- 隐私政策 URL 填第 1.3 节的地址

**测试说明 / Test instructions**（很关键，审核员需要登录态才能测）

```
1. 本扩展需要有效的微信读书网页版登录态。请在 https://weread.qq.com 登录任意可用账号。
2. 打开书架中任意一本已购买/已解锁的书籍，例如 https://weread.qq.com/web/reader/<bookHash> 。
3. 页面右下角会出现蓝色「导出」悬浮按钮，点击展开面板。
4. 选择格式后点击「导出全文」，进度条走完后会自动下载一个 .md/.html/.txt 文件；也可点「复制全文」或单章「复制/下载」。
5. 未购买章节会显示为失败并列出原因，属于预期行为（扩展不会绕过任何付费限制）。
6. 全部逻辑在本地运行：无远程代码、无数据上传、无分析 SDK，源码见 https://github.com/freeabyss/WeReadExporter-Chrome-Extension 。
```

> 提供可复现的测试账号/步骤能显著减少来回沟通；如果审核员无法登录微信读书，通常会要求补充演示视频或截图。

---

## 6. 「分发」与提交审核

| 字段 | 建议 |
|---|---|
| 可见性 Visibility | **Public**（要所有人可搜到）或 **Unlisted**（仅持链接可装） |
| 发布范围 | 先选全部国家/地区；如只面向中文用户可只选中国 |
| 价格 | 免费（商店内购/付费已废弃） |
| 是否面向儿童 | 否 |

点 **「提交审核 / Submit for review」**。

- 审核时长：通常 **1–5 个工作日**；新开发者账号、含敏感权限或需要人工复核时可能 **1–3 周**（宣传图单独审核约一周）。
- 官方说明：[Review process](https://developer.chrome.com/docs/webstore/review-process)、[Check review status](https://developer.chrome.com/docs/webstore/check-review)。
- 被拒时会给出具体政策条款，按邮件/控制台提示修改后重新提交即可；常见原因见第 0 节的政策风险。

---

## 7. 如果商店审核不通过（备选分发渠道）

1. **GitHub Release + 加载已解压**（当前已可用）
   `https://github.com/freeabyss/WeReadExporter-Chrome-Extension/releases` 下载 zip → 解压 → `chrome://extensions` 开开发者模式 → 加载已解压的扩展程序。
2. **Edge 加载项商店**：<https://partner.microsoft.com/dashboard/microsoftedge/> —— 免费注册、无需 $5，直接复用同一份 MV3 zip（需按提示补 manifest 字段），审核相对宽松，且 Edge/Chrome 都能装。
3. **Unlisted 不公开列出**：仍要审核，但不在搜索结果中出现，适合小范围。
4. **Firefox Add-ons (AMO)**：需要把 `chrome.*` 适配成 `browser.*` 并调整 manifest，属于另一个移植工作。
5. **企业/自托管分发**：通过组策略 `ExtensionInstallForcelist` 或自托管 CRX，仅适合受控设备。

---

## 8. 上架后的维护清单

- 每次更新：`manifest.json` 版本号 +1 → `npm test` → `npm run test:chrome` → `npm run package -- --store` → 上传新包 → 提交审核。
- 可以同步在 GitHub 建一个 Release 并附上两个 zip（用户手动加载版本 + 商店包），本仓库已提供 `npm run package`。
- 微信读书前端算法可能改版；签名/解码/接口分别在 `src/lib/weread-hash.js`、`weread-decode.js`、`weread-api.js`，改版时优先检查这三处。
- 关注商店评价与政策邮件；如收到商标/版权投诉，及时按第 0 节调整名称与描述。

---

## 参考链接

- [Register your developer account](https://developer.chrome.com/docs/webstore/register)
- [Publish in the Chrome Web Store](https://developer.chrome.com/docs/webstore/publish)
- [Complete your listing information](https://developer.chrome.com/docs/webstore/cws-dashboard-listing)
- [Fill out the privacy fields](https://developer.chrome.com/docs/webstore/cws-dashboard-privacy)
- [Provide test instructions](https://developer.chrome.com/docs/webstore/cws-dashboard-test-instructions)
- [Supplying Images（图片尺寸规范）](https://developer.chrome.com/docs/webstore/images)
- [Chrome Web Store review process](https://developer.chrome.com/docs/webstore/review-process)
- [Chrome Web Store Developer Dashboard](https://chromewebstore.google.com/devconsole)
