# 面板布局调整：头部固定在底部 + 导出按钮防误触

## 功能目标

1. **"字幕导出 收起/展开" 固定在面板底部**，展开时内容向上生长，操作位置始终不变，动作连贯。
2. **"⬇ 导出 Markdown" 与头部之间留出足够间距**，避免面板展开后误触导出按钮。

---

## 当前问题

- `togglePanel()` 在每次点击时检测面板与视口的距离，动态决定向上还是向下展开，同时设置 `flex-direction: column` 或 `column-reverse` 内联样式。
- 拖动面板到不同位置后，下次展开方向可能改变，头部位置会随之跳变，体验不连贯。
- 展开方向为向下时，内容在头部下方，"导出按钮"是 body 最后一个元素，距离头部自然较近；向上展开时 body 反序，"导出按钮"也在 body 最底部，紧挨着头部，容易误触。

---

## 方案设计

### 核心思路

面板 `position: fixed; bottom: Xpx`，以右下角为锚点。设为 `flex-direction: column-reverse` 后：

- `#bsub-head`（第一个子元素）→ 渲染在底部 ✅
- `#bsub-body`（第二个子元素）→ 渲染在头部上方 ✅

展开时面板向上生长，锚点不动，头部始终在底部。不再需要运行时检测方向。

### 展开后的视觉结构

```
┌──────────────────────┐  ← 面板顶部（随内容高度变化）
│  字幕  [N 行 ✅]    │
│  评论  [等待中]      │
│  ──────────────────  │
│  ☑ 视频信息          │
│  ☑ 时间轴            │
│  ☐ 高质量评论        │
│  ──────────────────  │
│  ⬇ 导出 Markdown    │
│                      │  ← padding-bottom 16px（隔离区）
│──────────────────────│
│  📝 字幕导出  [收起] │  ← 头部，始终固定在底部
└──────────────────────┘  ← 面板底部（固定锚点）
```

---

## 需要修改的内容

### 1. CSS — 两处改动

**（a）`#bsub-panel`：`flex-direction` 改为 `column-reverse`（永久）**

```css
/* 改前 */
flex-direction: column;

/* 改后 */
flex-direction: column-reverse;
```

**（b）`#bsub-body`：`transform-origin` 改为 `bottom center`**

body 向上展开，scaleY 动画应从底边（与头部的交界处）开始。

```css
/* 改前 */
transform-origin: top center;

/* 改后 */
transform-origin: bottom center;
```

**（c）`#bsub-panel.expanded #bsub-body`：添加 `padding-bottom`**

在 body 底部留出隔离区，与头部产生视觉距离。

```css
/* 新增 */
padding-bottom: 16px;
```

### 2. JS — `togglePanel()` 大幅简化

删除全部方向检测逻辑（`expandUp`、`expandLeft`、`originX/Y`、设置 `flexDirection` 和 `transformOrigin` 的代码），只保留核心两行：

```javascript
function togglePanel() {
  const isExpanded = document.getElementById('bsub-panel').classList.toggle('expanded');
  document.getElementById('bsub-toggle').textContent = isExpanded ? '收起' : '展开';
}
```

---

## 受影响的文件

| 文件 | 改动位置 |
|------|---------|
| `bili2md-feed-ai.user.js` | `GM_addStyle` 中的 `#bsub-panel`、`#bsub-body`、`#bsub-panel.expanded #bsub-body` 三条规则；`togglePanel()` 函数体 |

其余函数（`createPanel`、`updatePanel`、`sampleTheme`、`enableDrag`）不动。

---

## 潜在风险与边界情况

| 场景 | 分析 |
|------|------|
| 面板拖到屏幕顶部，向上空间不足 | `position: fixed; bottom: Xpx` 锚定底部，面板向上生长；顶部空间不足时会被视口裁剪，但当前面板高度约 280px，正常使用不会超出。如需处理可后续加滚动。 |
| `padding-bottom: 16px` 会让 `max-height: 400px` 不够用吗 | 当前 body 实际内容高约 250px，加 16px 仍远低于 400px，无影响。 |
| `enableDrag` 中的 `sampleTheme` 采样点是面板中心 | 面板始终向上展开，采样位置语义不变，无影响。 |
| light/dark theme 的 CSS 规则用了后代选择器 | 不涉及 flex 方向，无影响。 |
