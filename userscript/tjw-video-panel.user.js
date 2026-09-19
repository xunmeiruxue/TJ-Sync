// ==UserScript==
// @name         TJ-VideoPrep 画面面板（渡幕）
// @namespace    https://github.com/xunmeiruxue/TJ-VideoPrep
// @version      0.1.0
// @description  在渡幕（Trans-Jimaku Web）界面旁挂一个画面面板，跟随渡幕的播放头显示对应视频画面。不改动渡幕任何文件。
// @author       YG
// @match        http://127.0.0.1/*
// @match        http://localhost/*
// @run-at       document-start
// @grant        none
// ==/UserScript==

/* 原理
 * 渡幕的播放器是一个全局单例：Pr(){return tc||(tc=new Audio,tc.preload="auto"),tc}
 * 音频由本地后端 http://127.0.0.1:<port>/api/tracks/<id>/media/audio 供给。
 * 本脚本在页面脚本执行前 hook 掉 window.Audio（因此必须 @run-at document-start
 * 且 @grant none —— 用了 GM_* 会被放进沙箱世界，就 hook 不到页面对象了），
 * 拿到那个元素的引用后：
 *   - 读它的 currentTime 作为唯一权威时钟
 *   - 驱动一个静音 <video> 显示对应画面
 *   - 播放时让 video 自然走，只在漂移超过阈值时校正（每帧强行 seek 会卡解码）
 * 不碰渡幕的音频、波形、播放头，因此它的一切功能都不受影响。
 */

(function () {
  'use strict';

  if (window.__tjwPanelInstalled) return;
  window.__tjwPanelInstalled = true;

  const PLAY_DRIFT_LIMIT = 0.08;   // 播放中允许的漂移（秒），超过就校正
  const PAUSE_DRIFT_LIMIT = 0.02;  // 暂停时允许的漂移，更严格
  const STORE_KEY = 'lastVideo';

  /* ---------------------------------------------------------------- 1. hook Audio */

  const OrigAudio = window.Audio;
  if (typeof OrigAudio === 'function') {
    window.Audio = new Proxy(OrigAudio, {
      construct(target, args, newTarget) {
        const el = Reflect.construct(target, args, newTarget);
        try {
          window.__tjwAudioEl = el;
          window.dispatchEvent(new CustomEvent('tjw-audio-ready'));
        } catch (e) { /* 忽略 */ }
        return el;
      },
    });
  }

  /* ---------------------------------------------------------------- 2. IndexedDB 存取文件句柄 */

  function idb() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open('tjw-panel', 1);
      req.onupgradeneeded = () => {
        if (!req.result.objectStoreNames.contains('kv')) req.result.createObjectStore('kv');
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  async function idbSet(key, value) {
    try {
      const db = await idb();
      await new Promise((res, rej) => {
        const tx = db.transaction('kv', 'readwrite');
        tx.objectStore('kv').put(value, key);
        tx.oncomplete = res;
        tx.onerror = () => rej(tx.error);
      });
    } catch (e) { /* 忽略 */ }
  }

  async function idbGet(key) {
    try {
      const db = await idb();
      return await new Promise((res, rej) => {
        const tx = db.transaction('kv', 'readonly');
        const r = tx.objectStore('kv').get(key);
        r.onsuccess = () => res(r.result);
        r.onerror = () => rej(r.error);
      });
    } catch (e) {
      return null;
    }
  }

  /* ---------------------------------------------------------------- 3. 样式与面板 */

  const CSS = `
  #tjw-panel{position:fixed;right:16px;top:72px;z-index:2147483000;width:480px;min-width:260px;
    background:#12161c;border:1px solid #2a3543;border-radius:8px;overflow:hidden;resize:both;
    box-shadow:0 12px 40px rgba(0,0,0,.55);font:12px/1.5 "Segoe UI","Microsoft YaHei UI",sans-serif;color:#e6edf3}
  #tjw-panel.tjw-min{height:32px!important;resize:none}
  #tjw-panel.tjw-min .tjw-body{display:none}
  .tjw-bar{display:flex;align-items:center;gap:6px;padding:5px 8px;background:#1a2129;
    border-bottom:1px solid #253040;cursor:move;user-select:none}
  .tjw-title{font-weight:600;letter-spacing:.5px;color:#9aa7b6}
  .tjw-status{flex:1;font-family:Consolas,monospace;font-size:11px;color:#6e7d8c;
    overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .tjw-off{display:flex;align-items:center;gap:3px;color:#6e7d8c;font-size:11px}
  .tjw-off input{width:48px;background:#0d1117;border:1px solid #253040;color:#e6edf3;
    border-radius:4px;padding:1px 3px;font-family:Consolas,monospace;font-size:11px}
  .tjw-btn{background:#1f2a35;border:1px solid #2a3543;color:#e6edf3;border-radius:5px;
    padding:2px 8px;font-size:11px;cursor:pointer}
  .tjw-btn:hover{background:#26323f}
  .tjw-body{position:relative;background:#000;aspect-ratio:16/9}
  .tjw-body video{width:100%;height:100%;display:block;object-fit:contain;background:#000}
  .tjw-hint{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;
    color:#6e7d8c;text-align:center;padding:12px;pointer-events:none}
  .tjw-body.has-video .tjw-hint{display:none}
  .tjw-body.tjw-drag{outline:2px dashed #2ea043;outline-offset:-6px}
  `;

  function injectStyle() {
    const s = document.createElement('style');
    s.textContent = CSS;
    (document.head || document.documentElement).appendChild(s);
  }

  let panel, body, video, statusEl, offsetEl;

  function buildPanel() {
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
        <button class="tjw-btn" data-a="min">—</button>
      </div>
      <div class="tjw-body">
        <video muted playsinline preload="auto"></video>
        <div class="tjw-hint">把分离时生成的 preview.mp4 拖到这里，<br>或点右上角「选视频」</div>
      </div>`;

    document.body.appendChild(panel);

    body = panel.querySelector('.tjw-body');
    video = panel.querySelector('video');
    statusEl = panel.querySelector('.tjw-status');
    offsetEl = panel.querySelector('.tjw-off input');

    panel.querySelector('[data-a="pick"]').addEventListener('click', pickVideo);
    panel.querySelector('[data-a="min"]').addEventListener('click', () => panel.classList.toggle('tjw-min'));
    offsetEl.addEventListener('change', () => { offsetEl.blur(); });

    makeDraggable(panel.querySelector('.tjw-bar'));

    // 拖入视频文件
    body.addEventListener('dragover', (e) => {
      e.preventDefault();
      e.stopPropagation();
      body.classList.add('tjw-drag');
    });
    body.addEventListener('dragleave', () => body.classList.remove('tjw-drag'));
    body.addEventListener('drop', async (e) => {
      e.preventDefault();
      e.stopPropagation();
      body.classList.remove('tjw-drag');
      const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
      if (f) attachBlob(URL.createObjectURL(f), f.name);
    });
  }

  function makeDraggable(handle) {
    let sx = 0, sy = 0, ox = 0, oy = 0, dragging = false;
    handle.addEventListener('pointerdown', (e) => {
      dragging = true;
      sx = e.clientX; sy = e.clientY;
      const r = panel.getBoundingClientRect();
      ox = r.left; oy = r.top;
      panel.style.right = 'auto';
      panel.style.left = ox + 'px';
      panel.style.top = oy + 'px';
      handle.setPointerCapture(e.pointerId);
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

  /* ---------------------------------------------------------------- 4. 选择视频 */

  function attachBlob(url, name) {
    video.src = url;
    body.classList.add('has-video');
    video.load();
    setStatus(`已载入 ${name || '视频'}`);
  }

  async function pickVideo() {
    // 优先用 File System Access API：句柄能存起来，下次自动恢复
    if (window.showOpenFilePicker) {
      try {
        const [handle] = await window.showOpenFilePicker({
          types: [{ description: '视频', accept: { 'video/*': ['.mp4', '.m4v', '.webm'] } }],
        });
        await idbSet(STORE_KEY, handle);
        const file = await handle.getFile();
        attachBlob(URL.createObjectURL(file), file.name);
        return;
      } catch (e) {
        if (e && e.name === 'AbortError') return;
      }
    }

    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'video/*';
    input.addEventListener('change', () => {
      const f = input.files && input.files[0];
      if (f) attachBlob(URL.createObjectURL(f), f.name);
    });
    input.click();
  }

  async function restoreLast() {
    const handle = await idbGet(STORE_KEY);
    if (!handle || !handle.getFile) return;
    try {
      const perm = await handle.queryPermission({ mode: 'read' });
      if (perm !== 'granted') {
        setStatus('点「选视频」重新授权上次的文件');
        return;
      }
      const file = await handle.getFile();
      attachBlob(URL.createObjectURL(file), file.name);
    } catch (e) { /* 忽略 */ }
  }

  /* ---------------------------------------------------------------- 5. 跟随 */

  function setStatus(text) {
    if (statusEl) statusEl.textContent = text;
  }

  function offsetSeconds() {
    const ms = parseFloat(offsetEl && offsetEl.value);
    return Number.isFinite(ms) ? ms / 1000 : 0;
  }

  let lastReport = 0;

  function tick() {
    const a = window.__tjwAudioEl;

    if (!a) {
      setStatus('等待渡幕播放器…（打开一个音轨后生效）');
    } else if (!video.src) {
      setStatus('未选择视频');
    } else {
      const target = a.currentTime + offsetSeconds();
      const drift = Math.abs(video.currentTime - target);
      const playing = !a.paused;

      if (playing) {
        if (video.paused) {
          const p = video.play();
          if (p && p.catch) p.catch(() => { /* 自动播放被拦：忽略 */ });
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
          `${playing ? '播放中' : '已暂停'} · 漂移 ${(drift * 1000).toFixed(0)} ms · ${formatTime(target)}`
        );
      }
    }

    requestAnimationFrame(tick);
  }

  function formatTime(s) {
    if (!Number.isFinite(s) || s < 0) s = 0;
    const m = Math.floor(s / 60);
    const sec = s - m * 60;
    return `${m}:${sec.toFixed(2).padStart(5, '0')}`;
  }

  /* ---------------------------------------------------------------- 6. 启动 */

  function boot() {
    injectStyle();
    buildPanel();
    restoreLast();
    requestAnimationFrame(tick);
  }

  if (document.body) {
    boot();
  } else {
    const obs = new MutationObserver(() => {
      if (document.body) {
        obs.disconnect();
        boot();
      }
    });
    obs.observe(document.documentElement, { childList: true, subtree: true });
  }
})();
