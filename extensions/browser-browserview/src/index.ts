import { MayuraError } from 'mayura';
import {
  BrowserError, browserHttpFailure, browserResponseFailure, resolveCdpUrl,
  type BrowserBackend, type BrowserProvider, type ProviderBrowserSpec,
} from 'mayura/browser';

export interface BrowserViewBrowserOptions {
  /** A BrowserView API key (`bv_live_...`). Nothing is read from the environment. */
  readonly apiKey: string;
  /**
   * Give each browser a live view (`liveViewUrl`), a link with a token in it: `'view'` (the default) is BrowserView's
   * watch link; `'interact'` its viewer, which lets whoever has the link use the browser; `false` gives none.
   */
  readonly liveView?: 'view' | 'interact' | false;
  /** BrowserView's stealth mode; off here, though BrowserView's own default is on. */
  readonly stealth?: boolean;
  /** End a session after this long without activity, in seconds; off by default, as the lifetime ends it. */
  readonly idleTimeoutSeconds?: number;
  /** The longest lifetime; 4 hours by default (BrowserView's paid plans; 15 minutes on its free plan). */
  readonly maxLifetimeMs?: number;
  /** For tests and proxies: the fetch to use. */
  readonly fetch?: typeof fetch;
  /** The API's address; `https://sessions.browserview.io` by default. */
  readonly baseUrl?: string;
}

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

/**
 * Browsers as BrowserView sessions: hosted Chromium, driven over CDP from any runtime, with no dependency. Each browser
 * is a session created when opened and released when done; it is not kept alive, so it also ends shortly after its
 * connection does, and BrowserView ends it at its lifetime. Its CDP connection needs a header: on a runtime whose
 * WebSocket cannot send one, give `createBrowsers` a `webSocket`. Give the result to `createBrowsers` from `mayura/browser`.
 */
export function browserViewBrowsers(options: BrowserViewBrowserOptions): BrowserProvider {
  if (!options || typeof options.apiKey !== 'string' || !/^[!-~]{8,512}$/u.test(options.apiKey)) throw new MayuraError('INVALID_CONFIG', 'browserViewBrowsers(): apiKey must be a BrowserView API key.');
  const liveView = options.liveView ?? 'view';
  if (liveView !== 'view' && liveView !== 'interact' && liveView !== false) throw new MayuraError('INVALID_CONFIG', "browserViewBrowsers(): liveView is 'view', 'interact' or false.");
  if (options.stealth !== undefined && typeof options.stealth !== 'boolean') throw new MayuraError('INVALID_CONFIG', 'browserViewBrowsers(): stealth must be a boolean.');
  const idle = options.idleTimeoutSeconds ?? 0;
  if (!Number.isSafeInteger(idle) || idle < 0) throw new MayuraError('INVALID_CONFIG', 'browserViewBrowsers(): idleTimeoutSeconds is a whole number of seconds, or 0 for none.');
  const maxLifetimeMs = options.maxLifetimeMs ?? 14_400_000;
  if (!Number.isSafeInteger(maxLifetimeMs) || maxLifetimeMs < 1_000 || maxLifetimeMs > 14_400_000) throw new MayuraError('INVALID_CONFIG', 'browserViewBrowsers(): maxLifetimeMs is 1 s to 4 hours.');
  if (options.fetch !== undefined && typeof options.fetch !== 'function') throw new MayuraError('INVALID_CONFIG', 'browserViewBrowsers(): fetch must be a function.');
  const base = (() => {
    try { const url = new URL(options.baseUrl ?? 'https://sessions.browserview.io'); if (url.protocol !== 'https:' && url.hostname !== '127.0.0.1' && url.hostname !== 'localhost') throw new Error(); return url.origin; }
    catch { throw new MayuraError('INVALID_CONFIG', 'browserViewBrowsers(): baseUrl must be an https URL.'); }
  })();
  const fetcher = options.fetch ?? globalThis.fetch;
  const headers = (json = false) => ({ authorization: `Bearer ${options.apiKey}`, ...(json ? { 'content-type': 'application/json' } : {}) });
  /** One of BrowserView's paths as a URL of its own service; anything else is refused. */
  const own = (path: unknown): string | undefined => typeof path === 'string' && /^\/[^/\\]/u.test(path) ? new URL(path, base).href : undefined;

  const create = async (spec: ProviderBrowserSpec, { signal }: { readonly signal: AbortSignal }): Promise<BrowserBackend> => {
    const created = await fetcher(`${base}/sessions`, { method: 'POST', signal, headers: headers(true), body: JSON.stringify({
      width: clamp(spec.viewport.width, 320, 3_840), height: clamp(spec.viewport.height, 240, 2_160),
      // BrowserView ends the session at its timeout, should a release never come.
      timeout_seconds: Math.ceil(spec.lifetimeMs / 1_000), idle_timeout_seconds: idle,
      // Not kept alive: the session ends shortly after its connection does.
      keep_alive: false,
      stealth: options.stealth ?? false, proxies: false, solve_captchas: false, downloads: false, record: false, agent: false,
      ...(Object.keys(spec.labels).length ? { metadata: { ...spec.labels } } : {}),
    }) });
    if (!created.ok) throw browserResponseFailure(created);
    const session = await created.json().catch(() => undefined) as { id?: unknown; cdp_url?: unknown; cdp_token?: unknown; watch_url?: unknown; viewer_url?: unknown } | undefined;
    const endpoint = own(session?.cdp_url);
    if (typeof session?.id !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/u.test(session.id) || !endpoint || typeof session.cdp_token !== 'string' || !/^[!-~]{1,4096}$/u.test(session.cdp_token)) {
      throw new BrowserError('invalid_response');
    }
    const id = session.id; const cdpHeaders = { 'x-session-token': session.cdp_token };
    const release = async ({ signal: callSignal }: { readonly signal: AbortSignal }) => {
      // BrowserView's release is idempotent; 404 means the session is gone.
      const reply = await fetcher(`${base}/sessions/${id}/release`, { method: 'POST', signal: callSignal, headers: headers() });
      void reply.body?.cancel().catch(() => undefined);
      if (!reply.ok) throw browserHttpFailure(reply.status);
    };
    // The CDP URL is the session's http address, asked (with its token) for the browser's WebSocket.
    let url: string;
    try { url = await resolveCdpUrl(endpoint, { headers: cdpHeaders, signal, fetch: fetcher }); }
    catch (error) { await release({ signal: AbortSignal.timeout(30_000) }).catch(() => undefined); throw error; }
    // Without liveView, createBrowsers shows no live view.
    const view = own(liveView === 'interact' ? session.viewer_url : session.watch_url);
    return { id, cdp: { url, headers: cdpHeaders }, ...(view ? { liveViewUrl: view } : {}), release };
  };

  return Object.freeze({ id: 'browserview', features: Object.freeze({ liveView: liveView !== false }), maxLifetimeMs, create });
}
