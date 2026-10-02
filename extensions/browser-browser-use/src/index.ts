import { MayuraError } from 'mayura';
import {
  BrowserError, browserHttpFailure, browserResponseFailure, resolveCdpUrl,
  type BrowserBackend, type BrowserProvider, type ProviderBrowserSpec,
} from 'mayura/browser';

export interface BrowserUseBrowserOptions {
  /** A Browser Use Cloud API key. Nothing is read from the environment. */
  readonly apiKey: string;
  /**
   * Give each browser Browser Use's live view (`liveViewUrl`); off by default, as whoever has the link may be able to
   * use the browser, not only watch it.
   */
  readonly liveView?: boolean;
  /** Route browsing through Browser Use's proxy in this country, such as `us`; no proxy by default (Browser Use's own default is `us`). */
  readonly proxyCountryCode?: string;
  /** Let Browser Use solve captchas; off here, though Browser Use's own default is on. */
  readonly solveCaptchas?: boolean;
  /** The longest lifetime; Browser Use's 4 hours by default. */
  readonly maxLifetimeMs?: number;
  /** For tests and proxies: the fetch to use. */
  readonly fetch?: typeof fetch;
  /** The API's address; `https://api.browser-use.com` by default. */
  readonly baseUrl?: string;
}

/** A CDP URL over TLS, or plain only on this machine (a local proxy or a test). */
const secureEndpoint = /^(?:wss|https):\/\/|^(?:ws|http):\/\/(?:127\.0\.0\.1|localhost|\[::1\])[:/]/u;

/**
 * Browsers from Browser Use Cloud: hosted Chromium, driven over CDP from any runtime, with no dependency. Each browser
 * is created when opened and stopped when released; Browser Use stops it at its lifetime too. A Browser Use browser
 * outlives its connection: only stopping ends it. Give the result to `createBrowsers` from `mayura/browser`.
 */
export function browserUseBrowsers(options: BrowserUseBrowserOptions): BrowserProvider {
  if (!options || typeof options.apiKey !== 'string' || !/^[!-~]{8,512}$/u.test(options.apiKey)) throw new MayuraError('INVALID_CONFIG', 'browserUseBrowsers(): apiKey must be a Browser Use API key.');
  for (const flag of ['liveView', 'solveCaptchas'] as const) {
    if (options[flag] !== undefined && typeof options[flag] !== 'boolean') throw new MayuraError('INVALID_CONFIG', `browserUseBrowsers(): ${flag} must be a boolean.`);
  }
  if (options.proxyCountryCode !== undefined && (typeof options.proxyCountryCode !== 'string' || !/^[a-z]{2}$/u.test(options.proxyCountryCode))) {
    throw new MayuraError('INVALID_CONFIG', 'browserUseBrowsers(): proxyCountryCode is a two-letter country code, such as us.');
  }
  const maxLifetimeMs = options.maxLifetimeMs ?? 14_400_000;
  if (!Number.isSafeInteger(maxLifetimeMs) || maxLifetimeMs < 60_000 || maxLifetimeMs > 14_400_000) throw new MayuraError('INVALID_CONFIG', 'browserUseBrowsers(): maxLifetimeMs is 1 minute to 4 hours.');
  if (options.fetch !== undefined && typeof options.fetch !== 'function') throw new MayuraError('INVALID_CONFIG', 'browserUseBrowsers(): fetch must be a function.');
  const base = (() => {
    try { const url = new URL(options.baseUrl ?? 'https://api.browser-use.com'); if (url.protocol !== 'https:' && url.hostname !== '127.0.0.1' && url.hostname !== 'localhost') throw new Error(); return url.origin; }
    catch { throw new MayuraError('INVALID_CONFIG', 'browserUseBrowsers(): baseUrl must be an https URL.'); }
  })();
  const fetcher = options.fetch ?? globalThis.fetch;
  const liveView = options.liveView ?? false;
  const headers = (json = false) => ({ 'x-browser-use-api-key': options.apiKey, ...(json ? { 'content-type': 'application/json' } : {}) });

  const create = async (spec: ProviderBrowserSpec, { signal }: { readonly signal: AbortSignal }): Promise<BrowserBackend> => {
    if (Object.keys(spec.labels).length > 10) throw new MayuraError('INVALID_INPUT', 'Browser Use takes at most 10 labels.');
    const created = await fetcher(`${base}/api/v2/browsers`, { method: 'POST', signal, headers: headers(true), body: JSON.stringify({
      // Browser Use stops the browser at its timeout, should a stop never come: whole minutes, 1 to 240 as the
      // lifetime is at most 4 hours.
      timeout: Math.ceil(spec.lifetimeMs / 60_000),
      browserScreenWidth: Math.max(320, spec.viewport.width), browserScreenHeight: Math.max(320, spec.viewport.height),
      // Browser Use proxies through the US unless told otherwise.
      proxyCountryCode: options.proxyCountryCode ?? null,
      solveCaptchas: options.solveCaptchas ?? false, enableRecording: false,
      ...(Object.keys(spec.labels).length ? { metadata: { ...spec.labels } } : {}),
    }) });
    if (!created.ok) throw browserResponseFailure(created);
    const browser = await created.json().catch(() => undefined) as { id?: unknown; cdpUrl?: unknown; liveUrl?: unknown } | undefined;
    if (typeof browser?.id !== 'string' || !/^[A-Za-z0-9-]{1,128}$/u.test(browser.id) || typeof browser.cdpUrl !== 'string' || !secureEndpoint.test(browser.cdpUrl)) {
      throw new BrowserError('invalid_response');
    }
    const id = browser.id;
    const release = async ({ signal: callSignal }: { readonly signal: AbortSignal }) => {
      const reply = await fetcher(`${base}/api/v2/browsers/${id}`, { method: 'PATCH', signal: callSignal, headers: headers(true), body: JSON.stringify({ action: 'stop' }) });
      void reply.body?.cancel().catch(() => undefined);
      if (reply.ok) return;
      // A browser that already stopped may not be stoppable: ask how it is before calling that a failure.
      const state = await fetcher(`${base}/api/v2/browsers/${id}`, { signal: callSignal, headers: headers() });
      const status = state.ok ? (await state.json().catch(() => undefined) as { status?: unknown } | undefined)?.status : (void state.body?.cancel().catch(() => undefined), undefined);
      if (state.status === 404 || status === 'stopped') return;
      throw browserHttpFailure(reply.status);
    };
    // Without liveView, createBrowsers shows no live view. The CDP URL is a WebSocket, or the browser's http(s)
    // address, asked for its WebSocket.
    let url: string;
    try { url = /^wss?:/u.test(browser.cdpUrl) ? browser.cdpUrl : await resolveCdpUrl(browser.cdpUrl, { signal, fetch: fetcher }); }
    catch (error) { await release({ signal: AbortSignal.timeout(30_000) }).catch(() => undefined); throw error; }
    return { id, cdp: { url }, ...(typeof browser.liveUrl === 'string' ? { liveViewUrl: browser.liveUrl } : {}), release };
  };

  return Object.freeze({ id: 'browser-use', features: Object.freeze({ liveView }), maxLifetimeMs, create });
}
