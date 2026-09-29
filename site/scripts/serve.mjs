// Serves dist/client the way GitHub Pages does, under SITE_BASE: a directory serves its index.html, a directory
// without a trailing slash redirects to one, and anything else missing gets 404.html with status 404.
//     SITE_BASE=/mayura/ pnpm build && SITE_BASE=/mayura/ pnpm preview
import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const output = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'dist', 'client');
const base = `/${(process.env.SITE_BASE ?? '').replace(/^\/+|\/+$/gu, '')}/`.replace('//', '/');
const port = Number(process.env.PORT ?? 4173);
const types = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml',
  '.json': 'application/json', '.xml': 'application/xml', '.txt': 'text/plain; charset=utf-8', '.md': 'text/markdown; charset=utf-8',
};

const send = (response, status, file) => {
  response.writeHead(status, { 'content-type': types[extname(file)] ?? 'application/octet-stream' });
  createReadStream(file).pipe(response);
};

createServer((request, response) => {
  const { pathname, search } = new URL(request.url ?? '/', 'http://localhost');
  if (!pathname.startsWith(base)) return send(response, 404, join(output, '404.html'));
  const path = normalize(join(output, decodeURIComponent(pathname.slice(base.length))));
  if (!path.startsWith(output)) return send(response, 404, join(output, '404.html'));
  if (existsSync(path) && statSync(path).isDirectory()) {
    if (!pathname.endsWith('/')) { response.writeHead(301, { location: `${pathname}/${search}` }); return response.end(); }
    if (existsSync(join(path, 'index.html'))) return send(response, 200, join(path, 'index.html'));
  } else if (existsSync(path)) return send(response, 200, path);
  send(response, 404, join(output, '404.html'));
}).listen(port, '127.0.0.1', () => console.log(`http://localhost:${port}${base}`));
