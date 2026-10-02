import { MayuraError } from 'mayura';
import {
  BrowserError, browserHttpFailure, browserResponseFailure,
  type BrowserBackend, type BrowserProvider, type ProviderBrowserSpec,
} from 'mayura/browser';

export interface SteelBrowserOptions {
  /** A Steel API key. Nothing is read from the environment. */
  readonly apiKey: string;
  /**
   * Give each browser a live view (`liveViewUrl`): Steel's session viewer, which needs no sign-in, so anyone with the
   * URL can see the session. `'view'` (the default) only shows it; `'interact'` also lets them use it; `false` gives none.
   */
  readonly liveView?: 'view' | 'interact' | false;
  /** Let Steel solve captchas; off by default. */
  readonly solveCaptcha?: boolean;
  /** Block ads; off by default. */
  readonly blockAds?: boolean;
  /** End a session after this long without CDP commands or input, in milliseconds; unset by default. */
  readonly inactivityTimeoutMs?: number;
  /** The longest lifetime; 24 hours by default (Steel's plans allow 15 minutes to 24 hours). */
  readonly maxLifetimeMs?: number;
  /** For tests and proxies: the fetch to use. */
  readonly fetch?: typeof fetch;
  /** The API's address; `https://api.steel.dev` by default. */
  readonly baseUrl?: string;
}

const ended = new Set(['released', 'failed']);
/** A CDP WebSocket over TLS, or plain only on this machine (a local proxy or a test). */
const secureSocket = /^(?:wss:\/\/|ws:\/\/(?:127\.0\.0\.1|localhost|\[::1\])[:/])/u;

/**
 * Browsers as Steel sessions: hosted Chromium, driven over CDP from any runtime, with no dependency. Each browser is a
 * session created when opened and released when done. A Steel session outlives its connection, so a browser not
 * released runs until its lifetime, which is given to Steel as the session's timeout.
 * Give the result to `createBrowsers` from `mayura/browser`.
 */
export function steelBrowsers(options: SteelBrowserOptions): BrowserProvider {
  if (!options || typeof options.apiKey !== 'string' || !/^[!-~]{8,512}$/u.test(options.apiKey)) throw new MayuraError('INVALID_CONFIG', 'steelBrowsers(): apiKey must be a Steel API key.');
  const liveView = options.liveView ?? 'view';
  if (liveView !== 'view' && liveView !== 'interact' && liveView !== false) throw new MayuraError('INVALID_CONFIG', "steelBrowsers(): liveView is 'view', 'interact' or false.");
  for (const flag of ['solveCaptcha', 'blockAds'] as const) {
    if (options[flag] !== undefined && typeof options[flag] !== 'boolean') throw new MayuraError('INVALID_CONFIG', `steelBrowsers(): ${flag} must be a boolean.`);
  }
  const maxLifetimeMs = options.maxLifetimeMs ?? 86_400_000;
  if (!Number.isSafeInteger(maxLifetimeMs) || maxLifetimeMs < 15_000 || maxLifetimeMs > 86_400_000) throw new MayuraError('INVALID_CONFIG', 'steelBrowsers(): maxLifetimeMs is 15 s to 24 hours.');
  const inactivity = options.inactivityTimeoutMs;
  if (inactivity !== undefined && (!Number.isSafeInteger(inactivity) || inactivity < 1_000)) throw new MayuraError('INVALID_CONFIG', 'steelBrowsers(): inactivityTimeoutMs is at least 1 s.');
  if (options.fetch !== undefined && typeof options.fetch !== 'function') throw new MayuraError('INVALID_CONFIG', 'steelBrowsers(): fetch must be a function.');
  const base = (() => {
    try { const url = new URL(options.baseUrl ?? 'https://api.steel.dev'); if (url.protocol !== 'https:' && url.hostname !== '127.0.0.1' && url.hostname !== 'localhost') throw new Error(); return url.origin; }
    catch { throw new MayuraError('INVALID_CONFIG', 'steelBrowsers(): baseUrl must be an https URL.'); }
  })();
  const fetcher = options.fetch ?? globalThis.fetch;
  const headers = (json = false) => ({ 'steel-api-key': options.apiKey, ...(json ? { 'content-type': 'application/json' } : {}) });

  const create = async (spec: ProviderBrowserSpec, { signal }: { readonly signal: AbortSignal }): Promise<BrowserBackend> => {
    // Steel ends the session at its timeout, should a release never come (at least 15 s).
    const timeout = Math.max(15_000, spec.lifetimeMs);
    if (inactivity !== undefined && inactivity >= timeout) throw new MayuraError('INVALID_INPUT', 'inactivityTimeoutMs must be shorter than the lifetime.');
    const created = await fetcher(`${base}/v1/sessions`, { method: 'POST', signal, headers: headers(true), body: JSON.stringify({
      timeout, ...(inactivity !== undefined ? { inactivityTimeout: inactivity } : {}),
      dimensions: { width: spec.viewport.width, height: spec.viewport.height },
      solveCaptcha: options.solveCaptcha ?? false, blockAds: options.blockAds ?? false, useProxy: false,
    }) });
    if (!created.ok) throw browserResponseFailure(created);
    const session = await created.json().catch(() => undefined) as { id?: unknown; websocketUrl?: unknown; debugUrl?: unknown } | undefined;
    if (typeof session?.id !== 'string' || !/^[A-Za-z0-9-]{1,128}$/u.test(session.id) || typeof session.websocketUrl !== 'string' || !secureSocket.test(session.websocketUrl)) {
      throw new BrowserError('invalid_response');
    }
    const id = session.id;
    // Steel takes the key on the WebSocket as a query parameter.
    const cdp = new URL(session.websocketUrl); cdp.searchParams.set('apiKey', options.apiKey);
    let liveViewUrl: string | undefined;
    if (liveView && typeof session.debugUrl === 'string') {
      try { const view = new URL(session.debugUrl); view.searchParams.set('interactive', liveView === 'interact' ? 'true' : 'false'); liveViewUrl = view.href; }
      catch { /* no live view */ }
    }
    return {
      id, cdp: { url: cdp.href }, ...(liveViewUrl ? { liveViewUrl } : {}),
      release: async ({ signal: callSignal }) => {
        const reply = await fetcher(`${base}/v1/sessions/${id}/release`, { method: 'POST', signal: callSignal, headers: headers(true), body: '{}' });
        void reply.body?.cancel().catch(() => undefined);
        if (reply.ok) return;
        // A session that already ended may not be releasable: ask how it is before calling that a failure.
        const state = await fetcher(`${base}/v1/sessions/${id}`, { signal: callSignal, headers: headers() });
        const status = state.ok ? (await state.json().catch(() => undefined) as { status?: unknown } | undefined)?.status : (void state.body?.cancel().catch(() => undefined), undefined);
        if (state.status === 404 || (typeof status === 'string' && ended.has(status))) return;
        throw browserHttpFailure(reply.status);
      },
    };
  };

  return Object.freeze({ id: 'steel', features: Object.freeze({ liveView: liveView !== false }), maxLifetimeMs, create });
}
