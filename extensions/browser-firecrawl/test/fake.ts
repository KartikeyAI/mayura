import { localBrowsers } from 'mayura/browser/local';

export interface Seen { readonly method: string; readonly path: string; readonly headers: Headers; readonly body?: Record<string, unknown> }

/**
 * Firecrawl's v2 API, answering in its formats: Interact sessions (with `chrome`, a browser launched from the Chrome
 * installed here), scrape, map, search, and crawls that finish after `crawlPolls` status checks.
 */
export function fakeFirecrawl(options: {
  readonly chrome?: 'chrome' | 'edge';
  readonly reply?: (seen: Seen) => Response | undefined;
  readonly crawlPolls?: number;
  readonly crawlStatus?: string;
} = {}) {
  const seen: Seen[] = []; const sessions = new Map<string, { deleted: boolean; release?: () => Promise<void> }>(); let next = 1;
  const crawls = new Map<string, { polls: number; cancelled: boolean }>();
  const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init); const url = new URL(request.url);
    const text = await request.text();
    const entry: Seen = { method: request.method, path: url.pathname, headers: request.headers, ...(text ? { body: JSON.parse(text) as Record<string, unknown> } : {}) };
    seen.push(entry);
    if (request.headers.get('authorization') !== 'Bearer fc-test-key-1') return Response.json({ success: false, error: 'Unauthorized' }, { status: 401 });
    const custom = options.reply?.(entry); if (custom) return custom;
    const body = entry.body ?? {};
    if (request.method === 'POST' && url.pathname === '/v2/interact') {
      const id = `fc-session-${next++}`;
      let cdpUrl = `wss://cdp-proxy.firecrawl.example/cdp/${id}?token=secret`; let release: (() => Promise<void>) | undefined;
      if (options.chrome) {
        const backend = await localBrowsers({ channel: options.chrome }).create({ lifetimeMs: 300_000, viewport: { width: 1_280, height: 800 }, labels: {} }, { signal: AbortSignal.timeout(60_000) });
        cdpUrl = backend.cdp.url; release = () => backend.release({ signal: AbortSignal.timeout(30_000) });
      }
      sessions.set(id, { deleted: false, ...(release ? { release } : {}) });
      return Response.json({ success: true, id, cdpUrl, liveViewUrl: `https://liveview.firecrawl.example/${id}`, interactiveLiveViewUrl: `https://liveview.firecrawl.example/${id}?interactive=true`, expiresAt: '2026-10-02T12:00:00Z' });
    }
    const interact = /^\/v2\/interact\/([A-Za-z0-9_-]+)$/u.exec(url.pathname);
    if (interact && request.method === 'DELETE') {
      const session = sessions.get(interact[1]!);
      if (!session || session.deleted) return Response.json({ success: false, error: 'Session not found' }, { status: 404 });
      session.deleted = true; await session.release?.();
      return Response.json({ success: true, sessionDurationMs: 1_000, creditsBilled: 2 });
    }
    if (request.method === 'POST' && url.pathname === '/v2/scrape') {
      const format = (body['formats'] as unknown[])[0];
      const metadata = { title: 'Example page', url: body['url'], sourceURL: body['url'], statusCode: 200 };
      if (typeof format === 'object') return Response.json({ success: true, data: { json: { price: 42, prompt: (format as { prompt: string }).prompt }, metadata } });
      return Response.json({ success: true, data: { markdown: `# Example\n${'word '.repeat(50)}`, html: '<h1>Example</h1>', summary: 'An example page.', links: ['https://example.com/a', 'https://other.example/b', 7], metadata } });
    }
    if (request.method === 'POST' && url.pathname === '/v2/map') {
      return Response.json({ success: true, links: [{ url: 'https://example.com/', title: 'Home' }, 'https://example.com/about', { title: 'no url' }] });
    }
    if (request.method === 'POST' && url.pathname === '/v2/search') {
      return Response.json({ success: true, data: { web: [{ url: 'https://example.com/', title: 'Example', description: 'A site.' }, { title: 'broken' }] } });
    }
    if (request.method === 'POST' && url.pathname === '/v2/crawl') {
      const id = `crawl-${next++}`; crawls.set(id, { polls: 0, cancelled: false });
      return Response.json({ success: true, id, url: `https://api.firecrawl.example/v2/crawl/${id}` });
    }
    const crawl = /^\/v2\/crawl\/([A-Za-z0-9-]+)$/u.exec(url.pathname);
    if (crawl) {
      const job = crawls.get(crawl[1]!);
      if (!job) return Response.json({ success: false, error: 'Not found' }, { status: 404 });
      if (request.method === 'DELETE') { job.cancelled = true; return Response.json({ success: true, status: 'cancelled' }); }
      job.polls++;
      if (job.polls < (options.crawlPolls ?? 1)) return Response.json({ success: true, status: 'scraping', total: 3, completed: job.polls });
      return Response.json({ success: true, status: options.crawlStatus ?? 'completed', total: 3, completed: 3, data: [
        { markdown: '# One', metadata: { url: 'https://example.com/one', title: 'One', statusCode: 200 } },
        { markdown: '# Two', metadata: { url: 'https://example.com/two', title: 'Two', statusCode: 200 } },
        { markdown: '# Away', metadata: { url: 'https://elsewhere.example/three', title: 'Away', statusCode: 200 } },
      ] });
    }
    return Response.json({ success: false, error: 'Not found' }, { status: 404 });
  }) as typeof globalThis.fetch;
  return { fetch, seen, sessions, crawls };
}
