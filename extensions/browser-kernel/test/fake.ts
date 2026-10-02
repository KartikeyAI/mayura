import { localBrowsers } from 'mayura/browser/local';

export interface Seen { readonly method: string; readonly path: string; readonly headers: Headers; readonly body?: Record<string, unknown> }

/**
 * Kernel's browsers API, answering in its formats. With `chrome`, each browser is one launched from the Chrome
 * installed here, and its CDP URL that browser's, so browsers can be driven for real.
 */
export function fakeKernel(options: { readonly chrome?: 'chrome' | 'edge'; readonly create?: () => Response; readonly remove?: () => Response } = {}) {
  const seen: Seen[] = []; const browsers = new Map<string, { deleted: boolean; release?: () => Promise<void> }>(); let next = 1;
  const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init); const url = new URL(request.url);
    const text = await request.text();
    seen.push({ method: request.method, path: url.pathname, headers: request.headers, ...(text ? { body: JSON.parse(text) as Record<string, unknown> } : {}) });
    if (request.headers.get('authorization') !== 'Bearer sk_kernel_test_1') return Response.json({ code: 'unauthorized', message: 'Unauthorized' }, { status: 401 });
    if (request.method === 'POST' && url.pathname === '/browsers') {
      if (options.create) return options.create();
      const id = `kernel_${next++}`;
      let cdp = `wss://proxy.kernel.example:8443/browser/cdp?jwt=secret-${id}`; let release: (() => Promise<void>) | undefined;
      if (options.chrome) {
        const backend = await localBrowsers({ channel: options.chrome }).create({ lifetimeMs: 300_000, viewport: { width: 1_280, height: 800 }, labels: {} }, { signal: AbortSignal.timeout(60_000) });
        cdp = backend.cdp.url; release = () => backend.release({ signal: AbortSignal.timeout(30_000) });
      }
      browsers.set(id, { deleted: false, ...(release ? { release } : {}) });
      const headless = (JSON.parse(text) as { headless?: boolean }).headless;
      return Response.json({ session_id: id, cdp_ws_url: cdp, ...(headless ? {} : { browser_live_view_url: `https://api.kernel.example/browser/live/token-${id}` }), timeout_seconds: 60 });
    }
    const match = /^\/browsers\/([A-Za-z0-9_-]+)$/u.exec(url.pathname);
    const browser = match ? browsers.get(match[1]!) : undefined;
    if (request.method === 'DELETE' && options.remove) return options.remove();
    if (!browser || browser.deleted) return Response.json({ code: 'not_found', message: 'Browser not found' }, { status: 404 });
    browser.deleted = true; await browser.release?.();
    return new Response(null, { status: 204 });
  }) as typeof globalThis.fetch;
  return { fetch, seen, browsers };
}
