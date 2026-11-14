import test from 'node:test';
import assert from 'node:assert/strict';
import { createHarness, addWatchedTabs, settle, loadCreateDOMPurify } from './helpers/source-harness.mjs';
import { JSDOM } from 'jsdom';

const createDOMPurify = await loadCreateDOMPurify();
// Real DOM for the sanitiser; the app shell around it is still the test double.
const DOMPurify = createDOMPurify(new JSDOM('').window);

function realHarness(options = {}) {
  const h = createHarness({ dompurify: DOMPurify, ...options });
  const { a } = addWatchedTabs(h, options.native !== false);
  h.activate(a);
  return h;
}

const doc = h => h.element('#doc');
const outline = h => h.element('#outline-list');
const ids = h => JSON.parse(JSON.stringify(h.state.heads.map(x => x.id)));
const titles = h => JSON.parse(JSON.stringify(h.state.heads.map(x => x.title)));

function clickAnchor(anchor) {
  const event = { target: anchor, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; } };
  let root = anchor;
  while (root.parentNode) root = root.parentNode;
  root.dispatch('click', event);
  return event;
}

const openedPaths = h => h.calls.filter(c => c.command === 'read_text_file').map(c => c.path);

test('render: SVG elements get ids, outline entries and normalised dimensions from viewBox', () => {
  const h = realHarness();
  h.call('render', '<svg viewBox="0 0 24 24"><g id="layer-1"><path id="icon-path" d="M0 0h24v24z"/><circle cx="12" cy="12" r="5"/></g></svg>');
  assert.deepEqual(ids(h), ['svg', 'layer-1', 'icon-path', 'circle']);
  assert.deepEqual(titles(h), ['svg', 'g#layer-1', 'path#icon-path', 'circle']);
  const svg = doc(h).querySelector('svg');
  assert.equal(svg.getAttribute('width'), '24');
  assert.equal(svg.getAttribute('height'), '24');
  const entries = outline(h).querySelectorAll('a');
  assert.deepEqual(entries.map(a => a.textContent), ['svg', 'g#layer-1', 'path#icon-path', 'circle']);
  assert.match(h.element('#docmeta').textContent, /24 × 24/);
  assert.match(h.element('#docmeta').textContent, /viewBox 0 0 24 24/);
});

test('render: XML preamble and DOCTYPE are stripped before rendering', () => {
  const h = realHarness();
  const raw = '<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" "http://www.w3.org/Graphics/SVG/1.1/DTD/svg11.dtd">\n<svg width="100" height="80"><rect id="box" width="100" height="80"/></svg>';
  h.call('render', raw);
  const svg = doc(h).querySelector('svg');
  assert.ok(svg, 'svg root is rendered');
  assert.equal(svg.getAttribute('width'), '100');
  assert.equal(svg.getAttribute('height'), '80');
  assert.deepEqual(titles(h), ['svg', 'rect#box']);
});

test('render: a DOCTYPE with an internal subset is stripped whole', () => {
  const h = realHarness();
  const out = h.call('stripXmlPreamble', '<?xml version="1.0"?>\n<!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" "x.dtd" [\n<!ENTITY ns_svg "http://www.w3.org/2000/svg">\n]>\n<svg/>');
  assert.equal(out, '<svg/>');
});

test('render: XML source block gets a copy button and preserves raw source', () => {
  const h = realHarness();
  const raw = '<svg viewBox="0 0 16 16"><path d="M1 1 L15 15"/></svg>';
  h.call('render', raw);
  const pre = doc(h).querySelector('pre.svg-source');
  assert.ok(pre, 'source block is built');
  const button = pre.querySelector('button.copy');
  assert.ok(button, 'source block gets a copy button');
  assert.equal(button.getAttribute('title'), 'Copy SVG code');
  assert.equal(pre.querySelector('code').textContent, raw);
});

test('render: the link router classifies every shape an SVG link can produce', () => {
  const h = realHarness({ invoke: async () => null });
  h.call('render', [
    '<svg viewBox="0 0 100 100">',
    '  <a href="#target-group"><text>in page</text></a>',
    '  <a href="https://example.com/x"><text>external</text></a>',
    '  <a href="mailto:someone@example.com"><text>mail</text></a>',
    '  <a href="tel:+61400000000"><text>call</text></a>',
    '  <a href="icons/next.svg"><text>relative</text></a>',
    '  <a href="index.html?file=C:%5CWindows%5Cwin.ini"><text>the app</text></a>',
    '  <a href="javascript:alert(1)"><text>raw script</text></a>',
    '  <g id="target-group"><circle cx="10" cy="10" r="5"/></g>',
    '</svg>',
  ].join('\n'));

  const anchors = doc(h).querySelectorAll('a[href]');
  const byText = new Map(anchors.map(a => [a.textContent, a]));
  assert.deepEqual([...byText.keys()], ['in page', 'external', 'mail', 'call', 'relative', 'the app']);

  assert.equal(clickAnchor(byText.get('in page')).defaultPrevented, true);
  assert.deepEqual(openedPaths(h), [], 'an in-page anchor opens nothing');

  assert.equal(clickAnchor(byText.get('the app')).defaultPrevented, true);
  assert.equal(h.notices.at(-1), 'Blocked: that link points back at the app');
  assert.deepEqual(openedPaths(h), []);

  assert.equal(clickAnchor(byText.get('relative')).defaultPrevented, true);
  assert.deepEqual(openedPaths(h), ['icons/next.svg']);

  h.context.openUrl = async () => {};
  for (const text of ['external', 'mail', 'call']) {
    assert.equal(clickAnchor(byText.get(text)).defaultPrevented, true, `${text} is intercepted`);
  }
  assert.equal(doc(h).querySelectorAll('a[href]').filter(a => a.getAttribute('href').startsWith('javascript')).length, 0);
});

test('render: hostile SVG is stripped by the sanitiser on the way in', () => {
  const h = realHarness();
  h.call('render', '<svg viewBox="0 0 10 10" onload="alert(1)"><script>alert(1)</script><circle cx="5" cy="5" r="4" onclick="alert(1)"/></svg>');
  const stage = doc(h).querySelector('.svg-stage');
  assert.doesNotMatch(stage.innerHTML, /<script/i);
  assert.doesNotMatch(stage.innerHTML, /onload/i);
  assert.doesNotMatch(stage.innerHTML, /onclick/i);
  assert.ok(stage.querySelector('circle'), 'safe vector shape survives');
});

test('render: an empty document clears the outline without throwing', async () => {
  const h = realHarness();
  h.call('render', '');
  assert.deepEqual(ids(h), []);
  assert.match(outline(h).textContent, /No SVG elements/);
  await settle();
});

test('find: scrolling down to a match keeps #chrome visible', () => {
  const h = realHarness();
  h.call('render', '<svg viewBox="0 0 20 20"><path id="bottom-shape" d="M0 0h10"/></svg>');
  h.element('#find-input').value = 'bottom-shape';
  h.call('openFind');
  const scroller = h.element('#scroller');
  scroller.scrollTop = 250;
  scroller.dispatch('scroll', {});
  assert.equal(h.element('#chrome').classList.contains('hidden'), false,
    'toolbar must stay visible while the Find bar is open below it');
});

test('render: local images resolve only inside the document folder', () => {
  const h = realHarness();
  h.run("state.docDir = 'C:/docs/art'");
  h.call('render', [
    '<svg viewBox="0 0 10 10">',
    '<image id="inside" href="img/a.png" width="1" height="1"/>',
    '<image id="up" href="../secret.png" width="1" height="1"/>',
    '<image id="sneaky" href="img/../../secret.png" width="1" height="1"/>',
    '<image id="abs-out" href="C:/Users/x.png" width="1" height="1"/>',
    '</svg>',
  ].join(''));
  const href = id => doc(h).querySelector('#' + id).getAttribute('href');
  assert.equal(href('inside'), 'mock-asset:C:/docs/art/img/a.png');
  assert.equal(href('up'), null);
  assert.equal(href('sneaky'), null);
  assert.equal(href('abs-out'), null);
});
