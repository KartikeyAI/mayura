import { MayuraError } from 'mayura';

export interface QuickActionsOptions {
  /** Your Cloudflare account id (32 hex characters). */
  readonly accountId: string;
  /** A Cloudflare API token with the "Browser Rendering - Edit" permission. Nothing is read from the environment. */
  readonly apiToken: string;
  /** For tests and proxies: the fetch to use. */
  readonly fetch?: typeof fetch;
  /** The API's address; `https://api.cloudflare.com` by default. */
  readonly baseUrl?: string;
}

/** What every action renders: a page, and optionally only the requests it may make. */
export interface PageRequest {
  readonly url: string;
  /** Regular expressions: the page loads only what matches one. */
  readonly allowRequestPattern?: readonly string[];
}
export interface CallOptions { readonly signal?: AbortSignal }
export interface ScrapedElement { readonly text: string; readonly html: string; readonly attributes: readonly { readonly name: string; readonly value: string }[] }
export interface CrawlStart {
  readonly url: string;
  /** Pages to read; 10 by default. */
  readonly limit?: number;
  readonly depth?: number;
  readonly formats?: readonly ('markdown' | 'html')[];
  readonly includePatterns?: readonly string[];
  readonly excludePatterns?: readonly string[];
  readonly allowRequestPattern?: readonly string[];
}
export type CrawlStatus = 'running' | 'completed' | 'errored' | 'cancelled_due_to_timeout' | 'cancelled_due_to_limits' | 'cancelled_by_user';
export interface CrawlRecord { readonly url: string; readonly status: string; readonly markdown?: string; readonly html?: string; readonly title?: string; readonly httpStatus?: number }
export interface CrawlResult { readonly id: string; readonly status: CrawlStatus; readonly total: number; readonly finished: number; readonly records: readonly CrawlRecord[]; readonly cursor?: string | number }

/** Cloudflare Browser Run's quick actions: one call renders a page and gives back what was asked for. */
export interface QuickActions {
  markdown(request: PageRequest, options?: CallOptions): Promise<string>;
  /** The page's HTML once rendered. */
  content(request: PageRequest, options?: CallOptions): Promise<string>;
  links(request: PageRequest & { readonly visibleLinksOnly?: boolean; readonly excludeExternalLinks?: boolean }, options?: CallOptions): Promise<readonly string[]>;
  scrape(request: PageRequest & { readonly selectors: readonly string[] }, options?: CallOptions): Promise<readonly { readonly selector: string; readonly results: readonly ScrapedElement[] }[]>;
  screenshot(request: PageRequest & { readonly fullPage?: boolean }, options?: CallOptions): Promise<Uint8Array>;
  pdf(request: PageRequest, options?: CallOptions): Promise<Uint8Array>;
  /** Structured data from the page by Cloudflare's model (Workers AI, billed as such): a prompt, a JSON Schema, or both. */
  json(request: PageRequest & { readonly prompt?: string; readonly schema?: Record<string, unknown> }, options?: CallOptions): Promise<unknown>;
  readonly crawl: {
    start(request: CrawlStart, options?: CallOptions): Promise<string>;
    status(id: string, options?: CallOptions & { readonly cursor?: string | number; readonly limit?: number }): Promise<CrawlResult>;
    cancel(id: string, options?: CallOptions): Promise<void>;
  };
}

const statuses: readonly CrawlStatus[] = ['running', 'completed', 'errored', 'cancelled_due_to_timeout', 'cancelled_due_to_limits', 'cancelled_by_user'];
const failure = (status: number) => new MayuraError('TOOL_FAILED',
  status === 429 ? 'Cloudflare is rate limiting Browser Run requests (HTTP 429).' : `Cloudflare refused the request (HTTP ${status}).`);
const invalid = () => new MayuraError('TOOL_FAILED', 'Cloudflare returned a response that is not valid.');

/**
 * A client for Cloudflare Browser Run's REST quick actions, from any runtime with no dependency. Nothing it reads of
 * Cloudflare's errors reaches its own: a failure names only its HTTP status.
 */
export function cloudflareQuickActions(options: QuickActionsOptions): QuickActions {
  if (!options || typeof options.accountId !== 'string' || !/^[0-9a-f]{32}$/u.test(options.accountId)) throw new MayuraError('INVALID_CONFIG', 'cloudflareQuickActions(): accountId must be a Cloudflare account id.');
  if (typeof options.apiToken !== 'string' || !/^[A-Za-z0-9_-]{20,512}$/u.test(options.apiToken)) throw new MayuraError('INVALID_CONFIG', 'cloudflareQuickActions(): apiToken must be a Cloudflare API token.');
  if (options.fetch !== undefined && typeof options.fetch !== 'function') throw new MayuraError('INVALID_CONFIG', 'cloudflareQuickActions(): fetch must be a function.');
  const base = (() => {
    try { const url = new URL(options.baseUrl ?? 'https://api.cloudflare.com'); if (url.protocol !== 'https:' && url.hostname !== '127.0.0.1' && url.hostname !== 'localhost') throw new Error(); return url.origin; }
    catch { throw new MayuraError('INVALID_CONFIG', 'cloudflareQuickActions(): baseUrl must be an https URL.'); }
  })();
  const root = `${base}/client/v4/accounts/${options.accountId}/browser-run`;
  const fetcher = options.fetch ?? globalThis.fetch;
  const headers = { authorization: `Bearer ${options.apiToken}`, 'content-type': 'application/json' };
  const page = (request: PageRequest) => {
    if (!request || typeof request.url !== 'string' || !/^https?:\/\//u.test(request.url)) throw new MayuraError('INVALID_INPUT', 'url must be an http(s) URL.');
    return { url: request.url, ...(request.allowRequestPattern ? { allowRequestPattern: [...request.allowRequestPattern] } : {}) };
  };
  const send = async (method: 'GET' | 'POST' | 'DELETE', path: string, body: unknown, signal: AbortSignal | undefined) => {
    const reply = await fetcher(`${root}${path}`, { method, headers, ...(signal ? { signal } : {}), ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    if (!reply.ok) { void reply.body?.cancel().catch(() => undefined); throw failure(reply.status); }
    return reply;
  };
  /** The `result` of Cloudflare's JSON envelope. */
  const result = async (reply: Response): Promise<unknown> => {
    const data = await reply.json().catch(() => undefined) as { success?: unknown; result?: unknown } | undefined;
    if (!data || data.success !== true) throw invalid();
    return data.result;
  };
  const bytes = async (reply: Response): Promise<Uint8Array> => {
    if (/json/u.test(reply.headers.get('content-type') ?? '')) { void reply.body?.cancel().catch(() => undefined); throw invalid(); }
    return new Uint8Array(await reply.arrayBuffer());
  };
  const text = (value: unknown) => { if (typeof value !== 'string') throw invalid(); return value; };

  const actions: QuickActions = {
    markdown: async (request, call = {}) => text(await result(await send('POST', '/markdown', page(request), call.signal))),
    content: async (request, call = {}) => {
      const reply = await send('POST', '/content', page(request), call.signal);
      // Cloudflare does not document whether HTML comes in its envelope or as itself: either is taken.
      return /json/u.test(reply.headers.get('content-type') ?? '') ? text(await result(reply)) : reply.text();
    },
    links: async (request, call = {}) => {
      const value = await result(await send('POST', '/links', { ...page(request), ...(request.visibleLinksOnly ? { visibleLinksOnly: true } : {}), ...(request.excludeExternalLinks ? { excludeExternalLinks: true } : {}) }, call.signal));
      if (!Array.isArray(value)) throw invalid();
      return value.filter((link): link is string => typeof link === 'string');
    },
    scrape: async (request, call = {}) => {
      if (!Array.isArray(request.selectors) || request.selectors.length === 0 || request.selectors.length > 20 || request.selectors.some(item => typeof item !== 'string' || item === '' || item.length > 500)) {
        throw new MayuraError('INVALID_INPUT', 'selectors are 1 to 20 CSS selectors.');
      }
      const value = await result(await send('POST', '/scrape', { ...page(request), elements: request.selectors.map(selector => ({ selector })) }, call.signal));
      if (!Array.isArray(value)) throw invalid();
      return value.map(item => {
        const entry = item as { selector?: unknown; results?: unknown };
        return { selector: typeof entry?.selector === 'string' ? entry.selector : '', results: (Array.isArray(entry?.results) ? entry.results : []).map(found => {
          const element = found as { text?: unknown; html?: unknown; attributes?: unknown };
          return { text: typeof element?.text === 'string' ? element.text : '', html: typeof element?.html === 'string' ? element.html : '',
            attributes: (Array.isArray(element?.attributes) ? element.attributes : []).filter((attribute): attribute is { name: string; value: string } =>
              typeof (attribute as { name?: unknown })?.name === 'string' && typeof (attribute as { value?: unknown })?.value === 'string').map(({ name, value }) => ({ name, value })) };
        }) };
      });
    },
    screenshot: async (request, call = {}) => bytes(await send('POST', '/screenshot', { ...page(request), screenshotOptions: { type: 'png', fullPage: request.fullPage === true } }, call.signal)),
    pdf: async (request, call = {}) => bytes(await send('POST', '/pdf', page(request), call.signal)),
    json: async (request, call = {}) => {
      if (request.prompt === undefined && request.schema === undefined) throw new MayuraError('INVALID_INPUT', 'json needs a prompt, a schema, or both.');
      return result(await send('POST', '/json', { ...page(request), ...(request.prompt ? { prompt: request.prompt } : {}),
        ...(request.schema ? { response_format: { type: 'json_schema', json_schema: request.schema } } : {}) }, call.signal));
    },
    crawl: Object.freeze({
      start: async (request: CrawlStart, call: CallOptions = {}) => {
        const id = await result(await send('POST', '/crawl', { ...page(request), limit: request.limit ?? 10, ...(request.depth ? { depth: request.depth } : {}),
          formats: [...(request.formats ?? ['markdown'])],
          options: { includeSubdomains: false, includeExternalLinks: false,
            ...(request.includePatterns ? { includePatterns: [...request.includePatterns] } : {}), ...(request.excludePatterns ? { excludePatterns: [...request.excludePatterns] } : {}) } }, call.signal));
        if (typeof id !== 'string' || !/^[A-Za-z0-9-]{1,128}$/u.test(id)) throw invalid();
        return id;
      },
      status: async (id: string, call: CallOptions & { readonly cursor?: string | number; readonly limit?: number } = {}) => {
        if (typeof id !== 'string' || !/^[A-Za-z0-9-]{1,128}$/u.test(id)) throw new MayuraError('INVALID_INPUT', 'id must be a crawl job id.');
        const query = new URLSearchParams({ limit: String(call.limit ?? 100), ...(call.cursor !== undefined ? { cursor: String(call.cursor) } : {}) });
        const value = await result(await send('GET', `/crawl/${id}?${query}`, undefined, call.signal)) as { id?: unknown; status?: unknown; total?: unknown; finished?: unknown; records?: unknown; cursor?: unknown } | undefined;
        if (!value || !statuses.includes(value.status as CrawlStatus)) throw invalid();
        const records = (Array.isArray(value.records) ? value.records : []).flatMap(item => {
          const record = item as { url?: unknown; status?: unknown; markdown?: unknown; html?: unknown; metadata?: { title?: unknown; status?: unknown } };
          if (typeof record?.url !== 'string') return [];
          return [{ url: record.url, status: typeof record.status === 'string' ? record.status : '', ...(typeof record.markdown === 'string' ? { markdown: record.markdown } : {}),
            ...(typeof record.html === 'string' ? { html: record.html } : {}), ...(typeof record.metadata?.title === 'string' ? { title: record.metadata.title } : {}),
            ...(typeof record.metadata?.status === 'number' ? { httpStatus: record.metadata.status } : {}) }];
        });
        return { id, status: value.status as CrawlStatus, total: Number(value.total) || 0, finished: Number(value.finished) || 0, records,
          ...(typeof value.cursor === 'string' || typeof value.cursor === 'number' ? { cursor: value.cursor } : {}) };
      },
      cancel: async (id: string, call: CallOptions = {}) => {
        if (typeof id !== 'string' || !/^[A-Za-z0-9-]{1,128}$/u.test(id)) throw new MayuraError('INVALID_INPUT', 'id must be a crawl job id.');
        const reply = await send('DELETE', `/crawl/${id}`, undefined, call.signal);
        void reply.body?.cancel().catch(() => undefined);
      },
    }),
  };
  return Object.freeze(actions);
}
