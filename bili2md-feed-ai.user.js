// ==UserScript==
// @name         bili2md-feed-ai
// @namespace    https://github.com/kkghrsbsb/bili2md-feed-ai
// @version      2.0.0
// @description  自动抓取B站AI字幕和热门评论，连同视频信息一起导出为Markdown，方便喂给AI提问
// @author       kkghrsbsb
// @match        *://www.bilibili.com/video/*
// @match        *://www.bilibili.com/bangumi/play/*
// @grant        GM_addStyle
// @run-at       document-start
// ==/UserScript==

(function () {
  'use strict';

  // ═══════════════════════════════════════════════════
  //  状态
  // ═══════════════════════════════════════════════════
  let subtitleLines = [];
  let capturedLangs = {};
  let commentMap = new Map(); // rpid → {user, text, likes, sub[]}
  let commentObserverStarted = false;

  // ═══════════════════════════════════════════════════
  //  字幕捕获（不变）
  // ═══════════════════════════════════════════════════
  function tryParseSubtitle(url, text) {
    try {
      const json = JSON.parse(text);
      const body = json?.body ?? json?.data?.body;
      if (!Array.isArray(body) || body.length === 0) return;
      const lines = body.map(i => ({ from: i.from, to: i.to, content: (i.content ?? '').trim() })).filter(l => l.content);
      const key = url.split('/').pop().split('?')[0] || url;
      if (capturedLangs[key]) return;
      capturedLangs[key] = lines;
      subtitleLines = lines;
      updatePanel();
    } catch (_) {}
  }

  const _fetch = window.fetch;
  window.fetch = async function (...args) {
    const res = await _fetch.apply(this, args);
    try {
      const url = typeof args[0] === 'string' ? args[0] : (args[0]?.url ?? '');
      if (url.includes('subtitle')) res.clone().text().then(t => tryParseSubtitle(url, t));
    } catch (_) {}
    return res;
  };
  const _open = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (m, url, ...r) { this._url = url; return _open.call(this, m, url, ...r); };
  const _send = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.send = function (...a) {
    this.addEventListener('load', function () {
      try { if (this._url?.includes('subtitle')) tryParseSubtitle(this._url, this.responseText); } catch (_) {}
    });
    return _send.apply(this, a);
  };

  // ═══════════════════════════════════════════════════
  //  文本清洗
  // ═══════════════════════════════════════════════════
  function cleanText(str) {
    if (!str) return '';
    return str
      .replace(/\[图片\]/g, '').replace(/\{[^}]*\}/g, '')
      .replace(/\[(?:[^\]]{1,20})\]/g, '')
      .replace(/[\u{1F000}-\u{1FFFF}]/gu, '').replace(/[\u{2600}-\u{27BF}]/gu, '')
      .replace(/[\u{FE00}-\u{FE0F}]/gu, '').replace(/[\u{1F300}-\u{1FAFF}]/gu, '')
      .replace(/\u200D/gu, '').replace(/\s{2,}/g, ' ').trim();
  }

  // ═══════════════════════════════════════════════════
  //  从 bili-comment-thread-renderer 的 __data 读评论
  //
  //  B站评论 DOM 层级：
  //  #commentapp > bili-comments
  //    └─ shadowRoot
  //         └─ bili-comment-thread-renderer  ← __data 在这里
  //              .__data.replies[0]  = 主评论数据
  //              .__data.replies[1+] = 子评论数据（或用 .replies 字段）
  //
  //  也可以从 bili-comment-renderer.__data 读单条评论
  // ═══════════════════════════════════════════════════
  function readThreadData(threadEl) {
    try {
      // __data 就是主评论对象本身（经控制台验证）
      // 字段：rpid, member, content, like, replies(子评论数组), root=0 表示顶级评论
      const d = threadEl.__data;
      if (!d) return;

      // root=0 且 parent=0 才是顶级主评论，排除子评论误入
      if (d.root !== 0 || d.parent !== 0) return;

      const rpid = String(d.rpid || d.rpid_str || '');
      if (!rpid || commentMap.has(rpid)) return;

      const text  = cleanText(d.content?.message || '');
      const user  = d.member?.uname || '匿名';
      const likes = d.like || 0;
      if (!text) return;

      const entry = { user, text, likes, sub: [] };

      // 子评论在 d.replies 数组里
      for (const s of (d.replies || []).slice(0, 5)) {
        const st = cleanText(s?.content?.message || '');
        if (!st) continue;
        entry.sub.push({ user: s?.member?.uname || '匿名', text: st, likes: s.like || 0 });
      }

      commentMap.set(rpid, entry);
      updatePanel();
    } catch (_) {}
  }

  // 扫描 bili-comments shadowRoot 下所有 thread 元素
  function scanThreads(root) {
    const threads = root.querySelectorAll('bili-comment-thread-renderer');
    threads.forEach(readThreadData);
  }

  // ═══════════════════════════════════════════════════
  //  启动评论监听
  //  关键：MutationObserver 必须 observe bili-comments.shadowRoot
  //  而不是 document，否则无法穿透 Shadow DOM 边界
  // ═══════════════════════════════════════════════════
  function startCommentObserver() {
    if (commentObserverStarted) return;

    // 等待 #commentapp > bili-comments 出现
    function tryAttach() {
      // B站评论区容器：#commentapp 下的 bili-comments 元素
      const biliComments =
        document.querySelector('#commentapp bili-comments') ||
        document.querySelector('bili-comments');

      if (!biliComments) {
        setTimeout(tryAttach, 500);
        return;
      }

      const sr = biliComments.shadowRoot;
      if (!sr) {
        // shadowRoot 可能还没创建，稍后重试
        setTimeout(tryAttach, 300);
        return;
      }

      commentObserverStarted = true;
      console.log('[字幕抓取] 找到 bili-comments shadowRoot，开始监听评论');

      // 先扫描已有的
      scanThreads(sr);

      // 监听 shadowRoot 内的 DOM 变化
      const obs = new MutationObserver(() => scanThreads(sr));
      obs.observe(sr, { childList: true, subtree: true });
    }

    tryAttach();
  }

  // ═══════════════════════════════════════════════════
  //  兜底：通过 DOM 文本直接读（当 __data 读不到时）
  //  直接遍历 shadow DOM 文本节点抓评论内容和点赞数
  // ═══════════════════════════════════════════════════
  function readFromShadowText() {
    if (commentMap.size > 0) return; // 已有数据，跳过

    const biliComments =
      document.querySelector('#commentapp bili-comments') ||
      document.querySelector('bili-comments');
    if (!biliComments?.shadowRoot) return;

    // 每个 thread renderer
    const threads = biliComments.shadowRoot.querySelectorAll('bili-comment-thread-renderer');
    threads.forEach((thread, idx) => {
      try {
        const tsr = thread.shadowRoot;
        if (!tsr) return;

        // 主评论
        const commentEl = tsr.querySelector('bili-comment-renderer');
        if (!commentEl?.shadowRoot) return;
        const csr = commentEl.shadowRoot;

        // 用户名
        const user = csr.querySelector('.user-name, [class*="user-name"], .username')?.textContent?.trim() || `评论${idx+1}`;

        // 正文：bili-rich-text > shadowRoot > #contents
        const richText = csr.querySelector('bili-rich-text');
        const textEl   = richText?.shadowRoot?.querySelector('#contents') || richText;
        const text     = cleanText(textEl?.textContent || csr.querySelector('[class*="content"], [class*="text"]')?.textContent || '');

        // 点赞数
        const likeEl = csr.querySelector('[class*="like"] span, [class*="like-num"], .like-num');
        const likes  = parseInt(likeEl?.textContent?.replace(/[^0-9]/g, '') || '0') || 0;

        if (!text) return;

        const rpid = `dom_${idx}_${user}`;
        if (commentMap.has(rpid)) return;

        const entry = { user, text, likes, sub: [] };

        // 子评论
        const repliesEl = tsr.querySelector('#replies, bili-comment-replies');
        if (repliesEl) {
          const replyEls = (repliesEl.shadowRoot || repliesEl).querySelectorAll('bili-comment-reply-renderer');
          replyEls.forEach((replyEl, ri) => {
            if (ri >= 5) return;
            const rsr   = replyEl.shadowRoot || replyEl;
            const rRich = rsr.querySelector('bili-rich-text');
            const rText = cleanText((rRich?.shadowRoot?.querySelector('#contents') || rRich)?.textContent || rsr.querySelector('[class*="content"]')?.textContent || '');
            const rUser = rsr.querySelector('.user-name, [class*="user-name"]')?.textContent?.trim() || '匿名';
            if (rText) entry.sub.push({ user: rUser, text: rText, likes: 0 });
          });
        }

        commentMap.set(rpid, entry);
      } catch (_) {}
    });

    if (commentMap.size > 0) {
      console.log(`[字幕抓取] DOM文本兜底读取 ${commentMap.size} 条`);
      updatePanel();
    }
  }

  // ═══════════════════════════════════════════════════
  //  视频元数据
  // ═══════════════════════════════════════════════════
  function getMetaFromState() {
    try {
      const s = window.__INITIAL_STATE__;
      if (!s) return null;
      const vd = s.videoData;
      if (vd) return { title: vd.title || '', desc: vd.desc || '', uploader: vd.owner?.name || '', aid: String(vd.aid || '') };
      const mi = s.mediaInfo;
      if (mi) return { title: mi.title || '', desc: mi.evaluate || '', uploader: mi.up_info?.uname || '', aid: '' };
    } catch (_) {}
    return null;
  }
  function getMetaFromDOM() {
    const title =
      document.querySelector('h1[title]')?.getAttribute('title')?.trim() ||
      document.querySelector('h1.video-title')?.textContent?.trim() ||
      document.title.replace(/\s*[-_|]?\s*哔哩哔哩.*$/, '').trim() || '未知视频';
    let desc = '';
    for (const sel of ['.basic-desc-info', '#v_desc .desc-info-text', '#v_desc', '.desc-info']) {
      const t = document.querySelector(sel)?.innerText?.trim();
      if (t) { desc = t; break; }
    }
    const uploader = document.querySelector('.up-name, .username, [class*="upName"]')?.textContent?.trim() || '';
    return { title, desc, uploader, aid: '' };
  }
  function getVideoMeta() {
    const s = getMetaFromState(), d = getMetaFromDOM();
    return {
      title:    s?.title    || d.title    || '未知视频',
      desc:     s?.desc     || d.desc     || '',
      uploader: s?.uploader || d.uploader || '',
      aid:      s?.aid      || d.aid      || '',
      url:      location.href.split('?')[0],
    };
  }

  function getTopComments(limit = 30) {
    return [...commentMap.values()].sort((a, b) => b.likes - a.likes).slice(0, limit).filter(c => c.text);
  }

  // ═══════════════════════════════════════════════════
  //  Markdown 生成
  // ═══════════════════════════════════════════════════
  function fmtTime(sec) {
    const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = Math.floor(sec % 60);
    if (h > 0) return `${h}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`;
    return `${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`;
  }

  function buildMarkdown(meta, lines, comments, opts) {
    const { includeInfo, includeTimestamp, includeComments } = opts;
    const now = new Date().toLocaleString('zh-CN');
    let md = `# ${meta.title}\n\n`;
    if (includeInfo) {
      md += `> **来源：** ${meta.url}  \n`;
      if (meta.uploader) md += `> **UP主：** ${meta.uploader}  \n`;
      md += `> **导出时间：** ${now}  \n\n`;
      if (meta.desc) md += `## 视频简介\n\n${meta.desc}\n\n`;
    }
    md += `## 字幕内容\n\n`;
    if (lines.length === 0) {
      md += '_未捕获到字幕，请确认视频已开启AI字幕并播放片刻。_\n';
    } else if (includeTimestamp) {
      lines.forEach(l => { md += `**[${fmtTime(l.from)}]** ${l.content}  \n`; });
    } else {
      md += lines.map(l => l.content).join('\n') + '\n';
    }
    if (includeComments) {
      md += `\n## 高质量评论\n\n`;
      if (comments.length === 0) {
        md += '_评论尚未加载，请滚动到评论区后再导出。_\n';
      } else {
        comments.forEach((c, i) => {
          md += `**${i + 1}. ${c.user}**（👍 ${c.likes}）\n${c.text}\n`;
          c.sub.forEach(s => { md += `\n> **↳ ${s.user}**（👍 ${s.likes}）\n> ${s.text}\n`; });
          md += '\n';
        });
      }
    }
    md += `\n---\n_由「B站AI字幕抓取」脚本导出_\n`;
    return md;
  }

  function safeFilename(n) { return n.replace(/[\/\\:*?"<>|]/g, '_').slice(0, 80); }

  // ═══════════════════════════════════════════════════
  //  导出：点击导出按钮时也主动触发一次文本兜底扫描
  // ═══════════════════════════════════════════════════
  function doExport() {
    const btn = document.getElementById('bsub-export-btn');
    if (btn) { btn.disabled = true; btn.textContent = '⏳ 导出中…'; }

    // 导出前再扫一次（捕获最新加载的评论，兜底文本读取）
    try { scanThreads(document.querySelector('#commentapp bili-comments, bili-comments')?.shadowRoot); } catch (_) {}
    if (commentMap.size === 0) readFromShadowText();

    const opts = {
      includeInfo:      document.getElementById('bsub-opt-info')?.checked     ?? true,
      includeTimestamp: document.getElementById('bsub-opt-ts')?.checked       ?? true,
      includeComments:  document.getElementById('bsub-opt-comments')?.checked ?? false,
    };
    const meta     = getVideoMeta();
    const comments = opts.includeComments ? getTopComments(30) : [];
    const md       = buildMarkdown(meta, subtitleLines, comments, opts);
    const blob = new Blob([md], { type: 'text/markdown;charset=utf-8' });
    const url  = URL.createObjectURL(blob);
    const a    = Object.assign(document.createElement('a'), { href: url, download: `${safeFilename(meta.title)}.md` });
    document.body.appendChild(a); a.click();
    setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 1000);
    if (btn) { btn.disabled = false; btn.textContent = '⬇ 导出 Markdown'; }
  }

  // ═══════════════════════════════════════════════════
  //  样式
  // ═══════════════════════════════════════════════════
  GM_addStyle(`
    #bsub-panel {
      position: fixed; bottom: 80px; right: 20px; z-index: 99999;
      font-family: 'PingFang SC', 'Hiragino Sans GB', sans-serif;
      color: rgba(255,255,255,0.92);
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
      border-radius: 100px;
      padding: 8px 14px;
      min-width: 0;
      user-select: none;
      display: flex;
      flex-direction: column-reverse;
      transition:
        min-width 0.38s cubic-bezier(0.32,0,0.15,1),
        border-radius 0.38s cubic-bezier(0.32,0,0.15,1);
    }
    #bsub-panel.expanded { padding: 14px 16px; min-width: 260px; border-radius: 22px; }
    #bsub-head { margin:0; font-size:15px; font-weight:600; color:rgba(255,255,255,0.92); display:flex; align-items:center; gap:8px; white-space:nowrap; }
    #bsub-toggle { margin-left:auto; font-size:12px; color:rgba(255,255,255,0.48); background:none; border:none; cursor:pointer; padding:0; }
    #bsub-body {
      max-height: 0; opacity: 0; overflow: hidden;
      transform: scaleY(0.96); transform-origin: bottom center;
      transition:
        max-height 0.38s cubic-bezier(0.32,0,0.15,1),
        opacity 0.28s ease,
        transform 0.32s cubic-bezier(0.32,0,0.15,1);
    }
    #bsub-panel.expanded #bsub-body { max-height: 400px; opacity: 1; transform: scaleY(1); margin-bottom: 12px; padding-bottom: 16px; }
    #bsub-status { font-size:13px; color:rgba(255,255,255,0.48); margin-bottom:12px; line-height:1.7; }
    .bsub-row { display:flex; align-items:center; gap:4px; }
    .bsub-badge { display:inline-block; border-radius:20px; padding:0 7px; font-weight:700; font-size:12px; }
    .bsub-badge-sub  { background:rgba(0,174,236,0.22); color:rgba(0,174,236,0.95); border:1px solid rgba(0,174,236,0.35); }
    .bsub-badge-cmt  { background:rgba(255,180,0,0.22);  color:rgba(230,168,0,0.95);  border:1px solid rgba(255,180,0,0.35); }
    .bsub-badge-none { background:rgba(255,255,255,0.06); color:rgba(255,255,255,0.35); }
    .bsub-opts { display:flex; flex-direction:column; gap:8px; margin-bottom:12px; }
    .bsub-opt-row { display:flex; align-items:flex-start; gap:7px; cursor:pointer; }
    .bsub-opt-row input[type=checkbox] { margin:2px 0 0; accent-color:#00aeec; cursor:pointer; flex-shrink:0; }
    .bsub-opt-label { display:flex; flex-direction:column; gap:2px; }
    .bsub-opt-name { font-size:14px; color:rgba(255,255,255,0.92); font-weight:500; }
    .bsub-opt-hint { font-size:12px; color:rgba(255,255,255,0.40); line-height:1.4; }
    .bsub-divider { border:none; border-top:1px solid rgba(255,255,255,0.10); margin:10px 0; }
    #bsub-export-btn {
      width:100%; padding:8px 0; cursor:pointer; font-size:14px; font-weight:600;
      background:rgba(0,174,236,0.28);
      border:1px solid rgba(0,174,236,0.5);
      border-bottom-color:rgba(0,174,236,0.2);
      box-shadow:0 1px 0 rgba(255,255,255,0.15) inset;
      color:rgba(255,255,255,0.95);
      backdrop-filter:blur(8px);
      border-radius:12px;
      transition:all 0.15s ease;
    }
    #bsub-export-btn:hover { background:rgba(0,174,236,0.4); transform:translateY(-1px); box-shadow:0 1px 0 rgba(255,255,255,0.15) inset,0 4px 12px rgba(0,174,236,0.25); }
    #bsub-export-btn:active { transform:scale(0.97) translateY(0); }
    #bsub-export-btn:disabled { opacity:.55; cursor:default; }

    /* ── light theme ── */
    #bsub-panel[data-theme="light"] {
      background: rgba(0,0,0,0.07);
      border-color: rgba(0,0,0,0.14);
      border-bottom-color: rgba(0,0,0,0.05);
      box-shadow:
        0 0 0 0.5px rgba(0,0,0,0.06) inset,
        0 2px 8px rgba(0,0,0,0.04) inset,
        0 20px 60px rgba(0,0,0,0.14),
        0 4px 16px rgba(0,0,0,0.08);
      color: rgba(0,0,0,0.85);
    }
    #bsub-panel[data-theme="light"] #bsub-head   { color: rgba(0,0,0,0.85); }
    #bsub-panel[data-theme="light"] #bsub-toggle { color: rgba(0,0,0,0.42); }
    #bsub-panel[data-theme="light"] #bsub-status { color: rgba(0,0,0,0.45); }
    #bsub-panel[data-theme="light"] .bsub-opt-name { color: rgba(0,0,0,0.85); }
    #bsub-panel[data-theme="light"] .bsub-opt-hint { color: rgba(0,0,0,0.42); }
    #bsub-panel[data-theme="light"] .bsub-badge-none { background:rgba(0,0,0,0.06); color:rgba(0,0,0,0.35); }
    #bsub-panel[data-theme="light"] .bsub-divider { border-top-color: rgba(0,0,0,0.10); }
  `);

  // ═══════════════════════════════════════════════════
  //  面板
  // ═══════════════════════════════════════════════════
  function sampleTheme(panel) {
    const rect = panel.getBoundingClientRect();
    const cx = rect.left + rect.width  / 2;
    const cy = rect.top  + rect.height / 2;
    panel.style.visibility = 'hidden';
    let el = document.elementFromPoint(cx, cy);
    panel.style.visibility = '';
    // 向上找第一个不透明背景色
    while (el && el !== document.documentElement) {
      const bg = getComputedStyle(el).backgroundColor;
      if (bg && bg !== 'transparent' && bg !== 'rgba(0, 0, 0, 0)') {
        const m = bg.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
        if (m) {
          const [r, g, b] = [m[1], m[2], m[3]].map(v => {
            const c = parseInt(v) / 255;
            return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
          });
          const L = 0.2126 * r + 0.7152 * g + 0.0722 * b;
          panel.dataset.theme = L > 0.5 ? 'light' : 'dark';
          return;
        }
      }
      el = el.parentElement;
    }
    panel.dataset.theme = 'dark'; // 兜底：找不到背景色默认暗色
  }

  function createPanel() {
    const p = document.createElement('div');
    p.id = 'bsub-panel';
    p.innerHTML = `
      <h3 id="bsub-head"><span>📝</span><span>字幕导出</span><button id="bsub-toggle">展开</button></h3>
      <div id="bsub-body">
        <div id="bsub-status">
          <div class="bsub-row">字幕&nbsp;<span class="bsub-badge bsub-badge-none" id="bsub-sub-badge">等待中</span></div>
          <div class="bsub-row">评论&nbsp;<span class="bsub-badge bsub-badge-none" id="bsub-cmt-badge">等待中</span></div>
        </div>
        <div class="bsub-opts">
          <label class="bsub-opt-row">
            <input type="checkbox" id="bsub-opt-info" checked>
            <span class="bsub-opt-label">
              <span class="bsub-opt-name">视频信息</span>
              <span class="bsub-opt-hint">含标题、UP主、简介</span>
            </span>
          </label>
          <label class="bsub-opt-row">
            <input type="checkbox" id="bsub-opt-ts" checked>
            <span class="bsub-opt-label">
              <span class="bsub-opt-name">时间轴</span>
              <span class="bsub-opt-hint">保留 [mm:ss] 便于精确定位</span>
            </span>
          </label>
          <label class="bsub-opt-row">
            <input type="checkbox" id="bsub-opt-comments">
            <span class="bsub-opt-label">
              <span class="bsub-opt-name">高质量评论</span>
              <span class="bsub-opt-hint">按点赞排序取前30条<br>需先滚动到评论区</span>
            </span>
          </label>
        </div>
        <hr class="bsub-divider">
        <button id="bsub-export-btn">⬇ 导出 Markdown</button>
      </div>
    `;
    document.body.appendChild(p);
    sampleTheme(p);
    document.getElementById('bsub-head').addEventListener('click', togglePanel);
    document.getElementById('bsub-export-btn').addEventListener('click', e => { e.stopPropagation(); doExport(); });

    (function enableDrag(panel) {
      const head = document.getElementById('bsub-head');
      head.style.cursor = 'grab';
      head.addEventListener('pointerdown', e => {
        if (e.target.id === 'bsub-toggle') return;
        e.preventDefault();
        head.style.cursor = 'grabbing';
        const r0 = panel.getBoundingClientRect();
        const initRight  = window.innerWidth  - r0.right;
        const initBottom = window.innerHeight - r0.bottom;
        const sx = e.clientX, sy = e.clientY;
        let hasMoved = false;
        let lastThemeAt = 0;
        const onMove = e => {
          hasMoved = true;
          const dx = e.clientX - sx, dy = e.clientY - sy;
          panel.style.right  = Math.max(8, Math.min(initRight  - dx, window.innerWidth  - 60)) + 'px';
          panel.style.bottom = Math.max(8, Math.min(initBottom - dy, window.innerHeight - 40)) + 'px';
          const now = Date.now();
          if (now - lastThemeAt > 100) { lastThemeAt = now; sampleTheme(panel); }
        };
        const onUp = () => {
          head.style.cursor = 'grab';
          window.removeEventListener('pointermove', onMove);
          window.removeEventListener('pointerup', onUp);
          sampleTheme(panel);
          if (hasMoved) {
            head.addEventListener('click', e => e.stopImmediatePropagation(), { once: true, capture: true });
          }
        };
        window.addEventListener('pointermove', onMove);
        window.addEventListener('pointerup', onUp);
      });
    })(p);
  }

  function togglePanel() {
    const isExpanded = document.getElementById('bsub-panel').classList.toggle('expanded');
    document.getElementById('bsub-toggle').textContent = isExpanded ? '收起' : '展开';
  }

  function updatePanel() {
    const sb = document.getElementById('bsub-sub-badge');
    if (sb) { const n = subtitleLines.length; sb.textContent = n > 0 ? `${n} 行 ✅` : '等待中'; sb.className = n > 0 ? 'bsub-badge bsub-badge-sub' : 'bsub-badge bsub-badge-none'; }
    const cb = document.getElementById('bsub-cmt-badge');
    if (cb) { const n = commentMap.size; cb.textContent = n > 0 ? `${n} 条 ✅` : '等待中'; cb.className = n > 0 ? 'bsub-badge bsub-badge-cmt' : 'bsub-badge bsub-badge-none'; }
  }

  // ═══════════════════════════════════════════════════
  //  启动
  // ═══════════════════════════════════════════════════
  window.addEventListener('load', () => {
    createPanel();
    // 开始轮询等待评论区 DOM 出现
    startCommentObserver();
    console.log('[B站字幕抓取] v1.9 已启动');
  });

})();
