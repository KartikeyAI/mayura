import { localBrowsers } from 'mayura/browser/local';

export interface Seen { readonly method: string; readonly path: string; readonly search: string; readonly authorization: string | null; readonly body?: Record<string, unknown> }
export const account = '0123456789abcdef0123456789abcdef';
export const token = 'cf_test_token_0123456789abcdef';

/**
 * Browser Run's session API, answering in its formats. With `chrome`, each session is a browser launched from the
 * Chrome installed here, and `connect` opens a WebSocket to a session's browser, as Browser Run's
 * `/devtools/browser/{session}` does, for every client that connects to it.
 */
export function fakeBrowserRun(options: { readonly chrome?: 'chrome' | 'edge'; readonly acquire?: () => Response; readonly liveView?: () => Response; readonly close?: () => Response } = {}) {
  const seen: Seen[] = []; let next = 1;
  const sessions = new Map<string, { closed: boolean; socket: string; release?: () => Promise<void> }>();
  const prefix = `/client/v4/accounts/${account}/browser-run/devtools/browser`;
  const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init); const url = new URL(request.url);
    const text = await request.text();
    seen.push({ method: request.method, path: url.pathname, search: url.search, authorization: request.headers.get('authorization'), ...(text ? { body: JSON.parse(text) as Record<string, unknown> } : {}) });
    if (request.headers.get('authorization') !== `Bearer ${token}`) return Response.json({ success: false, errors: [{ code: 10000, message: 'Authentication error' }] }, { status: 401 });
    if (request.method === 'POST' && url.pathname === prefix) {
      if (options.acquire) return options.acquire();
      const id = `1909cef7-0000-4394-bc31-${String(next++).padStart(12, '0')}`;
      let socket = `ws://127.0.0.1:9222/devtools/browser/${id}`; let release: (() => Promise<void>) | undefined;
      if (options.chrome) {
        const backend = await localBrowsers({ channel: options.chrome }).create({ lifetimeMs: 300_000, viewport: { width: 1_280, height: 800 }, labels: {} }, { signal: AbortSignal.timeout(60_000) });
        socket = backend.cdp.url; release = () => backend.release({ signal: AbortSignal.timeout(30_000) });
      }
      sessions.set(id, { closed: false, socket, ...(release ? { release } : {}) });
      return Response.json({ sessionId: id, webSocketDebuggerUrl: `wss://api.cloudflare.com${prefix}/${id}` });
    }
    const live = new RegExp(`^${prefix}/([A-Za-z0-9-]+)/live_view$`, 'u').exec(url.pathname);
    if (live && request.method === 'POST') {
      if (options.liveView) return options.liveView();
      if (!sessions.has(live[1]!)) return Response.json({ error: 'not found' }, { status: 404 });
      return Response.json({ id: 'lv-1', options: {}, devtoolsFrontendUrl: `https://live.browser.run/ui/view?mode=tab&wss=x&jwt=signed-${live[1]}`, webSocketDebuggerUrl: 'wss://x' });
    }
    const close = new RegExp(`^${prefix}/([A-Za-z0-9-]+)$`, 'u').exec(url.pathname);
    if (close && request.method === 'DELETE') {
      if (options.close) return options.close();
      const session = sessions.get(close[1]!);
      if (!session || session.closed) return Response.json({ error: 'not found' }, { status: 404 });
      session.closed = true; await session.release?.();
      return Response.json({ status: 'closing' });
    }
    return Response.json({ error: 'not found' }, { status: 404 });
  }) as typeof globalThis.fetch;
  /** The browser behind a session's CDP address, for a WebSocket factory; undefined once closed or unknown. */
  const socketFor = (url: string): string | undefined => {
    const match = new RegExp(`^wss://api\\.cloudflare\\.com${prefix}/([A-Za-z0-9-]+)$`, 'u').exec(url);
    const session = match ? sessions.get(match[1]!) : undefined;
    return session && !session.closed ? session.socket : undefined;
  };
  return { fetch, seen, sessions, socketFor };
}
