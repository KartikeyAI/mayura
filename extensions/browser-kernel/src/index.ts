import { MayuraError } from 'mayura';
import {
  BrowserError, browserHttpFailure, browserResponseFailure,
  type BrowserBackend, type BrowserProvider, type ProviderBrowserSpec,
} from 'mayura/browser';

export interface KernelBrowserOptions {
  /** A Kernel API key. Nothing is read from the environment. */
  readonly apiKey: string;
  /**
   * Give each browser a live view (`liveViewUrl`), a link with a token in it: `'view'` (the default) only shows the
   * browser; `'interact'` also lets whoever has the link use it; `false` gives none, and runs the browser headless.
   */
  readonly liveView?: 'view' | 'interact' | false;
  /** Kernel's stealth mode, which also turns on its captcha solver; off by default. */
  readonly stealth?: boolean;
  /** Where browsers run: `us-east` (Kernel's default), `eu-west` or `ap-southeast`. */
  readonly region?: 'us-east' | 'eu-west' | 'ap-southeast';
  /**
   * How long a browser waits once nothing is connected before Kernel deletes it, in seconds: 60 by default (10 to
   * 259,200). It ends a browser whose release never came, such as when this process stops.
   */
  readonly standbyTimeoutSeconds?: number;
  /** The longest lifetime; 24 hours by default. */
  readonly maxLifetimeMs?: number;
  /** For tests and proxies: the fetch to use. */
  readonly fetch?: typeof fetch;
  /** The API's address; `https://api.onkernel.com` by default. */
  readonly baseUrl?: string;
}

const regions = ['us-east', 'eu-west', 'ap-southeast'] as const;
/** A CDP WebSocket over TLS, or plain only on this machine (a local proxy or a test). */
const secureSocket = /^(?:wss:\/\/|ws:\/\/(?:127\.0\.0\.1|localhost|\[::1\])[:/])/u;

/**
 * Browsers from Kernel: hosted Chromium, driven over CDP from any runtime, with no dependency. Each browser is created
 * when opened and deleted when released. Kernel keeps a browser running while it is connected, so its lifetime is kept
 * by `createBrowsers`; a browser left without a connection is deleted after `standbyTimeoutSeconds`.
 * Give the result to `createBrowsers` from `mayura/browser`.
 */
export function kernelBrowsers(options: KernelBrowserOptions): BrowserProvider {
  if (!options || typeof options.apiKey !== 'string' || !/^[!-~]{8,512}$/u.test(options.apiKey)) throw new MayuraError('INVALID_CONFIG', 'kernelBrowsers(): apiKey must be a Kernel API key.');
  const liveView = options.liveView ?? 'view';
  if (liveView !== 'view' && liveView !== 'interact' && liveView !== false) throw new MayuraError('INVALID_CONFIG', "kernelBrowsers(): liveView is 'view', 'interact' or false.");
  if (options.stealth !== undefined && typeof options.stealth !== 'boolean') throw new MayuraError('INVALID_CONFIG', 'kernelBrowsers(): stealth must be a boolean.');
  if (options.region !== undefined && !regions.includes(options.region)) throw new MayuraError('INVALID_CONFIG', `kernelBrowsers(): region is one of ${regions.join(', ')}.`);
  const standby = options.standbyTimeoutSeconds ?? 60;
  if (!Number.isSafeInteger(standby) || standby < 10 || standby > 259_200) throw new MayuraError('INVALID_CONFIG', 'kernelBrowsers(): standbyTimeoutSeconds is 10 to 259,200.');
  const maxLifetimeMs = options.maxLifetimeMs ?? 86_400_000;
  if (!Number.isSafeInteger(maxLifetimeMs) || maxLifetimeMs < 1_000 || maxLifetimeMs > 259_200_000) throw new MayuraError('INVALID_CONFIG', 'kernelBrowsers(): maxLifetimeMs is 1 s to 72 hours.');
  if (options.fetch !== undefined && typeof options.fetch !== 'function') throw new MayuraError('INVALID_CONFIG', 'kernelBrowsers(): fetch must be a function.');
  const base = (() => {
    try { const url = new URL(options.baseUrl ?? 'https://api.onkernel.com'); if (url.protocol !== 'https:' && url.hostname !== '127.0.0.1' && url.hostname !== 'localhost') throw new Error(); return url.origin; }
    catch { throw new MayuraError('INVALID_CONFIG', 'kernelBrowsers(): baseUrl must be an https URL.'); }
  })();
  const fetcher = options.fetch ?? globalThis.fetch;
  const headers = (json = false) => ({ authorization: `Bearer ${options.apiKey}`, ...(json ? { 'content-type': 'application/json' } : {}) });

  const create = async (spec: ProviderBrowserSpec, { signal }: { readonly signal: AbortSignal }): Promise<BrowserBackend> => {
    const created = await fetcher(`${base}/browsers`, { method: 'POST', signal, headers: headers(true), body: JSON.stringify({
      timeout_seconds: standby,
      // Kernel's live view needs a browser with a screen.
      headless: liveView === false,
      stealth: options.stealth ?? false,
      viewport: { width: spec.viewport.width, height: spec.viewport.height },
      ...(options.region ? { region: options.region } : {}),
      ...(Object.keys(spec.labels).length ? { tags: { ...spec.labels } } : {}),
    }) });
    if (!created.ok) throw browserResponseFailure(created);
    const browser = await created.json().catch(() => undefined) as { session_id?: unknown; cdp_ws_url?: unknown; browser_live_view_url?: unknown } | undefined;
    if (typeof browser?.session_id !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/u.test(browser.session_id) || typeof browser.cdp_ws_url !== 'string' || !secureSocket.test(browser.cdp_ws_url)) {
      throw new BrowserError('invalid_response');
    }
    const id = browser.session_id;
    let liveViewUrl: string | undefined;
    // Without liveView, createBrowsers shows none (and a headless browser has none).
    if (typeof browser.browser_live_view_url === 'string') {
      try { const view = new URL(browser.browser_live_view_url); if (liveView === 'view') view.searchParams.set('readOnly', 'true'); liveViewUrl = view.href; }
      catch { /* no live view */ }
    }
    return {
      id, cdp: { url: browser.cdp_ws_url }, ...(liveViewUrl ? { liveViewUrl } : {}),
      release: async ({ signal: callSignal }) => {
        const reply = await fetcher(`${base}/browsers/${id}`, { method: 'DELETE', signal: callSignal, headers: headers() });
        void reply.body?.cancel().catch(() => undefined);
        // 404: deleted already, which createBrowsers counts as released.
        if (!reply.ok) throw browserHttpFailure(reply.status);
      },
    };
  };

  return Object.freeze({ id: 'kernel', features: Object.freeze({ liveView: liveView !== false }), maxLifetimeMs, create });
}
