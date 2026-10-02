import { localBrowsers } from 'mayura/browser/local';

export interface Seen { readonly method: string; readonly path: string; readonly headers: Headers; readonly body?: Record<string, unknown> }

/**
 * BrowserView's sessions API, answering in its formats: relative URLs, and a CDP endpoint that describes its browser
 * only to its session token. With `chrome`, each session is a browser launched from the Chrome installed here;
 * `browsers` maps each session to that browser's own WebSocket.
 */
export function fakeBrowserView(options: { readonly chrome?: 'chrome' | 'edge'; readonly create?: () => Response; readonly release?: () => Response } = {}) {
  const seen: Seen[] = []; let next = 1;
  const sessions = new Map<string, { ended: boolean; token: string; socket: string; release?: () => Promise<void> }>();
  const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init); const url = new URL(request.url);
    const text = await request.text();
    seen.push({ method: request.method, path: url.pathname, headers: request.headers, ...(text ? { body: JSON.parse(text) as Record<string, unknown> } : {}) });
    const cdp = /^\/sessions\/([A-Za-z0-9_-]+)\/cdp\/json\/version$/u.exec(url.pathname);
    if (cdp) {
      const session = sessions.get(cdp[1]!);
      if (!session || session.ended || request.headers.get('x-session-token') !== session.token) return Response.json({ error: 'unauthorized' }, { status: 401 });
      return Response.json({ Browser: 'Chrome', webSocketDebuggerUrl: session.socket });
    }
    if (request.headers.get('authorization') !== 'Bearer bv_live_test_1') return Response.json({ error: 'unauthorized' }, { status: 401 });
    if (request.method === 'POST' && url.pathname === '/sessions') {
      if (options.create) return options.create();
      const id = `bv_${next++}`; const token = `cdp-token-${id}`;
      let socket = `ws://127.0.0.1:9222/devtools/browser/${id}`; let release: (() => Promise<void>) | undefined;
      if (options.chrome) {
        const backend = await localBrowsers({ channel: options.chrome }).create({ lifetimeMs: 300_000, viewport: { width: 1_280, height: 800 }, labels: {} }, { signal: AbortSignal.timeout(60_000) });
        socket = backend.cdp.url; release = () => backend.release({ signal: AbortSignal.timeout(30_000) });
      }
      sessions.set(id, { ended: false, token, socket, ...(release ? { release } : {}) });
      return Response.json({ id, status: 'running', cdp_url: `/sessions/${id}/cdp`, cdp_token: token,
        watch_url: `/sessions/${id}/watch?token=view-${id}`, viewer_url: `/sessions/${id}/viewer?token=control-${id}` }, { status: 201 });
    }
    const match = /^\/sessions\/([A-Za-z0-9_-]+)\/release$/u.exec(url.pathname);
    if (options.release) return options.release();
    const session = match ? sessions.get(match[1]!) : undefined;
    if (!session) return Response.json({ error: 'not_found' }, { status: 404 });
    if (!session.ended) { session.ended = true; await session.release?.(); }
    return new Response(null, { status: 202 });
  }) as typeof globalThis.fetch;
  return { fetch, seen, sessions };
}
