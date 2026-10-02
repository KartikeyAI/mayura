import { localBrowsers } from 'mayura/browser/local';

export interface Seen { readonly method: string; readonly path: string; readonly headers: Headers; readonly body?: Record<string, unknown> }

/**
 * Anchor Browser's sessions API, answering in its formats (a `data` wrapper; 401 for a session it does not have).
 * With `chrome`, each session is a browser launched from the Chrome installed here, and its CDP URL that browser's.
 */
export function fakeAnchor(options: { readonly chrome?: 'chrome' | 'edge'; readonly create?: () => Response; readonly end?: () => Response } = {}) {
  const seen: Seen[] = []; const sessions = new Map<string, { ended: boolean; release?: () => Promise<void> }>(); let next = 1;
  const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init); const url = new URL(request.url);
    const text = await request.text();
    seen.push({ method: request.method, path: url.pathname, headers: request.headers, ...(text ? { body: JSON.parse(text) as Record<string, unknown> } : {}) });
    const invalid = () => Response.json({ error: { code: 401, message: 'Invalid API Key or browser session ID' } }, { status: 401 });
    if (request.headers.get('anchor-api-key') !== 'sk-anchor-test-1') return invalid();
    if (request.method === 'POST' && url.pathname === '/v1/sessions') {
      if (options.create) return options.create();
      const id = `anchor-${next++}`;
      let cdp = `wss://connect.anchorbrowser.example?apiKey=secret&sessionId=${id}`; let release: (() => Promise<void>) | undefined;
      if (options.chrome) {
        const backend = await localBrowsers({ channel: options.chrome }).create({ lifetimeMs: 300_000, viewport: { width: 1_280, height: 800 }, labels: {} }, { signal: AbortSignal.timeout(60_000) });
        cdp = backend.cdp.url; release = () => backend.release({ signal: AbortSignal.timeout(30_000) });
      }
      sessions.set(id, { ended: false, ...(release ? { release } : {}) });
      return Response.json({ data: { id, cdp_url: cdp, live_view_url: `https://live.anchorbrowser.example/inspector.html?sessionId=${id}` } });
    }
    const match = /^\/v1\/sessions\/([A-Za-z0-9-]+)$/u.exec(url.pathname);
    if (request.method === 'DELETE' && options.end) return options.end();
    const session = match ? sessions.get(match[1]!) : undefined;
    if (!session || session.ended) return invalid();
    session.ended = true; await session.release?.();
    return Response.json({ data: { status: 'ended' } });
  }) as typeof globalThis.fetch;
  return { fetch, seen, sessions };
}
