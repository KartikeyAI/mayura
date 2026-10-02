import { MayuraError } from 'mayura';
import {
  BrowserError, browserHttpFailure, browserResponseFailure,
  type BrowserBackend, type BrowserProvider, type ProviderBrowserSpec,
} from 'mayura/browser';

export interface AnchorBrowserOptions {
  /** An Anchor Browser API key. Nothing is read from the environment. */
  readonly apiKey: string;
  /**
   * Give each browser a live view (`liveViewUrl`): `'view'` (the default) only shows the session; `'interact'` also
   * lets whoever has the link use it; `false` gives none and runs the browser headless.
   */
  readonly liveView?: 'view' | 'interact' | false;
  /** Block ads; off here, though Anchor's own default is on. */
  readonly adblock?: boolean;
  /** Record sessions; off here, though Anchor's own default is on. */
  readonly recording?: boolean;
  /**
   * How long a session waits once nothing is connected before Anchor ends it, in minutes: 1 by default. It ends a
   * session whose release never came, such as when this process stops.
   */
  readonly idleTimeoutMinutes?: number;
  /** The longest lifetime; 24 hours by default. */
  readonly maxLifetimeMs?: number;
  /** For tests and proxies: the fetch to use. */
  readonly fetch?: typeof fetch;
  /** The API's address; `https://api.anchorbrowser.io` by default. */
  readonly baseUrl?: string;
}

/** A CDP WebSocket over TLS, or plain only on this machine (a local proxy or a test). */
const secureSocket = /^(?:wss:\/\/|ws:\/\/(?:127\.0\.0\.1|localhost|\[::1\])[:/])/u;

/**
 * Browsers as Anchor Browser sessions: hosted Chromium, driven over CDP from any runtime, with no dependency. Each
 * browser is a session created when opened and ended when released; Anchor ends it at its lifetime, or soon after
 * nothing is connected, too. Give the result to `createBrowsers` from `mayura/browser`.
 */
export function anchorBrowsers(options: AnchorBrowserOptions): BrowserProvider {
  if (!options || typeof options.apiKey !== 'string' || !/^[!-~]{8,512}$/u.test(options.apiKey)) throw new MayuraError('INVALID_CONFIG', 'anchorBrowsers(): apiKey must be an Anchor Browser API key.');
  const liveView = options.liveView ?? 'view';
  if (liveView !== 'view' && liveView !== 'interact' && liveView !== false) throw new MayuraError('INVALID_CONFIG', "anchorBrowsers(): liveView is 'view', 'interact' or false.");
  for (const flag of ['adblock', 'recording'] as const) {
    if (options[flag] !== undefined && typeof options[flag] !== 'boolean') throw new MayuraError('INVALID_CONFIG', `anchorBrowsers(): ${flag} must be a boolean.`);
  }
  const idle = options.idleTimeoutMinutes ?? 1;
  if (!Number.isSafeInteger(idle) || idle < 1 || idle > 1_440) throw new MayuraError('INVALID_CONFIG', 'anchorBrowsers(): idleTimeoutMinutes is 1 to 1,440.');
  const maxLifetimeMs = options.maxLifetimeMs ?? 86_400_000;
  // createBrowsers keeps lifetimes within what its timers reach.
  if (!Number.isSafeInteger(maxLifetimeMs) || maxLifetimeMs < 60_000) throw new MayuraError('INVALID_CONFIG', 'anchorBrowsers(): maxLifetimeMs is at least 1 minute.');
  if (options.fetch !== undefined && typeof options.fetch !== 'function') throw new MayuraError('INVALID_CONFIG', 'anchorBrowsers(): fetch must be a function.');
  const base = (() => {
    try { const url = new URL(options.baseUrl ?? 'https://api.anchorbrowser.io'); if (url.protocol !== 'https:' && url.hostname !== '127.0.0.1' && url.hostname !== 'localhost') throw new Error(); return url.origin; }
    catch { throw new MayuraError('INVALID_CONFIG', 'anchorBrowsers(): baseUrl must be an https URL.'); }
  })();
  const fetcher = options.fetch ?? globalThis.fetch;
  const headers = (json = false) => ({ 'anchor-api-key': options.apiKey, ...(json ? { 'content-type': 'application/json' } : {}) });

  const create = async (spec: ProviderBrowserSpec, { signal }: { readonly signal: AbortSignal }): Promise<BrowserBackend> => {
    const created = await fetcher(`${base}/v1/sessions`, { method: 'POST', signal, headers: headers(true), body: JSON.stringify({
      session: {
        // Anchor ends the session at its maximum duration, should a release never come; its docs disagree on the
        // default, so it is always given.
        timeout: { max_duration: Math.ceil(spec.lifetimeMs / 60_000), idle_timeout: idle },
        recording: { active: options.recording ?? false },
        proxy: { active: false },
        ...(liveView ? { live_view: { read_only: liveView === 'view' } } : {}),
        ...(Object.keys(spec.labels).length ? { tags: Object.entries(spec.labels).map(([key, value]) => `${key}=${value}`) } : {}),
      },
      browser: {
        viewport: { width: spec.viewport.width, height: spec.viewport.height },
        adblock: { active: options.adblock ?? false },
        captcha_solver: { active: false },
        // Anchor's live view needs a browser with a screen.
        headless: { active: liveView === false },
      },
    }) });
    if (!created.ok) throw browserResponseFailure(created);
    const session = (await created.json().catch(() => undefined) as { data?: { id?: unknown; cdp_url?: unknown; live_view_url?: unknown } } | undefined)?.data;
    if (typeof session?.id !== 'string' || !/^[A-Za-z0-9-]{1,128}$/u.test(session.id) || typeof session.cdp_url !== 'string' || !secureSocket.test(session.cdp_url)) {
      throw new BrowserError('invalid_response');
    }
    const id = session.id;
    return {
      id, cdp: { url: session.cdp_url },
      // Without liveView, createBrowsers shows no live view.
      ...(typeof session.live_view_url === 'string' ? { liveViewUrl: session.live_view_url } : {}),
      release: async ({ signal: callSignal }) => {
        const reply = await fetcher(`${base}/v1/sessions/${id}`, { method: 'DELETE', signal: callSignal, headers: headers() });
        void reply.body?.cancel().catch(() => undefined);
        if (reply.ok) return;
        // Anchor answers a session it no longer has as "invalid API key or session id" (401); the key worked when the
        // session was created, so that is a session already ended.
        throw browserHttpFailure(reply.status === 401 ? 404 : reply.status);
      },
    };
  };

  return Object.freeze({ id: 'anchor', features: Object.freeze({ liveView: liveView !== false }), maxLifetimeMs, create });
}
