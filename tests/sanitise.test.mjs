import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { loadCreateDOMPurify } from './helpers/source-harness.mjs';
import { createDomWindow } from './helpers/mini-dom.mjs';

const createDOMPurify = await loadCreateDOMPurify();
const DOMPurify = createDOMPurify(createDomWindow());

const SVG_PURIFY = {
  USE_PROFILES: { svg: true, svgFilters: true, html: true },
  ADD_TAGS: ['use', 'symbol', 'defs', 'clipPath', 'mask', 'pattern', 'marker', 'linearGradient', 'radialGradient', 'stop', 'textPath', 'tspan', 'title', 'desc', 'switch'],
  ADD_ATTR: ['target', 'id', 'viewBox', 'preserveAspectRatio', 'xmlns', 'xmlns:xlink', 'xlink:href', 'href'],
  FORBID_TAGS: ['script', 'iframe', 'object', 'embed', 'form'],
};

const render = text => DOMPurify.sanitize(text, SVG_PURIFY);

test('sanitiser: the harness can actually run the real DOMPurify', () => {
  assert.equal(DOMPurify.isSupported, true);
  assert.match(DOMPurify.version, /^3\./);
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

test('sanitiser: ordinary SVG shapes, gradients, defs and viewBox DO survive', () => {
  const sample = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><defs><linearGradient id="g"><stop offset="0%" stop-color="#fff"/></linearGradient></defs><g id="layer"><path d="M10 10 H 90 V 90 H 10 Z" fill="url(#g)"/><circle cx="50" cy="50" r="20"/></g></svg>';
  const html = render(sample);
  assert.match(html, /viewBox="0 0 100 100"/);
  assert.match(html, /<lineargradient id="g">/i);
  assert.match(html, /<path d="M10 10 H 90 V 90 H 10 Z"/i);
  assert.match(html, /<circle cx="50" cy="50" r="20">/i);
});

test('sanitiser: src/main.js actually pipes SVG input through DOMPurify', () => {
  const source = readFileSync(new URL('../src/main.js', import.meta.url), 'utf8');
  const fn = source.slice(source.indexOf('function render(text)'));
  assert.match(fn, /DOMPurify\.sanitize\(\s*cleanSource\s*,\s*SVG_PURIFY\s*\)/);
});
