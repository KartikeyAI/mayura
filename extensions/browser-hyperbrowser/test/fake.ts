import { localBrowsers } from 'mayura/browser/local';

export interface Seen { readonly method: string; readonly path: string; readonly headers: Headers; readonly body?: Record<string, unknown> }

/**
 * Hyperbrowser's sessions API, answering in its formats. With `chrome`, each session is a browser launched from the
 * Chrome installed here, and its WebSocket endpoint that browser's, so sessions can be driven for real.
 */
export function fakeHyperbrowser(options: {
  readonly chrome?: 'chrome' | 'edge';
  readonly create?: () => Response;
  readonly stop?: () => Response;
  readonly sessionStatus?: string;
} = {}) {
  const seen: Seen[] = []; const sessions = new Map<string, { status: string; release?: () => Promise<void> }>(); let next = 1;
  const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init); const url = new URL(request.url);
    const text = await request.text();
    seen.push({ method: request.method, path: url.pathname, headers: request.headers, ...(text ? { body: JSON.parse(text) as Record<string, unknown> } : {}) });
    if (request.headers.get('x-api-key') !== 'hb_test_key_1') return Response.json({ message: 'Unauthorized' }, { status: 401 });
    if (request.method === 'POST' && url.pathname === '/api/session') {
      if (options.create) return options.create();
      const id = `hb-session-${next++}`;
      let wsEndpoint = `wss://connect.hyperbrowser.example/?token=secret-${id}`; let release: (() => Promise<void>) | undefined;
      if (options.chrome) {
        const backend = await localBrowsers({ channel: options.chrome }).create({ lifetimeMs: 300_000, viewport: { width: 1_280, height: 800 }, labels: {} }, { signal: AbortSignal.timeout(60_000) });
        wsEndpoint = backend.cdp.url; release = () => backend.release({ signal: AbortSignal.timeout(30_000) });
      }
      sessions.set(id, { status: 'active', ...(release ? { release } : {}) });
      return Response.json({ id, status: 'active', wsEndpoint, liveUrl: `https://app.hyperbrowser.example/live?token=live-${id}`, token: `live-${id}` });
    }
    const match = /^\/api\/session\/([A-Za-z0-9-]+)(\/stop)?$/u.exec(url.pathname);
    const session = match ? sessions.get(match[1]!) : undefined;
    if (!session) return Response.json({ message: 'Session not found' }, { status: 404 });
    if (request.method === 'GET') return Response.json({ id: match![1], status: options.sessionStatus ?? session.status });
    if (options.stop) return options.stop();
    if (session.status !== 'active') return Response.json({ message: 'Session is not active' }, { status: 400 });
    session.status = 'closed'; await session.release?.();
    return Response.json({ success: true });
  }) as typeof globalThis.fetch;
  return { fetch, seen, sessions };
}
