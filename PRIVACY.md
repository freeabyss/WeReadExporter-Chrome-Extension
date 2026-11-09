# 隐私政策 / Privacy Policy

**扩展名称**：微信读书导出助手（WeRead Exporter）
**适用版本**：v1.0.0 及以上
**生效日期**：2026-11-09

## 一句话总结

本扩展**不收集、不存储、不传输任何个人数据**。所有操作都在你的浏览器本地完成。

## 详细说明

### 1. 我们收集什么

**什么也不收集。**

- 没有账号体系、没有登录、没有用户标识；
- 没有统计、埋点、崩溃上报或任何分析 SDK；
- 没有远程服务器，扩展不会向除 `weread.qq.com` 之外的任何地址发送数据；
- 不读取、不保存、不导出浏览器 Cookie、密码或历史记录。

### 2. 扩展做了什么

当且仅当你主动点击「复制本章 / 下载本章 / 导出全文」等按钮时：

1. 扩展从当前微信读书阅读页的内联状态中读取 `bookId` 与会话参数 `psvts`；
2. 使用浏览器自身的登录态（Cookie 由浏览器自动携带，扩展代码不接触其值），向 **`weread.qq.com` 同源接口**请求你当前账号**已经有权阅读**的章节内容；
3. 在本地解码、整理成 Markdown / HTML / TXT；
4. 写入剪贴板，或生成 Blob 触发浏览器下载，文件只保存在你自己选择的下载目录。

### 3. 权限用途

| 权限 | 用途 |
|---|---|
| `clipboardWrite` | 实现「复制本章 / 复制全文」，仅在用户点击复制按钮时调用 |
| 主机访问 `https://weread.qq.com/web/reader/*` | 仅在微信读书阅读页注入悬浮面板，并向同源接口请求章节内容 |

扩展**没有** `storage`、`tabs`、`webRequest`、`downloads`、`cookies`、后台 Service Worker 或任何网络权限。

### 4. 数据去向

- 导出的文本内容**只**留在你的浏览器内存与本地下载文件里；
- 面板位置、格式偏好等设置保存在浏览器的 `localStorage` 中（仅本机，不上传）；已成功导出的章节缓存在页面内存里，刷新页面即清空；
- 无第三方共享、无跨境传输、无商业化使用。

### 5. 第三方内容

本扩展只用于导出**你本人合法购买或有权阅读**的内容，请遵守微信读书用户协议及相关法律法规。扩展作者不提供、不托管、不传播任何书籍内容，也不对使用者导出内容的用途负责。

### 6. 开源与审计

本项目完全开源，可自行审查代码：

- 仓库：https://github.com/freeabyss/WeReadExporter-Chrome-Extension
- 源码入口：`src/content.js`、`src/lib/`
- 内置第三方库：Turndown（MIT，本地打包，无 CDN 远程代码）

### 7. 联系方式

如对本政策有疑问，请在上述仓库提交 Issue。

---

> English summary: This extension collects, stores, and transmits no personal data. It runs entirely locally in your browser, uses only same-origin requests to `weread.qq.com` with your existing session, and writes output only to your clipboard or a local download. No analytics, no remote code, no servers.
