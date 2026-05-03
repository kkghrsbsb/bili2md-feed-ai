# bili2md-feed-ai

一个 Tampermonkey 油猴脚本，运行在 B 站视频页面，自动捕获 AI 字幕、视频元数据、高质量评论，一键导出为 Markdown，方便直接喂给 AI 提问或做笔记。

**支持页面：** `bilibili.com/video/*`（普通视频）、`bilibili.com/bangumi/play/*`（番剧）

---

## 安装

1. 安装浏览器扩展 [Tampermonkey](https://www.tampermonkey.net/)
2. 新建脚本，将 `bili2md-feed-ai.user.js` 内容完整粘贴进去，`Ctrl+S` 保存

---

## 使用

打开任意 B 站视频页面，右下角出现 **📝 字幕导出** 浮动面板（默认收起）。

1. **字幕**：在播放器设置中手动开启 AI 字幕，播放视频，字幕自动捕获，面板显示"N 行 ✅"
2. **评论**（可选）：勾选"高质量评论"后，向下滚动到评论区等待加载，面板显示"N 条 ✅"
3. 按需勾选选项，点击 **⬇ 导出 Markdown**

---

## 导出内容

| 模块 | 默认 | 内容 |
|------|------|------|
| 视频信息 | ✅ | 标题、来源链接、UP 主、导出时间、视频简介 |
| 时间轴 | ✅ | 字幕每行带 `[mm:ss]` 时间戳，方便定位视频片段 |
| 高质量评论 | ❌ | 按点赞降序取前 30 条主评论，含热门子评论（每条最多 5 条） |

关闭时间轴后导出纯文字字幕，token 更省，适合让 AI 做全文总结。

---

## 技术实现

### 字幕捕获

B 站 AI 字幕通过 HTTP 请求返回 JSON。脚本在 `document-start` 阶段同时 hook `window.fetch` 和 `XMLHttpRequest`，拦截 URL 含 `subtitle` 的响应并解析。以 URL 末段文件名作为 key 去重，防止重复捕获同一轨道。

字幕 JSON 结构：`{ body: [ { from, to, content } ] }` 或 `{ data: { body: [...] } }`

### 视频元数据

优先读 `window.__INITIAL_STATE__`（B 站 SSR 内嵌数据），比 DOM 选择器更可靠：

```js
// 普通视频
window.__INITIAL_STATE__.videoData  // { title, desc, owner.name, aid, bvid }

// 番剧
window.__INITIAL_STATE__.mediaInfo  // { title, evaluate, up_info.uname }
```

DOM 选择器（`h1[title]`、`#v_desc` 等）作为兜底。

### 评论捕获

**为何不直接调 API：** B 站评论 API 需要 WBI 签名（每日轮换的 `mixinKey` + MD5），且风控 Cookie（`buvid3`/`buvid4`/`bili_ticket`）在油猴环境中难以完整复现，实测返回 `v_voucher` 拦截。

**为何 hook fetch 无效：** B 站新版评论区（`bili-comments` Web Component，基于 Lit 框架）使用 Shadow DOM 渲染，其内部 fetch 不经过 `window.fetch`。

**最终方案：读 `__data` + MutationObserver**

每个 `bili-comment-thread-renderer` 元素上有 `__data` 属性，直接存储评论完整数据：

```js
threadEl.__data = {
  rpid: 298050524945,
  root: 0,           // 0 = 顶级主评论
  parent: 0,
  like: 238,
  member: { uname: '...' },
  content: { message: '...' },
  replies: [ ... ],
}
```

`root === 0 && parent === 0` 是顶级主评论的判断条件（早期版本缺少此判断，导致子评论被误读为主评论）。

MutationObserver 必须 observe `bili-comments.shadowRoot`，不能挂在 `document` 上：

```js
// ❌ subtree:true 无法穿透 Shadow DOM 边界
observer.observe(document.documentElement, { childList: true, subtree: true });

// ✅ 正确做法
const sr = document.querySelector('bili-comments').shadowRoot;
observer.observe(sr, { childList: true, subtree: true });
```

**启动流程：** 轮询等待 `bili-comments` 出现（每 500ms）→ 拿到 `shadowRoot` → 扫描已有节点 → 挂载 Observer 监听后续加载。

---

## 已知局限

| 问题 | 说明 |
|------|------|
| 评论依赖页面渲染 | 必须先滚动到评论区，脚本才能读到数据 |
| 只读已渲染的评论 | 通常第一屏约 10–20 条，继续下滑可累积更多 |
| 点赞数是快照 | 页面加载时的值，非实时 |
| B 站改版风险 | Shadow DOM 结构或 `__data` 字段名可能随前端更新变化 |
| AI 字幕需手动开启 | 部分视频不支持，需在播放器设置中手动启用 |

---

## 调试参考

在控制台运行以下代码验证 `__data` 结构是否正常：

```js
const bc = document.querySelector('#commentapp bili-comments, bili-comments');
const threads = bc?.shadowRoot?.querySelectorAll('bili-comment-thread-renderer');
const t = threads?.[0];
console.log('keys:', Object.keys(t?.__data || {}));
console.log('root:', t?.__data?.root, 'parent:', t?.__data?.parent);
console.log('text:', t?.__data?.content?.message);
console.log('likes:', t?.__data?.like);
```

如果 `__data` 失效（B 站改版），脚本会自动降级到文本兜底方案，沿 Shadow DOM 层级读 `bili-rich-text` 下的文本节点。
