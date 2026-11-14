import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { loadCreateDOMPurify } from './helpers/source-harness.mjs';
import { sanitizeSvg, SVG_PURIFY, cleanCss } from '../src/sanitize.js';

// The real DOMPurify on a spec-compliant DOM (jsdom), using the exact config
// module the app imports. Not a browser, but no hand-rolled parser either.
const createDOMPurify = await loadCreateDOMPurify();
const { window } = new JSDOM('');
const DOMPurify = createDOMPurify(window);

const render = text => sanitizeSvg(DOMPurify, text);
const parse = text => {
  const div = window.document.createElement('div');
  div.innerHTML = render(text);
  return div;
};

test('sanitiser: the harness can actually run the real DOMPurify', () => {
  assert.equal(DOMPurify.isSupported, true);
  assert.match(DOMPurify.version, /^3\./);
});

test('sanitiser: SVG profiles only, no HTML profile', () => {
  assert.deepEqual(SVG_PURIFY.USE_PROFILES, { svg: true, svgFilters: true });
  for (const tag of ['script', 'foreignObject']) assert.ok(SVG_PURIFY.FORBID_TAGS.includes(tag), tag);
});

test('sanitiser: a <script> tag inside an SVG does not survive', () => {
  const hostile = [
    '<svg><script>alert(1)</script></svg>',
    '<svg><SCRIPT>alert(1)</SCRIPT></svg>',
    '<svg><g><script href="https://evil.example/x.js"/></g></svg>',
  ];
  for (const svg of hostile) {
    const html = render(svg);
    assert.doesNotMatch(html, /<script/i, `script survived: ${svg}`);
    assert.doesNotMatch(html, /alert\(1\)/, `script body survived: ${svg}`);
  }
});

test('sanitiser: onload=, onclick= and onerror= event handlers on SVG elements do not survive', () => {
  const hostile = [
    '<svg onload="alert(1)"><rect width="10" height="10"/></svg>',
    '<svg><path d="M0 0" onclick="alert(1)"/></svg>',
    '<svg><image href="x.png" onerror="alert(1)"/></svg>',
    '<svg><circle onmouseover="steal()"/></svg>',
  ];
  for (const svg of hostile) {
    const html = render(svg);
    assert.doesNotMatch(html, /\son[a-z]+\s*=/i, `event handler survived: ${svg} -> ${html}`);
  }
});

test('sanitiser: javascript: hrefs on SVG <a> elements are stripped', () => {
  for (const href of [
    'javascript:alert(1)',
    'JaVaScRiPt:alert(1)',
    ' javascript:alert(1)',
    '&#106;avascript:alert(1)',
  ]) {
    const html = render(`<svg><a href="${href}"><text>click</text></a></svg>`);
    assert.doesNotMatch(html, /javascript/i, `javascript: survived for ${href}: ${html}`);
  }
});

test('sanitiser: foreignObject and embedded HTML are removed', () => {
  const html = render('<svg xmlns="http://www.w3.org/2000/svg"><foreignObject width="200" height="40"><a xmlns="http://www.w3.org/1999/xhtml" href="https://example.com">x</a><iframe src="https://example.com"></iframe></foreignObject><rect width="1" height="1"/></svg>');
  assert.doesNotMatch(html, /foreignobject/i);
  assert.doesNotMatch(html, /iframe|example\.com/i);
  assert.match(html, /<rect/);
});

test('sanitiser: SMIL href animation cannot inject a javascript: link', () => {
  for (const svg of [
    '<svg><a><set attributeName="href" to="javascript:alert(1)"/><text>x</text></a></svg>',
    '<svg><a><animate attributeName="href" values="javascript:alert(1)"/><text>x</text></a></svg>',
  ]) {
    assert.doesNotMatch(render(svg), /javascript|<set|<animate\b/i, svg);
  }
});

test('sanitiser: remote and non-fragment references on non-link elements are dropped', () => {
  const div = parse([
    '<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink">',
    '<image id="remote" href="https://example.com/x.png" width="1" height="1"/>',
    '<image id="remote-x" xlink:href="http://example.com/x.png" width="1" height="1"/>',
    '<image id="proto" href="//example.com/x.png" width="1" height="1"/>',
    '<image id="unc" href="\\\\server\\share\\x.png" width="1" height="1"/>',
    '<image id="file" href="file:///C:/Users/x.png" width="1" height="1"/>',
    '<image id="asset" href="http://asset.localhost/C%3A%5Cx.png" width="1" height="1"/>',
    '<image id="local" href="img/pic.png" width="1" height="1"/>',
    '<image id="data" href="data:image/png;base64,AAAA" width="1" height="1"/>',
    '<image id="datahtml" href="data:text/html,hi" width="1" height="1"/>',
    '<use id="use-remote" href="https://example.com/x.svg#a"/>',
    '<use id="use-file" href="other.svg#a"/>',
    '<use id="use-local" href="#shape"/>',
    '<rect id="shape" width="1" height="1"/>',
    '</svg>',
  ].join(''));
  const href = id => {
    const el = div.querySelector('#' + id);
    assert.ok(el, `${id} element survives`);
    return el.getAttribute('href') ?? el.getAttribute('xlink:href');
  };
  for (const id of ['remote', 'remote-x', 'proto', 'unc', 'file', 'asset', 'datahtml', 'use-remote', 'use-file']) {
    assert.equal(href(id), null, `${id} reference should be dropped`);
  }
  assert.equal(href('local'), 'img/pic.png');
  assert.equal(href('data'), 'data:image/png;base64,AAAA');
  assert.equal(href('use-local'), '#shape');
});

test('sanitiser: CSS @import and remote url() are neutralised, fragment url() kept', () => {
  const html = render('<svg><style>@import url(https://example.com/a.css); .a{fill:url(#g)} .b{background:url("https://example.com/t.png")}</style><rect class="a" style="fill:url(https://example.com/p.svg#x)" filter="url(#f)"/></svg>');
  assert.doesNotMatch(html, /example\.com|@import/i);
  assert.match(html, /url\(#g\)/);
  assert.match(html, /filter="url\(#f\)"/);
  assert.equal(cleanCss('fill:url( "#a" )'), 'fill:url( "#a" )');
  assert.equal(cleanCss('x:url(data:image/png;base64,AA)'), 'x:url(data:image/png;base64,AA)');
});

test('sanitiser: ordinary SVG shapes, gradients, defs, styles and viewBox DO survive', () => {
  const sample = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><style>.c{fill:red}</style><defs><linearGradient id="g"><stop offset="0%" stop-color="#fff"/></linearGradient></defs><g id="layer"><path d="M10 10 H 90 V 90 H 10 Z" fill="url(#g)"/><circle class="c" cx="50" cy="50" r="20"/></g></svg>';
  const html = render(sample);
  assert.match(html, /viewBox="0 0 100 100"/);
  assert.match(html, /<lineargradient id="g">/i);
  assert.match(html, /<path d="M10 10 H 90 V 90 H 10 Z" fill="url\(#g\)"/i);
  assert.match(html, /<circle class="c" cx="50" cy="50" r="20">/i);
  assert.match(html, /<style>\.c\{fill:red\}<\/style>/);
});

test('sanitiser: src/main.js actually pipes SVG input through the shared sanitiser', () => {
  const source = readFileSync(new URL('../src/main.js', import.meta.url), 'utf8');
  assert.match(source, /import \{ sanitizeSvg \} from '\.\/sanitize\.js';/);
  const fn = source.slice(source.indexOf('function render(text)'));
  assert.match(fn, /sanitizeSvg\(\s*DOMPurify\s*,\s*cleanSource\s*\)/);
});
