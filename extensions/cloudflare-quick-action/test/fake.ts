export interface Seen { readonly method: string; readonly path: string; readonly query: URLSearchParams; readonly headers: Headers; readonly body?: Record<string, unknown> }

const account = '0123456789abcdef0123456789abcdef';
const envelope = (result: unknown) => Response.json({ success: true, errors: [], messages: [], result });

/** Cloudflare Browser Run's quick actions, answering in their formats; crawls finish after `crawlPolls` checks. */
export function fakeBrowserRun(options: { readonly reply?: (seen: Seen) => Response | undefined; readonly crawlPolls?: number; readonly crawlStatus?: string; readonly htmlAsText?: boolean } = {}) {
  const seen: Seen[] = []; const crawls = new Map<string, { polls: number; cancelled: boolean }>(); let next = 1;
  const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init); const url = new URL(request.url);
    const text = await request.text();
    const prefix = `/client/v4/accounts/${account}/browser-run`;
    const entry: Seen = { method: request.method, path: url.pathname.startsWith(prefix) ? url.pathname.slice(prefix.length) : url.pathname, query: url.searchParams, headers: request.headers,
      ...(text ? { body: JSON.parse(text) as Record<string, unknown> } : {}) };
    seen.push(entry);
    if (request.headers.get('authorization') !== 'Bearer cf_test_token_0123456789abcdef') return Response.json({ success: false, errors: [{ code: 10000, message: 'Authentication error' }] }, { status: 401 });
    const custom = options.reply?.(entry); if (custom) return custom;
    switch (entry.path) {
      case '/markdown': return envelope(`# Example\n${'word '.repeat(40)}`);
      case '/content': return options.htmlAsText ? new Response('<html><h1>Example</h1></html>', { headers: { 'content-type': 'text/html' } }) : envelope('<html><h1>Example</h1></html>');
      case '/links': return envelope(['https://example.com/a', 'https://other.example/b', 3]);
      case '/scrape': return envelope([{ selector: 'h1', results: [{ text: 'Example', html: 'Example', attributes: [{ name: 'class', value: 'title' }, { name: 1 }], height: 10, width: 10, top: 0, left: 0 }] }]);
      case '/screenshot': return new Response(new Uint8Array([0x89, 0x50, 0x4e, 0x47]), { headers: { 'content-type': 'image/png' } });
      case '/pdf': return new Response(new Uint8Array([0x25, 0x50, 0x44, 0x46]), { headers: { 'content-type': 'application/pdf' } });
      case '/json': return envelope({ price: 42 });
      case '/crawl': { const id = `job-${next++}`; crawls.set(id, { polls: 0, cancelled: false }); return envelope(id); }
      default: {
        const match = /^\/crawl\/([A-Za-z0-9-]+)$/u.exec(entry.path); const job = match ? crawls.get(match[1]!) : undefined;
        if (!job) return Response.json({ success: false, errors: [{ code: 404, message: 'Not found' }] }, { status: 404 });
        if (request.method === 'DELETE') { job.cancelled = true; return envelope({ id: match![1], status: 'cancelled_by_user' }); }
        job.polls++;
        if (job.polls < (options.crawlPolls ?? 1)) return envelope({ id: match![1], status: 'running', total: 3, finished: job.polls, records: [] });
        return envelope({ id: match![1], status: options.crawlStatus ?? 'completed', browserSecondsUsed: 12.5, total: 4, finished: 4, records: [
          { url: 'https://example.com/one', status: 'completed', markdown: '# One', metadata: { status: 200, title: 'One', url: 'https://example.com/one' } },
          { url: 'https://example.com/two', status: 'completed', markdown: '# Two', metadata: { status: 200, title: 'Two', url: 'https://example.com/two' } },
          { url: 'https://example.com/robots-only', status: 'disallowed' },
          { url: 'https://elsewhere.example/three', status: 'completed', markdown: '# Away', metadata: { status: 200, title: 'Away' } },
        ] });
      }
    }
  }) as typeof globalThis.fetch;
  return { fetch, seen, crawls };
}
