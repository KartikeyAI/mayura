import { MayuraError } from 'mayura';
import type { BrowserBackend, BrowserProvider, ProviderBrowserSpec } from 'mayura/browser';

export interface BrowserlessBrowserOptions {
  /** A Browserless API token. Nothing is read from the environment. */
  readonly token: string;
  /** Browserless's hosted region: `production-sfo` (the default), `production-lon` or `production-ams`. */
  readonly region?: 'production-sfo' | 'production-lon' | 'production-ams';
  /**
   * Your own Browserless instead of the hosted one, such as `wss://browserless.internal` or, on this machine,
   * `ws://127.0.0.1:3000`. Plain `ws://` is accepted only on this machine.
   */
  readonly endpoint?: string;
  /** Block ads; off by default. */
  readonly blockAds?: boolean;
  /** Browserless's stealth mode; off by default. */
  readonly stealth?: boolean;
  /** The longest lifetime: 1 hour by default (Browserless's plans allow 2 minutes to an hour); up to 24 hours self-hosted. */
  readonly maxLifetimeMs?: number;
}

const regions = ['production-sfo', 'production-lon', 'production-ams'] as const;
/** A WebSocket over TLS, or plain only on this machine. */
const secureSocket = /^(?:wss:\/\/|ws:\/\/(?:127\.0\.0\.1|localhost|\[::1\])[:/])/u;

/**
 * Browsers from Browserless, hosted or your own: each is a fresh browser launched when its CDP connection opens and
 * ended when it closes, kept to its lifetime by Browserless's timeout. Nothing is kept between browsers. From any
 * runtime, with no dependency. Give the result to `createBrowsers` from `mayura/browser`.
 */
export function browserlessBrowsers(options: BrowserlessBrowserOptions): BrowserProvider {
  if (!options || typeof options.token !== 'string' || !/^[A-Za-z0-9_.-]{8,512}$/u.test(options.token)) throw new MayuraError('INVALID_CONFIG', 'browserlessBrowsers(): token must be a Browserless API token.');
  if (options.region !== undefined && !regions.includes(options.region)) throw new MayuraError('INVALID_CONFIG', `browserlessBrowsers(): region is one of ${regions.join(', ')}.`);
  if (options.region !== undefined && options.endpoint !== undefined) throw new MayuraError('INVALID_CONFIG', 'browserlessBrowsers(): give a region or an endpoint, not both.');
  for (const flag of ['blockAds', 'stealth'] as const) {
    if (options[flag] !== undefined && typeof options[flag] !== 'boolean') throw new MayuraError('INVALID_CONFIG', `browserlessBrowsers(): ${flag} must be a boolean.`);
  }
  const endpoint = (() => {
    const text = options.endpoint ?? `wss://${options.region ?? 'production-sfo'}.browserless.io`;
    try {
      const url = new URL(text);
      if (!secureSocket.test(url.href) || url.search || url.hash || url.username || url.password) throw new Error();
      return url;
    } catch { throw new MayuraError('INVALID_CONFIG', 'browserlessBrowsers(): endpoint is a wss:// URL (ws:// only on this machine), without a query.'); }
  })();
  const maxLifetimeMs = options.maxLifetimeMs ?? 3_600_000;
  if (!Number.isSafeInteger(maxLifetimeMs) || maxLifetimeMs < 1_000 || maxLifetimeMs > 86_400_000) throw new MayuraError('INVALID_CONFIG', 'browserlessBrowsers(): maxLifetimeMs is 1 s to 24 hours.');
  let count = 0;

  const create = async (spec: ProviderBrowserSpec): Promise<BrowserBackend> => {
    const url = new URL(endpoint.href);
    // The token goes in the query, as Browserless takes it; the timeout ends the browser at its lifetime.
    url.searchParams.set('token', options.token);
    url.searchParams.set('timeout', String(spec.lifetimeMs));
    if (options.blockAds) url.searchParams.set('blockAds', 'true');
    if (options.stealth) url.searchParams.set('stealth', 'true');
    return {
      id: `browserless-${++count}`, cdp: { url: url.href },
      // The browser ends when its connection does, which releasing the browser closes.
      release: async () => undefined,
    };
  };

  return Object.freeze({ id: 'browserless', features: Object.freeze({ liveView: false }), maxLifetimeMs, create });
}
