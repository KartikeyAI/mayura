import { MayuraError } from 'mayura';
import type { BrowserBackend, BrowserProvider } from 'mayura/browser';

export interface CloudflareBrowserOptions {
  /** Your Cloudflare account id (32 hex characters). */
  readonly accountId: string;
  /** A Cloudflare API token with the "Browser Rendering - Edit" permission. Nothing is read from the environment. */
  readonly apiToken: string;
  /**
   * How long a browser stays once nothing is connected, in milliseconds: 60,000 by default (10,000 to 600,000). It is
   * how a released browser, or one whose process stopped, ends.
   */
  readonly keepAliveMs?: number;
  /** The longest lifetime; 1 hour by default. */
  readonly maxLifetimeMs?: number;
  /** For tests and proxies: the CDP endpoint's address instead of Cloudflare's. Plain `ws://` only on this machine. */
  readonly endpoint?: string;
}

/** A WebSocket over TLS, or plain only on this machine. */
const secureSocket = /^(?:wss:\/\/|ws:\/\/(?:127\.0\.0\.1|localhost|\[::1\])[:/])/u;

/**
 * Browsers from Cloudflare Browser Run (formerly Browser Rendering), reached from outside a Worker over its CDP
 * endpoint: each is a browser Cloudflare launches when its connection opens, ended `keepAliveMs` after the connection
 * closes. The token travels in a header on the WebSocket: Node and Bun send it; elsewhere give `createBrowsers` a
 * `webSocket` that can. Give the result to `createBrowsers` from `mayura/browser`.
 */
export function cloudflareBrowsers(options: CloudflareBrowserOptions): BrowserProvider {
  if (!options || typeof options.accountId !== 'string' || !/^[0-9a-f]{32}$/u.test(options.accountId)) throw new MayuraError('INVALID_CONFIG', 'cloudflareBrowsers(): accountId must be a Cloudflare account id.');
  if (typeof options.apiToken !== 'string' || !/^[A-Za-z0-9_-]{20,512}$/u.test(options.apiToken)) throw new MayuraError('INVALID_CONFIG', 'cloudflareBrowsers(): apiToken must be a Cloudflare API token.');
  const keepAlive = options.keepAliveMs ?? 60_000;
  // Cloudflare's pages give 10 and 20 minutes as the most; 10 holds either way.
  if (!Number.isSafeInteger(keepAlive) || keepAlive < 10_000 || keepAlive > 600_000) throw new MayuraError('INVALID_CONFIG', 'cloudflareBrowsers(): keepAliveMs is 10,000 to 600,000.');
  const maxLifetimeMs = options.maxLifetimeMs ?? 3_600_000;
  if (!Number.isSafeInteger(maxLifetimeMs) || maxLifetimeMs < 1_000) throw new MayuraError('INVALID_CONFIG', 'cloudflareBrowsers(): maxLifetimeMs is at least 1 s.');
  const endpoint = (() => {
    try {
      const url = new URL(options.endpoint ?? `wss://api.cloudflare.com/client/v4/accounts/${options.accountId}/browser-run/devtools/browser`);
      if (!secureSocket.test(url.href) || url.search || url.hash || url.username || url.password) throw new Error();
      return url;
    } catch { throw new MayuraError('INVALID_CONFIG', 'cloudflareBrowsers(): endpoint is a wss:// URL (ws:// only on this machine), without a query.'); }
  })();
  let count = 0;

  return Object.freeze({
    id: 'cloudflare', features: Object.freeze({ liveView: false }), maxLifetimeMs,
    create: async (): Promise<BrowserBackend> => {
      const url = new URL(endpoint.href); url.searchParams.set('keep_alive', String(keepAlive));
      return {
        id: `cloudflare-${++count}`, cdp: { url: url.href, headers: { authorization: `Bearer ${options.apiToken}` } },
        // The browser ends keepAliveMs after its connection closes, which releasing the browser does.
        release: async () => undefined,
      };
    },
  });
}
