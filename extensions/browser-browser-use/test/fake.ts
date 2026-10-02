import { localBrowsers } from 'mayura/browser/local';

export interface Seen { readonly method: string; readonly path: string; readonly headers: Headers; readonly body?: Record<string, unknown> }

/**
 * Browser Use's browsers API, answering in its formats. With `chrome`, each browser is one launched from the Chrome
 * installed here, its CDP URL that browser's WebSocket or (`httpCdp`) its http address; requests to that address go
 * to the browser itself.
 */
export function fakeBrowserUse(options: {
  readonly chrome?: 'chrome' | 'edge';
  readonly httpCdp?: boolean;
  readonly create?: () => Response;
  readonly stop?: () => Response;
  readonly browserStatus?: string;
} = {}) {
  const seen: Seen[] = []; const browsers = new Map<string, { status: string; release?: () => Promise<void> }>(); let next = 1;
  const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init); const url = new URL(request.url);
    if (url.hostname === '127.0.0.1') return globalThis.fetch(request);
    const text = await request.text();
    seen.push({ method: request.method, path: url.pathname, headers: request.headers, ...(text ? { body: JSON.parse(text) as Record<string, unknown> } : {}) });
    if (request.headers.get('x-browser-use-api-key') !== 'bu_test_key_1') return Response.json({ detail: 'Unauthorized' }, { status: 401 });
    if (request.method === 'POST' && url.pathname === '/api/v2/browsers') {
      if (options.create) return options.create();
      const id = `0000-bu-${next++}`;
      let cdpUrl = `wss://cdp.browser-use.example/${id}?token=secret`; let release: (() => Promise<void>) | undefined;
      if (options.chrome) {
        const backend = await localBrowsers({ channel: options.chrome }).create({ lifetimeMs: 300_000, viewport: { width: 1_280, height: 800 }, labels: {} }, { signal: AbortSignal.timeout(60_000) });
        cdpUrl = options.httpCdp ? `http://${new URL(backend.cdp.url).host}` : backend.cdp.url; release = () => backend.release({ signal: AbortSignal.timeout(30_000) });
      }
      browsers.set(id, { status: 'active', ...(release ? { release } : {}) });
      return Response.json({ id, status: 'active', cdpUrl, liveUrl: `https://live.browser-use.example/${id}`, timeoutAt: '2026-10-02T12:00:00Z' }, { status: 201 });
    }
    const match = /^\/api\/v2\/browsers\/([A-Za-z0-9-]+)$/u.exec(url.pathname);
    const browser = match ? browsers.get(match[1]!) : undefined;
    if (!browser) return Response.json({ detail: 'Browser session not found' }, { status: 404 });
    if (request.method === 'GET') return Response.json({ id: match![1], status: options.browserStatus ?? browser.status });
    if (options.stop) return options.stop();
    if (browser.status !== 'active') return Response.json({ detail: 'Browser session is not active' }, { status: 422 });
    browser.status = 'stopped'; await browser.release?.();
    return Response.json({ id: match![1], status: 'stopped' });
  }) as typeof globalThis.fetch;
  return { fetch, seen, browsers };
}
