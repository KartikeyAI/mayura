import { MayuraError } from 'mayura';
import {
  BrowserError, browserHttpFailure, browserResponseFailure,
  type BrowserBackend, type BrowserProvider, type ProviderBrowserSpec,
} from 'mayura/browser';

export interface HyperbrowserBrowserOptions {
  /** A Hyperbrowser API key. Nothing is read from the environment. */
  readonly apiKey: string;
  /**
   * Give each browser a live view (`liveViewUrl`), a link with a token in it: `'view'` (the default) only shows the
   * session; `'interact'` also lets whoever has the link use it; `false` gives none.
   */
  readonly liveView?: 'view' | 'interact' | false;
  /** Let Hyperbrowser solve captchas; off by default. */
  readonly solveCaptchas?: boolean;
  /** Block ads; off by default. */
  readonly adblock?: boolean;
  /** Where sessions run, as Hyperbrowser names regions; Hyperbrowser's default otherwise. */
  readonly region?: string;
  /** The longest lifetime; Hyperbrowser's 12 hours by default. */
  readonly maxLifetimeMs?: number;
  /** For tests and proxies: the fetch to use. */
  readonly fetch?: typeof fetch;
  /** The API's address; `https://api.hyperbrowser.ai` by default. */
  readonly baseUrl?: string;
}

/** Statuses of a session that has ended; `close-error` is not one, as the session may still run. */
const ended = new Set(['closed', 'error']);
/** A CDP WebSocket over TLS, or plain only on this machine (a local proxy or a test). */
const secureSocket = /^(?:wss:\/\/|ws:\/\/(?:127\.0\.0\.1|localhost|\[::1\])[:/])/u;

/**
 * Browsers as Hyperbrowser sessions: hosted Chromium, driven over CDP from any runtime, with no dependency. Each browser
 * is a session created when opened and stopped when done; it also stops when its connection does, or at its lifetime.
 * Give the result to `createBrowsers` from `mayura/browser`.
 */
export function hyperbrowserBrowsers(options: HyperbrowserBrowserOptions): BrowserProvider {
  if (!options || typeof options.apiKey !== 'string' || !/^[!-~]{8,512}$/u.test(options.apiKey)) throw new MayuraError('INVALID_CONFIG', 'hyperbrowserBrowsers(): apiKey must be a Hyperbrowser API key.');
  const liveView = options.liveView ?? 'view';
  if (liveView !== 'view' && liveView !== 'interact' && liveView !== false) throw new MayuraError('INVALID_CONFIG', "hyperbrowserBrowsers(): liveView is 'view', 'interact' or false.");
  for (const flag of ['solveCaptchas', 'adblock'] as const) {
    if (options[flag] !== undefined && typeof options[flag] !== 'boolean') throw new MayuraError('INVALID_CONFIG', `hyperbrowserBrowsers(): ${flag} must be a boolean.`);
  }
  if (options.region !== undefined && (typeof options.region !== 'string' || !/^[a-z0-9-]{2,32}$/u.test(options.region))) throw new MayuraError('INVALID_CONFIG', 'hyperbrowserBrowsers(): region must be a Hyperbrowser region.');
  const maxLifetimeMs = options.maxLifetimeMs ?? 43_200_000;
  if (!Number.isSafeInteger(maxLifetimeMs) || maxLifetimeMs < 60_000 || maxLifetimeMs > 43_200_000) throw new MayuraError('INVALID_CONFIG', 'hyperbrowserBrowsers(): maxLifetimeMs is 1 minute to 12 hours.');
  if (options.fetch !== undefined && typeof options.fetch !== 'function') throw new MayuraError('INVALID_CONFIG', 'hyperbrowserBrowsers(): fetch must be a function.');
  const base = (() => {
    try { const url = new URL(options.baseUrl ?? 'https://api.hyperbrowser.ai'); if (url.protocol !== 'https:' && url.hostname !== '127.0.0.1' && url.hostname !== 'localhost') throw new Error(); return url.origin; }
    catch { throw new MayuraError('INVALID_CONFIG', 'hyperbrowserBrowsers(): baseUrl must be an https URL.'); }
  })();
  const fetcher = options.fetch ?? globalThis.fetch;
  const headers = (json = false) => ({ 'x-api-key': options.apiKey, ...(json ? { 'content-type': 'application/json' } : {}) });

  const create = async (spec: ProviderBrowserSpec, { signal }: { readonly signal: AbortSignal }): Promise<BrowserBackend> => {
    const created = await fetcher(`${base}/api/session`, { method: 'POST', signal, headers: headers(true), body: JSON.stringify({
      // Hyperbrowser stops the session at its timeout, should a stop never come (1 to 720 minutes).
      timeoutMinutes: Math.min(720, Math.max(1, Math.ceil(spec.lifetimeMs / 60_000))),
      screen: { width: spec.viewport.width, height: spec.viewport.height },
      ...(options.region ? { region: options.region } : {}),
      useProxy: false, useStealth: false, solveCaptchas: options.solveCaptchas ?? false, adblock: options.adblock ?? false,
      enableWebRecording: false, enableVideoWebRecording: false, saveDownloads: false,
      viewOnlyLiveView: liveView !== 'interact',
    }) });
    if (!created.ok) throw browserResponseFailure(created);
    const session = await created.json().catch(() => undefined) as { id?: unknown; wsEndpoint?: unknown; liveUrl?: unknown } | undefined;
    if (typeof session?.id !== 'string' || !/^[A-Za-z0-9-]{1,128}$/u.test(session.id) || typeof session.wsEndpoint !== 'string' || !secureSocket.test(session.wsEndpoint)) {
      throw new BrowserError('invalid_response');
    }
    const id = session.id;
    // Not kept alive: the session stops when its connection does.
    return {
      id, cdp: { url: session.wsEndpoint },
      ...(liveView && typeof session.liveUrl === 'string' ? { liveViewUrl: session.liveUrl } : {}),
      release: async ({ signal: callSignal }) => {
        const reply = await fetcher(`${base}/api/session/${id}/stop`, { method: 'PUT', signal: callSignal, headers: headers() });
        void reply.body?.cancel().catch(() => undefined);
        if (reply.ok) return;
        // A session that already ended may not be stoppable: ask how it is before calling that a failure (a 404 below
        // means it is gone).
        const state = await fetcher(`${base}/api/session/${id}`, { signal: callSignal, headers: headers() });
        const status = state.ok ? (await state.json().catch(() => undefined) as { status?: unknown } | undefined)?.status : (void state.body?.cancel().catch(() => undefined), undefined);
        if (typeof status === 'string' && ended.has(status)) return;
        throw browserHttpFailure(reply.status);
      },
    };
  };

  return Object.freeze({ id: 'hyperbrowser', features: Object.freeze({ liveView: liveView !== false }), maxLifetimeMs, create });
}
