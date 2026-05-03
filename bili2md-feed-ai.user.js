// ==UserScript==
// @name         B站AI字幕抓取 & 导出MD
// @namespace    https://github.com/your-namespace
// @version      1.9.0
// @description  自动抓取B站AI字幕和热门评论，连同视频信息一起导出为Markdown，方便喂给AI提问
// @author       You
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
      font-family: 'PingFang SC', 'Hiragino Sans GB', sans-serif; font-size: 13px;
      color: #e8e8e8; background: rgba(15,16,22,0.93);
      border: 1px solid rgba(255,255,255,0.10); border-radius: 12px; padding: 8px 14px;
      box-shadow: 0 8px 32px rgba(0,0,0,0.55); backdrop-filter: blur(14px);
      user-select: none; min-width: 0;
    }
    #bsub-panel.expanded { padding: 14px 16px; min-width: 230px; }
    #bsub-head { margin:0; font-size:13px; font-weight:600; color:#fff; display:flex; align-items:center; gap:8px; cursor:pointer; white-space:nowrap; }
    #bsub-toggle { margin-left:auto; font-size:11px; color:#666; background:none; border:none; cursor:pointer; padding:0; }
    #bsub-body { display:none; margin-top:12px; }
    #bsub-panel.expanded #bsub-body { display:block; }
    #bsub-status { font-size:11.5px; color:#888; margin-bottom:12px; line-height:1.7; }
    .bsub-row { display:flex; align-items:center; gap:4px; }
    .bsub-badge { display:inline-block; border-radius:20px; padding:0 7px; font-weight:700; font-size:11px; }
    .bsub-badge-sub  { background:rgba(0,174,236,0.15); color:#00aeec; }
    .bsub-badge-cmt  { background:rgba(255,180,0,0.15); color:#e6a800; }
    .bsub-badge-none { background:rgba(255,255,255,0.06); color:#555; }
    .bsub-opts { display:flex; flex-direction:column; gap:8px; margin-bottom:12px; }
    .bsub-opt-row { display:flex; align-items:flex-start; gap:7px; cursor:pointer; }
    .bsub-opt-row input[type=checkbox] { margin:2px 0 0; accent-color:#00aeec; cursor:pointer; flex-shrink:0; }
    .bsub-opt-label { display:flex; flex-direction:column; gap:2px; }
    .bsub-opt-name { font-size:12.5px; color:#ddd; font-weight:500; }
    .bsub-opt-hint { font-size:11px; color:#555; line-height:1.4; }
    .bsub-divider { border:none; border-top:1px solid rgba(255,255,255,0.07); margin:10px 0; }
    #bsub-export-btn {
      width:100%; padding:8px 0; border-radius:8px; border:none; cursor:pointer;
      font-size:13px; font-weight:600; background:linear-gradient(90deg,#00aeec,#0080cc); color:#fff;
      transition:filter .15s,transform .1s,opacity .15s;
    }
    #bsub-export-btn:hover  { filter:brightness(1.12); }
    #bsub-export-btn:active { transform:scale(.97); }
    #bsub-export-btn:disabled { opacity:.55; cursor:default; }
  `);

  // ═══════════════════════════════════════════════════
  //  面板
  // ═══════════════════════════════════════════════════
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
    document.getElementById('bsub-head').addEventListener('click', togglePanel);
    document.getElementById('bsub-export-btn').addEventListener('click', e => { e.stopPropagation(); doExport(); });
  }

  function togglePanel() {
    const p = document.getElementById('bsub-panel');
    const b = document.getElementById('bsub-toggle');
    const ex = !p.classList.contains('expanded');
    p.classList.toggle('expanded', ex);
    b.textContent = ex ? '收起' : '展开';
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
