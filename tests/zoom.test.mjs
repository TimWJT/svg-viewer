import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { createHarness } from './helpers/source-harness.mjs';

const MIN = 0.1, MAX = 32;

const scaleOf = h => vm.runInContext('scale', h.context);

function pinch(h, { deltaY = -20, ctrlKey = true, clientX = 400, clientY = 300 } = {}) {
  const event = {
    type: 'wheel', deltaY, deltaMode: 0,
    ctrlKey, metaKey: false, shiftKey: false,
    clientX, clientY,
    defaultPrevented: false,
    preventDefault() { this.defaultPrevented = true; },
    stopPropagation() {},
  };
  h.window.dispatch('wheel', event);
  settle(h);
  return event;
}

function settle(h) {
  for (let i = 0; i < 500 && h.run('zoomEaseRaf'); i++) h.flushFrames();
}

function flushTimers(h) {
  for (const timer of [...h.timers.values()]) if (timer.kind === 'timeout') timer.fn();
}

test('a trackpad pinch reaches the page as ctrl+wheel and zooms the SVG', () => {
  const h = createHarness();
  const before = scaleOf(h);
  const event = pinch(h, { deltaY: -30 });
  assert.ok(scaleOf(h) > before, 'pinch out should increase the scale');
  assert.equal(event.defaultPrevented, true, 'the event must be claimed or WebView2 double-zooms');
});

test('wheel zoom eases over frames instead of jumping per event', () => {
  const h = createHarness();
  const before = scaleOf(h);
  const event = {
    type: 'wheel', deltaY: -40, deltaMode: 0, ctrlKey: true, metaKey: false, shiftKey: false,
    clientX: 400, clientY: 300, defaultPrevented: false,
    preventDefault() { this.defaultPrevented = true; }, stopPropagation() {},
  };
  h.window.dispatch('wheel', event);
  assert.equal(scaleOf(h), before);
  h.flushFrames();
  const partway = scaleOf(h);
  settle(h);
  const target = scaleOf(h);
  assert.ok(partway > before && partway < target);
  assert.equal(h.run('zoomEaseRaf'), 0);
});

test('the wheel listener is registered passive:false and in the capture phase', () => {
  const h = createHarness();
  const wheel = h.listenerOptions('wheel');
  assert.ok(wheel.length);
  for (const options of wheel) {
    assert.equal(options?.passive, false);
    assert.equal(options?.capture, true);
  }
});

test('zoom is clamped to the documented SVG range (10% to 3200%) in both directions', () => {
  const h = createHarness();
  for (let i = 0; i < 200; i++) pinch(h, { deltaY: -400 });
  assert.ok(Math.abs(scaleOf(h) - MAX) < 1e-9, `clamped to ${MAX}, got ${scaleOf(h)}`);

  for (let i = 0; i < 400; i++) pinch(h, { deltaY: 400 });
  assert.ok(Math.abs(scaleOf(h) - MIN) < 1e-9, `clamped to ${MIN}, got ${scaleOf(h)}`);
});

test('a burst of pinch events persists zoom once, not once per event', () => {
  const h = createHarness();
  const zoomWrites = () => h.writes.filter(([key]) => key === 'svgv.zoom');
  for (let i = 0; i < 25; i++) pinch(h, { deltaY: -10 });
  assert.equal(zoomWrites().length, 0);
  flushTimers(h);
  assert.equal(zoomWrites().length, 1);
});

test('every Windows webview is created with WebView2 pinch enabled', () => {
  const rust = readFileSync(new URL('../src-tauri/src/main.rs', import.meta.url), 'utf8')
    .replace(/^\s*\/\/.*$/gm, '');
  const conf = JSON.parse(readFileSync(new URL('../src-tauri/tauri.conf.json', import.meta.url), 'utf8'));
  const js = readFileSync(new URL('../src/main.js', import.meta.url), 'utf8');

  assert.match(rust, /const PAGE_RECEIVES_PINCH: bool = cfg!\(target_os = "windows"\);/);
  const main = conf.app.windows.find(w => w.label === 'main');
  assert.equal(main.create, false);

  const builders = rust.match(/WebviewWindowBuilder::(new|from_config)\(/g) || [];
  const enabled = rust.match(/\.zoom_hotkeys_enabled\(PAGE_RECEIVES_PINCH\)/g) || [];
  assert.ok(builders.length >= 2);
  assert.equal(enabled.length, builders.length);
  assert.match(js, /new WebviewWindow\([^;]*zoomHotkeysEnabled: IS_WINDOWS/s);
});
