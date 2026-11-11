/* Runs synchronously in <head>, before the stylesheet and application bundle.
   Also bundled as a fallback: both startup and the theme button use this logic. */
(() => {
  if (window.__svgvTheme) return;
  function read() {
    try { return JSON.parse(localStorage.getItem('svgv.theme')); }
    catch { return 'auto'; }
  }
  function apply(value) {
    const theme = value === 'light' || value === 'dark' ? value : 'auto';
    const root = document.documentElement;
    if (theme === 'auto') root.removeAttribute('data-theme');
    else root.setAttribute('data-theme', theme);
    return theme;
  }
  window.__svgvTheme = { read, apply };
  apply(read());
})();
