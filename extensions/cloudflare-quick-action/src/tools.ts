import { defineTool, media, MayuraError, withMedia, type AnyTool, type JsonObject, type Schema } from 'mayura';
import { originPolicy } from 'mayura/browser';
import type { QuickActions } from './client.js';

export interface QuickActionToolsOptions {
  /** Names the tools (`<name>.markdown`, ...) and their permissions (`web:<name>:read`, ...); `cloudflare` by default. */
  readonly name?: string;
  /**
   * The sites the tools may read, as `createBrowsers` takes them: `['https://example.com', 'https://*.example.com']`,
   * or `'all'`. Required: nothing is allowed by default. The page Cloudflare renders loads nothing from other sites.
   */
  readonly origins: 'all' | readonly string[];
  /** Make `<name>.screenshot`, an image of a page; permission `web:<name>:read`. Off by default. */
  readonly screenshot?: boolean;
  /** Make `<name>.json`, structured data from a page by Cloudflare's model (Workers AI); permission `web:<name>:extract`. Off by default. */
  readonly json?: boolean;
  /** Make `<name>.crawl`, which reads many pages of a site; permission `web:<name>:crawl`. Off by default. */
  readonly crawl?: boolean;
  /** The most bytes of a page's content returned to the model; 64 KiB by default. */
  readonly maxPageBytes?: number;
  /** The most pages one crawl reads; 10 by default (at most 100). */
  readonly maxCrawlPages?: number;
  /** The longest one crawl runs before it is cancelled; 5 minutes by default. */
  readonly crawlTimeoutMs?: number;
  /** What each call costs at most, in micro-units of your budget currency, by tool; 0 by default. */
  readonly costMicros?: { readonly markdown?: number; readonly links?: number; readonly scrape?: number; readonly screenshot?: number; readonly json?: number; readonly crawl?: number };
}

type Kind = 'string' | 'integer?' | 'boolean?' | 'string?' | 'object?' | 'strings';
function object<T>(fields: Readonly<Record<string, Kind>>, maxString: number, check?: (value: T) => string | undefined): Schema<T> {
  return { '~standard': { version: 1, vendor: 'mayura-cloudflare', validate: (value: unknown) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return { issues: [{ message: 'Expected an object.' }] };
    const input = value as Record<string, unknown>;
    for (const name of Object.keys(input)) if (!Object.hasOwn(fields, name)) return { issues: [{ message: `Unexpected field ${name}.` }] };
    for (const [name, kind] of Object.entries(fields)) {
      const item = input[name];
      if (item === undefined) { if (kind.endsWith('?')) continue; return { issues: [{ message: `${name} is required.` }] }; }
      if (kind.startsWith('string') && kind !== 'strings' && (typeof item !== 'string' || item.length > maxString)) return { issues: [{ message: `${name} must be a string.` }] };
      if (kind === 'strings' && (!Array.isArray(item) || item.length === 0 || item.length > 20 || item.some(entry => typeof entry !== 'string' || entry === '' || entry.length > 500))) return { issues: [{ message: `${name} is 1 to 20 strings.` }] };
      if (kind.startsWith('integer') && (typeof item !== 'number' || !Number.isSafeInteger(item) || item < 1)) return { issues: [{ message: `${name} must be a positive whole number.` }] };
      if (kind.startsWith('boolean') && typeof item !== 'boolean') return { issues: [{ message: `${name} must be true or false.` }] };
      if (kind.startsWith('object') && (!item || typeof item !== 'object' || Array.isArray(item) || JSON.stringify(item).length > 20_000)) return { issues: [{ message: `${name} must be a JSON Schema object.` }] };
    }
    const message = check?.(input as T);
    return message === undefined ? { value: input as T } : { issues: [{ message }] };
  } } } as Schema<T>;
}
const anything: Schema<unknown> = { '~standard': { version: 1, vendor: 'mayura-cloudflare', validate: (value: unknown) => ({ value }) } } as Schema<unknown>;
const schema = (required: readonly string[], properties: Record<string, unknown>) => ({ type: 'object', additionalProperties: false, ...(required.length ? { required: [...required] } : {}), properties }) as unknown as JsonObject;
const encoder = new TextEncoder(); const decoder = new TextDecoder();
function clip(text: string, max: number): { text: string; truncated: boolean } {
  const bytes = encoder.encode(text);
  return bytes.byteLength <= max ? { text, truncated: false } : { text: decoder.decode(bytes.subarray(0, max)).replace(/�$/u, ''), truncated: true };
}
const correctable = new Set(['INVALID_INPUT', 'PERMISSION_DENIED', 'LIMIT_EXCEEDED']);
const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\/]/gu, '\\$&');

/** Request patterns that let a page load only from the origins (already checked by originPolicy). */
export function originPatterns(origins: readonly string[]): string[] {
  return origins.map(origin => {
    const match = /^(https?):\/\/(\*\.)?([^/:]+|\[[^\]]+\])(?::(\d{1,5}))?\/?$/u.exec(origin.toLowerCase())!;
    const port = match[4] ? `:${match[4]}` : `(:${match[1] === 'https' ? 443 : 80})?`;
    return `^${match[1]}://${match[2] ? '([a-z0-9-]+\\.)+' : ''}${escape(match[3]!)}${port}(/|\\?|#|$)`;
  });
}

/**
 * Cloudflare Browser Run's quick actions as tools: `<name>.markdown`, `<name>.links` and `<name>.scrape` read pages
 * (`web:<name>:read`); screenshots, JSON extraction and crawls are each off until enabled. Every URL must be within
 * `origins`, and the page Cloudflare renders loads nothing from elsewhere. Page content comes back as the tools'
 * results, for the model to read: treat it as untrusted text.
 */
export function quickActionTools(actions: QuickActions, options: QuickActionToolsOptions): AnyTool[] {
  if (!actions || typeof actions.markdown !== 'function') throw new MayuraError('INVALID_CONFIG', 'quickActionTools() needs quick actions from cloudflareQuickActions().');
  const name = options?.name ?? 'cloudflare';
  if (typeof name !== 'string' || !/^[a-z][a-z0-9_-]{0,31}$/u.test(name)) throw new MayuraError('INVALID_CONFIG', 'quickActionTools(): name is lowercase letters, digits, _ and -, starting with a letter.');
  const policy = originPolicy(options.origins);
  const allowRequestPattern = policy.all ? undefined : originPatterns(options.origins as readonly string[]);
  for (const flag of ['screenshot', 'json', 'crawl'] as const) {
    if (options[flag] !== undefined && typeof options[flag] !== 'boolean') throw new MayuraError('INVALID_CONFIG', `quickActionTools(): ${flag} must be a boolean.`);
  }
  const bound = (value: number | undefined, label: string, fallback: number, min: number, max: number) => {
    const result = value ?? fallback;
    if (!Number.isSafeInteger(result) || result < min || result > max) throw new MayuraError('INVALID_CONFIG', `quickActionTools(): ${label} is ${min} to ${max}.`);
    return result;
  };
  const maxPageBytes = bound(options.maxPageBytes, 'maxPageBytes', 65_536, 1_024, 4_194_304);
  const maxCrawlPages = bound(options.maxCrawlPages, 'maxCrawlPages', 10, 1, 100);
  const crawlTimeoutMs = bound(options.crawlTimeoutMs, 'crawlTimeoutMs', 300_000, 10_000, 3_600_000);
  const costs = options.costMicros ?? {};
  for (const [tool, cost] of Object.entries(costs)) if (!Number.isSafeInteger(cost) || (cost as number) < 0) throw new MayuraError('INVALID_CONFIG', `quickActionTools(): costMicros.${tool} must be a non-negative whole number.`);

  /** The page request for a URL the tools may read, or a refusal the model can act on. */
  const page = (url: unknown) => {
    let parsed: URL;
    try { parsed = new URL(String(url)); } catch { throw new MayuraError('INVALID_INPUT', 'url must be an http(s) URL.'); }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new MayuraError('INVALID_INPUT', 'url must be an http(s) URL.');
    if (!policy.allows(parsed.href)) throw new MayuraError('PERMISSION_DENIED', `${parsed.origin} is outside the sites these tools may read.`);
    return { url: parsed.href, ...(allowRequestPattern ? { allowRequestPattern } : {}) };
  };
  const tool = (id: string, permission: string, cost: number | undefined, description: string, input: Schema<unknown>, inputJsonSchema: JsonObject,
    execute: (request: Record<string, unknown>, signal: AbortSignal) => Promise<JsonObject | ReturnType<typeof withMedia>>, extra: Record<string, unknown> = {}, timeoutMs = 120_000) =>
    defineTool({ id: `${name}.${id}`, version: '1', effects: 'read', capabilities: [`web:${name}:${permission}`], timeoutMs, costMicros: cost ?? 0,
      description, input, output: anything, inputJsonSchema, ...extra,
      execute: async (request: unknown, context: { readonly signal: AbortSignal }) => {
        try { return await execute(request as Record<string, unknown>, context.signal); }
        catch (error) {
          // Mistakes the model can put right come back as the result, so it can try again; Cloudflare's failures are thrown.
          if (error instanceof MayuraError && correctable.has(error.code)) return { error: error.code, message: error.message } as JsonObject;
          throw error;
        }
      } } as never) as unknown as AnyTool;
  const urlField = { type: 'string', description: 'An http(s) URL.' };

  const tools: AnyTool[] = [
    tool('markdown', 'read', costs.markdown, `Read a web page, rendered by Cloudflare's browser, as markdown. Only some sites may be read. Up to ${maxPageBytes} bytes.`,
      object<{ url: string }>({ url: 'string' }, 8_192), schema(['url'], { url: urlField }),
      async (request, signal) => {
        const target = page(request['url']); const content = clip(await actions.markdown(target, { signal }), maxPageBytes);
        return { url: target.url, markdown: content.text, ...(content.truncated ? { truncated: true } : {}) } as JsonObject;
      }),
    tool('links', 'read', costs.links, 'List the links on a web page, rendered by Cloudflare\'s browser.',
      object<{ url: string; visibleOnly?: boolean; excludeExternal?: boolean }>({ url: 'string', visibleOnly: 'boolean?', excludeExternal: 'boolean?' }, 8_192),
      schema(['url'], { url: urlField, visibleOnly: { type: 'boolean' }, excludeExternal: { type: 'boolean' } }),
      async (request, signal) => {
        const target = page(request['url']);
        const links = await actions.links({ ...target, visibleLinksOnly: request['visibleOnly'] === true, excludeExternalLinks: request['excludeExternal'] === true }, { signal });
        return { url: target.url, links: links.slice(0, 1_000) } as unknown as JsonObject;
      }),
    tool('scrape', 'read', costs.scrape, 'Read the elements of a web page that match CSS selectors: their text and attributes.',
      object<{ url: string; selectors: string[] }>({ url: 'string', selectors: 'strings' }, 8_192),
      schema(['url', 'selectors'], { url: urlField, selectors: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 20, description: 'CSS selectors, such as h1 or a.product-link.' } }),
      async (request, signal) => {
        const target = page(request['url']);
        const found = await actions.scrape({ ...target, selectors: request['selectors'] as string[] }, { signal });
        let budget = maxPageBytes; let truncated = false;
        const elements = found.map(group => ({ selector: group.selector, results: group.results.flatMap(element => {
          const text = clip(element.text, Math.max(0, budget)); budget -= encoder.encode(text.text).byteLength;
          if (text.truncated) truncated = true;
          return budget < 0 || (text.text === '' && element.text !== '') ? [] : [{ text: text.text, attributes: element.attributes.slice(0, 20) }];
        }) }));
        return { url: target.url, elements, ...(truncated ? { truncated: true } : {}) } as unknown as JsonObject;
      }),
  ];
  if (options.screenshot) {
    tools.push(tool('screenshot', 'read', costs.screenshot, 'See a web page, rendered by Cloudflare\'s browser, as an image: the visible part, or (fullPage) all of it.',
      object<{ url: string; fullPage?: boolean }>({ url: 'string', fullPage: 'boolean?' }, 8_192), schema(['url'], { url: urlField, fullPage: { type: 'boolean' } }),
      async (request, signal) => {
        const target = page(request['url']);
        const image = await actions.screenshot({ ...target, fullPage: request['fullPage'] === true }, { signal });
        if (image.byteLength > 16 * 1_048_576) throw new MayuraError('LIMIT_EXCEEDED', 'The screenshot is larger than 16 MiB.');
        return withMedia({ url: target.url, bytes: image.byteLength } as JsonObject, [media(image, 'image/png')]);
      }, { media: { accept: ['image/png'], maxItems: 1, maxBytes: 16 * 1_048_576 } }));
  }
  if (options.json) {
    tools.push(tool('json', 'extract', costs.json, 'Pull structured data out of a web page with Cloudflare\'s model: say what to extract in prompt, and optionally give a JSON Schema for its shape.',
      object<{ url: string; prompt: string; schema?: Record<string, unknown> }>({ url: 'string', prompt: 'string', schema: 'object?' }, 8_192, request => request.prompt.trim() === '' ? 'prompt is required.' : undefined),
      schema(['url', 'prompt'], { url: urlField, prompt: { type: 'string' }, schema: { type: 'object', description: 'A JSON Schema for the data.' } }),
      async (request, signal) => {
        const target = page(request['url']);
        const data = await actions.json({ ...target, prompt: request['prompt'] as string, ...(request['schema'] ? { schema: request['schema'] as Record<string, unknown> } : {}) }, { signal });
        if (encoder.encode(JSON.stringify(data ?? null)).byteLength > maxPageBytes) throw new MayuraError('LIMIT_EXCEEDED', `The extracted data is larger than ${maxPageBytes} bytes.`);
        return { url: target.url, data: (data ?? null) as JsonObject } as JsonObject;
      }));
  }
  if (options.crawl) {
    tools.push(tool('crawl', 'crawl', costs.crawl, `Read up to ${maxCrawlPages} pages of a site, starting at a URL and following its links on the same site, as markdown, rendered by Cloudflare's browser.`,
      object<{ url: string; limit?: number; includePattern?: string }>({ url: 'string', limit: 'integer?', includePattern: 'string?' }, 8_192, request => (request.limit ?? 1) > maxCrawlPages ? `limit is at most ${maxCrawlPages}.` : undefined),
      schema(['url'], { url: urlField, limit: { type: 'integer', minimum: 1, maximum: maxCrawlPages }, includePattern: { type: 'string', description: 'A wildcard pattern the pages to read must match, such as https://example.com/docs/**.' } }),
      async (request, signal) => {
        const target = page(request['url']); const limit = (request['limit'] as number | undefined) ?? maxCrawlPages;
        const id = await actions.crawl.start({ ...target, limit, formats: ['markdown'], ...(request['includePattern'] ? { includePatterns: [request['includePattern'] as string] } : {}) }, { signal });
        const deadline = Date.now() + crawlTimeoutMs; let finished = false;
        try {
          for (;;) {
            const status = await actions.crawl.status(id, { signal, limit });
            if (status.status !== 'running') {
              finished = true;
              if (status.status !== 'completed') throw new MayuraError('TOOL_FAILED', `Cloudflare's crawl ended without completing (${status.status}).`);
              // Only pages read, and within the sites allowed.
              const pages = status.records.filter(record => record.status === 'completed' && policy.allows(record.url)).slice(0, limit).map(record => {
                const content = clip(record.markdown ?? '', maxPageBytes);
                return { url: record.url, ...(record.title ? { title: record.title.slice(0, 500) } : {}), markdown: content.text, ...(content.truncated ? { truncated: true } : {}) };
              });
              return { url: target.url, pages } as unknown as JsonObject;
            }
            if (Date.now() >= deadline) throw new MayuraError('TIMEOUT', 'The crawl took too long, and was cancelled.');
            await new Promise((resolve, reject) => {
              const stop = () => { clearTimeout(timer); reject(new MayuraError('CANCELLED', 'The crawl was cancelled.')); };
              const timer = setTimeout(() => { signal.removeEventListener('abort', stop); resolve(undefined); }, 2_000);
              if (signal.aborted) stop(); else signal.addEventListener('abort', stop, { once: true });
            });
          }
        } finally {
          // A crawl not finished is cancelled, so it stops spending.
          if (!finished) await actions.crawl.cancel(id, { signal: AbortSignal.timeout(30_000) }).catch(() => undefined);
        }
      }, {}, crawlTimeoutMs + 60_000));
  }
  return tools;
}
