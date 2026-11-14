import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { DomElement, DomNode, NODE_TYPE } from './mini-dom.mjs';
import { sanitizeSvg } from '../../src/sanitize.js';

const sourcePath = new URL('../../src/main.js', import.meta.url);

export async function loadCreateDOMPurify() {
  const mod = await import('dompurify');
  return mod.default || mod;
}

export function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

export async function settle() {
  for (let i = 0; i < 20; i++) await Promise.resolve();
}

class FakeNode extends DomElement {
  constructor(tagName = '', text = '') {
    if (tagName === '#text') return new DomTextNode(null, text);
    if (tagName === '#fragment') return new DomNode(null, NODE_TYPE.fragment, '#document-fragment');
    super(null, tagName, text);
  }
  dispatch(name, event) { for (const fn of this.listeners.get(name) || []) fn(event); }
}

class DomTextNode extends DomNode {
  constructor(ownerDocument, text) {
    super(ownerDocument, NODE_TYPE.text, '#text');
    this.nodeValue = text;
  }
}

export function createHarness({ native = true, saved = {}, rawSaved = {}, label = 'main', search = '', invoke, checkUpdate, listen, allowNewWindows = false, dompurify } = {}) {
  const nodes = new Map();
  const document = new FakeNode('document');
  const element = selector => {
    if (selector === '#tabbar .tab[aria-selected="true"]') return element('#tabbar').querySelector('.tab[aria-selected="true"]');
    if (!nodes.has(selector)) {
      const node = new FakeNode(selector.includes('input') ? 'input' : 'div');
      node.ownerDocument = document;
      nodes.set(selector, node);
    }
    return nodes.get(selector);
  };
  document.documentElement = new FakeNode('html');
  document.head = new FakeNode('head');
  document.body = new FakeNode('body');
  document.querySelector = element;
  document.querySelectorAll = selector => [element(selector)];
  document.createElement = tag => { const node = new FakeNode(tag); node.ownerDocument = document; return node; };
  document.createTextNode = text => { const node = new FakeNode('#text', text); node.ownerDocument = document; return node; };
  document.createDocumentFragment = () => new FakeNode('#fragment');
  document.createTreeWalker = (root, _kind, filter) => {
    const accepted = [];
    const walk = node => {
      if (node.nodeType === 3 && (!filter || filter.acceptNode(node) === 1)) accepted.push(node);
      node.children.forEach(walk);
    };
    walk(root);
    let i = 0;
    return { nextNode: () => accepted[i++] || null };
  };
  const window = new FakeNode('window');
  if (native) window.__TAURI_INTERNALS__ = {};
  const storage = new Map(Object.entries(saved).map(([key, value]) => ['svgv.' + key, JSON.stringify(value)]));
  for (const [key, value] of Object.entries(rawSaved)) storage.set('svgv.' + key, value);
  const writes = [];
  const localStorage = {
    getItem: key => storage.get(key) ?? null,
    setItem(key, value) { writes.push([key, value]); storage.set(key, value); },
    removeItem: key => storage.delete(key),
  };
  const timers = new Map(), frames = new Map();
  let timerSeq = 0, frameSeq = 0;
  const calls = [], notices = [], listeners = [], newWindows = [];
  const toastNode = element('#toast');
  Object.defineProperty(toastNode, 'textContent', {
    get: () => notices.at(-1) || '',
    set: value => notices.push(String(value)),
  });
  const nativeWindow = {
    label, closeCalls: 0, focusCalls: 0,
    destroyCalls: 0,
    async close() { this.closeCalls++; },
    async destroy() { this.destroyCalls++; },
    async setFocus() { this.focusCalls++; },
    async setTitle() {},
    async onCloseRequested(handler) { this.closeRequestedHandler = handler; return () => {}; },
  };
  const context = vm.createContext({
    console, document, window, localStorage, location: { search }, URLSearchParams, TextEncoder,
    NodeFilter: { SHOW_TEXT: 4, FILTER_ACCEPT: 1, FILTER_REJECT: 2 },
    Node: { TEXT_NODE: 3 },
    CSS: { escape: value => value },
    navigator: { clipboard: { writeText: async () => {} } },
    matchMedia: () => ({ matches: false, addEventListener() {} }),
    performance: { now: () => 0 },
    ResizeObserver: class { observe() {} },
    setTimeout: (fn, ms) => { const id = ++timerSeq; timers.set(id, { fn, ms, kind: 'timeout' }); return id; },
    clearTimeout: id => timers.delete(id),
    setInterval: (fn, ms) => { const id = ++timerSeq; timers.set(id, { fn, ms, kind: 'interval' }); return id; },
    clearInterval: id => timers.delete(id),
    requestAnimationFrame: fn => { const id = ++frameSeq; frames.set(id, fn); return id; },
    cancelAnimationFrame: id => frames.delete(id),
    DOMPurify: dompurify || { sanitize: html => html },
    sanitizeSvg: dompurify ? sanitizeSvg : (_purify, html) => html,
    getAllWebviewWindows: async () => [],
    hljs: { highlightElement() {}, registerLanguage() {} },
    xmlLang: {},
    cssLang: {},
    invoke: async (command, args) => {
      calls.push({ command, ...args });
      if (invoke) return invoke(command, args);
      if (command === 'external_open_ready') return;
      if (command === 'claim_external_open') return true;
      if (command === 'initial_file') return null;
      if (command === 'file_mtime') return 1;
      if (command === 'read_text_file') return '<svg>' + args.path + '</svg>';
      throw new Error('Unexpected mocked IPC: ' + command);
    },
    convertFileSrc: path => 'mock-asset:' + path,
    listen: async (name, callback, options) => {
      listeners.push({ name, callback, options });
      if (listen) return listen(name, callback, options);
      return () => {};
    },
    getCurrentWindow: () => nativeWindow,
    WebviewWindow: class {
      constructor(label, options) {
        if (!allowNewWindows) throw new Error('Unexpected new-window request');
        newWindows.push({ label, options });
      }
      once(name, callback) { if (name === 'tauri://created') callback(); return Promise.resolve(() => {}); }
    },
    openDialog: async () => null,
    checkUpdate: checkUpdate || (async () => { throw new Error('Unexpected updater check'); }),
    relaunch: async () => { throw new Error('Unexpected relaunch'); },
    getVersion: async () => 'test-version',
    openUrl: async () => { throw new Error('Unexpected external URL'); },
    indexedDB: { open() { throw new Error('IndexedDB disabled in fixtures'); } },
  });
  let source = readFileSync(sourcePath, 'utf8').replace(/^import\s+[^;]+;\s*$/gm, '');
  const bootStart = source.indexOf('const boot = (async function boot() {');
  if (bootStart < 0) throw new Error('Harness boot boundary missing; update source adapter');
  const bootEnd = source.indexOf('})();', bootStart);
  if (bootEnd < 0) throw new Error('Harness boot end missing');
  source = source.slice(0, bootStart) + 'globalThis.__boot = async function boot() {' +
    source.slice(bootStart + 'const boot = (async function boot() {'.length, bootEnd) +
    '}; const boot = new Promise((resolve, reject) => { globalThis.__startBoot = () => { const result = __boot(); result.then(resolve, reject); return result; }; });' +
    source.slice(bootEnd + '})();'.length);
  vm.runInContext(readFileSync(new URL('../../src/startup.js', import.meta.url), 'utf8'), context);
  vm.runInContext(source, context, { filename: sourcePath.pathname });
  const run = code => vm.runInContext(code, context);
  return {
    run, context, element, document, window, storage, writes, calls, notices, timers, nativeWindow, listeners, newWindows,
    async emit(name, payload) {
      await Promise.all(listeners.filter(l => l.name === name).map(l => l.callback({ payload })));
    },
    get tabs() { return run('tabs'); },
    get state() { return run('state'); },
    boot: () => context.__startBoot(),
    call(name, ...args) { return run(name)(...args); },
    addTab(init) {
      context.__tabInit = init;
      return run('(() => { const tab = makeTab(__tabInit); tabs.push(tab); return tab; })()');
    },
    activate(tab) { run('activateTab')(tab.id); },
    listenerOptions(type) {
      return (window.listeners.get(type) || []).map(fn => window.listenerOptions.get(fn) ?? null);
    },
    flushFrames() {
      const pending = [...frames.values()]; frames.clear();
      pending.forEach(fn => fn(0));
    },
    key({ target = element('#find-input'), ...options } = {}) {
      const event = { target, key: 'w', ctrlKey: true, metaKey: false, shiftKey: false, defaultPrevented: false,
        preventDefault() { this.defaultPrevented = true; }, stopPropagation() {}, ...options };
      window.dispatch('keydown', event);
      return event;
    },
  };
}

export function addWatchedTabs(h, native = true) {
  const a = h.addTab({ name: 'A.svg', text: 'A original', lastModified: 1, ...(native ? { path: 'C:/fixture/A.svg' } : { handle: { getFile: async () => ({ lastModified: 1, text: async () => 'A original' }) } }) });
  const b = h.addTab({ name: 'B.svg', text: 'B original', lastModified: 1, ...(native ? { path: 'C:/fixture/B.svg' } : { handle: { getFile: async () => ({ lastModified: 1, text: async () => 'B original' }) } }) });
  h.activate(a);
  return { a, b };
}
