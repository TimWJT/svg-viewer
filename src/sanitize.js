/* SVG sanitiser config, shared by the app (src/main.js) and the tests so the
   two can never drift apart.

   - SVG + SVG filter profiles only: no HTML profile, so no embedded HTML.
   - foreignObject is forbidden: it is the door back into HTML.
   - Non-link elements may only reference same-document fragments (#id).
     <image>/<feImage> may also use a data: image or a local relative/absolute
     path (rewritten to the asset protocol by resolveImages in the desktop app).
     Remote http(s), protocol-relative, file:, asset: and any other scheme are
     dropped, so opening an SVG never makes a network request or reaches the
     asset handler with a path the app did not build itself.
   - CSS: @import is removed and url() that is not #fragment or data: becomes
     none. This is best effort; the CSP (Tauri config, and the meta tag in the
     standalone build) is the real backstop for CSS loads.
   - <a href> is left to DOMPurify's own URI check and the app's click router. */

export const SVG_PURIFY = {
  USE_PROFILES: { svg: true, svgFilters: true },
  ADD_TAGS: ['use', 'symbol', 'defs', 'clipPath', 'mask', 'pattern', 'marker', 'linearGradient', 'radialGradient', 'stop', 'textPath', 'tspan', 'title', 'desc', 'switch'],
  ADD_ATTR: ['target', 'id', 'viewBox', 'preserveAspectRatio', 'xmlns', 'xmlns:xlink', 'xlink:href', 'href'],
  FORBID_TAGS: ['script', 'foreignObject', 'iframe', 'object', 'embed', 'form', 'set', 'animate'],
};

const URL_ATTRS = new Set(['href', 'xlink:href', 'src']);
const IMAGE_TAGS = new Set(['image', 'feimage']);
const SCHEME = /^[a-z][a-z0-9+.-]*:/i;
const DRIVE = /^[a-z]:[\\/]/i;
const DATA_IMAGE = /^data:image\/(?:png|jpe?g|gif|webp|avif|bmp|svg\+xml)[;,]/i;

function squash(value) {
  // Browsers ignore ASCII whitespace and control characters inside URLs.
  return String(value || '').replace(/[\u0000- \u007f]/g, '');
}

/** True if an SVG element (not <a>) may keep this href/src value. */
export function allowedRef(tag, value) {
  const v = squash(value);
  if (v.startsWith('#')) return true;
  if (!IMAGE_TAGS.has(tag)) return false;
  if (DATA_IMAGE.test(v)) return true;
  if (/^[\\/]{2}/.test(v)) return false;
  return DRIVE.test(v) || !SCHEME.test(v);
}

const CSS_URL = /url\(\s*(['"]?)([^)]*?)\1\s*\)/gi;

export function cleanCss(css) {
  return String(css)
    .replace(/@import\b[^;]*;?/gi, '')
    .replace(CSS_URL, (whole, _q, inner) => {
      const v = squash(inner);
      return v.startsWith('#') || /^data:/i.test(v) ? whole : 'none';
    });
}

const hooked = new WeakSet();

function install(purify) {
  if (hooked.has(purify)) return;
  hooked.add(purify);
  purify.addHook('uponSanitizeElement', (node, data) => {
    if (data.tagName === 'style' && node.textContent) {
      node.textContent = cleanCss(node.textContent);
    }
  });
  purify.addHook('uponSanitizeAttribute', (node, data) => {
    const tag = String(node.nodeName || '').toLowerCase();
    const name = String(data.attrName || '').toLowerCase();
    if (URL_ATTRS.has(name) && tag !== 'a' && !allowedRef(tag, data.attrValue)) {
      data.keepAttr = false;
      return;
    }
    if (/url\s*\(|@import/i.test(data.attrValue || '')) {
      data.attrValue = cleanCss(data.attrValue);
    }
  });
}

export function sanitizeSvg(purify, text) {
  install(purify);
  return purify.sanitize(text, SVG_PURIFY);
}
