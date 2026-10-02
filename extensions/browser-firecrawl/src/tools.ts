import { defineTool, MayuraError, type AnyTool, type JsonObject, type Schema } from 'mayura';
import { originPolicy } from 'mayura/browser';
import { firecrawlBase } from './api.js';

export interface FirecrawlToolsOptions {
  /** A Firecrawl API key (`fc-...`). Nothing is read from the environment. */
  readonly apiKey: string;
  /** Names the tools (`<name>.scrape`, ...) and their permissions (`web:<name>:read`, ...); `web` by default. */
  readonly name?: string;
  /**
   * The sites the tools may read, as `createBrowsers` takes them: `['https://example.com', 'https://*.example.com']`,
   * or `'all'`. Required: nothing is allowed by default. Search results are not bound by it, but reading them is.
   */
  readonly origins: 'all' | readonly string[];
  /** Make `<name>.search`, a web search; permission `web:<name>:search`. Off by default. */
  readonly search?: boolean;
  /** Make `<name>.crawl`, which reads many pages of a site; permission `web:<name>:crawl`. Off by default. */
  readonly crawl?: boolean;
  /** Make `<name>.extract`, which pulls structured data out of a page with Firecrawl's model; permission `web:<name>:extract`. Off by default. */
  readonly extract?: boolean;
  /** The most bytes of a page's content returned to the model; 64 KiB by default. */
  readonly maxPageBytes?: number;
  /** The most pages one crawl reads; 10 by default (at most 100). */
  readonly maxCrawlPages?: number;
  /** The longest one crawl runs before it is cancelled; 5 minutes by default. */
  readonly crawlTimeoutMs?: number;
  /** What each call costs at most, in micro-units of your budget currency, by tool; 0 by default. */
  readonly costMicros?: { readonly scrape?: number; readonly map?: number; readonly search?: number; readonly crawl?: number; readonly extract?: number };
  /** For tests and proxies: the fetch to use. */
  readonly fetch?: typeof fetch;
  /** The API's address; `https://api.firecrawl.dev` by default. */
  readonly baseUrl?: string;
}

type Kind = 'string' | 'integer' | 'string?' | 'integer?' | 'boolean?' | 'object?';
function object<T>(fields: Readonly<Record<string, Kind>>, maxString: number, check?: (value: T) => string | undefined): Schema<T> {
  return { '~standard': { version: 1, vendor: 'mayura-firecrawl', validate: (value: unknown) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return { issues: [{ message: 'Expected an object.' }] };
    const input = value as Record<string, unknown>;
    for (const name of Object.keys(input)) if (!Object.hasOwn(fields, name)) return { issues: [{ message: `Unexpected field ${name}.` }] };
    for (const [name, kind] of Object.entries(fields)) {
      const item = input[name];
      if (item === undefined) { if (kind.endsWith('?')) continue; return { issues: [{ message: `${name} is required.` }] }; }
      if (kind.startsWith('string') && (typeof item !== 'string' || item.length > maxString)) return { issues: [{ message: `${name} must be a string.` }] };
      if (kind.startsWith('integer') && (typeof item !== 'number' || !Number.isSafeInteger(item) || item < 1)) return { issues: [{ message: `${name} must be a positive whole number.` }] };
      if (kind.startsWith('boolean') && typeof item !== 'boolean') return { issues: [{ message: `${name} must be true or false.` }] };
      if (kind.startsWith('object') && (!item || typeof item !== 'object' || Array.isArray(item) || JSON.stringify(item).length > 20_000)) return { issues: [{ message: `${name} must be a JSON Schema object.` }] };
    }
    const message = check?.(input as T);
    return message === undefined ? { value: input as T } : { issues: [{ message }] };
  } } } as Schema<T>;
}
const anything: Schema<unknown> = { '~standard': { version: 1, vendor: 'mayura-firecrawl', validate: (value: unknown) => ({ value }) } } as Schema<unknown>;
const schema = (required: readonly string[], properties: Record<string, unknown>) => ({ type: 'object', additionalProperties: false, ...(required.length ? { required: [...required] } : {}), properties }) as unknown as JsonObject;
const encoder = new TextEncoder(); const decoder = new TextDecoder();
function clip(value: unknown, max: number): { text: string; truncated: boolean } {
  const text = typeof value === 'string' ? value : '';
  const bytes = encoder.encode(text);
  return bytes.byteLength <= max ? { text, truncated: false } : { text: decoder.decode(bytes.subarray(0, max)).replace(/�$/u, ''), truncated: true };
}
const correctable = new Set(['INVALID_INPUT', 'PERMISSION_DENIED', 'LIMIT_EXCEEDED']);
const formats = ['markdown', 'html', 'links', 'summary'] as const;

/**
 * Firecrawl's web data as tools: `<name>.scrape` and `<name>.map` read pages and list a site's links
 * (`web:<name>:read`); search, crawl and extract are each off until enabled, with their own permission. Every URL read
 * must be within `origins`. Firecrawl fetches the pages, from its own servers. Page content comes back as the tools'
 * results, for the model to read: treat it as untrusted text. Any runtime; no dependency.
 */
export function firecrawlTools(options: FirecrawlToolsOptions): AnyTool[] {
  if (!options || typeof options.apiKey !== 'string' || !/^[!-~]{8,512}$/u.test(options.apiKey)) throw new MayuraError('INVALID_CONFIG', 'firecrawlTools(): apiKey must be a Firecrawl API key.');
  const name = options.name ?? 'web';
  if (typeof name !== 'string' || !/^[a-z][a-z0-9_-]{0,31}$/u.test(name)) throw new MayuraError('INVALID_CONFIG', 'firecrawlTools(): name is lowercase letters, digits, _ and -, starting with a letter.');
  const policy = originPolicy(options.origins);
  for (const flag of ['search', 'crawl', 'extract'] as const) {
    if (options[flag] !== undefined && typeof options[flag] !== 'boolean') throw new MayuraError('INVALID_CONFIG', `firecrawlTools(): ${flag} must be a boolean.`);
  }
  const bound = (value: number | undefined, label: string, fallback: number, min: number, max: number) => {
    const result = value ?? fallback;
    if (!Number.isSafeInteger(result) || result < min || result > max) throw new MayuraError('INVALID_CONFIG', `firecrawlTools(): ${label} is ${min} to ${max}.`);
    return result;
  };
  const maxPageBytes = bound(options.maxPageBytes, 'maxPageBytes', 65_536, 1_024, 4_194_304);
  const maxCrawlPages = bound(options.maxCrawlPages, 'maxCrawlPages', 10, 1, 100);
  const crawlTimeoutMs = bound(options.crawlTimeoutMs, 'crawlTimeoutMs', 300_000, 10_000, 3_600_000);
  const costs = options.costMicros ?? {};
  for (const [tool, cost] of Object.entries(costs)) if (!Number.isSafeInteger(cost) || (cost as number) < 0) throw new MayuraError('INVALID_CONFIG', `firecrawlTools(): costMicros.${tool} must be a non-negative whole number.`);
  if (options.fetch !== undefined && typeof options.fetch !== 'function') throw new MayuraError('INVALID_CONFIG', 'firecrawlTools(): fetch must be a function.');
  const base = firecrawlBase(options.baseUrl, 'firecrawlTools');
  const fetcher = options.fetch ?? globalThis.fetch;
  const headers = { authorization: `Bearer ${options.apiKey}`, 'content-type': 'application/json' };

  /** A URL the tools may read, or a refusal the model can act on. */
  const allowed = (url: unknown): string => {
    let parsed: URL;
    try { parsed = new URL(String(url)); } catch { throw new MayuraError('INVALID_INPUT', 'url must be an http(s) URL.'); }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new MayuraError('INVALID_INPUT', 'url must be an http(s) URL.');
    if (!policy.allows(parsed.href)) throw new MayuraError('PERMISSION_DENIED', `${parsed.origin} is outside the sites these tools may read.`);
    return parsed.href;
  };
  /** Calls Firecrawl; what it wrote back on failure stays out of the error. */
  const call = async <T>(method: 'GET' | 'POST' | 'DELETE', path: string, signal: AbortSignal, body?: unknown): Promise<T> => {
    const reply = await fetcher(`${base}/v2${path}`, { method, signal, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    if (!reply.ok) {
      void reply.body?.cancel().catch(() => undefined);
      throw new MayuraError(reply.status === 402 ? 'BUDGET_EXCEEDED' : 'TOOL_FAILED', `Firecrawl refused the request (HTTP ${reply.status}).`);
    }
    const data = await reply.json().catch(() => undefined) as T & { success?: unknown } | undefined;
    if (!data || data.success === false) throw new MayuraError('TOOL_FAILED', 'Firecrawl did not succeed.');
    return data;
  };
  const scrapeOptions = (format: string) => ({ formats: [format], onlyMainContent: true, skipTlsVerification: false });
  const page = (data: { markdown?: unknown; html?: unknown; summary?: unknown; links?: unknown; metadata?: { title?: unknown; statusCode?: unknown; url?: unknown; sourceURL?: unknown } } | undefined, format: string) => {
    const metadata = data?.metadata ?? {};
    const content = format === 'links' ? undefined : clip(data?.[format as 'markdown' | 'html' | 'summary'], maxPageBytes);
    return {
      url: typeof metadata.url === 'string' ? metadata.url : typeof metadata.sourceURL === 'string' ? metadata.sourceURL : '',
      ...(typeof metadata.title === 'string' ? { title: metadata.title.slice(0, 500) } : {}),
      ...(typeof metadata.statusCode === 'number' ? { status: metadata.statusCode } : {}),
      ...(content ? { [format]: content.text, ...(content.truncated ? { truncated: true } : {}) } : {}),
      ...(format === 'links' ? { links: (Array.isArray(data?.links) ? data.links : []).filter((link): link is string => typeof link === 'string').slice(0, 500) } : {}),
    };
  };
  const tool = (id: string, permission: string, cost: number | undefined, description: string, input: Schema<unknown>, inputJsonSchema: JsonObject,
    execute: (request: Record<string, unknown>, signal: AbortSignal) => Promise<JsonObject>, timeoutMs = 120_000) =>
    defineTool({ id: `${name}.${id}`, version: '1', effects: 'read', capabilities: [`web:${name}:${permission}`], timeoutMs, costMicros: cost ?? 0,
      description, input, output: anything, inputJsonSchema,
      execute: async (request: unknown, context: { readonly signal: AbortSignal }) => {
        try { return await execute(request as Record<string, unknown>, context.signal); }
        catch (error) {
          // Mistakes the model can put right come back as the result, so it can try again; Firecrawl's failures are thrown.
          if (error instanceof MayuraError && correctable.has(error.code)) return { error: error.code, message: error.message } as JsonObject;
          throw error;
        }
      } } as never) as unknown as AnyTool;
  const urlField = { type: 'string', description: 'An http(s) URL.' };

  const tools: AnyTool[] = [
    tool('scrape', 'read', costs.scrape, `Read a web page through Firecrawl, as markdown (the default), html, its links, or a summary. Only some sites may be read. Up to ${maxPageBytes} bytes of content.`,
      object<{ url: string; format?: string }>({ url: 'string', format: 'string?' }, 8_192, request => request.format === undefined || (formats as readonly string[]).includes(request.format) ? undefined : `format is one of ${formats.join(', ')}.`),
      schema(['url'], { url: urlField, format: { type: 'string', enum: [...formats] } }),
      async (request, signal) => {
        const url = allowed(request['url']); const format = (request['format'] as string | undefined) ?? 'markdown';
        const reply = await call<{ data?: Record<string, unknown> }>('POST', '/scrape', signal, { url, ...scrapeOptions(format), timeout: 60_000 });
        return page(reply.data, format) as unknown as JsonObject;
      }),
    tool('map', 'read', costs.map, 'List the pages of a site, optionally only those matching a search, through Firecrawl.',
      object<{ url: string; search?: string; limit?: number }>({ url: 'string', search: 'string?', limit: 'integer?' }, 8_192, request => (request.limit ?? 1) > 500 ? 'limit is at most 500.' : undefined),
      schema(['url'], { url: urlField, search: { type: 'string' }, limit: { type: 'integer', minimum: 1, maximum: 500 } }),
      async (request, signal) => {
        const url = allowed(request['url']);
        const reply = await call<{ links?: unknown }>('POST', '/map', signal, { url, limit: (request['limit'] as number | undefined) ?? 100, ...(request['search'] ? { search: request['search'] } : {}) });
        const links = (Array.isArray(reply.links) ? reply.links : []).flatMap(link => {
          const item = typeof link === 'string' ? { url: link } : link as { url?: unknown; title?: unknown };
          return typeof item?.url === 'string' ? [{ url: item.url, ...(typeof item.title === 'string' ? { title: item.title.slice(0, 300) } : {}) }] : [];
        }).slice(0, 500);
        return { url, links } as unknown as JsonObject;
      }),
  ];
  if (options.search) {
    tools.push(tool('search', 'search', costs.search, 'Search the web through Firecrawl: titles, URLs and descriptions of results. Reading a result needs scrape, within the sites allowed.',
      object<{ query: string; limit?: number }>({ query: 'string', limit: 'integer?' }, 500, request => request.query.trim() === '' ? 'query is required.' : (request.limit ?? 1) > 10 ? 'limit is at most 10.' : undefined),
      schema(['query'], { query: { type: 'string' }, limit: { type: 'integer', minimum: 1, maximum: 10 } }),
      async (request, signal) => {
        const reply = await call<{ data?: { web?: unknown } }>('POST', '/search', signal, { query: request['query'], limit: (request['limit'] as number | undefined) ?? 5, sources: ['web'] });
        const results = (Array.isArray(reply.data?.web) ? reply.data.web : []).flatMap(item => {
          const result = item as { url?: unknown; title?: unknown; description?: unknown };
          return typeof result?.url === 'string' ? [{ url: result.url, title: typeof result.title === 'string' ? result.title.slice(0, 300) : '', description: typeof result.description === 'string' ? result.description.slice(0, 1_000) : '' }] : [];
        });
        return { query: request['query'], results } as unknown as JsonObject;
      }));
  }
  if (options.crawl) {
    tools.push(tool('crawl', 'crawl', costs.crawl, `Read up to ${maxCrawlPages} pages of a site, starting at a URL and following its links on the same site, as markdown, through Firecrawl.`,
      object<{ url: string; limit?: number; includePaths?: string }>({ url: 'string', limit: 'integer?', includePaths: 'string?' }, 8_192, request => (request.limit ?? 1) > maxCrawlPages ? `limit is at most ${maxCrawlPages}.` : undefined),
      schema(['url'], { url: urlField, limit: { type: 'integer', minimum: 1, maximum: maxCrawlPages }, includePaths: { type: 'string', description: 'A regular expression the paths to read must match, such as ^/docs/.' } }),
      async (request, signal) => {
        const url = allowed(request['url']); const limit = (request['limit'] as number | undefined) ?? maxCrawlPages;
        const started = await call<{ id?: unknown }>('POST', '/crawl', signal, { url, limit, allowExternalLinks: false, allowSubdomains: false,
          ...(request['includePaths'] ? { includePaths: [request['includePaths']] } : {}), scrapeOptions: scrapeOptions('markdown') });
        const id = started.id;
        if (typeof id !== 'string' || !/^[A-Za-z0-9-]{1,128}$/u.test(id)) throw new MayuraError('TOOL_FAILED', 'Firecrawl did not start the crawl.');
        const deadline = Date.now() + crawlTimeoutMs; let finished = false;
        try {
          for (;;) {
            const status = await call<{ status?: unknown; data?: unknown }>('GET', `/crawl/${id}`, signal);
            if (status.status === 'completed') {
              finished = true;
              // Pages a redirect took elsewhere are left out.
              const pages = (Array.isArray(status.data) ? status.data : []).map(item => page(item as Record<string, unknown>, 'markdown')).filter(item => item.url !== '' && policy.allows(item.url)).slice(0, limit);
              return { url, pages } as unknown as JsonObject;
            }
            if (status.status === 'failed' || status.status === 'cancelled') { finished = true; throw new MayuraError('TOOL_FAILED', 'Firecrawl could not crawl the site.'); }
            if (Date.now() >= deadline) throw new MayuraError('TIMEOUT', 'The crawl took too long, and was cancelled.');
            await new Promise((resolve, reject) => {
              const stop = () => { clearTimeout(timer); reject(new MayuraError('CANCELLED', 'The crawl was cancelled.')); };
              const timer = setTimeout(() => { signal.removeEventListener('abort', stop); resolve(undefined); }, 2_000);
              if (signal.aborted) stop(); else signal.addEventListener('abort', stop, { once: true });
            });
          }
        } finally {
          // A crawl not finished is cancelled, so it stops spending.
          if (!finished) await call('DELETE', `/crawl/${id}`, AbortSignal.timeout(30_000)).catch(() => undefined);
        }
      }, crawlTimeoutMs + 60_000));
  }
  if (options.extract) {
    tools.push(tool('extract', 'extract', costs.extract, 'Pull structured data out of a web page with Firecrawl\'s model: say what to extract in prompt, and optionally give a JSON Schema for its shape.',
      object<{ url: string; prompt: string; schema?: Record<string, unknown> }>({ url: 'string', prompt: 'string', schema: 'object?' }, 8_192, request => request.prompt.trim() === '' ? 'prompt is required.' : undefined),
      schema(['url', 'prompt'], { url: urlField, prompt: { type: 'string' }, schema: { type: 'object', description: 'A JSON Schema for the data.' } }),
      async (request, signal) => {
        const url = allowed(request['url']);
        const reply = await call<{ data?: { json?: unknown; metadata?: { title?: unknown } } }>('POST', '/scrape', signal, { url, onlyMainContent: true, skipTlsVerification: false, timeout: 60_000,
          formats: [{ type: 'json', prompt: request['prompt'], ...(request['schema'] ? { schema: request['schema'] } : {}) }] });
        const data = reply.data?.json ?? null;
        if (encoder.encode(JSON.stringify(data)).byteLength > maxPageBytes) throw new MayuraError('LIMIT_EXCEEDED', `The extracted data is larger than ${maxPageBytes} bytes.`);
        return { url, data } as unknown as JsonObject;
      }));
  }
  return tools;
}
