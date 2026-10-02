import { MayuraError } from 'mayura';
import { BrowserError, browserHttpFailure, browserResponseFailure, type BrowserBackend, type BrowserProvider, type ProviderBrowserSpec } from 'mayura/browser';

export interface CloudflareBrowserOptions {
  /** Your Cloudflare account id (32 hex characters). */
  readonly accountId: string;
  /** A Cloudflare API token with the "Browser Rendering - Edit" permission. Nothing is read from the environment. */
  readonly apiToken: string;
  /**
   * How long a browser stays once nothing is connected, in milliseconds: 60,000 by default (10,000 to 600,000). It is
   * how a browser ends should its release never come, such as when this process stopped.
   */
  readonly keepAliveMs?: number;
  /**
   * Give each browser a live view (`liveViewUrl`), a link with a signed token in it, valid for the browser's lifetime
   * up to an hour: `'view'` (the default) is read only; `'interact'` lets whoever has the link use the browser;
   * `false` gives none.
   */
  readonly liveView?: 'view' | 'interact' | false;
  /** The longest lifetime; 1 hour by default. */
  readonly maxLifetimeMs?: number;
  /** For tests and proxies: the fetch to use. */
  readonly fetch?: typeof fetch;
  /** The API's address; `https://api.cloudflare.com` by default. Plain `http://` only on this machine. */
  readonly baseUrl?: string;
}

const loopback = new Set(['127.0.0.1', 'localhost', '[::1]']);

/**
 * Browsers from Cloudflare Browser Run (formerly Browser Rendering), reached from outside a Worker: each is a Browser
 * Run session, acquired when opened and closed when released, driven over CDP at the session's own address, so a
 * second client over `browser.cdp` joins the same browser. The token travels in a header on the WebSocket: Node and
 * Bun send it; elsewhere give `createBrowsers` a `webSocket` that can. Give the result to `createBrowsers` from
 * `mayura/browser`.
 */
export function cloudflareBrowsers(options: CloudflareBrowserOptions): BrowserProvider {
  if (!options || typeof options.accountId !== 'string' || !/^[0-9a-f]{32}$/u.test(options.accountId)) throw new MayuraError('INVALID_CONFIG', 'cloudflareBrowsers(): accountId must be a Cloudflare account id.');
  if (typeof options.apiToken !== 'string' || !/^[A-Za-z0-9_-]{20,512}$/u.test(options.apiToken)) throw new MayuraError('INVALID_CONFIG', 'cloudflareBrowsers(): apiToken must be a Cloudflare API token.');
  const keepAlive = options.keepAliveMs ?? 60_000;
  // Cloudflare's pages give 10 and 20 minutes as the most; 10 holds either way.
  if (!Number.isSafeInteger(keepAlive) || keepAlive < 10_000 || keepAlive > 600_000) throw new MayuraError('INVALID_CONFIG', 'cloudflareBrowsers(): keepAliveMs is 10,000 to 600,000.');
  const liveView = options.liveView ?? 'view';
  if (liveView !== 'view' && liveView !== 'interact' && liveView !== false) throw new MayuraError('INVALID_CONFIG', "cloudflareBrowsers(): liveView is 'view', 'interact' or false.");
  const maxLifetimeMs = options.maxLifetimeMs ?? 3_600_000;
  if (!Number.isSafeInteger(maxLifetimeMs) || maxLifetimeMs < 1_000) throw new MayuraError('INVALID_CONFIG', 'cloudflareBrowsers(): maxLifetimeMs is at least 1 s.');
  if (options.fetch !== undefined && typeof options.fetch !== 'function') throw new MayuraError('INVALID_CONFIG', 'cloudflareBrowsers(): fetch must be a function.');
  const base = (() => {
    try {
      const url = new URL(options.baseUrl ?? 'https://api.cloudflare.com');
      if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback.has(url.hostname))) || url.pathname !== '/' || url.search || url.hash || url.username || url.password) throw new Error();
      return url;
    } catch { throw new MayuraError('INVALID_CONFIG', 'cloudflareBrowsers(): baseUrl is an https origin (http:// only on this machine).'); }
  })();
  const fetcher = options.fetch ?? globalThis.fetch;
  const browsersUrl = `${base.origin}/client/v4/accounts/${options.accountId}/browser-run/devtools/browser`;
  const socketUrl = `${base.protocol === 'https:' ? 'wss:' : 'ws:'}//${base.host}/client/v4/accounts/${options.accountId}/browser-run/devtools/browser`;
  const headers = (json = false) => ({ authorization: `Bearer ${options.apiToken}`, ...(json ? { 'content-type': 'application/json' } : {}) });

  const create = async (spec: ProviderBrowserSpec, { signal }: { readonly signal: AbortSignal }): Promise<BrowserBackend> => {
    const acquired = await fetcher(`${browsersUrl}?keep_alive=${keepAlive}`, { method: 'POST', signal, headers: headers() });
    if (!acquired.ok) throw browserResponseFailure(acquired);
    const session = await acquired.json().catch(() => undefined) as { sessionId?: unknown } | undefined;
    if (typeof session?.sessionId !== 'string' || !/^[A-Za-z0-9-]{1,128}$/u.test(session.sessionId)) throw new BrowserError('invalid_response');
    const id = session.sessionId;
    const release = async ({ signal: callSignal }: { readonly signal: AbortSignal }) => {
      const reply = await fetcher(`${browsersUrl}/${id}`, { method: 'DELETE', signal: callSignal, headers: headers() });
      void reply.body?.cancel().catch(() => undefined);
      // 404: the session already ended.
      if (!reply.ok && reply.status !== 404) throw browserHttpFailure(reply.status);
    };
    let liveViewUrl: string | undefined;
    if (liveView !== false) {
      try {
        const reply = await fetcher(`${browsersUrl}/${id}/live_view`, { method: 'POST', signal, headers: headers(true), body: JSON.stringify({
          mode: 'tab', expiresInMs: Math.min(spec.lifetimeMs, 3_600_000), ...(liveView === 'view' ? { guardrails: { mode: 'readonly' } } : {}),
        }) });
        if (!reply.ok) throw browserResponseFailure(reply);
        const view = await reply.json().catch(() => undefined) as { devtoolsFrontendUrl?: unknown } | undefined;
        if (typeof view?.devtoolsFrontendUrl !== 'string' || !view.devtoolsFrontendUrl.startsWith('https://')) throw new BrowserError('invalid_response');
        liveViewUrl = view.devtoolsFrontendUrl;
      } catch (error) { await release({ signal: AbortSignal.timeout(30_000) }).catch(() => undefined); throw error; }
    }
    return { id, cdp: { url: `${socketUrl}/${id}`, headers: { authorization: `Bearer ${options.apiToken}` } }, ...(liveViewUrl ? { liveViewUrl } : {}), release };
  };

  return Object.freeze({ id: 'cloudflare', features: Object.freeze({ liveView: liveView !== false }), maxLifetimeMs, create });
}
