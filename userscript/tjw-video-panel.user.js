// ==UserScript==
// @name         TJ-Sync 画面面板（渡幕）
// @namespace    https://github.com/xunmeiruxue/TJ-Sync
// @version      0.2.1
// @description  在渡幕（Trans-Jimaku Web）界面旁挂一块画面显示，跟随渡幕的播放头。不改动渡幕任何文件。
// @author       YG
// @match        http://127.0.0.1/*
// @match        http://localhost/*
// @run-at       document-start
// @grant        none
// ==/UserScript==

/* 原理
 * 渡幕的播放器是一个全局单例：Pr(){return tc||(tc=new Audio,tc.preload="auto"),tc}
 * 音频由本地后端 http://127.0.0.1:<port>/api/tracks/<id>/media/audio 供给。
 * 本脚本在页面脚本执行前 hook 掉 window.Audio（所以必须 @run-at document-start
 * 且 @grant none —— 用了 GM_* 会被放进沙箱世界，就 hook 不到页面对象了），
 * 拿到那个元素后：读它的 currentTime 作为唯一权威时钟，驱动一个静音 <video>。
 * 不碰渡幕的音频、波形、播放头，它的功能完全不受影响。
 *
 * 只在渡幕页面生效：127.0.0.1 上可能开着很多别的服务，脚本会先确认当前页面
 * 是不是渡幕（看后端注入的 __BACKEND_PORT__ 或页面标题），不是就不显示面板。
 */

(function () {
  'use strict';

  if (window.__tjwPanelInstalled) return;
  window.__tjwPanelInstalled = true;

  const PLAY_DRIFT_LIMIT = 0.08;   // 播放中允许的漂移（秒）
  const PAUSE_DRIFT_LIMIT = 0.02;  // 暂停时允许的漂移，更严格
  const DETECT_TIMEOUT_MS = 6000;  // 等待确认为渡幕页面的上限

  /* ---------------------------------------------------------------- 1. hook Audio */

  const OrigAudio = window.Audio;
  if (typeof OrigAudio === 'function') {
    window.Audio = new Proxy(OrigAudio, {
      construct(target, args, newTarget) {
        const el = Reflect.construct(target, args, newTarget);
        try { window.__tjwAudioEl = el; } catch (e) { /* 忽略 */ }
        return el;
      },
    });
  }

  /** 取渡幕的播放元素：优先 hook 到的引用，兜底查 DOM */
  function audioEl() {
    const hooked = window.__tjwAudioEl;
    if (hooked && hooked.currentTime !== undefined) return hooked;
    const inDom = document.querySelector('audio');
    return inDom || null;
  }

  /* ---------------------------------------------------------------- 2. 只在渡幕页面工作 */

  function looksLikeTJW() {
    try {
      if (typeof window.__BACKEND_PORT__ !== 'undefined') return true;
    } catch (e) { /* 忽略 */ }
    const t = (document.title || '') + ' ' + location.href;
    return /trans[-\s_]?jimaku/i.test(t);
  }

  function waitForTJW(cb) {
    const started = Date.now();
    (function probe() {
      if (looksLikeTJW()) return cb();
      if (Date.now() - started > DETECT_TIMEOUT_MS) return; // 不是渡幕，什么都不做
      setTimeout(probe, 250);
    })();
  }

  /* ---------------------------------------------------------------- 3. 样式 */

  const CSS = `
  #tjw-panel{position:fixed;right:16px;top:72px;z-index:2147483000;width:480px;min-width:260px;
    background:#12161c;border:1px solid #2a3543;border-radius:8px;overflow:hidden;resize:both;
    box-shadow:0 12px 40px rgba(0,0,0,.55);font:12px/1.5 "Segoe UI","Microsoft YaHei UI",sans-serif;color:#e6edf3}
  .tjw-bar{display:flex;align-items:center;gap:6px;padding:5px 8px;background:#1a2129;
    border-bottom:1px solid #253040;cursor:move;user-select:none}
  .tjw-title{font-weight:600;letter-spacing:.5px;color:#9aa7b6;white-space:nowrap}
  .tjw-status{flex:1;font-family:Consolas,monospace;font-size:11px;color:#6e7d8c;
    overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .tjw-off{display:flex;align-items:center;gap:3px;color:#6e7d8c;font-size:11px;white-space:nowrap}
  .tjw-off input{width:44px;background:#0d1117;border:1px solid #253040;color:#e6edf3;
    border-radius:4px;padding:1px 3px;font-family:Consolas,monospace;font-size:11px}
  .tjw-btn{background:#1f2a35;border:1px solid #2a3543;color:#e6edf3;border-radius:5px;
    padding:2px 8px;font-size:11px;cursor:pointer;white-space:nowrap}
  .tjw-btn:hover{background:#26323f}
  .tjw-body{position:relative;background:#000;aspect-ratio:16/9}
  .tjw-body video{width:100%;height:100%;display:block;object-fit:contain;background:#000}
  .tjw-hint{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;
    color:#6e7d8c;text-align:center;padding:12px;pointer-events:none;pointer-events:none}
  .tjw-body.has-video .tjw-hint{display:none}
  .tjw-body.tjw-drag{outline:2px dashed #2ea043;outline-offset:-6px}

  /* 收起状态：只剩一个很小的胶囊 */
  #tjw-panel.tjw-min{width:auto;min-width:0;height:auto;resize:none}
  #tjw-panel.tjw-min .tjw-body,
  #tjw-panel.tjw-min .tjw-status,
  #tjw-panel.tjw-min .tjw-off,
  #tjw-panel.tjw-min [data-a="pick"]{display:none}
  #tjw-panel.tjw-min .tjw-bar{border-bottom:none;padding:3px 7px}
  `;

  /* ---------------------------------------------------------------- 4. 面板 */

  let panel, body, video, statusEl, offsetEl, fileInput, minBtn;

  function build() {
    const style = document.createElement('style');
    style.textContent = CSS;
    (document.head || document.documentElement).appendChild(style);

    panel = document.createElement('div');
    panel.id = 'tjw-panel';
    panel.innerHTML = `
      <div class="tjw-bar">
        <span class="tjw-title">画面</span>
        <span class="tjw-status">等待渡幕播放器…</span>
        <label class="tjw-off" title="画面相对声音的固定微调（毫秒），一般保持 0">偏移
          <input type="number" value="0" step="10">
        </label>
        <button class="tjw-btn" data-a="pick">选视频</button>
        <button class="tjw-btn" data-a="min" title="收起 / 展开">−</button>
      </div>
      <div class="tjw-body">
        <video muted playsinline preload="auto"></video>
        <div class="tjw-hint">把分离时生成的 preview.mp4 拖到这里，<br>或点右上角「选视频」</div>
      </div>
      <input type="file" accept="video/*,.mp4,.m4v,.webm" style="display:none">`;

    document.body.appendChild(panel);

    body = panel.querySelector('.tjw-body');
    video = panel.querySelector('video');
    statusEl = panel.querySelector('.tjw-status');
    offsetEl = panel.querySelector('.tjw-off input');
    fileInput = panel.querySelector('input[type=file]');
    minBtn = panel.querySelector('[data-a="min"]');

    // 选视频：同步触发 input.click()，保证仍在用户手势里，弹窗不会被拦
    panel.querySelector('[data-a="pick"]').addEventListener('click', () => fileInput.click());
    fileInput.addEventListener('change', () => {
      const f = fileInput.files && fileInput.files[0];
      if (f) attach(URL.createObjectURL(f), f.name);
    });

    // 收起 / 展开
    minBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      toggleMin();
    });

    offsetEl.addEventListener('change', () => offsetEl.blur());

    makeDraggable(panel.querySelector('.tjw-bar'));

    // 拖放视频
    body.addEventListener('dragover', (e) => {
      e.preventDefault();
      e.stopPropagation();
      body.classList.add('tjw-drag');
    });
    body.addEventListener('dragleave', () => body.classList.remove('tjw-drag'));
    body.addEventListener('drop', (e) => {
      e.preventDefault();
      e.stopPropagation();
      body.classList.remove('tjw-drag');
      const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
      if (f) attach(URL.createObjectURL(f), f.name);
    });

    video.addEventListener('loadedmetadata', () => {
      ready = true;
      fatal = '';
      video.currentTime = pendingSeek;
    });
    video.addEventListener('error', () => {
      const e = video.error;
      const codeText = {
        1: '加载被中止',
        2: '网络 / 读取错误',
        3: '解码失败（编码可能不被浏览器支持）',
        4: '源不被支持，或格式无法解析（也可能是页面策略阻止了媒体加载）',
      }[e && e.code] || '未知错误';
      fatal = `视频无法播放：${codeText}`;
      setStatus(fatal, videoDetail());
    });
    video.addEventListener('stalled', () => {
      if (!ready) setStatus('加载停滞…', videoDetail());
    });
  }

  function toggleMin() {
    const min = panel.classList.toggle('tjw-min');
    minBtn.textContent = min ? '＋' : '−';
    minBtn.title = min ? '展开' : '收起';
  }

  function makeDraggable(handle) {
    let sx = 0, sy = 0, ox = 0, oy = 0, dragging = false;
    handle.addEventListener('pointerdown', (e) => {
      if (e.target.closest('button, input, label')) return; // 控件上不拖动
      dragging = true;
      sx = e.clientX; sy = e.clientY;
      const r = panel.getBoundingClientRect();
      ox = r.left; oy = r.top;
      panel.style.right = 'auto';
      panel.style.left = ox + 'px';
      panel.style.top = oy + 'px';
      try { handle.setPointerCapture(e.pointerId); } catch (err) { /* 忽略 */ }
    });
    handle.addEventListener('pointermove', (e) => {
      if (!dragging) return;
      panel.style.left = ox + (e.clientX - sx) + 'px';
      panel.style.top = oy + (e.clientY - sy) + 'px';
    });
    handle.addEventListener('pointerup', (e) => {
      dragging = false;
      try { handle.releasePointerCapture(e.pointerId); } catch (err) { /* 忽略 */ }
    });
  }

  /* ---------------------------------------------------------------- 5. 载入视频 */

  let ready = false;
  let pendingSeek = 0;
  let fatal = '';            // 致命错误：编码不支持、被页面策略拦等
  let loadStartedAt = 0;
  let lastProbe = '';        // blob 可读性探测结果

  /** 用 fetch 读 blob 头部：区分"blob 本身有问题"和"media 加载被页面策略拦了" */
  function probeBlob(url) {
    lastProbe = '探测中…';
    fetch(url, { headers: { Range: 'bytes=0-2047' } })
      .then((r) => { lastProbe = `blob 可读（HTTP ${r.status}）`; })
      .catch((e) => { lastProbe = `blob 读取失败：${(e && e.message) || e}`; });
  }

  function videoDetail() {
    const e = video.error;
    return [
      `video.error = ${e ? `${e.code} ${e.message || ''}` : '无'}`,
      `readyState = ${video.readyState}（4 = 可播放）`,
      `networkState = ${video.networkState}`,
      `blob 探测 = ${lastProbe || '(未探测)'}`,
      `已等待 = ${loadStartedAt ? ((Date.now() - loadStartedAt) / 1000).toFixed(1) : '-'} s`,
    ].join('\n');
  }

  function attach(url, name) {
    ready = false;
    fatal = '';
    loadStartedAt = Date.now();
    probeBlob(url);
    const a = audioEl();
    pendingSeek = a ? a.currentTime + offsetSeconds() : 0;
    video.src = url;
    body.classList.add('has-video');
    video.load();
    setStatus(`已载入 ${name || '视频'}`, '正在加载元数据…');
  }

  /* ---------------------------------------------------------------- 6. 跟随 */

  function setStatus(text, detail) {
    if (!statusEl) return;
    statusEl.textContent = text;
    statusEl.title = detail || text;
  }

  function offsetSeconds() {
    const ms = parseFloat(offsetEl && offsetEl.value);
    return Number.isFinite(ms) ? ms / 1000 : 0;
  }

  let lastReport = 0;

  function tick() {
    requestAnimationFrame(tick);

    const a = audioEl();
    if (!a) {
      setStatus('等待渡幕播放器…', '打开一个音轨并开始播放后，渡幕才会创建音频元素');
      return;
    }
    if (!video.src) {
      setStatus('未选择视频', '点「选视频」或把 preview.mp4 拖进面板');
      return;
    }
    if (fatal) {
      setStatus(fatal, videoDetail());
      return;
    }
    if (!ready) {
      // 不要每帧覆盖同一个短句：把等待时长和诊断带上，便于判断卡在哪
      const waited = (Date.now() - loadStartedAt) / 1000;
      setStatus(
        `视频加载中… ${waited.toFixed(0)}s`,
        waited >= 5
          ? `${videoDetail()}\n\n超过 5 秒仍未就绪：编码不支持会走 error 分支提示；\n若既不报错也毫无进展，多半是页面策略（CSP）阻止了 blob 媒体加载。`
          : videoDetail()
      );
      return;
    }

    const target = a.currentTime + offsetSeconds();
    const drift = Math.abs(video.currentTime - target);
    const playing = !a.paused;

    // 渡幕支持变速，画面也要跟上
    const rate = a.playbackRate > 0 ? a.playbackRate : 1;
    if (Math.abs(video.playbackRate - rate) > 0.01) video.playbackRate = rate;

    if (playing) {
      if (video.paused) {
        const p = video.play();
        if (p && p.catch) p.catch(() => { /* 自动播放被拦则忽略 */ });
      }
      if (drift > PLAY_DRIFT_LIMIT) video.currentTime = target;
    } else {
      if (!video.paused) video.pause();
      if (drift > PAUSE_DRIFT_LIMIT) video.currentTime = target;
    }

    const now = performance.now();
    if (now - lastReport > 250) {
      lastReport = now;
      setStatus(
        `${playing ? '播放中' : '已暂停'} · 漂移 ${(drift * 1000).toFixed(0)} ms · ${fmt(target)}`,
        [
          `音频 currentTime = ${a.currentTime.toFixed(3)}`,
          `画面 currentTime = ${video.currentTime.toFixed(3)}`,
          `漂移 = ${(drift * 1000).toFixed(0)} ms`,
          `速率 = ${rate}`,
          `暂停 = ${a.paused}`,
          `视频就绪 = ${video.readyState}`,
        ].join('\n')
      );
    }
  }

  function fmt(s) {
    if (!Number.isFinite(s) || s < 0) s = 0;
    const m = Math.floor(s / 60);
    const sec = s - m * 60;
    return `${m}:${sec.toFixed(2).padStart(5, '0')}`;
  }

  /* ---------------------------------------------------------------- 7. 启动 */

  function waitBody(cb) {
    if (document.body) return cb();
    const obs = new MutationObserver(() => {
      if (document.body) {
        obs.disconnect();
        cb();
      }
    });
    obs.observe(document.documentElement, { childList: true, subtree: true });
  }

  // 尽量早地开始 hook（已在文件顶部完成），面板等确认是渡幕页面后再建
  waitBody(() => waitForTJW(() => {
    build();
    requestAnimationFrame(tick);
  }));
})();
