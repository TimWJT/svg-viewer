import './startup.js';
import DOMPurify from 'dompurify';
import hljs from 'highlight.js/lib/core';
import xmlLang from 'highlight.js/lib/languages/xml';
import cssLang from 'highlight.js/lib/languages/css';

hljs.registerLanguage('xml', xmlLang);
hljs.registerLanguage('css', cssLang);

/* Tauri APIs. Safe to import in a plain browser — nothing touches the native
   bridge until called, and every call site is behind the IS_TAURI check. */
import { invoke, convertFileSrc } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { WebviewWindow, getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow';
import { open as openDialog } from '@tauri-apps/plugin-dialog';
import { check as checkUpdate } from '@tauri-apps/plugin-updater';
import { relaunch } from '@tauri-apps/plugin-process';
import { getVersion } from '@tauri-apps/api/app';
import { openUrl } from '@tauri-apps/plugin-opener';

const root = document.documentElement;
const $ = (s) => document.querySelector(s);

const els = {
  bar: $('#bar'),
  chrome: $('#chrome'),
  title: $('#title'),
  live: $('#live'),
  doc: $('#doc'),
  canvas: $('#canvas'),
  scroller: $('#scroller'),
  outline: $('#outline'),
  outlineList: $('#outline-list'),
  empty: $('#empty'),
  drop: $('#drop'),
  toast: $('#toast'),
  zoomval: $('#zoomval'),
  fileInput: $('#file-input'),
};

/* ======================================================================
   Tabs
   ----------------------------------------------------------------------
   Each open SVG is a tab holding its own source text, watch state and
   scroll position. `state` always points at the active one, so the rest of
   the app keeps reading state.path / state.name as before.
   ====================================================================== */

let tabs = [];
let tabSeq = 0;

function makeTab(init) {
  return Object.assign({
    id: ++tabSeq,
    name: '',
    path: null,      // native path, when opened through the shell
    handle: null,    // FileSystemFileHandle, when opened in a browser
    text: '',
    lastModified: 0,
    docDir: null,
    scrollTop: 0,
    scrollLeft: 0,
    heads: [],
    pending: null,
  }, init);
}

/* A placeholder until something is opened, so `state.x` is always safe. */
let state = makeTab({});
let renderRevision = 0;

/* Deferred DOM work must still belong to this exact rendered document. */
function captureRenderGuard() {
  const tab = state;
  const revision = renderRevision;
  return () => state === tab && tabs.includes(tab) && revision === renderRevision;
}

/* True only inside the Tauri shell. In a plain browser every file path below
   falls back to the web APIs. */
const IS_TAURI = typeof window !== 'undefined' && !!window.__TAURI_INTERNALS__;

/* ---------- tiny persistence ---------- */
const store = {
  get(k, d) {
    try { const v = localStorage.getItem('svgv.' + k); return v === null ? d : JSON.parse(v); }
    catch { return d; }
  },
  set(k, v) { try { localStorage.setItem('svgv.' + k, JSON.stringify(v)); } catch {} },
};

function idb() {
  return new Promise((res, rej) => {
    const r = indexedDB.open('svgv', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('kv');
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}
async function idbSet(k, v) {
  const db = await idb();
  return new Promise((res, rej) => {
    const t = db.transaction('kv', 'readwrite');
    t.objectStore('kv').put(v, k);
    t.oncomplete = () => res();
    t.onerror = () => rej(t.error);
  });
}
async function idbGet(k) {
  const db = await idb();
  return new Promise((res, rej) => {
    const t = db.transaction('kv', 'readonly');
    const q = t.objectStore('kv').get(k);
    q.onsuccess = () => res(q.result);
    q.onerror = () => rej(q.error);
  });
}

/* ---------- settings ---------- */
const WHEEL_BASE = 0.0033;
const DEFAULTS = { zoomSpeed: 1, textSize: 14, invertZoom: false, openIn: 'tab', closeScope: 'tab', restoreTabs: false, updateOnStart: true };
let cfg = Object.assign({}, DEFAULTS, store.get('cfg', {}) || {});

function notchPercent() {
  return Math.round((Math.exp(100 * WHEEL_BASE * cfg.zoomSpeed) - 1) * 100);
}

function saveCfgFields(changed) {
  const next = Object.assign({}, store.get('cfg', {}) || {});
  for (const k of changed) next[k] = cfg[k];
  store.set('cfg', next);
}

function applyCfg({ remeasure = true, save = true, changed = null } = {}) {
  cfg.zoomSpeed = Math.min(4, Math.max(0.25, Number(cfg.zoomSpeed) || 1));
  cfg.textSize = Math.min(22, Math.max(11, Number(cfg.textSize) || 14));
  cfg.invertZoom = !!cfg.invertZoom;
  cfg.openIn = cfg.openIn === 'window' ? 'window' : 'tab';
  cfg.closeScope = cfg.closeScope === 'window' ? 'window' : 'tab';
  cfg.restoreTabs = !!cfg.restoreTabs;
  cfg.updateOnStart = cfg.updateOnStart !== false;

  const place = remeasure ? captureAnchor() : null;
  root.style.setProperty('--base-size', cfg.textSize + 'px');

  $('#cfg-zoomspeed').value = String(cfg.zoomSpeed);
  $('#cfg-textsize').value = String(cfg.textSize);
  $('#cfg-invert').checked = cfg.invertZoom;
  $('#cfg-restore').checked = cfg.restoreTabs;
  $('#cfg-update-on-start').checked = cfg.updateOnStart;
  $('#cfg-update-hint').textContent = cfg.updateOnStart
    ? 'Checked automatically when the app starts'
    : 'Not checked automatically — use the button';
  $('#cfg-openin').querySelectorAll('button').forEach((b) => b.setAttribute('aria-checked', String(b.dataset.val === cfg.openIn)));
  $('#cfg-openin-hint').textContent = cfg.openIn === 'window'
    ? 'Each file you open gets its own window'
    : 'Files you open join this window as tabs';
  $('#cfg-closescope').querySelectorAll('button').forEach((b) => b.setAttribute('aria-checked', String(b.dataset.val === cfg.closeScope)));
  $('#cfg-closescope-hint').textContent = cfg.closeScope === 'window'
    ? 'Ctrl+W closes the window and every tab in it'
    : 'Ctrl+W closes one tab; Ctrl+Shift+W closes the window';
  $('#cfg-zoomspeed-val').textContent = cfg.zoomSpeed.toFixed(2).replace(/0$/, '') + '×';
  $('#cfg-zoomspeed-hint').textContent = 'about ' + notchPercent() + '% per wheel notch';
  $('#cfg-textsize-val').textContent = cfg.textSize + 'px';

  if (save) saveCfgFields(changed || Object.keys(cfg));
  if (remeasure) measure(place || undefined);
}

function settingsOpen() { return $('#settings').classList.contains('on'); }

let settingsHadFocus = false;

function toggleSettings(force) {
  const on = force ?? !settingsOpen();
  if (on && findBarOpen()) closeFind();
  $('#settings').classList.toggle('on', on);
  $('#btn-settings').setAttribute('aria-pressed', String(on));
  if (!on) {
    if (settingsHadFocus) { settingsHadFocus = false; $('#btn-settings').focus(); }
    return;
  }
  els.chrome.classList.remove('hidden');
  settingsFocusables()[0]?.focus();
}

function settingsFocusables() {
  return [...$('#settings').querySelectorAll('input, button, select, [tabindex]')].filter((el) => !el.disabled);
}

/* ---------- toast ---------- */
let toastTimer;
function toast(msg) {
  els.toast.textContent = msg;
  els.toast.classList.add('on');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => els.toast.classList.remove('on'), 1600);
}

/* ======================================================================
   Updater
   ====================================================================== */

const UPDATE_EVERY = 6 * 60 * 60 * 1000;
let pendingUpdate = null;
let updateBusy = false;

function showUpdateBar(version) {
  $('#update-text').textContent = `Version ${version} is available`;
  $('#update').classList.add('on');
}

function hideUpdateBar() {
  $('#update').classList.remove('on');
}

async function checkForUpdate({ manual = false } = {}) {
  if (!IS_TAURI) {
    if (manual) toast('Updates are only available in the desktop app');
    return;
  }
  if (updateBusy) return;

  if (!manual) {
    const last = store.get('updateCheckedAt', 0) || 0;
    if (Date.now() - last < UPDATE_EVERY) return;
  }

  if (manual) $('#cfg-update-hint').textContent = 'Checking…';
  updateBusy = true;
  store.set('updateCheckedAt', Date.now());
  try {
    const found = await checkUpdate();
    if (found) {
      pendingUpdate = found;
      if (manual || store.get('updateSkipped', '') !== found.version) {
        showUpdateBar(found.version);
      }
      $('#cfg-update-hint').textContent = `Version ${found.version} is ready to install`;
    } else {
      pendingUpdate = null;
      hideUpdateBar();
      $('#cfg-update-hint').textContent = 'You are on the latest version';
      if (manual) toast('You are on the latest version');
    }
  } catch (err) {
    $('#cfg-update-hint').textContent = 'Could not reach the update server';
    if (manual) toast('Could not check for updates');
  } finally {
    updateBusy = false;
  }
}

async function installUpdate() {
  if (!pendingUpdate || updateBusy) return;
  updateBusy = true;
  const btn = $('#update-go');
  btn.disabled = true;

  let total = 0;
  let got = 0;
  try {
    await pendingUpdate.downloadAndInstall((e) => {
      if (e.event === 'Started') { total = e.data.contentLength || 0; got = 0; btn.textContent = 'Downloading…'; }
      else if (e.event === 'Progress') {
        got += e.data.chunkLength || 0;
        btn.textContent = total ? `${Math.round((got / total) * 100)}%` : 'Downloading…';
      } else if (e.event === 'Finished') { btn.textContent = 'Installing…'; }
    });
    await relaunch();
  } catch (err) {
    toast('Update failed — try downloading it from the releases page');
    btn.disabled = false;
    btn.textContent = 'Update';
    updateBusy = false;
  }
}

/* ======================================================================
   Zoom surface
   ----------------------------------------------------------------------
   #doc lays out once at its natural size and is then scaled with a CSS
   transform, exactly like browser pinch-zoom: no reflow, GPU-composited,
   and continuous rather than stepped. #canvas reserves the *scaled* box so
   the scroll container gets real scrollbars on both axes.
   ====================================================================== */

const MIN_SCALE = 0.1;
const MAX_SCALE = 32;

let scale = clampScale((store.get('zoom', 100) || 100) / 100);
let natW = 0;      // natural (unscaled) width of #doc
let natH = 0;      // natural (unscaled) height of #doc
let docLeft = 0;   // horizontal offset that keeps the artwork centred
let docTop = 0;    // vertical offset that keeps the artwork centred
let measuring = false;

function clampScale(s) { return Math.min(MAX_SCALE, Math.max(MIN_SCALE, s)); }

let lastAvail = -1;

function captureAnchor() {
  try {
    if (els.scroller.scrollTop < 1) return null;
    const top = els.scroller.getBoundingClientRect().top;
    const kids = els.doc.children;
    for (let i = 0; i < kids.length; i++) {
      const r = kids[i].getBoundingClientRect?.();
      if (r && r.bottom > top) {
        return { index: i, frac: r.height ? Math.max(0, (top - r.top) / r.height) : 0 };
      }
    }
  } catch {}
  return null;
}

const QUIET_SCROLL_MS = 150;
let quietScrollUntil = 0;

function setScrollQuietly(top, left) {
  els.scroller.classList.add('instant');
  if (left != null) els.scroller.scrollLeft = left;
  els.scroller.scrollTop = top;
  els.scroller.classList.remove('instant');
  quietScrollUntil = performance.now() + QUIET_SCROLL_MS;
}

function restoreAnchor(a) {
  if (!a) return;
  try {
    const el = els.doc.children[a.index];
    if (!el || !el.getBoundingClientRect) return;
    const top = els.scroller.getBoundingClientRect().top;
    const r = el.getBoundingClientRect();
    const delta = r.top + a.frac * r.height - top;
    if (Math.abs(delta) >= 0.5) setScrollQuietly(els.scroller.scrollTop + delta);
  } catch {}
}

function measure(keep) {
  if (measuring) return;
  const avail = els.scroller.clientWidth;
  if (!avail) { scheduleMeasure(); return; }

  const place = keep === false ? null
    : (keep && typeof keep === 'object') ? keep
    : captureAnchor();
  measuring = true;
  lastAvail = avail;
  els.doc.style.transform = 'none';
  els.doc.style.width = sourceOn ? avail + 'px' : 'max-content';
  natW = els.doc.offsetWidth;
  natH = els.doc.offsetHeight;
  measuring = false;
  paint();
  restoreAnchor(place);
}

document.addEventListener('visibilitychange', () => { if (!document.hidden) scheduleMeasure(); });
window.addEventListener('load', () => scheduleMeasure());

/** Apply the current scale. Cheap: no layout reads. */
function paint() {
  const availW = els.scroller.clientWidth;
  const availH = Math.max(0, (els.scroller.clientHeight || 0) - 44);
  const w = natW * scale;
  const h = natH * scale;
  const canvasW = Math.max(w, availW);
  const canvasH = sourceOn ? h : Math.max(h, availH);
  docLeft = Math.max(0, (canvasW - w) / 2);
  docTop = sourceOn ? 0 : Math.max(0, (canvasH - h) / 2);
  els.canvas.style.width = canvasW + 'px';
  els.canvas.style.height = canvasH + 'px';
  els.doc.style.transform = docTop
    ? `translate(${docLeft}px, ${docTop}px) scale(${scale})`
    : `translateX(${docLeft}px) scale(${scale})`;
  els.scroller.classList.toggle('pannable', !sourceOn || w > availW + 1 || h > availH + 1);
  els.zoomval.textContent = Math.round(scale * 100) + '%';
}

function zoomTo(next, clientX, clientY) {
  next = clampScale(next);
  if (Math.abs(next - scale) < 0.0001) return;

  const rect = els.scroller.getBoundingClientRect();
  const vx = clientX == null ? rect.width / 2 : Math.min(rect.width, Math.max(0, clientX - rect.left));
  const vy = clientY == null ? rect.height / 2 : Math.min(rect.height, Math.max(0, clientY - rect.top));

  const topPad = (els.canvas.offsetTop || 0) + docTop;
  const cx = els.scroller.scrollLeft + vx;
  const cy = els.scroller.scrollTop + vy - topPad;
  const leftBefore = docLeft;
  const ratio = next / scale;

  scale = next;
  paint();

  const nextTopPad = (els.canvas.offsetTop || 0) + docTop;
  setScrollQuietly(cy * ratio + nextTopPad - vy, (cx - leftBefore) * ratio + docLeft - vx);

  persistZoom();
}

let zoomSaveTimer = 0;
function persistZoom() {
  clearTimeout(zoomSaveTimer);
  zoomSaveTimer = setTimeout(() => store.set('zoom', Math.round(scale * 100)), 250);
}

const STEPS = [0.1, 0.15, 0.25, 0.33, 0.5, 0.67, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4, 6, 8, 12, 16, 24, 32];
let tween = 0;

function zoomAnimated(target) {
  cancelAnimationFrame(tween);
  cancelZoomEase();
  const from = scale;
  const to = clampScale(target);
  if (Math.abs(to - from) < 0.0001) return;
  if (document.hidden) { zoomTo(to); return; }
  const t0 = performance.now();
  const dur = 160;
  const step = (t) => {
    const k = Math.min(1, (t - t0) / dur);
    const eased = 1 - Math.pow(1 - k, 3);
    zoomTo(from + (to - from) * eased);
    if (k < 1) tween = requestAnimationFrame(step);
  };
  tween = requestAnimationFrame(step);
}

/** Scale so the SVG fits comfortably inside the window. */
function zoomFitWidth() {
  if (!natW) return;
  const availW = els.scroller.clientWidth;
  const availH = Math.max(200, (els.scroller.clientHeight || 600) - 64);
  const fit = (!sourceOn && natH > 0)
    ? Math.min(availW / natW, availH / natH)
    : (availW / natW);
  zoomAnimated(clampScale(fit));
  toast('Fit to window');
}

function zoomStep(dir) {
  const eps = 0.0001;
  let next;
  if (dir > 0) {
    next = STEPS.find((s) => s > scale + eps) ?? STEPS[STEPS.length - 1];
  } else {
    const below = STEPS.filter((s) => s < scale - eps);
    next = below.length ? below[below.length - 1] : STEPS[0];
  }
  zoomAnimated(next);
}

window.addEventListener('wheel', (e) => {
  if (!e.ctrlKey && !e.metaKey) return;
  e.preventDefault();
  cancelAnimationFrame(tween);
  const dir = cfg.invertZoom ? 1 : -1;
  const from = zoomTarget ? zoomTarget.scale : scale;
  easeZoomTo(from * Math.exp(dir * e.deltaY * WHEEL_BASE * cfg.zoomSpeed), e.clientX, e.clientY);
}, { passive: false, capture: true });

/* ---------- eased wheel / pinch zoom ---------- */
const ZOOM_EASE_MS = 25;
let zoomTarget = null;
let zoomEaseRaf = 0;
let zoomEaseLast = 0;

function easeZoomTo(target, clientX, clientY) {
  zoomTarget = { scale: clampScale(target), x: clientX, y: clientY };
  if (!zoomEaseRaf) {
    zoomEaseLast = 0;
    zoomEaseRaf = requestAnimationFrame(stepZoomEase);
  }
}

function cancelZoomEase() {
  cancelAnimationFrame(zoomEaseRaf);
  zoomEaseRaf = 0;
  zoomTarget = null;
}

function stepZoomEase(t) {
  zoomEaseRaf = 0;
  const z = zoomTarget;
  if (!z) return;
  const dt = zoomEaseLast && t > zoomEaseLast ? Math.min(50, t - zoomEaseLast) : 6;
  zoomEaseLast = t;
  const k = 1 - Math.exp(-dt / ZOOM_EASE_MS);
  const next = Math.exp(Math.log(scale) + (Math.log(z.scale) - Math.log(scale)) * k);
  const done = Math.abs(z.scale - next) < 0.001 || Math.abs(next - scale) < 0.0002;
  zoomTo(done ? z.scale : next, z.x, z.y);
  if (done) { zoomTarget = null; return; }
  zoomEaseRaf = requestAnimationFrame(stepZoomEase);
}

/* ---------- touch & gesture pinch ---------- */
const livePointers = new Map();
let pinchStartDist = 0;
let pinchStartScale = 1;

function pinchDistance() {
  const [a, b] = [...livePointers.values()];
  return Math.hypot(a.x - b.x, a.y - b.y);
}
function pinchCentre() {
  const [a, b] = [...livePointers.values()];
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
}

els.scroller.addEventListener('pointerdown', (e) => {
  if (e.pointerType !== 'touch') return;
  livePointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  if (livePointers.size === 2) {
    pinchStartDist = pinchDistance();
    pinchStartScale = scale;
  }
}, { passive: true });

els.scroller.addEventListener('pointermove', (e) => {
  if (e.pointerType !== 'touch' || !livePointers.has(e.pointerId)) return;
  livePointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  if (livePointers.size !== 2 || !pinchStartDist) return;
  e.preventDefault();
  cancelAnimationFrame(tween);
  cancelZoomEase();
  const c = pinchCentre();
  zoomTo(pinchStartScale * (pinchDistance() / pinchStartDist), c.x, c.y);
}, { passive: false });

function dropPointer(e) {
  if (livePointers.delete(e.pointerId) && livePointers.size < 2) pinchStartDist = 0;
}
els.scroller.addEventListener('pointerup', dropPointer, { passive: true });
els.scroller.addEventListener('pointercancel', dropPointer, { passive: true });
els.scroller.addEventListener('pointerleave', dropPointer, { passive: true });

let gestureStartScale = 1;
window.addEventListener('gesturestart', (e) => {
  e.preventDefault();
  gestureStartScale = scale;
}, { passive: false });
window.addEventListener('gesturechange', (e) => {
  e.preventDefault();
  cancelAnimationFrame(tween);
  cancelZoomEase();
  zoomTo(gestureStartScale * e.scale, e.clientX, e.clientY);
}, { passive: false });
window.addEventListener('gestureend', (e) => e.preventDefault(), { passive: false });

/* ---------- panning ----------
   Middle-drag or Alt+drag always pans. In canvas mode (sourceOn === false),
   plain left-drag also pans unless clicking a link. In XML source mode, plain
   left-drag is left alone so selecting source code works. */
let pan = null;

els.scroller.addEventListener('pointerdown', (e) => {
  const isLink = e.target?.closest?.('a, area, button');
  const wants = e.button === 1 || (e.button === 0 && (e.altKey || (!sourceOn && !isLink)));
  if (!wants) return;
  e.preventDefault();
  pan = {
    id: e.pointerId,
    x: e.clientX, y: e.clientY,
    left: els.scroller.scrollLeft, top: els.scroller.scrollTop,
  };
  try { els.scroller.setPointerCapture(e.pointerId); } catch {}
  els.scroller.classList.add('panning');
});

els.scroller.addEventListener('pointermove', (e) => {
  if (!pan || e.pointerId !== pan.id) return;
  els.scroller.scrollLeft = pan.left - (e.clientX - pan.x);
  els.scroller.scrollTop = pan.top - (e.clientY - pan.y);
});

function endPan(e) {
  if (!pan || (e && e.pointerId !== pan.id)) return;
  try { els.scroller.releasePointerCapture(pan.id); } catch {}
  pan = null;
  els.scroller.classList.remove('panning');
}
els.scroller.addEventListener('pointerup', endPan);
els.scroller.addEventListener('pointercancel', endPan);
els.scroller.addEventListener('auxclick', (e) => { if (e.button === 1) e.preventDefault(); });

let resizeRaf = 0;
new ResizeObserver(() => {
  if (els.scroller.clientWidth === lastAvail) return;
  cancelAnimationFrame(resizeRaf);
  resizeRaf = requestAnimationFrame(measure);
}).observe(els.scroller);

/* ---------- SVG parsing & sanitisation ---------- */
function slugify(text, used) {
  let base = text.toLowerCase().trim()
    .replace(/[^\p{L}\p{N}\s-]/gu, '')
    .replace(/\s+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-|-$/g, '') || 'element';
  let out = base, n = 2;
  while (used.has(out)) out = base + '-' + n++;
  used.add(out);
  return out;
}

const COPY_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h8"/></svg>';

/* Strip XML declaration (<?xml ...?>) and <!DOCTYPE svg ...> preamble before
   passing to DOMPurify so it starts directly at the <svg> root element. */
function stripXmlPreamble(text) {
  return String(text || '')
    .replace(/^\uFEFF/, '')
    .replace(/^\s*(?:<\?xml[\s\S]*?\?>\s*|<!--[\s\S]*?-->\s*|<!DOCTYPE[^>]*>\s*)*/i, '');
}

const SVG_PURIFY = {
  USE_PROFILES: { svg: true, svgFilters: true, html: true },
  ADD_TAGS: ['use', 'symbol', 'defs', 'clipPath', 'mask', 'pattern', 'marker', 'linearGradient', 'radialGradient', 'stop', 'textPath', 'tspan', 'title', 'desc', 'switch'],
  ADD_ATTR: ['target', 'id', 'viewBox', 'preserveAspectRatio', 'xmlns', 'xmlns:xlink', 'xlink:href', 'href'],
  FORBID_TAGS: ['script', 'iframe', 'object', 'embed', 'form'],
};

function joinPath(dir, rel) {
  const sep = dir.includes('\\') ? '\\' : '/';
  const parts = dir.split(/[\\/]/).filter((p, i) => p !== '' || i === 0);
  for (const seg of rel.split(/[\\/]/)) {
    if (!seg || seg === '.') continue;
    if (seg === '..') parts.pop();
    else parts.push(seg);
  }
  return parts.join(sep);
}

function isAbsolutePath(p) {
  return /^([a-zA-Z]:[\\/]|[\\/]{1,2})/.test(p);
}

function isNetworkPath(p) {
  return /^[\\/]{2}/.test(p);
}

/* Rewrite relative <image href> / <img src> through Tauri's asset protocol. */
function resolveImages() {
  if (!IS_TAURI || !state.docDir) return;
  els.doc.querySelectorAll('img[src], image[href], image[xlink\\:href]').forEach((img) => {
    const attr = img.hasAttribute('src') ? 'src' : (img.hasAttribute('href') ? 'href' : 'xlink:href');
    const raw = img.getAttribute(attr) || '';
    if (!raw || /^(https?:|data:|blob:|asset:|tauri:|file:|#)/i.test(raw)) return;
    let rel = raw;
    try { rel = decodeURIComponent(raw); } catch {}
    if (isNetworkPath(rel)) return;
    const abs = isAbsolutePath(rel) ? rel : joinPath(state.docDir, rel);
    try { img.setAttribute(attr, convertFileSrc(abs)); } catch {}
  });
}

/* ---------- links ---------- */
const DOC_EXT = /\.(?:svg)$/i;
const EXTERNAL_SCHEME = /^(?:https?|mailto|tel):/i;
const ANY_SCHEME = /^[a-zA-Z][a-zA-Z0-9+.-]*:/;

function urlRoot(u) {
  return u.protocol + '//' + u.host;
}

function resolveHref(href) {
  const base = location && location.href ? location.href : undefined;
  try { return new URL(href, base); } catch { return null; }
}

function linkToLocalPath(path) {
  let p = path;
  if (/^file:/i.test(p)) {
    const u = resolveHref(p);
    if (!u || u.host) return null;
    p = decodeURIComponent(u.pathname);
    if (/^\/[a-zA-Z]:/.test(p)) p = p.slice(1);
  } else {
    try { p = decodeURIComponent(p); } catch {}
  }
  if (isNetworkPath(p)) return null;
  if (isAbsolutePath(p)) return p;
  return state.docDir ? joinPath(state.docDir, p) : p;
}

function classifyLink(href) {
  if (href.startsWith('#')) return { kind: 'anchor' };
  if (!href.trim()) return { kind: 'top' };
  if (EXTERNAL_SCHEME.test(href)) return { kind: 'external' };
  if (href.startsWith('//')) return { kind: 'unsupported' };
  const bare = href.split('#')[0].split('?')[0];
  if (bare && DOC_EXT.test(bare) && (!ANY_SCHEME.test(bare) || /^file:/i.test(bare))) {
    const path = linkToLocalPath(bare);
    return path ? { kind: 'doc', path } : { kind: 'unsupported' };
  }
  const target = resolveHref(href);
  const self = resolveHref(location && location.href ? location.href : '');
  if (target && self) {
    return urlRoot(target) === urlRoot(self) ? { kind: 'refuse' } : { kind: 'unsupported' };
  }
  return ANY_SCHEME.test(href) ? { kind: 'unsupported' } : { kind: 'refuse' };
}

function linkHref(a) {
  return a.getAttribute('href') ?? a.getAttribute('xlink:href');
}

els.doc.addEventListener('click', (e) => {
  const a = e.target?.closest?.('a, area');
  if (!a || !els.doc.contains(a)) return;
  const href = linkHref(a);
  if (href === null) return;
  const route = classifyLink(href);
  if (route.kind === 'anchor') {
    const t = els.doc.querySelector('#' + CSS.escape(href.slice(1)));
    if (t) { e.preventDefault(); scrollToEl(t); }
    return;
  }
  e.preventDefault();
  const current = captureRenderGuard();
  if (route.kind === 'external') {
    if (IS_TAURI) {
      openUrl(href).catch(() => { if (current()) toast('Could not open link'); });
    } else {
      try { window.open(href, '_blank', 'noopener'); }
      catch { toast('Could not open link'); }
    }
    return;
  }
  if (route.kind === 'doc') {
    if (IS_TAURI) openPath(route.path).catch(() => { if (current()) toast('Could not open that file'); });
    else toast('Relative links only work in the desktop app');
    return;
  }
  if (route.kind === 'top') { els.scroller.scrollTo({ top: 0, behavior: 'smooth' }); return; }
  if (route.kind === 'refuse') toast('Blocked: that link points back at the app');
  else toast('Cannot open that link');
}, true);

els.doc.addEventListener('submit', (e) => {
  e.preventDefault();
  toast('Forms are not supported');
}, true);

/* Parse viewBox="minX minY width height" into positive numbers. */
function parseViewBox(vb) {
  if (!vb) return null;
  const parts = String(vb).trim().split(/[\s,]+/).map(Number);
  if (parts.length === 4 && parts.every(Number.isFinite) && parts[2] > 0 && parts[3] > 0) {
    return { minX: parts[0], minY: parts[1], width: parts[2], height: parts[3] };
  }
  return null;
}

/* Parse a numeric SVG length (e.g. "24", "24px", "100%"). Returns null for % or invalid. */
function parsePixelLength(val) {
  if (!val) return null;
  const s = String(val).trim();
  if (s.endsWith('%')) return null;
  const m = s.match(/^([0-9]+(?:\.[0-9]+)?)\s*(?:px)?$/i);
  return m ? Number(m[1]) : null;
}

/* Ensure a root <svg> has explicit pixel dimensions so it renders at its natural
   intrinsic size rather than collapsing to 0x0 or stretching to 300x150. */
function normaliseSvgDimensions(svg) {
  if (!svg) return null;
  const vb = parseViewBox(svg.getAttribute('viewBox'));
  const wAttr = parsePixelLength(svg.getAttribute('width'));
  const hAttr = parsePixelLength(svg.getAttribute('height'));
  const w = wAttr || (vb ? vb.width : 300);
  const h = hAttr || (vb ? vb.height : 150);
  if (!wAttr && w > 0) svg.setAttribute('width', String(w));
  if (!hAttr && h > 0) svg.setAttribute('height', String(h));
  return { width: w, height: h, viewBox: svg.getAttribute('viewBox') || null };
}

const OUTLINE_TAGS = new Set([
  'svg', 'g', 'defs', 'symbol', 'clippath', 'mask', 'lineargradient', 'radialgradient',
  'pattern', 'filter', 'path', 'rect', 'circle', 'ellipse', 'line', 'polyline',
  'polygon', 'text', 'image', 'use',
]);

function elementDepth(el, stop) {
  let d = 1;
  let cur = el.parentElement;
  while (cur && cur !== stop) {
    d++;
    cur = cur.parentElement;
  }
  return Math.min(d, 4);
}

function describeElement(el) {
  const tag = (el.tagName || '').toLowerCase();
  const rawId = el.getAttribute('id');
  const label = rawId ? `${tag}#${rawId}` : tag;
  if (tag === 'text') {
    const snippet = (el.textContent || '').trim().slice(0, 24);
    if (snippet) return `${label} "${snippet}"`;
  }
  return label;
}

function render(text) {
  renderRevision++;
  const current = captureRenderGuard();
  const cleanSource = stripXmlPreamble(text);
  const sanitised = DOMPurify.sanitize(cleanSource, SVG_PURIFY);

  const stage = document.createElement('div');
  stage.className = 'svg-stage';
  stage.innerHTML = sanitised;

  const svgRoot = stage.querySelector('svg');
  const dims = normaliseSvgDimensions(svgRoot);

  els.doc.innerHTML = '';
  els.doc.appendChild(stage);

  /* Also build the XML source block so toggling Source mode (s) is instant and
     has a one-click Copy SVG button. */
  if (cleanSource.trim()) {
    const pre = document.createElement('pre');
    pre.className = 'svg-source';
    pre.style.position = 'relative';
    const code = document.createElement('code');
    code.className = 'language-xml';
    code.textContent = text;
    try { hljs.highlightElement(code); } catch {}
    const btn = document.createElement('button');
    btn.className = 'btn copy';
    btn.type = 'button';
    btn.title = 'Copy SVG code';
    btn.innerHTML = COPY_ICON;
    btn.style.cssText = 'position:absolute;top:6px;right:6px;opacity:0;transition:opacity .12s';
    pre.addEventListener('mouseenter', () => { btn.style.opacity = '1'; });
    pre.addEventListener('mouseleave', () => { btn.style.opacity = '0'; });
    btn.addEventListener('click', () => {
      navigator.clipboard.writeText(text).then(
        () => { if (current()) toast('Copied SVG'); },
        () => { if (current()) toast('Copy failed'); },
      );
    });
    pre.append(code, btn);
    els.doc.appendChild(pre);
  }

  const used = new Set();
  const candidates = [...stage.querySelectorAll('*')].filter((el) =>
    OUTLINE_TAGS.has((el.tagName || '').toLowerCase())
  );

  state.heads = candidates.slice(0, 200).map((el) => {
    const title = describeElement(el);
    const existingId = el.getAttribute('id');
    const id = existingId && !used.has(existingId)
      ? (used.add(existingId), existingId)
      : slugify(title, used);
    if (!existingId) el.setAttribute('id', id);
    return { el, id, title, level: elementDepth(el, stage) };
  });

  resolveImages();

  els.doc.querySelectorAll('img').forEach((img) => {
    if (img.complete) return;
    const loaded = () => { if (current()) scheduleMeasure(); };
    img.addEventListener('load', loaded, { once: true });
    img.addEventListener('error', loaded, { once: true });
  });

  buildOutline();
  updateDocMeta(text, dims, candidates.length);
  measure(false);
}

/** Dimensions, element count and byte size for the toolbar. */
function updateDocMeta(source, dims, elementCount) {
  const el = $('#docmeta');
  if (!el) return;
  if (!source || !source.trim()) { el.textContent = ''; return; }
  const bytes = new TextEncoder().encode(source).length;
  const sizeStr = bytes >= 1024 ? `${(bytes / 1024).toFixed(1)} KB` : `${bytes} B`;
  const parts = [];
  if (dims) parts.push(`${dims.width} × ${dims.height}`);
  if (dims && dims.viewBox) parts.push(`viewBox ${dims.viewBox}`);
  if (elementCount) parts.push(`${elementCount} ${elementCount === 1 ? 'element' : 'elements'}`);
  parts.push(sizeStr);
  el.textContent = parts.join(' · ');
}

let measureRaf = 0;
function scheduleMeasure() {
  cancelAnimationFrame(measureRaf);
  measureRaf = requestAnimationFrame(measure);
}

function scrollToEl(el) {
  els.doc.querySelectorAll('.svg-highlight').forEach((n) => n.classList.remove('svg-highlight'));
  if (el && el.classList && el.tagName?.toLowerCase() !== 'svg') {
    el.classList.add('svg-highlight');
  }
  const top = (els.canvas.offsetTop || 0) + docTop + (el.offsetTop || 0) * scale - 60;
  els.scroller.scrollTo({ top: Math.max(0, top), behavior: 'smooth' });
}

function buildOutline() {
  els.outlineList.innerHTML = '';
  if (!state.heads.length) {
    const p = document.createElement('div');
    p.style.cssText = 'padding:6px 8px;font-size:12.5px;color:var(--faint)';
    p.textContent = 'No SVG elements';
    els.outlineList.appendChild(p);
    return;
  }
  const min = Math.min(...state.heads.map((h) => h.level));
  for (const h of state.heads) {
    const a = document.createElement('a');
    a.href = '#' + h.id;
    a.textContent = h.title;
    a.title = h.title;
    a.dataset.lvl = String(Math.min(h.level - min + 1, 4));
    a.dataset.id = h.id;
    a.addEventListener('click', (e) => {
      e.preventDefault();
      els.outlineList.querySelectorAll('a').forEach((link) => link.classList.toggle('active', link === a));
      scrollToEl(h.el);
    });
    els.outlineList.appendChild(a);
  }
}

/* ---------- document lifecycle ---------- */
function setDoc(text, resetScroll) {
  const keep = resetScroll ? 0 : els.scroller.scrollTop;
  const keepLeft = resetScroll ? 0 : els.scroller.scrollLeft;
  const place = resetScroll ? null : captureAnchor();
  state.text = text;
  render(text);
  els.empty.classList.add('gone');
  els.scroller.classList.add('instant');
  els.scroller.scrollTop = keep;
  els.scroller.scrollLeft = keepLeft;
  restoreAnchor(place);
  els.scroller.classList.add('instant');
  const current = captureRenderGuard();
  requestAnimationFrame(() => { if (current()) els.scroller.classList.remove('instant'); });
  if (!(IS_TAURI && state.path) && text.length < 900000) {
    store.set('lastText', text);
    store.set('lastName', state.name);
  }
  updateTitle();
  syncOutlineActive();
  if ($('#find').classList.contains('on')) runFind($('#find-input').value, false);
}

function updateTitle() {
  if (!state.name) {
    els.title.textContent = '';
    document.title = 'SVG Viewer';
    if (IS_TAURI) getCurrentWindow().setTitle(document.title).catch(() => {});
    return;
  }
  els.title.innerHTML = '';
  const b = document.createElement('b');
  b.textContent = state.name;
  els.title.appendChild(b);
  if (state.pending && !state.handle) {
    const s = document.createElement('span');
    s.textContent = '  · click to reconnect';
    els.title.appendChild(s);
    els.title.style.cursor = 'pointer';
  } else {
    els.title.style.cursor = 'default';
  }
  document.title = state.name + ' — SVG Viewer';
  if (IS_TAURI) {
    getCurrentWindow().setTitle(document.title).catch(() => {});
  }
}

async function loadFile(file, handle) {
  const text = await file.text();
  const existing = tabs.find((t) => !t.path && t.name === file.name);
  if (existing) {
    existing.text = text;
    existing.lastModified = file.lastModified;
    existing.handle = handle || null;
    activateTab(existing.id);
    if (state.id === existing.id) showActiveTab();
    return;
  }
  const tab = makeTab({
    name: file.name,
    text,
    lastModified: file.lastModified,
    handle: handle || null,
  });
  tabs.push(tab);
  stashScroll();
  state = tab;
  showActiveTab();
  els.scroller.focus({ preventScroll: true });
}

function loadPasted(text) {
  const taken = tabs.filter((t) => /^Pasted SVG/.test(t.name)).length;
  const tab = makeTab({ name: taken ? `Pasted SVG ${taken + 1}` : 'Pasted SVG', text });
  tabs.push(tab);
  stashScroll();
  state = tab;
  showActiveTab();
}

async function openHandle(h) {
  try {
    const perm = await h.queryPermission?.({ mode: 'read' });
    if (perm === 'prompt') await h.requestPermission?.({ mode: 'read' });
  } catch {}
  const f = await h.getFile();
  await idbSet('handle', h).catch(() => {});
  await loadFile(f, h);
}

/* ---------- native (Tauri) file handling ---------- */
function dirOf(path, name) {
  let dir = path.slice(0, Math.max(0, path.length - name.length - 1)) || null;
  if (dir && /^[a-zA-Z]:$/.test(dir)) dir += '\\';
  return dir;
}

async function openPath(path, { allowNewWindow = true } = {}) {
  const existing = tabs.find((t) => t.path && t.path.toLowerCase() === path.toLowerCase());
  if (existing) {
    activateTab(existing.id);
    try { await getCurrentWindow().setFocus(); } catch {}
    return false;
  }

  if (allowNewWindow && IS_TAURI && cfg.openIn === 'window' && tabs.length > 0) {
    await openInNewWindow(path);
    return true;
  }

  const text = await invoke('read_text_file', { path });
  let mtime = 0;
  try { mtime = await invoke('file_mtime', { path }); } catch {}

  const committed = tabs.find((t) => t.path && t.path.toLowerCase() === path.toLowerCase());
  if (committed) {
    activateTab(committed.id);
    try { await getCurrentWindow().setFocus(); } catch {}
    return false;
  }

  const name = baseName(path);
  const tab = makeTab({ name, path, text, lastModified: mtime, docDir: dirOf(path, name) });
  tabs.push(tab);
  stashScroll();
  state = tab;
  store.set('lastPath', path);
  showActiveTab();
  els.scroller.focus({ preventScroll: true });
  return true;
}

async function openInNewWindow(path) {
  try {
    const label = 'doc-' + Date.now().toString(36) + Math.floor(Math.random() * 1000);
    const w = new WebviewWindow(label, {
      url: 'index.html?file=' + encodeURIComponent(path),
      title: baseName(path) + ' — SVG Viewer',
      width: 1100,
      height: 820,
      dragDropEnabled: true,
      zoomHotkeysEnabled: IS_WINDOWS,
    });
    await new Promise((resolve, reject) => {
      w.once('tauri://created', resolve);
      w.once('tauri://error', reject);
      setTimeout(resolve, 3000);
    });
  } catch (err) {
    toast('Could not open a new window');
    await openPath(path, { allowNewWindow: false });
  }
}

async function openViaPicker() {
  if (IS_TAURI) {
    try {
      const sel = await openDialog({
        multiple: false,
        filters: [{ name: 'SVG Image', extensions: ['svg'] }],
      });
      const p = typeof sel === 'string' ? sel : sel?.path;
      if (p) await openPath(p);
    } catch (err) {
      toast('Could not open that file');
    }
    return;
  }
  if (window.showOpenFilePicker) {
    try {
      const [h] = await window.showOpenFilePicker({
        multiple: false,
        types: [{
          description: 'SVG Image',
          accept: { 'image/svg+xml': ['.svg'] },
        }],
      });
      if (h) await openHandle(h);
    } catch {}
  } else {
    els.fileInput.click();
  }
}

/* ---------- live reload ---------- */
const WATCH_INTERVAL = 700;
const WATCH_MAX_FAILS = 20;

let watchTimer = null;
let watchFails = 0;

let watchEpoch = 0;
let opSeq = 0;
let watchInFlight = null;

function beginWatchOp() {
  const s = { tab: state, path: state.path, handle: state.handle, epoch: watchEpoch, op: ++opSeq };
  watchInFlight = s;
  return s;
}

function watchOpCurrent(s) {
  return s.op === opSeq && s.epoch === watchEpoch && state === s.tab &&
    state.path === s.path && state.handle === s.handle && tabs.includes(s.tab);
}

function stopWatch() {
  watchEpoch++;
  watchInFlight = null;
  clearInterval(watchTimer);
  watchTimer = null;
  watchFails = 0;
  els.live.classList.remove('on');
  markActiveTabWatching(false);
}

function markActiveTabWatching(on) {
  const el = $('#tabbar .tab[aria-selected="true"]');
  if (el) el.dataset.watching = on ? 'yes' : 'no';
}

function onWatchError() {
  if (++watchFails >= WATCH_MAX_FAILS) {
    stopWatch();
    toast('Stopped watching — file unreadable');
  }
}

async function pollNative() {
  if (!state.path || !tabs.includes(state) || watchInFlight) return;
  const s = beginWatchOp();
  try {
    const m = await invoke('file_mtime', { path: s.path });
    if (!watchOpCurrent(s)) return;
    if (m !== s.tab.lastModified) {
      const text = await invoke('read_text_file', { path: s.path });
      if (!watchOpCurrent(s)) return;
      s.tab.lastModified = m;
      setDoc(text, false);
      toast('Reloaded');
    }
    watchFails = 0;
  } catch {
    if (watchOpCurrent(s)) onWatchError();
  } finally {
    if (watchInFlight === s) watchInFlight = null;
  }
}

async function pollHandle() {
  if (!state.handle || !tabs.includes(state) || watchInFlight) return;
  const s = beginWatchOp();
  try {
    const f = await s.handle.getFile();
    if (!watchOpCurrent(s)) return;
    if (f.lastModified !== s.tab.lastModified) {
      const text = await f.text();
      if (!watchOpCurrent(s)) return;
      s.tab.lastModified = f.lastModified;
      setDoc(text, false);
      toast('Reloaded');
    }
    watchFails = 0;
  } catch {
    if (watchOpCurrent(s)) onWatchError();
  } finally {
    if (watchInFlight === s) watchInFlight = null;
  }
}

function startWatch() {
  stopWatch();
  if (IS_TAURI && state.path) {
    els.live.classList.add('on');
    markActiveTabWatching(true);
    const epoch = watchEpoch;
    watchTimer = setInterval(() => { if (epoch === watchEpoch) pollNative(); }, WATCH_INTERVAL);
  } else if (state.handle) {
    els.live.classList.add('on');
    markActiveTabWatching(true);
    const epoch = watchEpoch;
    watchTimer = setInterval(() => { if (epoch === watchEpoch) pollHandle(); }, WATCH_INTERVAL);
  }
}

async function reloadNow() {
  if (!tabs.includes(state) || (!(IS_TAURI && state.path) && !state.handle)) return;
  const s = beginWatchOp();
  try {
    if (IS_TAURI && s.path) {
      const mtime = await invoke('file_mtime', { path: s.path }).catch(() => 0);
      if (!watchOpCurrent(s)) return;
      const text = await invoke('read_text_file', { path: s.path });
      if (!watchOpCurrent(s)) return;
      s.tab.lastModified = mtime;
      setDoc(text, false);
      startWatch();
      toast('Reloaded');
    } else if (s.handle) {
      const f = await s.handle.getFile();
      if (!watchOpCurrent(s)) return;
      const text = await f.text();
      if (!watchOpCurrent(s)) return;
      s.tab.lastModified = f.lastModified;
      setDoc(text, false);
      startWatch();
      toast('Reloaded');
    }
  } catch {
    if (watchOpCurrent(s)) toast('Could not reload');
  } finally {
    if (watchInFlight === s) watchInFlight = null;
  }
}

/* ======================================================================
   Find in page
   ====================================================================== */

let findMarks = [];
let findIndex = -1;

function findBarOpen() { return $('#find').classList.contains('on'); }

function offsetTopInDoc(el) {
  let y = 0;
  let node = el;
  while (node && node !== els.doc && node !== els.canvas) {
    y += node.offsetTop;
    node = node.offsetParent;
  }
  return y;
}

function clearFind() {
  for (const m of findMarks) {
    const parent = m.parentNode;
    if (!parent) continue;
    parent.replaceChild(document.createTextNode(m.textContent), m);
    parent.normalize();
  }
  findMarks = [];
  findIndex = -1;
}

function updateFindCount() {
  const el = $('#find-count');
  const q = $('#find-input').value.trim();
  el.textContent = findMarks.length ? `${findIndex + 1}/${findMarks.length}` : (q ? '0/0' : '');
  el.classList.toggle('none', !!q && !findMarks.length);
}

function focusMatch(i, doScroll = true) {
  findMarks.forEach((m, k) => m.classList.toggle('current', k === i));
  const m = findMarks[i];
  if (!m) return;
  if (doScroll) {
    const top = (els.canvas.offsetTop || 0) + docTop + offsetTopInDoc(m) * scale - els.scroller.clientHeight / 3;
    els.scroller.scrollTo({ top: Math.max(0, top), behavior: 'smooth' });
  }
}

function runFind(query, scrollToFirst = true) {
  clearFind();
  const needle = (query || '').trim().toLowerCase();
  if (!needle) { updateFindCount(); return; }

  const walker = document.createTreeWalker(els.doc, NodeFilter.SHOW_TEXT, {
    acceptNode(n) {
      if (!n.nodeValue) return NodeFilter.FILTER_REJECT;
      const p = n.parentElement;
      if (!p || p.classList.contains('anchor')) return NodeFilter.FILTER_REJECT;
      /* An HTML <mark> cannot draw inside MathML or SVG: wrapping a match there
         would blank that part of a diagram while Find is open. Matches in the
         XML source block (.svg-source) or plain text outside <svg> work cleanly. */
      if (p.closest('math, svg')) return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    },
  });

  const nodes = [];
  let n;
  while ((n = walker.nextNode())) nodes.push(n);

  for (const node of nodes) {
    const text = node.nodeValue;
    const lower = text.toLowerCase();
    let idx = lower.indexOf(needle);
    if (idx === -1) continue;

    const frag = document.createDocumentFragment();
    let last = 0;
    while (idx !== -1) {
      if (idx > last) frag.appendChild(document.createTextNode(text.slice(last, idx)));
      const mark = document.createElement('mark');
      mark.className = 'findhit';
      mark.textContent = text.slice(idx, idx + needle.length);
      frag.appendChild(mark);
      findMarks.push(mark);
      last = idx + needle.length;
      idx = lower.indexOf(needle, last);
    }
    if (last < text.length) frag.appendChild(document.createTextNode(text.slice(last)));
    node.parentNode.replaceChild(frag, node);
  }

  findIndex = findMarks.length ? 0 : -1;
  focusMatch(findIndex, scrollToFirst);
  updateFindCount();
}

function findStep(dir) {
  if (!findMarks.length) return;
  findIndex = (findIndex + dir + findMarks.length) % findMarks.length;
  focusMatch(findIndex);
  updateFindCount();
}

function openFind() {
  if (settingsOpen()) toggleSettings(false);
  $('#find').classList.add('on');
  $('#btn-find').setAttribute('aria-pressed', 'true');
  els.chrome.classList.remove('hidden');
  const input = $('#find-input');
  input.focus();
  input.select();
  if (input.value.trim()) runFind(input.value);
}

function closeFind() {
  $('#find').classList.remove('on');
  $('#btn-find').setAttribute('aria-pressed', 'false');
  clearFind();
  updateFindCount();
  els.scroller.focus({ preventScroll: true });
}

$('#find-input').addEventListener('input', (e) => runFind(e.target.value));
$('#find-input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); findStep(e.shiftKey ? -1 : 1); }
  else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeFind(); }
});
$('#find-next').addEventListener('click', () => findStep(1));
$('#find-prev').addEventListener('click', () => findStep(-1));
$('#find-close').addEventListener('click', closeFind);
$('#btn-find').addEventListener('click', (e) => { e.stopPropagation(); findBarOpen() ? closeFind() : openFind(); });
$('#find').addEventListener('click', (e) => e.stopPropagation());

function baseName(p) { return p.split(/[\\/]/).pop() || p; }

/* ---------- tab bar ---------- */
const CLOSE_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M18 6 6 18M6 6l12 12"/></svg>';

function renderTabs() {
  root.setAttribute('data-tabs', tabs.length > 1 ? 'many' : 'one');
  const bar = $('#tabbar');
  bar.innerHTML = '';

  for (const t of tabs) {
    const selected = t.id === state.id;
    const el = document.createElement('div');
    el.className = 'tab';
    el.setAttribute('id', 'tab-' + t.id);
    el.setAttribute('role', 'tab');
    el.setAttribute('aria-selected', String(selected));
    el.setAttribute('aria-controls', 'doc');
    el.tabIndex = selected ? 0 : -1;
    el.dataset.watching = selected && watchTimer ? 'yes' : 'no';
    el.title = t.path || t.name;

    const dot = document.createElement('span');
    dot.className = 'tab-dot';

    const name = document.createElement('span');
    name.className = 'tab-name';
    name.textContent = t.name || 'Untitled';

    const close = document.createElement('button');
    close.className = 'tab-close';
    close.type = 'button';
    close.setAttribute('aria-label', `Close ${t.name}`);
    close.tabIndex = -1;
    close.innerHTML = CLOSE_ICON;
    close.addEventListener('click', (e) => { e.stopPropagation(); closeTab(t.id); });

    el.append(dot, name, close);
    el.addEventListener('click', () => activateTab(t.id));
    el.addEventListener('auxclick', (e) => { if (e.button === 1) { e.preventDefault(); closeTab(t.id); } });
    bar.appendChild(el);
  }

  if (tabs.length) els.doc.setAttribute('aria-labelledby', 'tab-' + state.id);

  const active = bar.querySelector('.tab[aria-selected="true"]');
  active?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
}

function focusSelectedTab() {
  $('#tabbar').querySelector('.tab[aria-selected="true"]')?.focus();
}

$('#tabbar').addEventListener('keydown', (e) => {
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  const i = tabs.findIndex((t) => t.id === state.id);
  if (i === -1) return;
  let next;
  if (e.key === 'ArrowRight') next = (i + 1) % tabs.length;
  else if (e.key === 'ArrowLeft') next = (i - 1 + tabs.length) % tabs.length;
  else if (e.key === 'Home') next = 0;
  else if (e.key === 'End') next = tabs.length - 1;
  else if (e.key === 'Delete' || e.key === 'Backspace') {
    e.preventDefault();
    closeTab(state.id);
    focusSelectedTab();
    return;
  } else return;
  e.preventDefault();
  activateTab(tabs[next].id);
  focusSelectedTab();
});

function stashScroll() {
  if (!state.id) return;
  state.scrollTop = els.scroller.scrollTop;
  state.scrollLeft = els.scroller.scrollLeft;
  state.place = captureAnchor();
}

function activateTab(id) {
  if (id === state.id) return;
  const next = tabs.find((t) => t.id === id);
  if (!next) return;
  stashScroll();
  state = next;
  showActiveTab();
}

function showActiveTab() {
  startWatch();
  render(state.text);
  els.empty.classList.add('gone');
  els.scroller.classList.add('instant');
  els.scroller.scrollTop = state.scrollTop;
  els.scroller.scrollLeft = state.scrollLeft;
  restoreAnchor(state.place);
  els.scroller.classList.add('instant');
  const current = captureRenderGuard();
  requestAnimationFrame(() => { if (current()) els.scroller.classList.remove('instant'); });
  updateTitle();
  renderTabs();
  syncOutlineActive();
  persistTabs();
  if (findBarOpen()) runFind($('#find-input').value, false);
}

function closeTab(id) {
  const i = tabs.findIndex((t) => t.id === id);
  if (i === -1) return;
  const wasActive = tabs[i].id === state.id;
  const [closed] = tabs.splice(i, 1);
  if (closed.path) rememberClosed([closed.path]);

  if (!tabs.length) {
    stopWatch();
    renderRevision++;
    clearFind();
    updateFindCount();
    state = makeTab({});
    els.doc.innerHTML = '';
    els.empty.classList.remove('gone');
    els.outlineList.innerHTML = '';
    $('#docmeta').textContent = '';
    updateTitle();
    renderTabs();
    persistTabs();
    measure();
    els.scroller.scrollTop = 0;
    els.scroller.scrollLeft = 0;
    els.scroller.classList.remove('instant');
    if (IS_TAURI) destroyWindow();
    return;
  }
  if (wasActive) {
    state = tabs[Math.min(i, tabs.length - 1)];
    showActiveTab();
  } else {
    renderTabs();
    persistTabs();
  }
}

function stepTab(dir) {
  if (tabs.length < 2) return;
  const i = tabs.findIndex((t) => t.id === state.id);
  activateTab(tabs[(i + dir + tabs.length) % tabs.length].id);
}

function closeWindow() {
  if (IS_TAURI) {
    const paths = tabs.map((t) => t.path).filter(Boolean);
    if (paths.length) rememberClosed(paths);
    destroyWindow();
    return;
  }
  while (tabs.length) closeTab(tabs[tabs.length - 1].id);
}

function closeRequested() {
  if (cfg.closeScope === 'window') { closeWindow(); return; }
  if (state.id) closeTab(state.id);
}

let isMainWindow = true;
let windowLabel = 'main';

/* ---------- session and recently closed ---------- */
const CLOSED_MAX = 25;

function readSession() {
  const s = store.get('session', {});
  return s && typeof s === 'object' && !Array.isArray(s) ? s : {};
}

function persistTabs() {
  if (!IS_TAURI) return;
  const session = readSession();
  const paths = tabs.map((t) => t.path).filter(Boolean);
  if (paths.length) session[windowLabel] = paths;
  else delete session[windowLabel];
  store.set('session', session);
}

function cleanPaths(list) {
  return Array.isArray(list)
    ? list.filter((p) => typeof p === 'string' && p.trim().length > 0)
    : [];
}

function rememberClosed(paths) {
  if (!IS_TAURI) return;
  const stack = store.get('closed', []);
  const next = (Array.isArray(stack) ? stack : []).concat([paths]).slice(-CLOSED_MAX);
  store.set('closed', next);
}

async function reopenClosed() {
  if (!IS_TAURI) return;
  const stack = store.get('closed', []);
  if (!Array.isArray(stack) || !stack.length) { toast('Nothing to reopen'); return; }
  const paths = cleanPaths(stack.pop());
  store.set('closed', stack);
  let opened = 0;
  const failed = [];
  for (const p of paths) {
    try {
      if (await openPath(p, { allowNewWindow: false })) opened++;
    } catch {
      failed.push(p);
    }
  }
  if (failed.length) rememberClosed(failed);
  if (!opened) toast('Could not reopen that file');
}

function destroyWindow() {
  const session = readSession();
  delete session[windowLabel];
  store.set('session', session);
  getCurrentWindow().destroy().catch(() => {});
}

/** Step to the next/previous SVG file sitting in the same folder. */
async function stepFile(dir) {
  if (!IS_TAURI || !state.path) return;
  let siblings;
  try {
    siblings = await invoke('sibling_files', { path: state.path });
  } catch {
    return;
  }
  if (!siblings || siblings.length < 2) { toast('No other files in this folder'); return; }
  const lower = state.path.toLowerCase();
  const i = siblings.findIndex((p) => p.toLowerCase() === lower);
  if (i === -1) return;
  const next = siblings[(i + dir + siblings.length) % siblings.length];
  try {
    await openPath(next);
    toast(`${baseName(next)}  (${((i + dir + siblings.length) % siblings.length) + 1}/${siblings.length})`);
  } catch {
    toast('Could not open that file');
  }
}

/* ---------- appearance & inspection modes ---------- */
const THEMES = ['auto', 'light', 'dark'];
let theme = window.__svgvTheme.read();
function applyTheme(t, announce, save = true) {
  theme = window.__svgvTheme.apply(t);
  if (save) store.set('theme', theme);
  $('#btn-theme').setAttribute('aria-pressed', String(theme !== 'auto'));
  $('#btn-theme').title = 'Theme: ' + theme + ' (t)';
  if (announce) toast('Theme: ' + theme);
}

const BACKDROPS = ['checker', 'light', 'dark', 'auto'];
let bg = store.get('bg', 'checker');
function applyBackdrop(b, announce, save = true) {
  bg = BACKDROPS.includes(b) ? b : 'checker';
  root.setAttribute('data-bg', bg);
  if (save) store.set('bg', bg);
  $('#btn-bg').setAttribute('aria-pressed', String(bg !== 'auto'));
  $('#btn-bg').title = 'Backdrop: ' + bg + ' (b)';
  if (announce) toast('Backdrop: ' + bg);
}

let gridOn = store.get('grid', false);
function applyGrid(on, announce, save = true) {
  gridOn = !!on;
  root.setAttribute('data-grid', gridOn ? 'on' : 'off');
  if (save) store.set('grid', gridOn);
  $('#btn-grid').setAttribute('aria-pressed', String(gridOn));
  if (announce) toast(gridOn ? 'Bounds & grid shown' : 'Bounds & grid hidden');
}

let sourceOn = store.get('source', false);
function applySource(on, announce, save = true) {
  sourceOn = !!on;
  const place = captureAnchor();
  root.setAttribute('data-source', sourceOn ? 'on' : 'off');
  if (save) store.set('source', sourceOn);
  $('#btn-source').setAttribute('aria-pressed', String(sourceOn));
  measure(place);
  if (announce) toast(sourceOn ? 'XML source' : 'Rendered SVG');
}

let outlineOn = store.get('outline', false);
function applyOutline(on, announce, save = true) {
  outlineOn = !!on;
  root.setAttribute('data-outline', outlineOn ? 'on' : 'off');
  if (save) store.set('outline', outlineOn);
  $('#btn-outline').setAttribute('aria-pressed', String(outlineOn));
  syncOutlineActive();
  if (announce) toast(outlineOn ? 'Elements shown' : 'Elements hidden');
}

window.addEventListener('storage', (e) => {
  if (!e || !String(e.key || '').startsWith('svgv.')) return;
  switch (e.key.slice(5)) {
    case 'cfg':
      cfg = Object.assign({}, DEFAULTS, store.get('cfg', {}) || {});
      break;
    case 'theme':
      applyTheme(store.get('theme', 'auto'), false, false);
      break;
    case 'bg':
      applyBackdrop(store.get('bg', 'checker'), false, false);
      break;
    case 'grid':
      applyGrid(store.get('grid', false), false, false);
      break;
    case 'source':
      applySource(store.get('source', false), false, false);
      break;
    case 'outline':
      applyOutline(store.get('outline', false), false, false);
      break;
    default:
      return;
  }
  applyCfg({ remeasure: false, save: false });
});

/* ---------- scroll behaviour ---------- */
let lastScroll = 0;
function syncOutlineActive() {
  if (!outlineOn || !state.heads.length) return;
  let active = state.heads[0];
  for (const h of state.heads) {
    if (h.el.getBoundingClientRect && h.el.getBoundingClientRect().top <= 90) active = h; else break;
  }
  els.outlineList.querySelectorAll('a').forEach((a) => {
    a.classList.toggle('active', a.dataset.id === active.id);
  });
}

els.scroller.addEventListener('scroll', () => {
  const y = els.scroller.scrollTop;
  els.chrome.classList.toggle('scrolled', y > 4);
  if (performance.now() < quietScrollUntil || findBarOpen() || settingsOpen()) {
    lastScroll = y;
    syncOutlineActive();
    return;
  }
  if (y > 90 && y > lastScroll + 6) els.chrome.classList.add('hidden');
  else if (y < lastScroll - 6 || y <= 90) els.chrome.classList.remove('hidden');
  lastScroll = y;
  syncOutlineActive();
}, { passive: true });

window.addEventListener('mousemove', (e) => {
  if (e.clientY < (els.chrome.offsetHeight || 44) + 12) els.chrome.classList.remove('hidden');
});

/* ---------- printing ---------- */
const IS_WINDOWS = /win/i.test(`${navigator.userAgent || ''} ${navigator.platform || ''}`);

async function printDocument() {
  try {
    if (!IS_TAURI) { window.print(); return; }
    if (IS_WINDOWS) { await invoke('print_windows'); return; }
    await getCurrentWebviewWindow().print();
  } catch {
    toast('Could not open the print dialog');
  }
}

const NON_TEXT_INPUT = new Set(['button', 'checkbox', 'color', 'file', 'image', 'radio', 'range', 'reset', 'submit']);

function inTextEntry(target) {
  if (!target) return false;
  if (target.isContentEditable) return true;
  const tag = (target.tagName || '').toLowerCase();
  if (tag === 'textarea') return true;
  if (tag === 'input') return !NON_TEXT_INPUT.has((target.type || '').toLowerCase());
  return tag === 'button' || tag === 'select';
}

/* ---------- keyboard ---------- */
window.addEventListener('keydown', (e) => {
  const mod = e.ctrlKey || e.metaKey;

  if (e.key === 'Escape') {
    e.preventDefault();
    if (findBarOpen()) { closeFind(); return; }
    if (settingsOpen()) { toggleSettings(false); return; }
    els.doc.querySelectorAll('.svg-highlight').forEach((n) => n.classList.remove('svg-highlight'));
    els.scroller.focus({ preventScroll: true });
    return;
  }

  if (inTextEntry(e.target) && !mod && !e.altKey && !/^F\d+$/.test(e.key)) return;

  if (mod && e.key.toLowerCase() === 'w') {
    e.preventDefault();
    e.shiftKey ? closeWindow() : closeRequested();
    return;
  }
  if (mod && e.shiftKey && e.key.toLowerCase() === 't') {
    e.preventDefault();
    reopenClosed();
    return;
  }

  if (mod && (e.key === '=' || e.key === '+')) { e.preventDefault(); zoomStep(1); return; }
  if (mod && (e.key === '-' || e.key === '_')) { e.preventDefault(); zoomStep(-1); return; }
  if (mod && e.key === '0') { e.preventDefault(); zoomAnimated(1); return; }
  if (mod && e.key === '9') { e.preventDefault(); zoomFitWidth(); return; }
  if (mod && e.key.toLowerCase() === 'o') { e.preventDefault(); openViaPicker(); return; }
  if (mod && e.key.toLowerCase() === 'f') { e.preventDefault(); openFind(); return; }
  if (mod && e.key.toLowerCase() === 'p') { e.preventDefault(); printDocument(); return; }
  if (mod && e.key === 'Tab') { e.preventDefault(); stepTab(e.shiftKey ? -1 : 1); return; }
  if (mod && (e.key === 'PageDown' || e.key === 'PageUp')) {
    e.preventDefault();
    stepTab(e.key === 'PageDown' ? 1 : -1);
    return;
  }
  if (mod && /^[1-8]$/.test(e.key)) {
    e.preventDefault();
    const t = tabs[Number(e.key) - 1];
    if (t) activateTab(t.id);
    return;
  }
  if (e.key === 'F3') { e.preventDefault(); findBarOpen() ? findStep(e.shiftKey ? -1 : 1) : openFind(); return; }
  if (e.key === 'F5' || (mod && e.key.toLowerCase() === 'r')) { e.preventDefault(); reloadNow(); return; }
  if (mod) return;

  switch (e.key) {
    case '[': stepFile(-1); break;
    case ']': stepFile(1); break;
    case ',': toggleSettings(); break;
    case '=': case '+': zoomStep(1); break;
    case '-': zoomStep(-1); break;
    case 'o': applyOutline(!outlineOn, true); break;
    case 't': applyTheme(THEMES[(THEMES.indexOf(theme) + 1) % 3], true); break;
    case 'b': applyBackdrop(BACKDROPS[(BACKDROPS.indexOf(bg) + 1) % BACKDROPS.length], true); break;
    case 'g': applyGrid(!gridOn, true); break;
    case 's': applySource(!sourceOn, true); break;
    default: return;
  }
  e.preventDefault();
});

/* ---------- drag and drop ---------- */
let dragDepth = 0;
window.addEventListener('dragenter', (e) => { e.preventDefault(); dragDepth++; els.drop.classList.add('on'); });
window.addEventListener('dragover', (e) => { e.preventDefault(); });
window.addEventListener('dragleave', (e) => { e.preventDefault(); if (--dragDepth <= 0) { dragDepth = 0; els.drop.classList.remove('on'); } });
window.addEventListener('drop', async (e) => {
  e.preventDefault();
  dragDepth = 0;
  els.drop.classList.remove('on');
  const item = e.dataTransfer?.items?.[0];
  if (item && item.getAsFileSystemHandle) {
    try {
      const h = await item.getAsFileSystemHandle();
      if (h && h.kind === 'file') { await openHandle(h); return; }
    } catch {}
  }
  const f = e.dataTransfer?.files?.[0];
  if (f) { stopWatch(); await loadFile(f, null); }
});

let externalOpenListener = Promise.resolve();

if (IS_TAURI) {
  listen('tauri://drag-enter', () => els.drop.classList.add('on'));
  listen('tauri://drag-leave', () => els.drop.classList.remove('on'));
  listen('tauri://drag-drop', (e) => {
    els.drop.classList.remove('on');
    const p = e.payload?.paths?.[0];
    if (p) openPath(p).catch(() => toast('Could not open that file'));
  });
  externalOpenListener = listen('open-file', async (e) => {
    if (!e.payload) return;
    try {
      if (await invoke('claim_external_open', { path: e.payload })) await openPath(e.payload);
    } catch { toast('Could not open that file'); }
  }, { target: { kind: 'WebviewWindow', label: getCurrentWindow().label } });
  externalOpenListener.catch(() => {});
}

window.addEventListener('paste', (e) => {
  const tag = (e.target.tagName || '').toLowerCase();
  if (tag === 'input' || tag === 'textarea' || e.target.isContentEditable) return;
  const text = e.clipboardData?.getData('text/plain');
  if (!text || !text.trim()) return;
  loadPasted(text);
  toast('Rendered from clipboard');
});

/* ---------- buttons ---------- */
$('#btn-open').addEventListener('click', openViaPicker);
$('#btn-zoom-in').addEventListener('click', () => zoomStep(1));
$('#btn-zoom-out').addEventListener('click', () => zoomStep(-1));
els.zoomval.addEventListener('click', () => zoomAnimated(1));
$('#btn-outline').addEventListener('click', () => applyOutline(!outlineOn, false));
$('#btn-theme').addEventListener('click', () => applyTheme(THEMES[(THEMES.indexOf(theme) + 1) % 3], false));
$('#btn-bg').addEventListener('click', () => applyBackdrop(BACKDROPS[(BACKDROPS.indexOf(bg) + 1) % BACKDROPS.length], false));
$('#btn-grid').addEventListener('click', () => applyGrid(!gridOn, false));
$('#btn-source').addEventListener('click', () => applySource(!sourceOn, false));
$('#btn-print').addEventListener('click', printDocument);
$('#btn-settings').addEventListener('click', (e) => { e.stopPropagation(); toggleSettings(); });
$('#btn-fit').addEventListener('click', zoomFitWidth);

const bindRange = (id, key) => {
  $(id).addEventListener('input', (e) => {
    cfg[key] = Number(e.target.value);
    applyCfg({ remeasure: key !== 'zoomSpeed', changed: [key] });
  });
};
bindRange('#cfg-zoomspeed', 'zoomSpeed');
bindRange('#cfg-textsize', 'textSize');
$('#cfg-invert').addEventListener('change', (e) => {
  cfg.invertZoom = e.target.checked;
  applyCfg({ remeasure: false, changed: ['invertZoom'] });
});
$('#cfg-restore').addEventListener('change', (e) => {
  cfg.restoreTabs = e.target.checked;
  applyCfg({ remeasure: false, changed: ['restoreTabs'] });
});
$('#cfg-update-on-start').addEventListener('change', (e) => {
  cfg.updateOnStart = e.target.checked;
  applyCfg({ remeasure: false, changed: ['updateOnStart'] });
});
$('#cfg-openin').addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-val]');
  if (!btn) return;
  cfg.openIn = btn.dataset.val;
  applyCfg({ remeasure: false, changed: ['openIn'] });
});
$('#cfg-closescope').addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-val]');
  if (!btn) return;
  cfg.closeScope = btn.dataset.val;
  applyCfg({ remeasure: false, changed: ['closeScope'] });
});
$('#cfg-check').addEventListener('click', () => checkForUpdate({ manual: true }));
$('#update-go').addEventListener('click', installUpdate);
$('#update-later').addEventListener('click', () => {
  if (pendingUpdate) store.set('updateSkipped', pendingUpdate.version);
  hideUpdateBar();
});
$('#cfg-reset').addEventListener('click', () => {
  cfg = Object.assign({}, DEFAULTS);
  applyCfg({ changed: Object.keys(DEFAULTS) });
  toast('Settings reset');
});
$('#settings').addEventListener('click', (e) => e.stopPropagation());
$('#settings').addEventListener('focusin', () => { settingsHadFocus = true; });
$('#settings').addEventListener('keydown', (e) => {
  if (e.key !== 'Tab' || !settingsOpen()) return;
  const items = settingsFocusables();
  if (!items.length) return;
  const active = document.activeElement;
  const inside = !!(active && active.closest && active.closest('#settings'));
  const first = items[0];
  const last = items[items.length - 1];
  if (e.shiftKey && (active === first || !inside)) { e.preventDefault(); last.focus(); }
  else if (!e.shiftKey && (active === last || !inside)) { e.preventDefault(); first.focus(); }
});
document.addEventListener('click', () => toggleSettings(false));
$('#empty-open').addEventListener('click', openViaPicker);
els.title.addEventListener('click', async () => {
  if (state.pending && !state.handle) { try { await openHandle(state.pending); } catch {} }
});
els.fileInput.addEventListener('change', async () => {
  const f = els.fileInput.files?.[0];
  if (f) { stopWatch(); await loadFile(f, null); }
  els.fileInput.value = '';
});

/* ---------- boot ---------- */
applyCfg({ remeasure: false, save: false });
applyTheme(theme, false);
applyBackdrop(bg, false);
applyGrid(gridOn, false);
applySource(sourceOn, false);
applyOutline(outlineOn, false);
paint();

const boot = (async function boot() {
  renderTabs();

  if (IS_TAURI) {
    try { windowLabel = getCurrentWindow().label; } catch {}
    isMainWindow = windowLabel === 'main';

    const params = new URLSearchParams(location.search);
    const requested = params.get('file');
    if (requested) {
      try {
        const owned = params.get('externalOpen') !== '1' ||
          await invoke('claim_external_open', { path: requested });
        if (owned) await openPath(requested, { allowNewWindow: false });
      } catch { toast('Could not open that file'); }
      els.scroller.focus({ preventScroll: true });
      return;
    }

    let initial = null;
    try { initial = await invoke('initial_file'); } catch {}

    let saved = [];
    if (isMainWindow) {
      const last = readSession();
      const legacy = store.get('openTabs', null);
      if (legacy !== null) last.legacy = legacy;
      try { localStorage.removeItem('svgv.openTabs'); } catch {}
      store.set('session', {});
      const seen = new Set();
      for (const p of Object.values(last).flatMap(cleanPaths)) {
        if (!seen.has(p.toLowerCase())) { seen.add(p.toLowerCase()); saved.push(p); }
      }
      if (!cfg.restoreTabs && saved.length) { rememberClosed(saved); saved = []; }
    }
    for (const p of saved) {
      if (initial && p.toLowerCase() === initial.toLowerCase()) continue;
      try { await openPath(p, { allowNewWindow: false }); } catch { /* moved or deleted */ }
    }
    if (initial) {
      try { await openPath(initial, { allowNewWindow: false }); } catch { toast('Could not open that file'); }
    }
    if (!tabs.length) persistTabs();
    els.scroller.focus({ preventScroll: true });
    return;
  }

  /* browser: restore the last rendered SVG so the page is not blank */
  const lastText = store.get('lastText', null);
  const lastName = store.get('lastName', '');
  if (lastText) {
    const tab = makeTab({ name: lastName || 'Untitled.svg', text: lastText });
    tabs.push(tab);
    state = tab;
    showActiveTab();
  }

  try {
    const h = await idbGet('handle');
    if (!h) return;
    const perm = await h.queryPermission?.({ mode: 'read' });
    if (perm === 'granted') {
      await openHandle(h);
    } else {
      state.pending = h;
      if (!state.name) state.name = h.name;
      updateTitle();
    }
  } catch {}
  els.scroller.focus({ preventScroll: true });
})();

boot.finally(async () => {
  if (!IS_TAURI) return;
  await externalOpenListener;
  await invoke('external_open_ready');
}).catch(() => toast('Could not finish startup'));

if (IS_TAURI) {
  getVersion().then((v) => { $('#cfg-version').textContent = 'v' + v; }).catch(() => {});
  let bootLabel = 'main';
  try { bootLabel = getCurrentWindow().label; } catch {}
  if (bootLabel === 'main' && cfg.updateOnStart) setTimeout(() => { checkForUpdate(); }, 3000);
} else {
  $('#cfg-update').style.display = 'none';
  $('#cfg-update-start-field').style.display = 'none';
  $('#cfg-restore-field').style.display = 'none';
}
