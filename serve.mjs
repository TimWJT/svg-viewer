// Dev-only static server so the built file can be exercised over http://
// (localStorage, IndexedDB and the File System Access API need a real origin).
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join, normalize } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 4174);

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.svg': 'image/svg+xml; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
};

createServer(async (req, res) => {
  let path = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  if (path === '/') path = '/index.html';

  /* dist/ first so app.js resolves as the packaged app sees it
     (sibling of index.html), then the project root for fixtures like sample.svg */
  const candidates = [normalize(join(here, 'dist', path)), normalize(join(here, path))];

  for (const file of candidates) {
    if (!file.startsWith(here)) continue;
    try {
      const body = await readFile(file);
      const ext = file.slice(file.lastIndexOf('.')).toLowerCase();
      res.writeHead(200, { 'content-type': TYPES[ext] || 'application/octet-stream', 'cache-control': 'no-store' });
      res.end(body);
      return;
    } catch { /* try the next candidate */ }
  }
  res.writeHead(404).end('not found');
}).listen(PORT, () => console.log(`serving svg-viewer on http://localhost:${PORT}`));
