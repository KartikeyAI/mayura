import { MayuraError } from '@mayura/core';

/** What a provider's browsers can do beyond being driven over CDP. */
export interface BrowserFeatures {
  /** Whether a browser has a live view a person can watch (and often take over) in their own browser. */
  readonly liveView: boolean;
}

/** What a provider is asked to create, after `createBrowsers` checked it against its limits. */
export interface ProviderBrowserSpec {
  /** How long the browser may live, in milliseconds; the provider ends it then, or earlier when released. */
  readonly lifetimeMs: number;
  /** The window size pages are laid out for. */
  readonly viewport: { readonly width: number; readonly height: number };
  /** Labels to tag the session with, to find it in the provider's console. */
  readonly labels: Readonly<Record<string, string>>;
}

/** How to reach a browser over the Chrome DevTools Protocol. */
export interface BrowserCdpEndpoint {
  /** A `ws(s)://` URL of the browser's CDP endpoint (the browser target, not a page). */
  readonly url: string;
  /** Headers the WebSocket upgrade needs, such as a token. Never logged. */
  readonly headers?: Readonly<Record<string, string>>;
}

/** One browser, as a provider implements it. */
export interface BrowserBackend {
  readonly id: string;
  readonly cdp: BrowserCdpEndpoint;
  /** A URL where a person can watch the browser, for providers with `liveView`. It may carry a token: treat it as a secret. */
  readonly liveViewUrl?: string;
  /**
   * Open pages in a browser context of their own, disposed on release, and leave every other page alone: for a browser
   * shared with others, such as one you run yourself. Otherwise the browser is this one's alone.
   */
  readonly isolate?: boolean;
  /** Ends the browser. A browser that already ended is released. */
  release(options: { readonly signal: AbortSignal }): Promise<void>;
}

/** A place browsers come from: your own Chrome, or a hosted browser service. */
export interface BrowserProvider {
  /** Names the provider in errors and traces, such as `local` or `browserbase`. */
  readonly id: string;
  readonly features: BrowserFeatures;
  /** The longest lifetime the provider supports. */
  readonly maxLifetimeMs: number;
  create(spec: ProviderBrowserSpec, options: { readonly signal: AbortSignal }): Promise<BrowserBackend>;
}

/** Why a browser provider failed, without anything it wrote. */
export type BrowserFailureReason = 'authentication' | 'rate_limited' | 'quota' | 'unavailable' | 'timeout' | 'rejected' | 'gone' | 'invalid_response';

const messages: Readonly<Record<BrowserFailureReason, string>> = {
  authentication: 'The browser provider refused the credentials.',
  rate_limited: 'The browser provider is rate limiting requests.',
  quota: 'The browser provider refused for a plan or quota limit.',
  unavailable: 'The browser is unavailable.',
  timeout: 'The browser did not answer in time.',
  rejected: 'The browser refused the request.',
  gone: 'The browser has ended.',
  invalid_response: 'The browser returned a response that is not valid.',
};

/** A browser failure, with a fixed message: nothing the provider or a page wrote reaches it. */
export class BrowserError extends MayuraError {
  readonly reason: BrowserFailureReason;
  declare readonly httpStatus?: number;
  constructor(reason: BrowserFailureReason, httpStatus?: number) {
    if (!Object.hasOwn(messages, reason)) throw new MayuraError('INVALID_CONFIG', 'Unknown browser failure reason.');
    if (httpStatus !== undefined && (!Number.isSafeInteger(httpStatus) || httpStatus < 100 || httpStatus > 599)) throw new MayuraError('INVALID_CONFIG', 'An HTTP status must be between 100 and 599.');
    super('TOOL_FAILED', httpStatus === undefined ? messages[reason] : `${messages[reason]} (HTTP ${httpStatus})`);
    this.reason = reason;
    if (httpStatus !== undefined) Object.defineProperty(this, 'httpStatus', { value: httpStatus, enumerable: true });
    Object.freeze(this);
  }
}

/** For providers: an HTTP error status as its failure. 404 and 410 mean the browser has ended. */
export function browserHttpFailure(status: number): BrowserError {
  if (status === 401 || status === 403) return new BrowserError('authentication', status);
  if (status === 404 || status === 410) return new BrowserError('gone', status);
  if (status === 402) return new BrowserError('quota', status);
  if (status === 429) return new BrowserError('rate_limited', status);
  if (status === 408 || status === 504) return new BrowserError('timeout', status);
  if (status >= 500) return new BrowserError('unavailable', status);
  return new BrowserError('rejected', status);
}

/** For providers: a failed response as its failure, its body discarded unread. */
export function browserResponseFailure(response: Response): BrowserError {
  void response.body?.cancel().catch(() => undefined);
  return browserHttpFailure(response.status);
}
