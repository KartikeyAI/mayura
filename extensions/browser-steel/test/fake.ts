import { localBrowsers } from 'mayura/browser/local';

export interface Seen { readonly method: string; readonly path: string; readonly headers: Headers; readonly body?: Record<string, unknown> }

/**
 * Steel's sessions API, answering in its formats. With `chrome`, each session is a browser launched from the Chrome
 * installed here, and its WebSocket URL that browser's, so sessions can be driven for real.
 */
export function fakeSteel(options: {
  readonly chrome?: 'chrome' | 'edge';
  readonly create?: () => Response;
  readonly release?: () => Response;
  readonly sessionStatus?: string;
} = {}) {
  const seen: Seen[] = []; const sessions = new Map<string, { status: string; release?: () => Promise<void> }>(); let next = 1;
  const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init); const url = new URL(request.url);
    const text = await request.text();
    seen.push({ method: request.method, path: url.pathname, headers: request.headers, ...(text ? { body: JSON.parse(text) as Record<string, unknown> } : {}) });
    if (request.headers.get('steel-api-key') !== 'steel_test_key_1') return Response.json({ message: 'Unauthorized' }, { status: 401 });
    if (request.method === 'POST' && url.pathname === '/v1/sessions') {
      if (options.create) return options.create();
      const id = `0000000${next++}-steel`;
      let websocketUrl = `wss://connect.steel.example/?sessionId=${id}`; let release: (() => Promise<void>) | undefined;
      if (options.chrome) {
        const backend = await localBrowsers({ channel: options.chrome }).create({ lifetimeMs: 300_000, viewport: { width: 1_280, height: 800 }, labels: {} }, { signal: AbortSignal.timeout(60_000) });
        websocketUrl = backend.cdp.url; release = () => backend.release({ signal: AbortSignal.timeout(30_000) });
      }
      sessions.set(id, { status: 'live', ...(release ? { release } : {}) });
      return Response.json({ id, status: 'live', websocketUrl, debugUrl: `https://api.steel.example/v1/sessions/debug?sessionId=${id}`, timeout: 300_000 });
    }
    const match = /^\/v1\/sessions\/([A-Za-z0-9-]+)(\/release)?$/u.exec(url.pathname);
    const session = match ? sessions.get(match[1]!) : undefined;
    if (!session) return Response.json({ message: 'Not found' }, { status: 404 });
    if (request.method === 'GET') return Response.json({ id: match![1], status: options.sessionStatus ?? session.status });
    if (options.release) return options.release();
    if (session.status !== 'live') return Response.json({ message: 'Session already released' }, { status: 400 });
    session.status = 'released'; await session.release?.();
    return Response.json({ success: true, message: 'released' });
  }) as typeof globalThis.fetch;
  return { fetch, seen, sessions };
}
