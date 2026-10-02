import { localBrowsers } from 'mayura/browser/local';

export interface Seen { readonly method: string; readonly path: string; readonly headers: Headers; readonly body?: Record<string, unknown> }

/**
 * Browserbase's sessions API, answering in its formats. With `chrome`, each session is a browser launched from the
 * Chrome installed here, and its connect URL that browser's, so sessions can be driven for real.
 */
export function fakeBrowserbase(options: {
  readonly chrome?: 'chrome' | 'edge';
  readonly create?: () => Response;
  readonly debug?: () => Response;
  readonly release?: (status: string) => Response;
  readonly sessionStatus?: string;
} = {}) {
  const seen: Seen[] = []; const sessions = new Map<string, { status: string; release?: () => Promise<void> }>(); let next = 1;
  const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init); const url = new URL(request.url);
    const text = await request.text();
    seen.push({ method: request.method, path: url.pathname + url.search, headers: request.headers, ...(text ? { body: JSON.parse(text) as Record<string, unknown> } : {}) });
    if (request.headers.get('x-bb-api-key') !== 'bb_test_key_123') return Response.json({ message: 'Unauthorized' }, { status: 401 });
    if (request.method === 'POST' && url.pathname === '/v1/sessions') {
      if (options.create) return options.create();
      const id = `sess-${next++}`;
      let connectUrl = `wss://connect.browserbase.example/?signingKey=secret-${id}`; let release: (() => Promise<void>) | undefined;
      if (options.chrome) {
        const backend = await localBrowsers({ channel: options.chrome }).create({ lifetimeMs: 300_000, viewport: { width: 1_280, height: 800 }, labels: {} }, { signal: AbortSignal.timeout(60_000) });
        connectUrl = backend.cdp.url; release = () => backend.release({ signal: AbortSignal.timeout(30_000) });
      }
      sessions.set(id, { status: 'RUNNING', ...(release ? { release } : {}) });
      return Response.json({ id, projectId: 'proj-1', status: 'RUNNING', connectUrl, signingKey: 'signing-secret' }, { status: 201 });
    }
    const match = /^\/v1\/sessions\/([A-Za-z0-9-]+)(\/debug)?$/u.exec(url.pathname);
    const session = match ? sessions.get(match[1]!) : undefined;
    if (!session) return Response.json({ message: 'Not found' }, { status: 404 });
    if (match![2]) return options.debug?.() ?? Response.json({ debuggerFullscreenUrl: `https://www.browserbase.example/devtools-fullscreen/inspector.html?wss=${match![1]}`, pages: [] });
    if (request.method === 'GET') return Response.json({ id: match![1], status: options.sessionStatus ?? session.status });
    if (options.release) return options.release(session.status);
    if (session.status !== 'RUNNING') return Response.json({ message: 'Session is not running' }, { status: 400 });
    session.status = 'COMPLETED'; await session.release?.();
    return Response.json({ id: match![1], status: 'COMPLETED' });
  }) as typeof globalThis.fetch;
  return { fetch, seen, sessions };
}
