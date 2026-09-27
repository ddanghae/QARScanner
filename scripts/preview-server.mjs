import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { extname, isAbsolute, relative, resolve, sep } from 'node:path';

const types = new Map([
  ['.css', 'text/css; charset=utf-8'],
  ['.html', 'text/html; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.md', 'text/markdown; charset=utf-8'],
  ['.pine', 'text/plain; charset=utf-8'],
  ['.svg', 'image/svg+xml'],
  ['.webmanifest', 'application/manifest+json; charset=utf-8'],
]);

function isPublic(relativePath) {
  return relativePath === 'index.html' || relativePath === 'sw.js'
    || relativePath === 'manifest.webmanifest'
    || relativePath === `docs${sep}CHART-PATTERNS.md`
    || relativePath === `docs${sep}TRADINGVIEW-PATTERNS.md`
    || relativePath === `pine${sep}qar_pattern_detector.pine`
    || relativePath.startsWith(`css${sep}`) || relativePath.startsWith(`js${sep}`);
}

export function createPreviewServer(projectRoot) {
  const root = resolve(projectRoot);
  return createServer(async (req, res) => {
    if (!['GET', 'HEAD'].includes(req.method)) {
      res.writeHead(405, { allow: 'GET, HEAD' }).end();
      return;
    }
    try {
      const url = new URL(req.url, 'http://127.0.0.1');
      const decoded = decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname);
      const target = resolve(root, `.${decoded}`);
      const relativePath = relative(root, target);
      if (isAbsolute(relativePath) || relativePath === '..' || relativePath.startsWith(`..${sep}`)
        || !isPublic(relativePath)) {
        res.writeHead(404).end('Not found');
        return;
      }
      const bytes = await readFile(target);
      res.writeHead(200, {
        'content-type': types.get(extname(target)) ?? 'application/octet-stream',
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff',
      });
      res.end(req.method === 'HEAD' ? undefined : bytes);
    } catch (error) {
      res.writeHead(error.code === 'ENOENT' ? 404 : 400).end('Not found');
    }
  });
}
