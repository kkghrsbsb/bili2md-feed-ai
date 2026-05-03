# B站AI字幕抓取 & 导出MD — 项目文档

> 当前版本：**v1.9.0** | 文件名：`bili2md-feed-ai.user.js`

---

## 一、这是什么

一个 Tampermonkey 油猴脚本，运行在 B 站视频页面，自动捕获 AI 字幕、视频元数据、高质量评论，一键导出为 Markdown 文件，方便直接喂给 AI 提问或做笔记。

**支持页面：**
- `bilibili.com/video/*`（普通视频）
- `bilibili.com/bangumi/play/*`（番剧）

---

## 二、功能

导出的 MD 包含三个可选模块，通过浮动面板的勾选框控制：

| 模块 | 默认 | 内容 |
|------|------|------|
| 视频信息 | ✅ 开启 | 标题、来源链接、UP主、导出时间、视频简介 |
| 时间轴 | ✅ 开启 | 字幕每行带 `[mm:ss]` 时间戳，方便定位 |
| 高质量评论 | ❌ 关闭 | 页面中已加载的评论，按点赞降序取前30条，含热门子评论（每条最多5条） |

**导出 MD 结构示例：**

```markdown
# 视频标题

> **来源：** https://...
> **UP主：** xxx
> **导出时间：** 2026/5/4

## 视频简介
...

## 字幕内容
**[00:03]** 大家好，今天来讲...
**[00:07]** 这个技术的核心是...

## 高质量评论
**1. 用户名**（👍 1234）
评论内容...

> **↳ 回复者**（👍 56）
> 子评论内容...
```

---

## 三、使用方式

1. 安装 Tampermonkey 扩展
2. 新建脚本，粘贴 `.user.js` 内容保存
3. 打开 B 站视频页面，右下角出现 `📝 字幕导出` 浮动面板（默认收起）
4. **字幕**：开启 B 站 AI 字幕后播放视频，字幕自动捕获，面板显示"N 行 ✅"
5. **评论**：勾选"高质量评论"后，先向下滚动到评论区让页面加载，面板显示"N 条 ✅"
6. 按需勾选选项，点击"⬇ 导出 Markdown"

---

## 四、技术实现细节

### 4.1 字幕捕获

B 站 AI 字幕通过 HTTP 请求返回 JSON，脚本用以下方式拦截：

- **Hook `window.fetch`**：在 `document-start` 阶段替换 `window.fetch`，对 URL 中含 `subtitle` 的响应 clone 后解析
- **Hook `XMLHttpRequest`**：同样拦截 `open` 和 `send`，处理旧式 XHR 请求

字幕 JSON 结构：`{ body: [ { from, to, content } ] }` 或 `{ data: { body: [...] } }`

以 URL 末段文件名作为 key 去重，防止重复捕获同一轨道。

### 4.2 视频元数据

优先读 `window.__INITIAL_STATE__`（B 站在 HTML 中内嵌的 SSR 数据），比 DOM 选择器更可靠：

```js
// 普通视频
window.__INITIAL_STATE__.videoData → { title, desc, owner.name, aid, bvid }

// 番剧
window.__INITIAL_STATE__.mediaInfo → { title, evaluate, up_info.uname }
```

DOM 选择器作为兜底（`h1[title]`、`.basic-desc-info`、`#v_desc` 等）。

### 4.3 评论捕获（最复杂部分，踩过多个坑）

#### 为什么不用 API 直接请求

B 站评论 API（`/x/v2/reply/wbi/main`）需要 WBI 签名（2023年3月起），签名算法需要从 nav 接口获取每日变化的 `img_key`/`sub_key`，经字符重排后生成 `mixinKey`，再对参数做 MD5。

即使实现了签名，请求还需要完整的 `buvid3`、`buvid4`、`bili_ticket` 等风控 Cookie。实测在油猴环境中仍返回 `v_voucher`（风控拦截）。

#### 为什么 Hook fetch 拦截不到评论请求

B 站新版评论区（`bili-comments` Web Component，基于 Lit 框架）使用 **Shadow DOM** 渲染，其内部 fetch 请求在 Shadow DOM 的隔离上下文中执行，**不经过 `window.fetch`**，因此 Hook 失效。在 Network 面板中可以看到 `bili-comments.fcb41a8` 这样的 JS 资源，但搜不到 `/x/v2/reply` 请求。

#### 最终方案：读 `__data` 属性 + MutationObserver

B 站评论区用 Lit 框架渲染，**每个 `bili-comment-thread-renderer` 元素上都有 `__data` 属性**，直接存储该评论的完整原始数据对象（经控制台验证确认字段结构）。

**`__data` 字段结构（经实际验证）：**
```js
threadEl.__data = {
  rpid: 298050524945,      // 评论ID（主键）
  root: 0,                 // =0 表示顶级主评论
  parent: 0,               // =0 表示非子评论
  like: 238,               // 点赞数
  member: { uname: '...' }, // 用户信息
  content: { message: '...' }, // 评论正文
  replies: [ ... ],        // 子评论数组（最多3条默认展开）
  // ...其他字段
}
```

**关键坑：`root === 0 && parent === 0` 是顶级主评论的判断条件**，早期版本没有这个判断，导致子评论（`root !== 0`）也被当成主评论读入。

**MutationObserver 的正确用法：**

必须直接 observe `bili-comments.shadowRoot`，而不是 `document`：

```js
// ❌ 错误：subtree:true 不能穿透 Shadow DOM 边界
observer.observe(document.documentElement, { childList: true, subtree: true });

// ✅ 正确：observe Shadow DOM 根节点
const sr = document.querySelector('bili-comments').shadowRoot;
observer.observe(sr, { childList: true, subtree: true });
```

**评论 DOM 层级：**
```
document
└─ #commentapp
     └─ bili-comments
          └─ shadowRoot  ← MutationObserver 挂这里
               └─ bili-comment-thread-renderer  ← __data 在这
                    ├─ __data = { 主评论数据... }
                    └─ shadowRoot
                         ├─ bili-comment-renderer
                         └─ #replies → bili-comment-replies → bili-comment-reply-renderer
```

**启动流程：** 轮询等待 `bili-comments` 出现（每500ms重试）→ 拿到 `shadowRoot` → 先扫描已有节点 → 挂载 MutationObserver 监听后续加载

**文本兜底方案（`__data` 不可用时）：** 沿 Shadow DOM 层级 `bili-comment-renderer → shadowRoot → bili-rich-text → shadowRoot → #contents` 读文本节点，点赞数从 `[class*="like"] span` 读取。

### 4.4 文本清洗

评论和字幕文本统一清洗，去除：
- B 站图片占位符 `[图片]`、`{...}`
- B 站自定义表情 `[表情名]`（长度限制1-20字符，避免误删正常方括号内容）
- Unicode emoji（覆盖 U+1F000-1FFFF、U+2600-27BF、U+FE00-FE0F、U+1F300-1FAFF）
- 零宽连接符 U+200D

---

## 五、版本演进记录（踩坑历史）

| 版本 | 关键变化 | 失败原因 |
|------|---------|---------|
| v1.0 | 基础字幕捕获 | — |
| v1.2 | 加入视频简介 | 简介用 DOM 选择器读取，B 站简介在 `__INITIAL_STATE__.videoData.desc` 更可靠 |
| v1.3 | 勾选式面板UI + 独立导出按钮 | — |
| v1.4 | 首次加入评论（自己发 API 请求） | WBI 签名实现不完整，返回 `v_voucher` |
| v1.5 | 完整实现 WBI 签名（内置 MD5） | 仍失败：缺少风控 Cookie（`buvid3` 等未激活） |
| v1.6-1.7 | 改为 Hook fetch 拦截 B 站自身评论请求 | 评论区是 Shadow DOM Web Component，fetch 不经过 `window.fetch` |
| v1.8 | 改为读 `__data` + MutationObserver(document) | MutationObserver observe document 无法穿透 Shadow DOM 边界 |
| v1.9 | MutationObserver observe `bili-comments.shadowRoot`，修正 `__data` 字段路径 | 早期 `root/parent` 判断缺失导致全读子评论 → 已修复 |

---

## 六、已知局限 & 潜在问题

| 问题 | 说明 |
|------|------|
| 评论依赖页面渲染 | 必须先滚动到评论区让 B 站加载评论，脚本才能读到数据 |
| 只能读已渲染的评论 | 当前最多读页面中已渲染的评论（通常第一屏约10-20条），不是全部评论。继续向下滚动可累积更多 |
| 点赞数是渲染时快照 | 不是实时数据，是页面加载时的值 |
| B 站改版风险 | Shadow DOM 结构或 `__data` 字段名可能随 B 站前端更新而变化 |
| 番剧评论 | 番剧页面（`/bangumi/`）评论区入口选择器可能不同，建议验证 |
| 字幕需手动开启 | B 站 AI 字幕不是默认开启的，需要用户在播放器设置中手动开启 |

---

## 七、如果需要修改

**调整导出评论数量：** `getTopComments(30)` 中的 `30`

**调整子评论数量：** `(d.replies || []).slice(0, 5)` 中的 `5`

**调试评论读取：** 在控制台运行以下代码验证 `__data` 结构：
```js
const bc = document.querySelector('#commentapp bili-comments, bili-comments');
const threads = bc?.shadowRoot?.querySelectorAll('bili-comment-thread-renderer');
const t = threads?.[0];
console.log('keys:', Object.keys(t?.__data || {}));
console.log('root:', t?.__data?.root, 'parent:', t?.__data?.parent);
console.log('text:', t?.__data?.content?.message);
console.log('likes:', t?.__data?.like);
```

**如果 B 站改版导致 `__data` 失效：** 查看 `bili-comment-renderer.shadowRoot` 下的 `bili-rich-text` 元素，文本兜底方案（`readFromShadowText`）会尝试直接读 DOM 文本节点。
