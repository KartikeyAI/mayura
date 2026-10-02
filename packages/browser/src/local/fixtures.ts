import { createServer } from 'node:http';
import { browserFixturePages } from '../testing.js';

export interface BrowserFixtureServer {
  /** The origin browsers may load: `http://127.0.0.1:<port>`. */
  readonly allowed: string;
  /** The same server as another origin, for browsers to be kept from: `http://localhost:<port>`. */
  readonly blocked: string;
  /** Every request received: the Host header and the path. */
  requests(): readonly { readonly host: string; readonly path: string }[];
  close(): Promise<void>;
}

/**
 * Serves `browserFixturePages` from `mayura/browser/testing` on this machine, for `browserConformance`: one port,
 * reached as two origins. For tests; Node only.
 */
export async function serveBrowserFixtures(): Promise<BrowserFixtureServer> {
  const seen: { host: string; path: string }[] = [];
  let port = 0;
  const server = createServer((request, response) => {
    const path = (request.url ?? '/').split('?')[0]!;
    seen.push({ host: request.headers.host ?? '', path });
    const blocked = `http://localhost:${port}`;
    if (path === '/redirect-out') { response.writeHead(302, { location: `${blocked}/target` }).end(); return; }
    if (path === '/pixel.png') { response.writeHead(200, { 'content-type': 'image/png' }).end(); return; }
    const page = browserFixturePages[path];
    if (page === undefined) { response.writeHead(404, { 'content-type': 'text/plain' }).end('not found'); return; }
    response.writeHead(200, { 'content-type': path.endsWith('.js') ? 'text/javascript' : 'text/html; charset=utf-8', 'cache-control': 'no-store' })
      .end(page.replaceAll('{{blocked}}', blocked));
  });
  // Both loopback addresses, so localhost reaches it whichever one it resolves to.
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen({ port: 0, host: '::', ipv6Only: false }, () => resolve()); });
  port = (server.address() as { port: number }).port;
  return {
    allowed: `http://127.0.0.1:${port}`,
    blocked: `http://localhost:${port}`,
    requests: () => [...seen],
    close: () => new Promise(resolve => { server.closeAllConnections(); server.close(() => resolve()); }),
  };
}
