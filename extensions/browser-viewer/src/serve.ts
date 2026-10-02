import { MayuraError } from 'mayura';
import type { Browser } from 'mayura/browser';
import { browserViewer, type BrowserViewerOptions, type ViewerShare, type ViewerShareOptions } from './viewer.js';

export interface ServeBrowserViewerOptions extends Omit<BrowserViewerOptions, 'basePath'> {
  /** The address to listen on; `127.0.0.1` by default. Another needs `remote`. */
  readonly host?: string;
  /** The port; any free one by default. */
  readonly port?: number;
  /**
   * Listen beyond this machine. Links carry their token in the clear over plain HTTP: put TLS in front, and give
   * `publicUrl`.
   */
  readonly remote?: boolean;
  /** The origin people reach this server at, such as `https://viewer.example`, for the links; this server's by default. */
  readonly publicUrl?: string;
}

export interface ServedBrowserViewer {
  /** Where the viewer is reached. */
  readonly url: string;
  /** A link to watch the browser, and with `interact` to use it: `url` is the whole link, a secret. */
  share(browser: Browser, options?: ViewerShareOptions): Promise<ViewerShare & { readonly url: string }>;
  /** Revokes every share and stops the server. */
  close(): Promise<void>;
}

const loopback = new Set(['127.0.0.1', '::1', 'localhost']);

/**
 * A live viewer of its own on Node: an HTTP server answering `browserViewer`'s pages, on this machine only unless
 * `remote`. Node only; on other runtimes, mount `browserViewer().handle` in your server.
 */
export async function serveBrowserViewer(options: ServeBrowserViewerOptions = {}): Promise<ServedBrowserViewer> {
  const host = options.host ?? '127.0.0.1';
  if (typeof host !== 'string' || host === '') throw new MayuraError('INVALID_CONFIG', 'serveBrowserViewer(): host is an address to listen on.');
  if (!loopback.has(host) && options.remote !== true) throw new MayuraError('INVALID_CONFIG', 'serveBrowserViewer(): listening beyond this machine needs remote: true, with TLS in front.');
  const port = options.port ?? 0;
  if (!Number.isSafeInteger(port) || port < 0 || port > 65_535) throw new MayuraError('INVALID_CONFIG', 'serveBrowserViewer(): port is 0 to 65,535.');
  let publicUrl: URL | undefined;
  if (options.publicUrl !== undefined) {
    try { publicUrl = new URL(options.publicUrl); } catch { publicUrl = undefined; }
    if (!publicUrl || (publicUrl.protocol !== 'https:' && !loopback.has(publicUrl.hostname.replace(/^\[|\]$/gu, ''))) || publicUrl.pathname !== '/' || publicUrl.search || publicUrl.hash || publicUrl.username || publicUrl.password) {
      throw new MayuraError('INVALID_CONFIG', 'serveBrowserViewer(): publicUrl is an https origin (http:// only on this machine).');
    }
  }
  const { host: _host, port: _port, remote: _remote, publicUrl: _publicUrl, ...viewerOptions } = options;
  const viewer = browserViewer(viewerOptions);
  const { createServer } = await import('node:http');
  const { Readable } = await import('node:stream');

  const server = createServer((req, res) => {
    void (async () => {
      const chunks: Buffer[] = []; let size = 0;
      if (req.method === 'POST') {
        for await (const chunk of req as AsyncIterable<Buffer>) { size += chunk.byteLength; if (size > 4_096) break; chunks.push(chunk); }
        if (size > 4_096) { res.writeHead(413, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' }); res.end('Too large.'); return; }
      }
      const headers = new Headers();
      for (const [name, value] of Object.entries(req.headers)) if (typeof value === 'string') headers.set(name, value);
      const request = new Request(new URL(req.url ?? '/', 'http://viewer.invalid'), {
        method: req.method ?? 'GET', headers, ...(req.method === 'POST' ? { body: Buffer.concat(chunks) } : {}),
      });
      const response = await viewer.handle(request) ?? new Response('Not found.', { status: 404, headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' } });
      res.writeHead(response.status, Object.fromEntries(response.headers));
      if (!response.body) { res.end(); return; }
      // A stream's headers go now: its first frame may be a while coming.
      res.flushHeaders();
      const body = Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0]);
      res.on('close', () => body.destroy());
      body.on('error', () => res.destroy());
      body.pipe(res);
    })().catch(() => { if (!res.headersSent) res.writeHead(500); res.end(); });
  });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(port, host, () => { server.off('error', reject); resolve(); }); });
  const address = server.address();
  const listening = typeof address === 'object' && address ? `http://${address.family === 'IPv6' ? `[${address.address}]` : address.address}:${address.port}` : `http://${host}:${port}`;
  const url = publicUrl ? publicUrl.href : `${listening}/`;

  return {
    url,
    share: async (browser, shareOptions) => {
      const share = await viewer.share(browser, shareOptions);
      return Object.freeze({ path: share.path, interact: share.interact, expiresAt: share.expiresAt, revoke: share.revoke, url: new URL(share.path.slice(1), url).href });
    },
    close: async () => {
      viewer.close();
      server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
    },
  };
}
