import { MayuraError } from '@mayura/core';
import { resolveCdpUrl } from './cdp.js';
import type { BrowserProvider, ProviderBrowserSpec } from './contracts.js';

export interface CdpBrowsersOptions {
  /** The browser's CDP endpoint: a `ws(s)://` URL, or `http://host:port` (asked for its WebSocket URL). */
  readonly endpoint: string;
  /** Headers the endpoint needs, such as a token. */
  readonly headers?: Readonly<Record<string, string>>;
  /** The longest lifetime; 24 hours by default. */
  readonly maxLifetimeMs?: number;
  /** For tests and proxies: the fetch that asks an http endpoint for its WebSocket URL. */
  readonly fetch?: typeof fetch;
}

const headerName = /^[A-Za-z0-9-]{1,128}$/u;

/**
 * Browsers in a Chrome you already run, such as one started with `--remote-debugging-port`, or any service that gives
 * a CDP endpoint. Each browser is a new browser context in it, closed on release; its other tabs are left alone.
 */
export function cdpBrowsers(options: CdpBrowsersOptions): BrowserProvider {
  if (!options || typeof options.endpoint !== 'string' || !/^(?:wss?|https?):\/\/[^\s]{1,4096}$/u.test(options.endpoint)) {
    throw new MayuraError('INVALID_CONFIG', 'cdpBrowsers(): endpoint is a ws(s):// or http(s):// URL.');
  }
  const headers = options.headers ?? {};
  if (!headers || typeof headers !== 'object' || Object.entries(headers).some(([name, value]) => !headerName.test(name) || typeof value !== 'string' || /[\r\n\0]/u.test(value))) {
    throw new MayuraError('INVALID_CONFIG', 'cdpBrowsers(): headers are names and single-line values.');
  }
  const maxLifetimeMs = options.maxLifetimeMs ?? 86_400_000;
  if (!Number.isSafeInteger(maxLifetimeMs) || maxLifetimeMs < 1_000 || maxLifetimeMs > 2_147_483_647) throw new MayuraError('INVALID_CONFIG', 'cdpBrowsers(): maxLifetimeMs is 1 s to about 24 days.');
  let count = 0;
  return Object.freeze({
    id: 'cdp', maxLifetimeMs, features: Object.freeze({ liveView: false }),
    create: async (_spec: ProviderBrowserSpec, { signal }: { readonly signal: AbortSignal }) => {
      const url = await resolveCdpUrl(options.endpoint, { headers, signal, ...(options.fetch ? { fetch: options.fetch } : {}) });
      return { id: `cdp-${++count}`, cdp: { url, headers }, isolate: true, release: async () => undefined };
    },
  });
}
