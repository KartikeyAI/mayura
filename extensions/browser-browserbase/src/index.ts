import { MayuraError } from 'mayura';
import {
  BrowserError, browserHttpFailure, browserResponseFailure,
  type BrowserBackend, type BrowserProvider, type ProviderBrowserSpec,
} from 'mayura/browser';

export interface BrowserbaseBrowserOptions {
  /** A Browserbase API key. Nothing is read from the environment. */
  readonly apiKey: string;
  /** The project sessions belong to; the key's own project by default. */
  readonly projectId?: string;
  /** Where sessions run: `us-west-2` (Browserbase's default), `us-east-1`, `eu-central-1` or `ap-southeast-1`. */
  readonly region?: 'us-west-2' | 'us-east-1' | 'eu-central-1' | 'ap-southeast-1';
  /** Give each browser a live view (`liveViewUrl`); true by default. */
  readonly liveView?: boolean;
  /** Let Browserbase solve captchas; off here, though Browserbase's own default is on. */
  readonly solveCaptchas?: boolean;
  /** Let Browserbase record sessions and keep their logs; off here, though Browserbase's own default is on. */
  readonly recordSession?: boolean;
  /** Block ads; off by default. */
  readonly blockAds?: boolean;
  /** The longest lifetime: Browserbase's 6 hours by default (15 minutes on its free plan). */
  readonly maxLifetimeMs?: number;
  /** For tests and proxies: the fetch to use. */
  readonly fetch?: typeof fetch;
  /** The API's address; `https://api.browserbase.com` by default. */
  readonly baseUrl?: string;
}

const regions = ['us-west-2', 'us-east-1', 'eu-central-1', 'ap-southeast-1'] as const;
const ended = new Set(['ERROR', 'TIMED_OUT', 'COMPLETED']);
/** A CDP WebSocket over TLS, or plain only on this machine (a local proxy or a test). */
const secureSocket = /^(?:wss:\/\/|ws:\/\/(?:127\.0\.0\.1|localhost|\[::1\])[:/])/u;

/**
 * Browsers as Browserbase sessions: hosted Chromium, driven over CDP from any runtime, with no dependency. Each browser
 * is a session created when opened and released when done; it also ends when its connection does, or at its lifetime.
 * Give the result to `createBrowsers` from `mayura/browser`.
 */
export function browserbaseBrowsers(options: BrowserbaseBrowserOptions): BrowserProvider {
  if (!options || typeof options.apiKey !== 'string' || !/^[!-~]{8,512}$/u.test(options.apiKey)) throw new MayuraError('INVALID_CONFIG', 'browserbaseBrowsers(): apiKey must be a Browserbase API key.');
  if (options.projectId !== undefined && (typeof options.projectId !== 'string' || !/^[A-Za-z0-9-]{1,64}$/u.test(options.projectId))) throw new MayuraError('INVALID_CONFIG', 'browserbaseBrowsers(): projectId must be a Browserbase project id.');
  if (options.region !== undefined && !regions.includes(options.region)) throw new MayuraError('INVALID_CONFIG', `browserbaseBrowsers(): region is one of ${regions.join(', ')}.`);
  for (const flag of ['liveView', 'solveCaptchas', 'recordSession', 'blockAds'] as const) {
    if (options[flag] !== undefined && typeof options[flag] !== 'boolean') throw new MayuraError('INVALID_CONFIG', `browserbaseBrowsers(): ${flag} must be a boolean.`);
  }
  const maxLifetimeMs = options.maxLifetimeMs ?? 21_600_000;
  if (!Number.isSafeInteger(maxLifetimeMs) || maxLifetimeMs < 60_000 || maxLifetimeMs > 21_600_000) throw new MayuraError('INVALID_CONFIG', 'browserbaseBrowsers(): maxLifetimeMs is 1 minute to 6 hours.');
  if (options.fetch !== undefined && typeof options.fetch !== 'function') throw new MayuraError('INVALID_CONFIG', 'browserbaseBrowsers(): fetch must be a function.');
  const base = (() => {
    try { const url = new URL(options.baseUrl ?? 'https://api.browserbase.com'); if (url.protocol !== 'https:' && url.hostname !== '127.0.0.1' && url.hostname !== 'localhost') throw new Error(); return url.origin; }
    catch { throw new MayuraError('INVALID_CONFIG', 'browserbaseBrowsers(): baseUrl must be an https URL.'); }
  })();
  const fetcher = options.fetch ?? globalThis.fetch;
  const liveView = options.liveView ?? true;
  const headers = (json = false) => ({ 'x-bb-api-key': options.apiKey, ...(json ? { 'content-type': 'application/json' } : {}) });

  const create = async (spec: ProviderBrowserSpec, { signal }: { readonly signal: AbortSignal }): Promise<BrowserBackend> => {
    const created = await fetcher(`${base}/v1/sessions`, { method: 'POST', signal, headers: headers(true), body: JSON.stringify({
      ...(options.projectId ? { projectId: options.projectId } : {}),
      ...(options.region ? { region: options.region } : {}),
      // Browserbase ends the session at its timeout, should a release never come (at least a minute).
      timeout: Math.min(21_600, Math.max(60, Math.ceil(spec.lifetimeMs / 1_000))),
      // Not kept alive: the session also ends when its connection does.
      keepAlive: false,
      browserSettings: {
        viewport: { width: spec.viewport.width, height: spec.viewport.height },
        solveCaptchas: options.solveCaptchas ?? false, recordSession: options.recordSession ?? false, logSession: options.recordSession ?? false,
        blockAds: options.blockAds ?? false,
      },
      userMetadata: { ...spec.labels },
    }) });
    if (!created.ok) throw browserResponseFailure(created);
    const session = await created.json().catch(() => undefined) as { id?: unknown; connectUrl?: unknown; projectId?: unknown } | undefined;
    if (typeof session?.id !== 'string' || !/^[A-Za-z0-9-]{1,128}$/u.test(session.id) || typeof session.connectUrl !== 'string' || !secureSocket.test(session.connectUrl)) {
      throw new BrowserError('invalid_response');
    }
    const id = session.id; const projectId = typeof session.projectId === 'string' ? session.projectId : options.projectId;
    const release = async ({ signal: callSignal }: { readonly signal: AbortSignal }) => {
      const reply = await fetcher(`${base}/v1/sessions/${id}`, { method: 'POST', signal: callSignal, headers: headers(true),
        body: JSON.stringify({ status: 'REQUEST_RELEASE', ...(projectId ? { projectId } : {}) }) });
      void reply.body?.cancel().catch(() => undefined);
      if (reply.ok) return;
      // A session that already ended may not be releasable: ask how it is before calling that a failure.
      const state = await fetcher(`${base}/v1/sessions/${id}`, { signal: callSignal, headers: headers() });
      const status = state.ok ? (await state.json().catch(() => undefined) as { status?: unknown } | undefined)?.status : (void state.body?.cancel().catch(() => undefined), undefined);
      if (state.status === 404 || (typeof status === 'string' && ended.has(status))) return;
      throw browserHttpFailure(reply.status);
    };
    let liveViewUrl: string | undefined;
    try {
      if (liveView) {
        const debug = await fetcher(`${base}/v1/sessions/${id}/debug?expiresIn=${Math.min(21_600, Math.max(60, Math.ceil(spec.lifetimeMs / 1_000)))}`, { signal, headers: headers() });
        if (!debug.ok) throw browserResponseFailure(debug);
        const url = (await debug.json().catch(() => undefined) as { debuggerFullscreenUrl?: unknown } | undefined)?.debuggerFullscreenUrl;
        // createBrowsers shows it only at an https URL.
        if (typeof url !== 'string') throw new BrowserError('invalid_response');
        liveViewUrl = url;
      }
    } catch (error) {
      await release({ signal: AbortSignal.timeout(30_000) }).catch(() => undefined);
      throw error;
    }
    return { id, cdp: { url: session.connectUrl }, ...(liveViewUrl ? { liveViewUrl } : {}), release };
  };

  return Object.freeze({ id: 'browserbase', features: Object.freeze({ liveView }), maxLifetimeMs, create });
}
