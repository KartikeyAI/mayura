import { MayuraError } from 'mayura';
import {
  BrowserError, browserHttpFailure, browserResponseFailure,
  type BrowserBackend, type BrowserProvider, type ProviderBrowserSpec,
} from 'mayura/browser';
import { firecrawlBase } from './api.js';

export interface FirecrawlBrowserOptions {
  /** A Firecrawl API key (`fc-...`). Nothing is read from the environment. */
  readonly apiKey: string;
  /**
   * Give each browser a live view (`liveViewUrl`): `'view'` (the default) only shows it; `'interact'` gives Firecrawl's
   * interactive view, which lets whoever has the link use it; `false` gives none.
   */
  readonly liveView?: 'view' | 'interact' | false;
  /** End a browser after this long without activity, in seconds: 300 by default (10 to 3,600). */
  readonly activityTimeoutSeconds?: number;
  /** The longest lifetime; Firecrawl's 1 hour by default. */
  readonly maxLifetimeMs?: number;
  /** For tests and proxies: the fetch to use. */
  readonly fetch?: typeof fetch;
  /** The API's address; `https://api.firecrawl.dev` by default. */
  readonly baseUrl?: string;
}

/** A CDP WebSocket over TLS, or plain only on this machine (a local proxy or a test). */
const secureSocket = /^(?:wss:\/\/|ws:\/\/(?:127\.0\.0\.1|localhost|\[::1\])[:/])/u;

/**
 * Browsers from Firecrawl's Interact sessions: hosted Chromium, driven over CDP from any runtime, with no dependency.
 * Each browser is a session created when opened and deleted when released; Firecrawl ends it at its lifetime (30 s to
 * an hour), or after `activityTimeoutSeconds` without activity. Give the result to `createBrowsers` from `mayura/browser`.
 */
export function firecrawlBrowsers(options: FirecrawlBrowserOptions): BrowserProvider {
  if (!options || typeof options.apiKey !== 'string' || !/^[!-~]{8,512}$/u.test(options.apiKey)) throw new MayuraError('INVALID_CONFIG', 'firecrawlBrowsers(): apiKey must be a Firecrawl API key.');
  const liveView = options.liveView ?? 'view';
  if (liveView !== 'view' && liveView !== 'interact' && liveView !== false) throw new MayuraError('INVALID_CONFIG', "firecrawlBrowsers(): liveView is 'view', 'interact' or false.");
  const activity = options.activityTimeoutSeconds ?? 300;
  if (!Number.isSafeInteger(activity) || activity < 10 || activity > 3_600) throw new MayuraError('INVALID_CONFIG', 'firecrawlBrowsers(): activityTimeoutSeconds is 10 to 3,600.');
  const maxLifetimeMs = options.maxLifetimeMs ?? 3_600_000;
  if (!Number.isSafeInteger(maxLifetimeMs) || maxLifetimeMs < 30_000 || maxLifetimeMs > 3_600_000) throw new MayuraError('INVALID_CONFIG', 'firecrawlBrowsers(): maxLifetimeMs is 30 s to 1 hour.');
  if (options.fetch !== undefined && typeof options.fetch !== 'function') throw new MayuraError('INVALID_CONFIG', 'firecrawlBrowsers(): fetch must be a function.');
  const base = firecrawlBase(options.baseUrl, 'firecrawlBrowsers');
  const fetcher = options.fetch ?? globalThis.fetch;
  const headers = (json = false) => ({ authorization: `Bearer ${options.apiKey}`, ...(json ? { 'content-type': 'application/json' } : {}) });

  const create = async (spec: ProviderBrowserSpec, { signal }: { readonly signal: AbortSignal }): Promise<BrowserBackend> => {
    const created = await fetcher(`${base}/v2/interact`, { method: 'POST', signal, headers: headers(true), body: JSON.stringify({
      // Firecrawl ends the session at its ttl, should a release never come (at least 30 s).
      ttl: Math.max(30, Math.ceil(spec.lifetimeMs / 1_000)), activityTtl: activity,
    }) });
    if (!created.ok) throw browserResponseFailure(created);
    const session = await created.json().catch(() => undefined) as { id?: unknown; cdpUrl?: unknown; liveViewUrl?: unknown; interactiveLiveViewUrl?: unknown } | undefined;
    if (typeof session?.id !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/u.test(session.id) || typeof session.cdpUrl !== 'string' || !secureSocket.test(session.cdpUrl)) {
      throw new BrowserError('invalid_response');
    }
    const id = session.id;
    // Without liveView, createBrowsers shows no live view.
    const view = liveView === 'interact' ? session.interactiveLiveViewUrl : session.liveViewUrl;
    return {
      id, cdp: { url: session.cdpUrl }, ...(typeof view === 'string' ? { liveViewUrl: view } : {}),
      release: async ({ signal: callSignal }) => {
        const reply = await fetcher(`${base}/v2/interact/${id}`, { method: 'DELETE', signal: callSignal, headers: headers() });
        void reply.body?.cancel().catch(() => undefined);
        // 404: deleted already, which createBrowsers counts as released.
        if (!reply.ok) throw browserHttpFailure(reply.status);
      },
    };
  };

  return Object.freeze({ id: 'firecrawl', features: Object.freeze({ liveView: liveView !== false }), maxLifetimeMs, create });
}
