# 浮窗面板 Liquid Glass 重设计方案

**范围：** 仅修改 `GM_addStyle(...)` 的 CSS 和 `createPanel()` / `togglePanel()` / `updatePanel()` 三个函数，不触碰数据采集、导出、网络请求逻辑。

---

## 可行性评估

各模块逐一验证：

| 模块 | 结论 | 说明 |
|------|------|------|
| Liquid Glass 视觉 | ✅ 可行 | 现有代码已有 `backdrop-filter`，只是参数调整 |
| 字体尺寸放大 | ✅ 可行 | 纯 CSS 数值修改，无风险 |
| 动画（max-height + opacity） | ⚠️ 可行，有一处需修正 | 见下方「风险一」 |
| 展开方向自适应 | ✅ 可行 | `getBoundingClientRect()` 在 `fixed` 元素上可靠 |
| 自由拖动 | ⚠️ 可行，有一处需修正 | 见下方「风险二」 |
| 导出按钮样式 | ✅ 可行 | 纯 CSS 替换 |

### 风险一：`max-height` 动画会有"虚假延迟"

`max-height: 0 → 600px` 时，transition 的时长是按 600px 算的，但实际内容高度约 280–300px，动画的后半段在"空跑"，展开看起来会先快后停顿，收起则先停顿再快。

**修正：** 将 `max-height` 设为 `400px`（贴近实际内容高度），而不是 600px。如果未来内容增加再调整。

### 风险二：拖动结束后会意外触发一次展开/收起

浏览器在 `pointerdown → pointermove → pointerup` 序列之后，只要 pointer 没有位移超过阈值，仍然会触发 `click` 事件。`#bsub-head` 上的 `click` 监听器会把这次拖拽误判为点击，触发面板展开/收起。

**修正：** 在 `enableDrag` 内维护一个 `hasMoved` 标志，若实际发生了移动，在 `pointerup` 后用 `{ once: true, capture: true }` 捕获并吞掉紧接着的 `click` 事件：

```javascript
const onUp = () => {
  head.style.cursor = 'grab';
  window.removeEventListener('pointermove', onMove);
  window.removeEventListener('pointerup', onUp);
  if (hasMoved) {
    // 吞掉本次拖拽结束后的 click，防止误触发 togglePanel
    head.addEventListener('click', e => e.stopImmediatePropagation(), { once: true, capture: true });
  }
};
```

### 其余注意项（不是风险，但需确认）

- `updatePanel()` 通过 `getElementById` 找 badge 元素。新方案中 `#bsub-body` 从 `display:none` 改为 `opacity:0 / max-height:0`，元素仍在 DOM 中，`getElementById` 仍能找到，**无需修改 `updatePanel()`**。
- `backdrop-filter` 自动为元素创建新的 stacking context，`z-index: 99999` 保持不变即可。
- `flex-direction: column-reverse`（向上展开时）改变视觉顺序，不影响 DOM 顺序，`getElementById` 依然有效。

---

## 实施步骤

### Step 1 — 替换 `GM_addStyle`

完整替换 `GM_addStyle(...)` 内容：

```css
#bsub-panel {
  position: fixed; bottom: 80px; right: 20px; z-index: 99999;
  font-family: 'PingFang SC', 'Hiragino Sans GB', sans-serif;
  color: rgba(255,255,255,0.92);

  /* Liquid Glass */
  background: rgba(255,255,255,0.12);
  backdrop-filter: blur(40px) saturate(180%);
  -webkit-backdrop-filter: blur(40px) saturate(180%);
  border: 1px solid rgba(255,255,255,0.25);
  border-bottom-color: rgba(255,255,255,0.08);
  box-shadow:
    0 0 0 0.5px rgba(255,255,255,0.15) inset,
    0 2px 8px rgba(0,0,0,0.08) inset,
    0 20px 60px rgba(0,0,0,0.35),
    0 4px 16px rgba(0,0,0,0.2);

  border-radius: 100px;    /* 收起时完整胶囊 */
  padding: 8px 14px;
  min-width: 0;
  user-select: none;
  display: flex;
  flex-direction: column;

  /* 面板本身的形态过渡 */
  transition:
    min-width 0.38s cubic-bezier(0.32,0,0.15,1),
    border-radius 0.38s cubic-bezier(0.32,0,0.15,1);
}
#bsub-panel.expanded {
  padding: 14px 16px;
  min-width: 260px;
  border-radius: 22px;
}

#bsub-head {
  margin: 0;
  font-size: 15px;          /* 旧 13px */
  font-weight: 600;
  color: rgba(255,255,255,0.92);
  display: flex;
  align-items: center;
  gap: 8px;
  white-space: nowrap;
}
#bsub-toggle {
  margin-left: auto;
  font-size: 12px;
  color: rgba(255,255,255,0.48);
  background: none;
  border: none;
  cursor: pointer;
  padding: 0;
}

/* ── body：动画核心 ── */
#bsub-body {
  max-height: 0;
  opacity: 0;
  overflow: hidden;
  transform: scaleY(0.96);
  transform-origin: top center;
  transition:
    max-height 0.38s cubic-bezier(0.32,0,0.15,1),
    opacity 0.28s ease,
    transform 0.32s cubic-bezier(0.32,0,0.15,1);
}
#bsub-panel.expanded #bsub-body {
  max-height: 400px;        /* 贴近实际高度，避免虚假延迟 */
  opacity: 1;
  transform: scaleY(1);
  margin-top: 12px;
}

/* ── 状态 / badge ── */
#bsub-status { font-size: 13px; color: rgba(255,255,255,0.48); margin-bottom: 12px; line-height: 1.7; }
.bsub-row { display: flex; align-items: center; gap: 4px; }
.bsub-badge {
  display: inline-block; border-radius: 20px;
  padding: 0 7px; font-weight: 700; font-size: 12px;
}
.bsub-badge-sub  { background: rgba(0,174,236,0.22); color: rgba(0,174,236,0.95); border: 1px solid rgba(0,174,236,0.35); }
.bsub-badge-cmt  { background: rgba(255,180,0,0.22);  color: rgba(230,168,0,0.95);  border: 1px solid rgba(255,180,0,0.35); }
.bsub-badge-none { background: rgba(255,255,255,0.06); color: rgba(255,255,255,0.35); }

/* ── 选项 ── */
.bsub-opts { display: flex; flex-direction: column; gap: 8px; margin-bottom: 12px; }
.bsub-opt-row { display: flex; align-items: flex-start; gap: 7px; cursor: pointer; }
.bsub-opt-row input[type=checkbox] { margin: 2px 0 0; accent-color: #00aeec; cursor: pointer; flex-shrink: 0; }
.bsub-opt-label { display: flex; flex-direction: column; gap: 2px; }
.bsub-opt-name  { font-size: 14px; color: rgba(255,255,255,0.92); font-weight: 500; }
.bsub-opt-hint  { font-size: 12px; color: rgba(255,255,255,0.40); line-height: 1.4; }
.bsub-divider   { border: none; border-top: 1px solid rgba(255,255,255,0.10); margin: 10px 0; }

/* ── 导出按钮 ── */
#bsub-export-btn {
  width: 100%; padding: 8px 0; cursor: pointer; font-size: 14px; font-weight: 600;
  background: rgba(0,174,236,0.28);
  border: 1px solid rgba(0,174,236,0.5);
  border-bottom-color: rgba(0,174,236,0.2);
  box-shadow: 0 1px 0 rgba(255,255,255,0.15) inset;
  color: rgba(255,255,255,0.95);
  backdrop-filter: blur(8px);
  border-radius: 12px;
  transition: all 0.15s ease;
}
#bsub-export-btn:hover {
  background: rgba(0,174,236,0.4);
  transform: translateY(-1px);
  box-shadow: 0 1px 0 rgba(255,255,255,0.15) inset, 0 4px 12px rgba(0,174,236,0.25);
}
#bsub-export-btn:active  { transform: scale(0.97) translateY(0); }
#bsub-export-btn:disabled { opacity: 0.55; cursor: default; }
```

---

### Step 2 — 替换 `togglePanel()`

```javascript
function togglePanel() {
  const p = document.getElementById('bsub-panel');
  const body = document.getElementById('bsub-body');
  const rect = p.getBoundingClientRect();

  const expandUp   = (window.innerHeight - rect.bottom) < 320;
  const expandLeft = (window.innerWidth  - rect.right)  < 280;

  const originY = expandUp   ? 'bottom' : 'top';
  const originX = expandLeft ? 'right'  : 'left';
  body.style.transformOrigin = `${originX} ${originY}`;
  p.style.flexDirection = expandUp ? 'column-reverse' : 'column';

  const isExpanded = p.classList.toggle('expanded');
  document.getElementById('bsub-toggle').textContent = isExpanded ? '收起' : '展开';
}
```

---

### Step 3 — 在 `createPanel()` 末尾追加拖动逻辑

在 `document.getElementById('bsub-export-btn').addEventListener(...)` 之后，`}` 闭合前追加：

```javascript
// 拖动（以 right/bottom 坐标系操作，与 CSS 一致）
(function enableDrag(panel) {
  const head = document.getElementById('bsub-head');
  head.style.cursor = 'grab';

  head.addEventListener('pointerdown', e => {
    if (e.target.id === 'bsub-toggle') return;
    e.preventDefault();
    head.style.cursor = 'grabbing';

    const r0 = panel.getBoundingClientRect();
    let initRight  = window.innerWidth  - r0.right;
    let initBottom = window.innerHeight - r0.bottom;
    const sx = e.clientX, sy = e.clientY;
    let hasMoved = false;

    const onMove = e => {
      hasMoved = true;
      const dx = e.clientX - sx, dy = e.clientY - sy;
      const nr = Math.max(8, Math.min(initRight  - dx, window.innerWidth  - 60));
      const nb = Math.max(8, Math.min(initBottom - dy, window.innerHeight - 40));
      panel.style.right  = nr + 'px';
      panel.style.bottom = nb + 'px';
    };
    const onUp = () => {
      head.style.cursor = 'grab';
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      if (hasMoved) {
        // 吞掉本次拖拽结束后紧随的 click，避免误触发 togglePanel
        head.addEventListener('click', e => e.stopImmediatePropagation(),
          { once: true, capture: true });
      }
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  });
})(p);
```

---

### Step 4 — `updatePanel()` 无需修改

`#bsub-body` 改为 CSS 隐藏（非 `display:none`），badge 元素始终在 DOM 中，`getElementById` 正常工作。

---

## 改动文件

| 文件 | 改动类型 |
|------|---------|
| `bili2md-feed-ai.user.js` | 替换 `GM_addStyle` 内容；替换 `togglePanel()`；在 `createPanel()` 末尾追加拖动逻辑 |

其余文件不动。
