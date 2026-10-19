'use strict';

/* =====================================================================
   Ace's Editing Software - renderer
   One video track. Clips play back to back; editing a clip closes the gap.
   ===================================================================== */

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const uid = () => Math.random().toString(36).slice(2, 10);
const pad2 = (n) => String(n).padStart(2, '0');

const PAD = 24;          // left padding inside the timeline (px)
const MIN_LEN = 0.1;     // shortest clip (seconds)
const IMAGE_LEN = 5;     // default length for images (seconds)

const DEFAULT_FX = {
  fadeIn: 0, fadeOut: 0, blur: 0, speed: 1, volume: 100, muted: false,
  brightness: 0, contrast: 0, saturation: 0, sharpen: 0, bw: false, fit: 'contain',
  reverse: false, interp: 'nearest', pitch: true,
  blurType: 'gaussian', blurAmt: 0,
  hue: 0, vignette: 0, grain: 0, flipH: false, flipV: false
};

const ICONS = {
  plus:     ['s', '<path d="M12 5v14M5 12h14"/>'],
  x:        ['s', '<path d="M6 6l12 12M18 6L6 18"/>'],
  play:     ['f', '<path d="M7 4.5v15l12-7.5z"/>'],
  pause:    ['f', '<path d="M6 4h4v16H6zM14 4h4v16h-4z"/>'],
  toStart:  ['f', '<path d="M5 5h2.4v14H5zM20 5v14L8.6 12z"/>'],
  toEnd:    ['f', '<path d="M16.6 5H19v14h-2.4zM4 5l11.4 7L4 19z"/>'],
  stepBack: ['f', '<path d="M16 5v14L7 12z"/>'],
  stepFwd:  ['f', '<path d="M8 5v14l9-7z"/>'],
  undo:     ['s', '<path d="M9 6L4 11l5 5M4 11h9a6 6 0 0 1 0 9"/>'],
  redo:     ['s', '<path d="M15 6l5 5-5 5M20 11h-9a6 6 0 0 0 0 9"/>'],
  split:    ['s', '<circle cx="6" cy="6.5" r="2.4"/><circle cx="6" cy="17.5" r="2.4"/><path d="M8 8l12 9M8 16l12-9"/>'],
  dup:      ['s', '<path d="M8 8h12v12H8zM16 8V4H4v12h4"/>'],
  trash:    ['s', '<path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13M10 11v6M14 11v6"/>']
};
const icon = (n) => { const [k, d] = ICONS[n]; return `<svg class="ic ${k}" viewBox="0 0 24 24">${d}</svg>`; };
$$('i[data-icon]').forEach((e) => { e.innerHTML = icon(e.dataset.icon); });

/* ---------------------------------------------------------------- state */
const state = {
  media: [],
  clips: [],
  sel: [],            // selected clip ids; the last one is the one shown in the inspector
  playhead: 0,
  playing: false,
  zoom: 90,
  settings: { aspect: '16:9', height: 1080, fps: 30, quality: 'standard', format: 'mp4' },
  projectPath: null
};
let L = [];        // layout: [{clip, start, dur}]
let TOTAL = 0;
let history = [];
let future = [];

const mediaById = (id) => state.media.find((m) => m.id === id);
const mediaOf = (c) => mediaById(c.mediaId);
const clipDur = (c) => (c.out - c.in) / c.fx.speed;
const selectedClip = () => state.clips.find((c) => c.id === state.sel[state.sel.length - 1]) || null;
const selectedClips = () => state.clips.filter((c) => state.sel.includes(c.id));
const setSel = (ids) => { state.sel = ids.filter(Boolean); };

function relayout() {
  let t = 0;
  L = state.clips.map((clip) => { const dur = clipDur(clip); const r = { clip, start: t, dur }; t += dur; return r; });
  TOTAL = t;
}
function clipAt(t) {
  if (!L.length) return null;
  for (let i = 0; i < L.length; i++) {
    const r = L[i];
    if (t < r.start + r.dur - 1e-6 || i === L.length - 1) return { ...r, index: i };
  }
  return null;
}

/* -------------------------------------------------------------- helpers */
const fmtTime = (t) => { t = Math.max(0, t); return Math.floor(t / 60) + ':' + pad2(Math.floor(t % 60)); };
function timecode(t) {
  const fps = state.settings.fps;
  const frames = Math.round(Math.max(0, t) * fps);
  const f = frames % fps, s = Math.floor(frames / fps);
  return `${pad2(Math.floor(s / 3600))}:${pad2(Math.floor(s / 60) % 60)}:${pad2(s % 60)}:${pad2(f)}`;
}
let toastTimer = null;
function toast(msg, ms = 3600) {
  const t = $('#toast');
  t.textContent = msg; t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, ms);
}
function outSize() {
  const short = state.settings.height;
  const long = Math.round(short * 16 / 9 / 2) * 2;
  const a = state.settings.aspect;
  if (a === '9:16') return { w: short, h: long };
  if (a === '1:1') return { w: short, h: short };
  return { w: long, h: short };
}

/* ---------------------------------------------------------- undo / redo */
const snap = () => JSON.stringify({ clips: state.clips, sel: state.sel });
function snapshot() {
  const s = snap();
  if (history.length && history[history.length - 1] === s) return;
  history.push(s);
  if (history.length > 120) history.shift();
  future = [];
  updateUndoButtons();
}
function restore(s) {
  const o = JSON.parse(s);
  pause();
  state.clips = o.clips;
  state.sel = (o.sel || []).filter((id) => o.clips.some((c) => c.id === id));
  changed({ structural: true });
}
function undo() { if (!history.length) return; future.push(snap()); restore(history.pop()); updateUndoButtons(); }
function redo() { if (!future.length) return; history.push(snap()); restore(future.pop()); updateUndoButtons(); }
function updateUndoButtons() {
  $('#tUndo').disabled = !history.length;
  $('#tRedo').disabled = !future.length;
}

/* ------------------------------------------------------------ the video */
const video = document.createElement('video');
video.preload = 'auto';
video.playsInline = true;
const imageCache = new Map();
const imageFor = (m) => {
  let img = imageCache.get(m.id);
  if (!img) { img = new Image(); img.src = m.url; imageCache.set(m.id, img); }
  return img;
};

const screen = $('#screen');
const sctx = screen.getContext('2d');
const acc = document.createElement('canvas');
const actx = acc.getContext('2d');
const tmp = document.createElement('canvas');          // one frame with its effects, before motion-blur mixing
const tctx = tmp.getContext('2d');
const noise = document.createElement('canvas');        // film grain texture
noise.width = noise.height = 256;
(() => {
  const g = noise.getContext('2d'), d = g.createImageData(256, 256);
  for (let i = 0; i < d.data.length; i += 4) { const v = Math.random() * 255; d.data[i] = d.data[i + 1] = d.data[i + 2] = v; d.data[i + 3] = 255; }
  g.putImageData(d, 0, 0);
})();
let loaded = { clipId: null, videoMediaId: null };
let resetAcc = true;
let imgClock = { t0: 0, base: 0 };
let loadToken = 0;
let busy = false;
let raf = 0;

function sizeCanvases() {
  const s = outSize();
  const k = 720 / Math.min(s.w, s.h);
  screen.width = acc.width = tmp.width = Math.round(s.w * k);
  screen.height = acc.height = tmp.height = Math.round(s.h * k);
  resetAcc = true;
  fitStage();
}
function fitStage() {
  const wrap = $('#screenWrap');
  const availW = wrap.clientWidth - 36, availH = wrap.clientHeight - 36;
  const ar = screen.width / screen.height;
  const w = Math.max(40, Math.min(availW, availH * ar));
  screen.style.width = w + 'px';
  screen.style.height = (w / ar) + 'px';
}

const cssFilter = (fx) => {
  const f = [];
  if (fx.brightness) f.push(`brightness(${1 + fx.brightness / 200})`);
  if (fx.contrast) f.push(`contrast(${1 + fx.contrast / 100})`);
  if (fx.saturation) f.push(`saturate(${1 + fx.saturation / 100})`);
  if (fx.hue) f.push(`hue-rotate(${fx.hue}deg)`);
  if (fx.bw) f.push('grayscale(1)');
  return f.length ? f.join(' ') : 'none';
};

function fadeAmount(fx, lt, dur) {
  let a = 0;
  if (fx.fadeIn > 0 && lt < fx.fadeIn) a = Math.max(a, 1 - lt / fx.fadeIn);
  const rem = dur - lt;
  if (fx.fadeOut > 0 && rem < fx.fadeOut) a = Math.max(a, 1 - rem / fx.fadeOut);
  return clamp(a, 0, 1);
}

// Paints one source frame into ctx with flips, colour, and the chosen blur effect.
function paintSource(ctx, src, sw, sh, W, H, fx) {
  const k = fx.fit === 'cover' ? Math.max(W / sw, H / sh) : Math.min(W / sw, H / sh);
  const dw = sw * k, dh = sh * k, x = (W - dw) / 2, y = (H - dh) / 2;
  const short = Math.min(W, H);
  const amt = fx.blurAmt / 100;
  const type = fx.blurType;
  ctx.save();
  ctx.fillStyle = '#000'; ctx.fillRect(0, 0, W, H);
  if (fx.flipH || fx.flipV) {
    ctx.translate(W / 2, H / 2); ctx.scale(fx.flipH ? -1 : 1, fx.flipV ? -1 : 1); ctx.translate(-W / 2, -H / 2);
  }
  let filt = cssFilter(fx);
  filt = filt === 'none' ? '' : filt;
  if (amt > 0 && type === 'gaussian') filt += ` blur(${amt * 30 * short / 720}px)`;
  if (amt > 0 && type === 'box') filt += ` blur(${amt * 20 * short / 720 * 0.8}px)`;
  ctx.filter = filt || 'none';
  if (amt > 0 && (type === 'horizontal' || type === 'vertical' || type === 'zoom')) {
    const n = 9;
    for (let i = 0; i < n; i++) {
      const t = i / (n - 1);
      ctx.globalAlpha = 1 / (i + 1);                       // equal-weight average of the copies
      if (type === 'zoom') {
        const z = 1 + t * amt * 0.22;
        ctx.drawImage(src, (W - dw * z) / 2, (H - dh * z) / 2, dw * z, dh * z);
      } else {
        const off = (t - 0.5) * amt * 0.08 * (type === 'horizontal' ? W : H);
        ctx.drawImage(src, x + (type === 'horizontal' ? off : 0), y + (type === 'vertical' ? off : 0), dw, dh);
      }
    }
  } else {
    ctx.drawImage(src, x, y, dw, dh);
  }
  ctx.restore();
}

function drawFrame() {
  const W = screen.width, H = screen.height;
  sctx.globalAlpha = 1;
  sctx.fillStyle = '#000';
  sctx.fillRect(0, 0, W, H);
  const cur = clipAt(state.playhead);
  if (!cur) return;
  const { clip, start, dur } = cur;
  const fx = clip.fx;
  const m = mediaOf(clip);
  if (!m) return;

  const src = m.type === 'image' ? imageFor(m) : video;
  const sw = m.type === 'image' ? src.naturalWidth : src.videoWidth;
  const sh = m.type === 'image' ? src.naturalHeight : src.videoHeight;
  const ready = sw > 0 && (m.type === 'image' ? src.complete : src.readyState >= 2) && loaded.clipId === clip.id;

  if (ready) {
    const blur = fx.blur / 100;
    const alpha = state.playing && blur > 0 ? 1 - blur * 0.82 : 1;
    if (alpha === 1 || resetAcc) {
      actx.globalAlpha = 1; actx.filter = 'none';
      actx.fillStyle = '#000'; actx.fillRect(0, 0, W, H);
      resetAcc = false;
    }
    paintSource(tctx, src, sw, sh, W, H, fx);
    actx.globalAlpha = alpha;
    actx.drawImage(tmp, 0, 0);
    actx.globalAlpha = 1;
  }
  sctx.drawImage(acc, 0, 0);

  if (fx.vignette > 0) {
    const g = sctx.createRadialGradient(W / 2, H / 2, Math.min(W, H) * 0.25, W / 2, H / 2, Math.hypot(W, H) / 2);
    g.addColorStop(0, 'rgba(0,0,0,0)');
    g.addColorStop(1, `rgba(0,0,0,${fx.vignette / 100 * 0.95})`);
    sctx.fillStyle = g; sctx.fillRect(0, 0, W, H);
  }
  if (fx.grain > 0) {
    sctx.save();
    sctx.globalAlpha = fx.grain / 100 * 0.45;
    sctx.globalCompositeOperation = 'overlay';
    sctx.translate(Math.random() * 256, Math.random() * 256);
    sctx.fillStyle = sctx.createPattern(noise, 'repeat');
    sctx.fillRect(-256, -256, W + 512, H + 512);
    sctx.restore();
  }

  const a = fadeAmount(fx, state.playhead - start, dur);
  if (a > 0) { sctx.globalAlpha = a; sctx.fillStyle = '#000'; sctx.fillRect(0, 0, W, H); sctx.globalAlpha = 1; }
}

function seekVideo(t) {
  return new Promise((resolve) => {
    if (Math.abs(video.currentTime - t) < 0.001 && video.readyState >= 2) return resolve();
    let to = 0;
    const done = () => { video.removeEventListener('seeked', done); clearTimeout(to); resolve(); };
    to = setTimeout(done, 900);
    video.addEventListener('seeked', done);
    video.currentTime = t;
  });
}
function loadVideo(m) {
  return new Promise((resolve, reject) => {
    const ok = () => { cleanup(); resolve(); };
    const bad = () => { cleanup(); reject(new Error('unsupported')); };
    const cleanup = () => { video.removeEventListener('loadeddata', ok); video.removeEventListener('error', bad); };
    video.addEventListener('loadeddata', ok);
    video.addEventListener('error', bad);
    video.src = m.url;
    video.load();
  });
}

// Gets the preview ready to show (and optionally play) timeline time t.
async function prepare(t, play) {
  const tok = ++loadToken;
  const cur = clipAt(t);
  if (!cur) { video.pause(); drawFrame(); return; }
  const { clip, start } = cur;
  const fx = clip.fx;
  const m = mediaOf(clip);
  if (loaded.clipId !== clip.id) resetAcc = true;

  if (m.type === 'video') {
    if (loaded.videoMediaId !== m.id) {
      try { await loadVideo(m); }
      catch (e) {
        if (tok !== loadToken) return;
        loaded.videoMediaId = null;
        toast(`Can't preview ${m.name} here, but it will still export.`, 5000);
        loaded.clipId = clip.id; drawFrame(); return;
      }
      if (tok !== loadToken) return;
      loaded.videoMediaId = m.id;
    }
    loaded.clipId = clip.id;
    video.playbackRate = clamp(fx.speed, 0.0625, 16);
    video.preservesPitch = fx.pitch !== false;
    video.muted = fx.muted;
    video.volume = clamp(fx.volume / 100, 0, 1);
    const target = clamp(clip.in + (t - start) * fx.speed, 0, Math.max(0, m.duration - 0.01));
    if (!(play && Math.abs(video.currentTime - target) < 0.08 && !video.paused)) await seekVideo(target);
    if (tok !== loadToken) return;
    if (play) { try { await video.play(); } catch (e) { /* ignore */ } } else { video.pause(); }
  } else {
    video.pause();
    loaded.clipId = clip.id;
    const img = imageFor(m);
    if (!img.complete) await new Promise((r) => { img.onload = r; img.onerror = r; });
    if (tok !== loadToken) return;
    imgClock = { t0: performance.now(), base: t - start };
  }
  drawFrame();
}

function tick() {
  if (!state.playing) return;
  if (!busy) {
    const cur = clipAt(state.playhead);
    if (cur) {
      const { clip, start, dur, index } = cur;
      const m = mediaOf(clip);
      let local;
      if (m.type === 'video') {
        local = (video.currentTime - clip.in) / clip.fx.speed;
        const pr = clamp(clip.fx.speed, 0.0625, 16);
        if (video.playbackRate !== pr) video.playbackRate = pr;
        video.preservesPitch = clip.fx.pitch !== false;
        video.muted = clip.fx.muted;
      } else {
        local = (performance.now() - imgClock.t0) / 1000 + imgClock.base;
      }
      local = Math.max(0, local);
      const ended = local >= dur - 0.005 || (m.type === 'video' && video.ended);
      if (ended) {
        if (index >= L.length - 1) { state.playhead = TOTAL; pause(); updatePlayhead(); return; }
        state.playhead = start + dur + 0.0001;
        busy = true;
        prepare(state.playhead, true).then(() => { busy = false; });
      } else {
        state.playhead = start + local;
        const af = 1 - fadeAmount(clip.fx, local, dur);
        video.volume = clamp(clip.fx.volume / 100 * af, 0, 1);
      }
    }
    drawFrame();
    updatePlayhead();
  }
  raf = requestAnimationFrame(tick);
}

async function play() {
  if (!L.length) return;
  if (state.playing) return;
  if (state.playhead >= TOTAL - 0.02) state.playhead = 0;
  state.playing = true;
  setPlayIcon();
  busy = true;
  await prepare(state.playhead, true);
  busy = false;
  if (state.playing) raf = requestAnimationFrame(tick);
}
function pause() {
  state.playing = false;
  cancelAnimationFrame(raf);
  video.pause();
  setPlayIcon();
  resetAcc = true;
  drawFrame();
}
function togglePlay() { state.playing ? pause() : play(); }
function setPlayIcon() { const n = state.playing ? 'pause' : 'play'; $('#bPlay').innerHTML = `<i data-icon="${n}">${icon(n)}</i>`; }

function seek(t) {
  state.playhead = clamp(t, 0, TOTAL);
  updatePlayhead();
  prepare(state.playhead, state.playing);
}

/* ------------------------------------------------------------- timeline */
const tlscroll = $('#tlscroll'), tlcontent = $('#tlcontent'), trackEl = $('#track'), rulerEl = $('#ruler');
const xOf = (t) => PAD + t * state.zoom;

function renderRuler() {
  rulerEl.innerHTML = '';
  const steps = [0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 1800];
  const step = steps.find((s) => s * state.zoom >= 80) || 3600;
  const end = (parseFloat(tlcontent.style.width) - PAD) / state.zoom;
  const minor = step / (step >= 60 ? 6 : step === 15 ? 3 : step === 0.5 ? 1 : (step === 5 || step === 10) ? 5 : step === 30 ? 6 : 2);
  for (let t = 0, n = 0; t <= end; t += minor, n++) {
    const major = Math.abs(t / step - Math.round(t / step)) < 1e-6;
    const d = document.createElement('div');
    d.className = 'tick' + (major ? ' major' : '');
    d.style.left = xOf(t) + 'px';
    if (major) d.innerHTML = `<span>${fmtTime(t)}</span>`;
    rulerEl.appendChild(d);
    if (n > 4000) break;
  }
}

function badgesFor(fx) {
  const b = [];
  if (fx.fadeIn > 0 || fx.fadeOut > 0) b.push('Fade');
  if (fx.blur > 0) b.push('Motion');
  if (fx.blurAmt > 0) b.push('Blur');
  if (fx.speed !== 1) b.push(+fx.speed.toFixed(2) + '×' + (fx.interp === 'blend' ? ' blend' : fx.interp === 'optical' ? ' flow' : ''));
  if (fx.reverse) b.push('Rev');
  if (fx.bw) b.push('B/W');
  if (fx.brightness || fx.contrast || fx.saturation || fx.sharpen || fx.hue) b.push('Color');
  if (fx.vignette || fx.grain || fx.flipH || fx.flipV) b.push('Style');
  return b;
}

function renderTimeline() {
  const viewW = tlscroll.clientWidth;
  const w = Math.max(viewW, PAD + TOTAL * state.zoom + Math.max(240, viewW * 0.35));
  tlcontent.style.width = w + 'px';
  renderRuler();
  trackEl.innerHTML = '';
  L.forEach((r, i) => {
    const c = r.clip, m = mediaOf(c);
    const n = document.createElement('div');
    n.className = 'clip' + (state.sel.includes(c.id) ? ' sel' : '') + (state.sel.length > 1 && state.sel.includes(c.id) ? ' multi' : '') + (c.fx.muted ? ' muted' : '') + (!m || !m.hasAudio ? ' noaudio' : '');
    n.dataset.id = c.id;
    n.style.left = xOf(r.start) + 'px';
    n.style.width = Math.max(14, r.dur * state.zoom) + 'px';
    n.innerHTML =
      `<div class="thumbs" style="${m && m.thumb ? `background-image:url('${m.thumb}');` : ''}background-size:auto 100%"></div>` +
      `<div class="shade"></div><div class="top"></div>` +
      `<div class="label">${escapeHtml(m ? m.name : 'Missing file')}  ${fmtTime(r.dur)}</div>` +
      `<div class="badges">${badgesFor(c.fx).map((b) => `<span>${b}</span>`).join('')}</div>` +
      `<div class="astrip"></div><div class="handle l" data-h="l"></div><div class="handle r" data-h="r"></div>`;
    n.addEventListener('pointerdown', (e) => onClipDown(e, c, n, i));
    n.title = m ? m.name : '';
    trackEl.appendChild(n);
  });
  updatePlayhead();
}
const escapeHtml = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function updatePlayhead() {
  $('#playhead').style.transform = `translateX(${xOf(state.playhead)}px)`;
  $('#tcNow').textContent = timecode(state.playhead);
  $('#tcTotal').textContent = timecode(TOTAL);
  if (state.playing) {
    const x = xOf(state.playhead);
    const left = tlscroll.scrollLeft, w = tlscroll.clientWidth;
    if (x > left + w - 60) tlscroll.scrollLeft = x - 120;
    else if (x < left) tlscroll.scrollLeft = Math.max(0, x - 120);
  }
}

function timeFromClientX(cx) {
  const r = tlcontent.getBoundingClientRect();
  return clamp((cx - r.left - PAD) / state.zoom, 0, TOTAL);
}

function select(id, mode = 'replace') {
  if (id == null) setSel([]);
  else if (mode === 'toggle') {
    setSel(state.sel.includes(id) ? state.sel.filter((x) => x !== id) : [...state.sel, id]);
  } else if (mode === 'range' && state.sel.length) {
    const from = state.clips.findIndex((c) => c.id === state.sel[state.sel.length - 1]);
    const to = state.clips.findIndex((c) => c.id === id);
    const [lo, hi] = [Math.min(from, to), Math.max(from, to)];
    setSel(state.clips.slice(lo, hi + 1).map((c) => c.id).filter((x) => x !== id).concat(id));
  } else if (mode === 'primary') {
    setSel(state.sel.filter((x) => x !== id).concat(id));
  } else setSel([id]);
  refreshSelection();
}
function refreshSelection() {
  const multi = state.sel.length > 1;
  $$('.clip', trackEl).forEach((n) => {
    const on = state.sel.includes(n.dataset.id);
    n.classList.toggle('sel', on);
    n.classList.toggle('multi', on && multi);
  });
  syncInspector();
}

// Scrubbing on the ruler / empty track / playhead
function startScrub(e) {
  e.preventDefault();
  const was = state.playing;
  if (was) pause();
  seek(timeFromClientX(e.clientX));
  const move = (ev) => seek(timeFromClientX(ev.clientX));
  const up = () => { window.removeEventListener('pointermove', move); };
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', up, { once: true });
}
rulerEl.addEventListener('pointerdown', startScrub);
$('#playhead svg').addEventListener('pointerdown', startScrub);
trackEl.addEventListener('pointerdown', (e) => {
  if (e.target !== trackEl) return;
  select(null);
  startScrub(e);
});

function onClipDown(e, clip, node, index) {
  if (e.button !== 0) return;
  if (e.ctrlKey || e.metaKey) { e.preventDefault(); select(clip.id, 'toggle'); return; }   // Ctrl+click adds or removes a clip
  if (e.shiftKey) { e.preventDefault(); select(clip.id, 'range'); return; }                // Shift+click selects a range
  if (e.target.dataset.h) { select(clip.id); startTrim(e, clip, e.target.dataset.h); return; }
  if (state.sel.includes(clip.id)) select(clip.id, 'primary'); else select(clip.id);
  startReorder(e, clip, node, index);
}

function startTrim(e, clip, side) {
  e.preventDefault();
  if (state.playing) pause();
  snapshot();
  const m = mediaOf(clip);
  const sx = e.clientX;
  const orig = { in: clip.in, out: clip.out };
  const move = (ev) => {
    const d = (ev.clientX - sx) / state.zoom * clip.fx.speed;
    if (side === 'l') clip.in = clamp(orig.in + d, 0, orig.out - MIN_LEN);
    else clip.out = clamp(orig.out + d, orig.in + MIN_LEN, m.duration);
    relayout();
    renderTimeline();
    syncInspector(true);
    const r = L.find((x) => x.clip === clip);
    state.playhead = side === 'l' ? r.start : Math.max(r.start, r.start + r.dur - 0.04);
    updatePlayhead();
    prepare(state.playhead, false);
  };
  const up = () => { window.removeEventListener('pointermove', move); updateUndoButtons(); };
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', up, { once: true });
}

function startReorder(e, clip, node, index) {
  const sx = e.clientX;
  const group = state.clips.filter((c) => state.sel.includes(c.id));
  const inGroup = (i) => state.sel.includes(L[i].clip.id);
  let dragging = false, target = 0;
  const centers = L.map((r) => xOf(r.start + r.dur / 2));
  const nodes = $$('.clip', trackEl).filter((n) => state.sel.includes(n.dataset.id));
  const mark = $('#dropMark');
  const move = (ev) => {
    const dx = ev.clientX - sx;
    if (!dragging && Math.abs(dx) < 5) return;
    if (!dragging) { dragging = true; nodes.forEach((n) => n.classList.add('dragging')); if (state.playing) pause(); }
    nodes.forEach((n) => { n.style.transform = `translateX(${dx}px)`; });
    const cx = centers[index] + dx;
    const others = L.map((r, i) => ({ r, i })).filter((o) => !inGroup(o.i));
    target = others.filter((o) => centers[o.i] < cx).length;
    const bx = xOf(others.slice(0, target).reduce((a, o) => a + o.r.dur, 0));
    mark.style.left = (bx - 1) + 'px'; mark.style.display = 'block';
  };
  const up = (ev) => {
    window.removeEventListener('pointermove', move);
    mark.style.display = 'none';
    if (!dragging) { if (state.sel.length > 1) select(clip.id); seek(timeFromClientX(ev.clientX)); return; }
    const others = state.clips.filter((c) => !state.sel.includes(c.id));
    const next = [...others.slice(0, target), ...group, ...others.slice(target)];
    if (next.some((c, i) => c !== state.clips[i])) {
      snapshot();
      state.clips = next;
      changed({ structural: true });
    } else {
      nodes.forEach((n) => { n.style.transform = ''; n.classList.remove('dragging'); });
    }
  };
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', up, { once: true });
}

/* zoom */
function setZoom(z, anchorClientX) {
  z = clamp(z, 8, 400);
  if (z === state.zoom) return;
  const rect = tlscroll.getBoundingClientRect();
  const viewX = anchorClientX != null ? anchorClientX - rect.left : tlscroll.clientWidth / 2;
  const tAnchor = (tlscroll.scrollLeft + viewX - PAD) / state.zoom;
  state.zoom = z;
  $('#zoom').value = z; paintRange($('#zoom'));
  renderTimeline();
  tlscroll.scrollLeft = Math.max(0, PAD + tAnchor * z - viewX);
}
$('#zoom').addEventListener('input', (e) => setZoom(+e.target.value));
$('#tFit').addEventListener('click', () => {
  if (!TOTAL) return;
  const z = (tlscroll.clientWidth - PAD * 2) / TOTAL;
  state.zoom = clamp(z, 8, 400); $('#zoom').value = state.zoom; paintRange($('#zoom'));
  renderTimeline(); tlscroll.scrollLeft = 0;
});
tlscroll.addEventListener('wheel', (e) => {
  if (e.ctrlKey) { e.preventDefault(); setZoom(state.zoom * (e.deltaY < 0 ? 1.15 : 1 / 1.15), e.clientX); }
  else if (!e.shiftKey && Math.abs(e.deltaY) > Math.abs(e.deltaX)) { tlscroll.scrollLeft += e.deltaY; }
}, { passive: false });

/* ----------------------------------------------------------- edit actions */
function changed(opts = {}) {
  relayout();
  renderTimeline();
  syncInspector();
  updateEmpty();
  updateUndoButtons();
  updateTitle();
  state.playhead = clamp(state.playhead, 0, TOTAL);
  if (opts.structural) seek(state.playhead); else drawFrame();
  updatePlayhead();
}

function addClip(mediaId, index) {
  const m = mediaById(mediaId);
  if (!m) return null;
  const clip = {
    id: uid(), mediaId, in: 0, out: m.type === 'image' ? IMAGE_LEN : m.duration,
    fx: { ...DEFAULT_FX }
  };
  const at = index == null ? state.clips.length : index;
  state.clips.splice(at, 0, clip);
  return clip;
}

function splitAtPlayhead() {
  const cur = clipAt(state.playhead);
  if (!cur) return;
  const { clip, start, dur, index } = cur;
  const lt = state.playhead - start;
  if (lt < MIN_LEN || dur - lt < MIN_LEN) { toast('Move the playhead inside a clip to split it.'); return; }
  if (state.playing) pause();
  snapshot();
  const cut = clip.in + lt * clip.fx.speed;
  const right = { id: uid(), mediaId: clip.mediaId, in: cut, out: clip.out, fx: { ...clip.fx, fadeIn: 0 } };
  clip.out = cut;
  clip.fx = { ...clip.fx, fadeOut: 0 };
  state.clips.splice(index + 1, 0, right);
  setSel([right.id]);
  changed({ structural: true });
}
function deleteSelected() {
  const cs = selectedClips();
  if (!cs.length) { toast('Select a clip first.'); return; }
  if (state.playing) pause();
  snapshot();
  state.clips = state.clips.filter((x) => !cs.includes(x));
  state.sel = [];
  changed({ structural: true });
}
function duplicateSelected() {
  const cs = selectedClips();
  if (!cs.length) { toast('Select a clip first.'); return; }
  if (state.playing) pause();
  snapshot();
  const copies = [];
  [...cs].reverse().forEach((c) => {
    const copy = { ...c, id: uid(), fx: { ...c.fx } };
    state.clips.splice(state.clips.indexOf(c) + 1, 0, copy);
    copies.unshift(copy.id);
  });
  setSel(copies);
  changed({ structural: true });
}
function selectAll() { setSel(state.clips.map((c) => c.id)); refreshSelection(); }
$('#tSplit').onclick = splitAtPlayhead;
$('#tDel').onclick = deleteSelected;
$('#tDup').onclick = duplicateSelected;
$('#tUndo').onclick = undo;
$('#tRedo').onclick = redo;

/* ------------------------------------------------------------- media bin */
function renderBin() {
  const list = $('#binList');
  list.innerHTML = '';
  state.media.forEach((m) => {
    const d = document.createElement('div');
    d.className = 'media';
    d.draggable = true;
    d.title = 'Double-click to add to the timeline';
    d.innerHTML =
      `<div class="th" style="${m.thumb ? `background-image:url('${m.thumb}')` : ''}"></div>` +
      `<div><div class="nm">${escapeHtml(m.name)}</div>` +
      `<div class="mt">${m.type === 'image' ? 'Image' : fmtTime(m.duration)}  ${m.width}×${m.height}</div></div>` +
      `<div class="tools"><button data-a="add" title="Add to timeline"><i data-icon="plus"></i></button>` +
      `<button data-a="rm" title="Remove from project"><i data-icon="x"></i></button></div>`;
    $$('i[data-icon]', d).forEach((e) => { e.innerHTML = icon(e.dataset.icon); });
    d.addEventListener('dragstart', (e) => { e.dataTransfer.setData('text/ace-media', m.id); e.dataTransfer.effectAllowed = 'copy'; });
    d.addEventListener('dblclick', () => addToEnd(m.id));
    $('[data-a=add]', d).onclick = (e) => { e.stopPropagation(); addToEnd(m.id); };
    $('[data-a=rm]', d).onclick = (e) => { e.stopPropagation(); removeMedia(m.id); };
    list.appendChild(d);
  });
  $('#binEmpty').hidden = state.media.length > 0;
  $('#binCount').textContent = state.media.length ? String(state.media.length) : '';
}
function addToEnd(mediaId) {
  if (state.playing) pause();
  snapshot();
  const c = addClip(mediaId);
  setSel([c.id]);
  changed({ structural: true });
}
function removeMedia(id) {
  const used = state.clips.some((c) => c.mediaId === id);
  if (used && !confirm('This clip is used on the timeline. Remove it and its timeline clips?')) return;
  if (state.playing) pause();
  snapshot();
  state.clips = state.clips.filter((c) => c.mediaId !== id);
  state.media = state.media.filter((m) => m.id !== id);
  state.sel = state.sel.filter((id) => state.clips.some((c) => c.id === id));
  if (loaded.videoMediaId === id) loaded.videoMediaId = null;
  renderBin();
  changed({ structural: true });
}

async function importPaths(paths, insertIndex) {
  if (!paths || !paths.length) return;
  toast('Reading clips…', 60000);
  const { media, errors } = await window.ace.probe(paths);
  $('#toast').hidden = true;
  if (errors.length) toast(`Could not open ${errors.map((x) => x.name).join(', ')}: ${errors[0].error}`, 6000);
  if (!media.length) return;
  if (state.playing) pause();
  snapshot();
  const wasEmpty = state.clips.length === 0;
  let at = insertIndex == null ? state.clips.length : insertIndex;
  let last = null;
  media.forEach((m) => {
    m.id = uid();
    state.media.push(m);
    last = addClip(m.id, at++);
  });
  if (wasEmpty && media[0].height > media[0].width) { state.settings.aspect = '9:16'; sizeCanvases(); buildAspectSeg(); }
  setSel(last ? [last.id] : []);
  renderBin();
  changed({ structural: true });
  if (wasEmpty) { state.playhead = 0; seek(0); setTimeout(fitIfNeeded, 0); }
}
function fitIfNeeded() {
  const need = PAD * 2 + TOTAL * state.zoom;
  if (need > tlscroll.clientWidth) $('#tFit').click();
}
async function importDialog() {
  const paths = await window.ace.importDialog();
  importPaths(paths);
}
$('#btnImport').onclick = importDialog;
$('#btnImport2').onclick = importDialog;

/* drag and drop: files from Explorer, or clips from the media list */
let dragDepth = 0;
window.addEventListener('dragenter', (e) => { if (e.dataTransfer && [...e.dataTransfer.types].includes('Files')) { dragDepth++; $('#dropVeil').hidden = false; } });
window.addEventListener('dragleave', () => { dragDepth = Math.max(0, dragDepth - 1); if (!dragDepth) $('#dropVeil').hidden = true; });
window.addEventListener('dragover', (e) => e.preventDefault());
function insertIndexFromX(cx) {
  const t = timeFromClientX(cx);
  let idx = 0;
  L.forEach((r, i) => { if (t > r.start + r.dur / 2) idx = i + 1; });
  return idx;
}
window.addEventListener('drop', (e) => {
  e.preventDefault();
  dragDepth = 0; $('#dropVeil').hidden = true;
  const overTimeline = e.target.closest && e.target.closest('#timeline');
  const idx = overTimeline ? insertIndexFromX(e.clientX) : null;
  const mid = e.dataTransfer.getData('text/ace-media');
  if (mid) {
    if (state.playing) pause();
    snapshot();
    const c = addClip(mid, idx == null ? undefined : idx);
    setSel([c.id]);
    changed({ structural: true });
    return;
  }
  const files = [...e.dataTransfer.files];
  if (files.length) importPaths(files.map((f) => window.ace.pathFor(f)).filter(Boolean), idx);
});

/* ------------------------------------------------------------- inspector */
// Every control here changes ALL selected clips (Ctrl+click on the timeline to select several).
const SL = {
  fadeIn:     { k: 'fadeIn', label: 'Fade in', min: 0, max: 5, step: 0.1, unit: 's' },
  fadeOut:    { k: 'fadeOut', label: 'Fade out', min: 0, max: 5, step: 0.1, unit: 's' },
  blur:       { k: 'blur', label: 'Amount', min: 0, max: 100, step: 1, unit: '%' },
  blurAmt:    { k: 'blurAmt', label: 'Amount', min: 0, max: 100, step: 1, unit: '%' },
  speed:      { k: 'speed', label: 'Speed', min: 0.1, max: 4, step: 0.05, unit: '×', structural: true },
  volume:     { k: 'volume', label: 'Volume', min: 0, max: 200, step: 1, unit: '%' },
  brightness: { k: 'brightness', label: 'Brightness', min: -100, max: 100, step: 1, unit: '', signed: true },
  contrast:   { k: 'contrast', label: 'Contrast', min: -100, max: 100, step: 1, unit: '', signed: true },
  saturation: { k: 'saturation', label: 'Saturation', min: -100, max: 100, step: 1, unit: '', signed: true },
  hue:        { k: 'hue', label: 'Hue shift', min: -180, max: 180, step: 1, unit: '°', signed: true },
  sharpen:    { k: 'sharpen', label: 'Sharpen', min: 0, max: 100, step: 1, unit: '%' },
  vignette:   { k: 'vignette', label: 'Vignette', min: 0, max: 100, step: 1, unit: '%' },
  grain:      { k: 'grain', label: 'Film grain', min: 0, max: 100, step: 1, unit: '%' }
};
const GROUPS = [
  { title: 'Fades', rows: [{ t: 'slider', s: SL.fadeIn }, { t: 'slider', s: SL.fadeOut }] },
  { title: 'Motion blur', rows: [{ t: 'slider', s: SL.blur }] },
  { title: 'Blur effects', rows: [
    { t: 'pills', k: 'blurType', options: [['gaussian', 'Gaussian'], ['box', 'Box'], ['horizontal', 'Horizontal'], ['vertical', 'Vertical'], ['zoom', 'Zoom']] },
    { t: 'slider', s: SL.blurAmt } ] },
  { title: 'Speed and retime', rows: [
    { t: 'slider', s: SL.speed },
    { t: 'presets' },
    { t: 'duration' },
    { t: 'sub', text: 'Frame mode' },
    { t: 'pills', k: 'interp', options: [['nearest', 'Sampling'], ['blend', 'Frame blend'], ['optical', 'Optical flow']] },
    { t: 'toggle', k: 'pitch', label: 'Pitch', off: 'Change', on: 'Keep' },
    { t: 'toggle', k: 'reverse', label: 'Reverse', off: 'Off', on: 'On' },
    { t: 'sub', text: 'Speed ramp (splits the clip into steps)' },
    { t: 'ramps' },
    { t: 'note', text: 'Frame mode, reverse and optical flow show in the export. The preview plays forward at the chosen speed.' } ] },
  { title: 'Sound', rows: [{ t: 'slider', s: SL.volume }, { t: 'toggle', k: 'muted', label: 'Sound', off: 'On', on: 'Muted' }] },
  { title: 'Colour', rows: [
    { t: 'slider', s: SL.brightness }, { t: 'slider', s: SL.contrast }, { t: 'slider', s: SL.saturation },
    { t: 'slider', s: SL.hue }, { t: 'slider', s: SL.sharpen },
    { t: 'toggle', k: 'bw', label: 'Black and white', off: 'Off', on: 'On' } ] },
  { title: 'Style', rows: [
    { t: 'slider', s: SL.vignette }, { t: 'slider', s: SL.grain },
    { t: 'toggle', k: 'flipH', label: 'Flip horizontal', off: 'Off', on: 'On' },
    { t: 'toggle', k: 'flipV', label: 'Flip vertical', off: 'Off', on: 'On' } ] },
  { title: 'Framing', rows: [{ t: 'pills', k: 'fit', options: [['contain', 'Fit'], ['cover', 'Fill']] }] }
];

function paintRange(input) {
  const p = (input.value - input.min) / (input.max - input.min) * 100;
  const signed = +input.min < 0;
  input.style.setProperty('--lo', (signed ? Math.min(50, p) : 0) + '%');
  input.style.setProperty('--hi', (signed ? Math.max(50, p) : p) + '%');
}
function fmtVal(spec, v) {
  if (spec.k === 'speed') return (+v).toFixed(2).replace(/\.?0+$/, '') + '×';
  if (spec.unit === 's') return (+v).toFixed(1) + 's';
  const n = Math.round(v);
  return (spec.signed && n > 0 ? '+' : '') + n + spec.unit;
}

// Applies a change to every selected clip, with one undo step.
function applyFx(mutate, structural) {
  const cs = selectedClips();
  if (!cs.length) return;
  if (structural && state.playing) pause();
  snapshot();
  cs.forEach(mutate);
  changed({ structural: !!structural });
}

const lerpLog = (a, b, t) => a * Math.pow(b / a, t);
const RAMPS = {
  up:   { label: 'Slow to fast',     f: (t) => lerpLog(0.25, 2.5, t) },
  down: { label: 'Fast to slow',     f: (t) => lerpLog(2.5, 0.25, t) },
  mid:  { label: 'Slow in the middle', f: (t) => Math.pow(0.3, Math.sin(Math.PI * t)) }
};
function rampSelected(kind) {
  const cs = selectedClips();
  if (!cs.length) { toast('Select a clip first.'); return; }
  if (state.playing) pause();
  snapshot();
  const N = 10, ids = [];
  cs.forEach((c) => {
    const at = state.clips.indexOf(c);
    const len = c.out - c.in;
    const parts = Array.from({ length: N }, (_, i) => ({
      id: uid(), mediaId: c.mediaId,
      in: c.in + len * i / N, out: c.in + len * (i + 1) / N,
      fx: { ...c.fx, speed: clamp(RAMPS[kind].f((i + 0.5) / N), 0.1, 10),
            fadeIn: i === 0 ? c.fx.fadeIn : 0, fadeOut: i === N - 1 ? c.fx.fadeOut : 0 }
    }));
    state.clips.splice(at, 1, ...parts);
    parts.forEach((p) => ids.push(p.id));
  });
  setSel(ids);
  changed({ structural: true });
  toast('Speed ramp added. Turn on Frame blend to smooth it.');
}

let editing = false;
const collapsed = new Set();
function buildInspector() {
  const body = $('#inspBody');
  body.innerHTML = '';
  GROUPS.forEach((g) => {
    const box = document.createElement('div');
    box.className = 'group-fx' + (collapsed.has(g.title) ? ' collapsed' : '');
    box.innerHTML = `<h3>${g.title}</h3>`;
    $('h3', box).addEventListener('click', () => {
      box.classList.toggle('collapsed');
      box.classList.contains('collapsed') ? collapsed.add(g.title) : collapsed.delete(g.title);
    });
    g.rows.forEach((r) => box.appendChild(buildRow(r)));
    body.appendChild(box);
  });

  const acts = document.createElement('div');
  acts.className = 'fx-actions';
  acts.innerHTML =
    `<button class="btn" data-a="enhance">Enhance picture</button>` +
    `<button class="btn" data-a="all">Copy fades and blur to all clips</button>` +
    `<button class="btn quiet" data-a="reset">Reset effects</button>`;
  $('[data-a=enhance]', acts).onclick = () => {
    applyFx((c) => Object.assign(c.fx, { contrast: 12, saturation: 18, brightness: 2, sharpen: 30 }));
    toast('Added a little contrast, colour and sharpness.');
  };
  $('[data-a=all]', acts).onclick = () => {
    const c = selectedClip(); if (!c) return;
    snapshot();
    state.clips.forEach((o) => Object.assign(o.fx, { fadeIn: c.fx.fadeIn, fadeOut: c.fx.fadeOut, blur: c.fx.blur, blurType: c.fx.blurType, blurAmt: c.fx.blurAmt }));
    changed({ structural: true });
    toast('Fades and blur copied to every clip.');
  };
  $('[data-a=reset]', acts).onclick = () => applyFx((c) => { c.fx = { ...DEFAULT_FX }; }, true);
  body.appendChild(acts);
}

function buildRow(r) {
  const row = document.createElement('div');
  if (r.t === 'slider') {
    const s = r.s;
    row.className = 'fx-row';
    row.innerHTML = `<label title="Double-click to reset">${s.label}</label><span class="val"></span>` +
      `<input type="range" data-k="${s.k}" min="${s.min}" max="${s.max}" step="${s.step}">`;
    const input = $('input', row);
    const begin = () => { if (!editing) { editing = true; snapshot(); } };
    input.addEventListener('pointerdown', begin);
    input.addEventListener('keydown', begin);
    input.addEventListener('change', () => { editing = false; });
    input.addEventListener('input', () => {
      const v = +input.value;
      selectedClips().forEach((c) => { c.fx[s.k] = v; });
      paintRange(input);
      changed({ structural: !!s.structural });
    });
    $('label', row).addEventListener('dblclick', () => applyFx((c) => { c.fx[s.k] = DEFAULT_FX[s.k]; }, s.structural));
  } else if (r.t === 'pills') {
    row.className = 'fx-pills'; row.dataset.k = r.k;
    row.innerHTML = r.options.map(([v, t]) => `<button data-v="${v}">${t}</button>`).join('');
    $$('button', row).forEach((b) => b.addEventListener('click', () => applyFx((c) => { c.fx[r.k] = b.dataset.v; }, r.k === 'interp')));
  } else if (r.t === 'toggle') {
    row.className = 'toggle';
    row.innerHTML = `<span>${r.label}</span><div class="seg" data-t="${r.k}"><button data-v="0">${r.off}</button><button data-v="1">${r.on}</button></div>`;
    $$('button', row).forEach((b) => b.addEventListener('click', () => applyFx((c) => { c.fx[r.k] = b.dataset.v === '1'; }, r.k === 'reverse')));
  } else if (r.t === 'presets') {
    row.className = 'fx-pills'; row.dataset.presets = '1';
    row.innerHTML = [0.25, 0.5, 1, 2, 4].map((v) => `<button data-v="${v}">${v}×</button>`).join('');
    $$('button', row).forEach((b) => b.addEventListener('click', () => applyFx((c) => { c.fx.speed = +b.dataset.v; }, true)));
  } else if (r.t === 'duration') {
    row.className = 'fx-num';
    row.innerHTML = `<label>Length (s)</label><input type="number" min="0.05" step="0.01" data-dur>`;
    $('input', row).addEventListener('change', (e) => {
      const d = parseFloat(e.target.value);
      if (!(d > 0)) { syncInspector(); return; }
      applyFx((c) => { c.fx.speed = clamp((c.out - c.in) / d, 0.1, 10); }, true);
    });
  } else if (r.t === 'ramps') {
    row.className = 'fx-pills';
    row.innerHTML = Object.keys(RAMPS).map((k) => `<button data-r="${k}">${RAMPS[k].label}</button>`).join('');
    $$('button', row).forEach((b) => b.addEventListener('click', () => rampSelected(b.dataset.r)));
  } else if (r.t === 'sub') {
    row.className = 'fx-sub'; row.textContent = r.text;
  } else if (r.t === 'note') {
    row.className = 'fx-note'; row.textContent = r.text;
  }
  return row;
}

function syncInspector(light) {
  const cs = selectedClips();
  const c = selectedClip();
  $('#inspBody').hidden = !c;
  $('#inspEmpty').hidden = !!c;
  const m = c && mediaOf(c);
  $('#inspTitle').textContent = cs.length > 1 ? `${cs.length} clips selected` : (c && m ? m.name : 'Effects');
  $('#inspMeta').textContent = c ? fmtTime(cs.reduce((a, x) => a + clipDur(x), 0)) : '';
  $('#inspTitle').style.cssText = 'overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:210px';
  if (!c || light) return;
  const same = (k) => cs.every((o) => o.fx[k] === c.fx[k]);
  $$('input[type=range][data-k]').forEach((input) => {
    const s = SL[input.dataset.k];
    if (+input.value !== c.fx[s.k]) input.value = c.fx[s.k];
    const row = input.parentElement;
    $('.val', row).textContent = same(s.k) ? fmtVal(s, c.fx[s.k]) : 'Mixed';
    row.classList.toggle('mixed', !same(s.k));
    paintRange(input);
  });
  $$('.toggle .seg').forEach((seg) => $$('button', seg).forEach((b) => b.classList.toggle('on', same(seg.dataset.t) && (b.dataset.v === '1') === !!c.fx[seg.dataset.t])));
  $$('.fx-pills[data-k]').forEach((row) => $$('button', row).forEach((b) => b.classList.toggle('on', same(row.dataset.k) && b.dataset.v === c.fx[row.dataset.k])));
  $$('.fx-pills[data-presets] button').forEach((b) => b.classList.toggle('on', same('speed') && +b.dataset.v === c.fx.speed));
  const dur = $('input[data-dur]');
  if (document.activeElement !== dur) dur.value = cs.every((o) => Math.abs(clipDur(o) - clipDur(c)) < 0.005) ? clipDur(c).toFixed(2) : '';
}

/* ------------------------------------------------- segmented controls etc */
function makeSeg(el, options, get, set) {
  el.innerHTML = options.map(([v, t]) => `<button data-v="${v}">${t}</button>`).join('');
  const paint = () => $$('button', el).forEach((b) => b.classList.toggle('on', String(get()) === b.dataset.v));
  $$('button', el).forEach((b) => b.addEventListener('click', () => { set(b.dataset.v); paint(); }));
  paint();
}
function buildAspectSeg() {
  makeSeg($('#aspectSeg'), [['16:9', '16:9'], ['9:16', '9:16'], ['1:1', '1:1']],
    () => state.settings.aspect,
    (v) => { state.settings.aspect = v; sizeCanvases(); drawFrame(); updateExportSummary(); });
}

function updateEmpty() { $('#empty').hidden = state.clips.length > 0; }
function updateTitle() {
  const name = state.projectPath ? state.projectPath.split(/[\\/]/).pop().replace(/\.ace$/i, '') : 'Untitled project';
  $('#projName').textContent = name;
}

/* ---------------------------------------------------------- project files */
function projectJSON() {
  return JSON.stringify({
    app: 'aces-editing-software', version: 1,
    settings: state.settings,
    media: state.media.map((m) => ({ id: m.id, path: m.path })),
    clips: state.clips
  });
}
async function saveProject(saveAs) {
  const p = await window.ace.saveProject({ data: projectJSON(), filePath: state.projectPath, saveAs });
  if (p) { state.projectPath = p; updateTitle(); toast('Project saved.'); }
}
async function openProject() {
  const r = await window.ace.openProject();
  if (!r) return;
  let o;
  try { o = JSON.parse(r.data); if (o.app !== 'aces-editing-software') throw new Error(); }
  catch (e) { toast('That file is not an Ace project.'); return; }
  pause();
  toast('Opening project…', 60000);
  const { media, errors } = await window.ace.probe(o.media.map((m) => m.path));
  $('#toast').hidden = true;
  const byPath = new Map(media.map((m) => [m.path, m]));
  state.media = [];
  o.media.forEach((pm) => { const m = byPath.get(pm.path); if (m) { m.id = pm.id; state.media.push(m); } });
  state.clips = (o.clips || []).filter((c) => state.media.some((m) => m.id === c.mediaId))
    .map((c) => ({ ...c, fx: { ...DEFAULT_FX, ...c.fx } }));
  state.settings = { ...state.settings, ...o.settings };
  state.sel = []; state.playhead = 0; state.projectPath = r.path;
  history = []; future = [];
  loaded = { clipId: null, videoMediaId: null };
  sizeCanvases(); buildAspectSeg();
  renderBin();
  changed({ structural: true });
  setTimeout(fitIfNeeded, 0);
  if (errors.length) toast(`Missing files were left out: ${errors.map((x) => x.name).join(', ')}`, 7000);
}
$('#btnOpen').onclick = openProject;
$('#btnSave').onclick = () => saveProject(false);

/* ------------------------------------------------------------------ export */
const modal = $('#modal');
let exportedPath = null;
// kind: video | audio | gif. "fixedQuality" formats ignore the quality setting.
const EXPORT_FORMATS = [
  { id: 'mp4',    label: 'MP4',        kind: 'video', ext: 'mp4',  long: 'MP4 video',        desc: 'H.264 video and AAC sound. Plays almost everywhere.' },
  { id: 'mov',    label: 'MOV',        kind: 'video', ext: 'mov',  long: 'MOV video',        desc: 'H.264 in a MOV file, good for Apple apps and editors.' },
  { id: 'prores', label: 'ProRes',     kind: 'video', ext: 'mov',  long: 'MOV ProRes video', desc: 'Large, near-lossless MOV for further editing. Ignores quality.', fixedQuality: true },
  { id: 'webm',   label: 'WebM',       kind: 'video', ext: 'webm', long: 'WebM video',       desc: 'VP9 video and Opus sound, made for the web.' },
  { id: 'mkv',    label: 'MKV',        kind: 'video', ext: 'mkv',  long: 'MKV video',        desc: 'H.264 and AAC in a Matroska file.' },
  { id: 'avi',    label: 'AVI',        kind: 'video', ext: 'avi',  long: 'AVI video',        desc: 'Older format for older software.' },
  { id: 'gif',    label: 'GIF',        kind: 'gif',   ext: 'gif',  long: 'Animated GIF',     desc: 'Silent looping picture, 15 frames a second, up to 480p.', fixedQuality: true },
  { id: 'mp3',    label: 'MP3',        kind: 'audio', ext: 'mp3',  long: 'MP3 audio',        desc: 'The sound only, as an MP3.' },
  { id: 'wav',    label: 'WAV',        kind: 'audio', ext: 'wav',  long: 'WAV audio',        desc: 'Uncompressed sound, large files, perfect quality.', fixedQuality: true },
  { id: 'flac',   label: 'FLAC',       kind: 'audio', ext: 'flac', long: 'FLAC audio',       desc: 'Lossless compressed sound.', fixedQuality: true },
  { id: 'm4a',    label: 'M4A',        kind: 'audio', ext: 'm4a',  long: 'M4A (AAC) audio',  desc: 'AAC sound, great for phones and Apple devices.' },
  { id: 'ogg',    label: 'OGG',        kind: 'audio', ext: 'ogg',  long: 'OGG audio',        desc: 'Vorbis sound, open format.' }
];
const fmtOf = () => EXPORT_FORMATS.find((f) => f.id === state.settings.format) || EXPORT_FORMATS[0];

function updateExportSummary() {
  const f = fmtOf();
  const s = outSize();
  const len = fmtTime(TOTAL);
  $('#fmtDesc').textContent = f.desc;
  $('#fResolution').hidden = f.kind !== 'video';
  $('#fFps').hidden = f.kind !== 'video';
  $('#fQuality').hidden = !!f.fixedQuality;
  $('#qualLabel').textContent = f.kind === 'audio' ? 'Sound quality' : 'Quality';
  const labels = f.kind === 'audio'
    ? [['draft', 'Small, 128k'], ['standard', 'Good, 192k'], ['high', 'Best, 320k']]
    : [['draft', 'Draft, fastest'], ['standard', 'Standard'], ['high', 'High, slower']];
  $$('#qualSeg button').forEach((b, i) => { b.textContent = labels[i][1]; });
  $('#expSummary').textContent = f.kind === 'video'
    ? `${s.w}×${s.h} at ${state.settings.fps} frames per second, ${len} long, saved as ${f.long}.`
    : f.kind === 'gif' ? `${len} long, saved as an animated GIF.`
    : `${len} long, saved as ${f.long}. Only the sound is exported.`;
}
function buildExportSegs() {
  const fmtSeg = (el, kind) => makeSeg(el, EXPORT_FORMATS.filter((f) => f.kind === kind || (kind === 'video' && f.kind === 'gif')).map((f) => [f.id, f.label]),
    () => state.settings.format,
    (v) => { state.settings.format = v; paintFormats(); updateExportSummary(); });
  const paintFormats = () => {
    $$('#fmtVideo button, #fmtAudio button').forEach((b) => b.classList.toggle('on', b.dataset.v === state.settings.format));
  };
  fmtSeg($('#fmtVideo'), 'video');
  fmtSeg($('#fmtAudio'), 'audio');
  paintFormats();
  makeSeg($('#resSeg'), [[720, '720p'], [1080, '1080p'], [1440, '1440p']], () => state.settings.height,
    (v) => { state.settings.height = +v; updateExportSummary(); });
  makeSeg($('#fpsSeg'), [[24, '24'], [30, '30'], [60, '60']], () => state.settings.fps,
    (v) => { state.settings.fps = +v; updateExportSummary(); updatePlayhead(); });
  makeSeg($('#qualSeg'), [['draft', ''], ['standard', ''], ['high', '']], () => state.settings.quality,
    (v) => { state.settings.quality = v; });
}
function openExport() {
  if (!state.clips.length) { toast('Add a clip to the timeline first.'); return; }
  if (state.playing) pause();
  $('#expSettings').hidden = false; $('#expProgress').hidden = true; $('#expDone').hidden = true;
  buildExportSegs(); updateExportSummary();
  modal.hidden = false;
}
function closeExport() { modal.hidden = true; }
$('#btnExport').onclick = openExport;
$('#expCancel').onclick = closeExport;
$('#expClose').onclick = closeExport;
$('#expShow').onclick = () => window.ace.showItem(exportedPath);
$('#expStop').onclick = () => window.ace.cancelExport();
window.ace.onProgress((p) => {
  $('#expBar').style.width = (p * 100).toFixed(1) + '%';
  $('#expStatus').textContent = `Exporting, ${Math.round(p * 100)}%`;
});

$('#expGo').onclick = async () => {
  const base = state.projectPath ? state.projectPath.split(/[\\/]/).pop().replace(/\.ace$/i, '') : 'Ace Export';
  const f = fmtOf();
  const out = await window.ace.chooseOutput(base + '.' + f.ext, f.ext, f.long);
  if (!out) return;
  const s = outSize();
  const clips = L.map((r) => {
    const m = mediaOf(r.clip);
    return { path: m.path, type: m.type, hasAudio: m.hasAudio, in: r.clip.in, out: r.clip.out, fx: r.clip.fx };
  });
  $('#expSettings').hidden = true; $('#expProgress').hidden = false;
  $('#expBar').style.width = '0%'; $('#expStatus').textContent = 'Starting export';
  const res = await window.ace.startExport({
    outPath: out, clips,
    settings: { w: s.w, h: s.h, fps: state.settings.fps, quality: state.settings.quality, format: f.id }
  });
  $('#expProgress').hidden = true;
  if (res.ok) {
    exportedPath = res.outPath;
    $('#expDoneText').textContent = `Export finished. Your ${f.kind === 'audio' ? 'audio' : f.kind === 'gif' ? 'GIF' : 'video'} is saved.`;
    $('#expDone').hidden = false; $('#expShow').hidden = false;
  } else if (res.cancelled) {
    closeExport(); toast('Export cancelled.');
  } else {
    $('#expDoneText').textContent = 'Export failed: ' + (res.error || 'unknown error');
    $('#expDone').hidden = false; $('#expShow').hidden = true;
  }
};

/* ---------------------------------------------------------------- keyboard */
const frame = () => 1 / state.settings.fps;
window.addEventListener('keydown', (e) => {
  if (!modal.hidden) { if (e.key === 'Escape') closeExport(); return; }
  const tag = (e.target.tagName || '').toLowerCase();
  const inRange = tag === 'input' && e.target.type === 'range';
  if (tag === 'input' && !inRange) return;
  const mod = e.ctrlKey || e.metaKey;
  const k = e.key.toLowerCase();
  if (mod && k === 'z') { e.preventDefault(); e.shiftKey ? redo() : undo(); }
  else if (mod && k === 'y') { e.preventDefault(); redo(); }
  else if (mod && k === 'a') { e.preventDefault(); selectAll(); }
  else if (mod && k === 'd') { e.preventDefault(); duplicateSelected(); }
  else if (mod && k === 's') { e.preventDefault(); saveProject(e.shiftKey); }
  else if (mod && k === 'o') { e.preventDefault(); openProject(); }
  else if (mod && k === 'i') { e.preventDefault(); importDialog(); }
  else if (mod && k === 'e') { e.preventDefault(); openExport(); }
  else if (inRange) return;
  else if (k === ' ') { e.preventDefault(); togglePlay(); }
  else if (k === 's' && !mod) { splitAtPlayhead(); }
  else if (k === 'delete' || k === 'backspace') { e.preventDefault(); deleteSelected(); }
  else if (k === 'arrowleft') { e.preventDefault(); if (state.playing) pause(); seek(state.playhead - (e.shiftKey ? 1 : frame())); }
  else if (k === 'arrowright') { e.preventDefault(); if (state.playing) pause(); seek(state.playhead + (e.shiftKey ? 1 : frame())); }
  else if (k === 'home') { seek(0); }
  else if (k === 'end') { seek(TOTAL); }
  else if (k === '=' || k === '+') { setZoom(state.zoom * 1.25); }
  else if (k === '-') { setZoom(state.zoom / 1.25); }
});

$('#bPlay').onclick = togglePlay;
$('#bStart').onclick = () => { if (state.playing) pause(); seek(0); };
$('#bEnd').onclick = () => { if (state.playing) pause(); seek(TOTAL); };
$('#bBack').onclick = () => { if (state.playing) pause(); seek(state.playhead - frame()); };
$('#bFwd').onclick = () => { if (state.playing) pause(); seek(state.playhead + frame()); };

window.addEventListener('resize', () => { fitStage(); renderTimeline(); });

/* -------------------------------------------------------------------- init */
buildInspector();
buildAspectSeg();
renderBin();
$$('input[type=range]').forEach(paintRange);
sizeCanvases();
setPlayIcon();
changed({});
// Exposed so the UI can be driven by tests.
window.__ace = { state, changed, addClip, importPaths };
