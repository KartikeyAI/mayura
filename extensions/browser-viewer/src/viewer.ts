import { MayuraError } from 'mayura';
import type { Browser } from 'mayura/browser';
import { viewerPage } from './page.js';
import { browserScreencast, type Screencast, type ScreencastOptions, type ViewerInput } from './screencast.js';

export interface BrowserViewerOptions extends Omit<ScreencastOptions, 'interact' | 'signal'> {
  /** Where the viewer is mounted in your server, such as `/viewer/`; `/` by default. */
  readonly basePath?: string;
  /**
   * Who may show the viewer page in a frame (its CSP `frame-ancestors`), such as `['https://app.example']`; nobody by
   * default.
   */
  readonly frameAncestors?: readonly string[];
  /** How many people may watch one share at once; 2 by default (1 to 16). */
  readonly maxViewersPerShare?: number;
  /** How many shares may be open at once; 16 by default (1 to 256). */
  readonly maxShares?: number;
  /** Input events a second, per share; 60 by default (1 to 500). */
  readonly maxInputPerSecond?: number;
}

export interface ViewerShareOptions {
  /** Let whoever has the link use the browser (mouse, keyboard, typing); off by default. */
  readonly interact?: boolean;
  /** How long the link works, in milliseconds; 1 hour by default (1 s to 24 hours). It also stops when the browser ends. */
  readonly expiresInMs?: number;
}

export interface ViewerShare {
  /** The viewer page's path, under `basePath`, with the link's token in it: treat it as a secret. */
  readonly path: string;
  readonly interact: boolean;
  /** When the link stops working, in milliseconds since the epoch. */
  readonly expiresAt: number;
  /** Stops the link now, and ends what is being watched through it. */
  revoke(): void;
}

export interface BrowserViewer {
  /** A link to watch the browser, and with `interact` to use it, for whoever has it. */
  share(browser: Browser, options?: ViewerShareOptions): Promise<ViewerShare>;
  /** Answers a request for a viewer path (`<basePath>v/...`); undefined for any other, for your server to answer. */
  handle(request: Request): Promise<Response | undefined>;
  /** How many shares are open. */
  readonly size: number;
  /** Revokes every share, and makes no more. */
  close(): void;
}

interface Share {
  readonly browser: Browser; readonly interact: boolean; readonly timer: ReturnType<typeof setTimeout>;
  readonly casts: Set<Screencast>; inputs: number[]; revoked: boolean;
}

const boundary = 'mayura-frame';
const encoder = new TextEncoder();
const origin = /^https?:\/\/[a-z0-9.-]+(?::\d{1,5})?$/iu;

function bound(value: number | undefined, name: string, fallback: number, min: number, max: number): number {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result < min || result > max) throw new MayuraError('INVALID_CONFIG', `browserViewer(): ${name} is ${min.toLocaleString('en-US')} to ${max.toLocaleString('en-US')}.`);
  return result;
}
function base64Url(bytes: Uint8Array): string {
  let binary = ''; for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '');
}
/** A request's body as text, read no further than `max` bytes; undefined when it is longer. */
async function bodyText(request: Request, max: number): Promise<string | undefined> {
  if (!request.body) return '';
  const reader = request.body.getReader(); const chunks: Uint8Array[] = []; let size = 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) { await reader.cancel().catch(() => undefined); return undefined; }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return new TextDecoder().decode(bytes);
}
async function digest(token: string): Promise<string> {
  const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(token)));
  return [...hash].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

/**
 * A live viewer for `mayura/browser` browsers, as web-standard request handling for any server: `share(browser)` gives
 * a link with a secret token to a page showing the browser's active tab as it changes (an MJPEG stream of its
 * screencast), and with `interact` a person can use the page too. Links expire, and end with the browser; nothing is
 * shown that is not shared. For a server of its own on Node, see `serveBrowserViewer`.
 */
export function browserViewer(options: BrowserViewerOptions = {}): BrowserViewer {
  const basePath = options.basePath ?? '/';
  if (typeof basePath !== 'string' || !/^\/(?:[A-Za-z0-9._~-]+\/)*$/u.test(basePath)) throw new MayuraError('INVALID_CONFIG', 'browserViewer(): basePath is a path such as / or /viewer/, starting and ending with /.');
  const frameAncestors = options.frameAncestors ?? [];
  if (!Array.isArray(frameAncestors) || frameAncestors.length > 16 || frameAncestors.some(item => typeof item !== 'string' || !origin.test(item))) {
    throw new MayuraError('INVALID_CONFIG', 'browserViewer(): frameAncestors are origins such as https://app.example.');
  }
  const maxViewers = bound(options.maxViewersPerShare, 'maxViewersPerShare', 2, 1, 16);
  const maxShares = bound(options.maxShares, 'maxShares', 16, 1, 256);
  const maxInput = bound(options.maxInputPerSecond, 'maxInputPerSecond', 60, 1, 500);
  const { basePath: _basePath, frameAncestors: _frameAncestors, maxViewersPerShare: _viewers, maxShares: _shares, maxInputPerSecond: _input, ...castOptions } = options;
  // Checked now, rather than when someone first watches.
  if (castOptions.webSocket !== undefined && typeof castOptions.webSocket !== 'function') throw new MayuraError('INVALID_CONFIG', 'browserViewer(): webSocket must be a function.');
  bound(castOptions.quality, 'quality', 60, 1, 100); bound(castOptions.maxWidth, 'maxWidth', 1_280, 320, 3_840); bound(castOptions.maxHeight, 'maxHeight', 800, 240, 2_160);
  bound(castOptions.maxFps, 'maxFps', 5, 1, 30); bound(castOptions.maxFrameBytes, 'maxFrameBytes', 2_097_152, 65_536, 16_777_216);
  const ancestors = frameAncestors.length ? frameAncestors.join(' ') : "'none'";

  const shares = new Map<string, Share>(); // by the token's SHA-256
  let closed = false;
  const revoke = (key: string) => {
    const share = shares.get(key);
    if (!share) return;
    shares.delete(key); share.revoked = true; clearTimeout(share.timer);
    for (const cast of share.casts) cast.close();
  };
  /** The share a token names, while it is open and its browser has not ended. */
  const find = (key: string): Share | undefined => {
    const share = shares.get(key);
    if (share?.browser.ended) { revoke(key); return undefined; }
    return share;
  };

  const headers = (extra: Record<string, string> = {}): Record<string, string> => ({
    'cache-control': 'no-store', 'referrer-policy': 'no-referrer', 'x-content-type-options': 'nosniff',
    'content-security-policy': `default-src 'none'; frame-ancestors ${ancestors}; base-uri 'none'; form-action 'none'`, ...extra,
  });
  const text = (status: number, body: string) => new Response(body, { status, headers: headers({ 'content-type': 'text/plain; charset=utf-8' }) });

  const stream = async (share: Share): Promise<Response> => {
    if (share.casts.size >= maxViewers) return text(429, 'Too many people are watching this browser.');
    let cast: Screencast;
    try { cast = await browserScreencast(share.browser, { ...castOptions, interact: share.interact }); }
    catch { return text(410, 'This browser cannot be shown.'); }
    // Revoked while connecting.
    if (share.revoked) { cast.close(); return text(404, 'Not found.'); }
    share.casts.add(cast);
    const body = new ReadableStream<Uint8Array>({
      pull: async controller => {
        const frame = await cast.next();
        if (!frame) { share.casts.delete(cast); controller.close(); return; }
        controller.enqueue(encoder.encode(`--${boundary}\r\nContent-Type: image/jpeg\r\nContent-Length: ${frame.data.byteLength}\r\n\r\n`));
        controller.enqueue(frame.data); controller.enqueue(encoder.encode('\r\n'));
      },
      cancel: () => { share.casts.delete(cast); cast.close(); },
    }, { highWaterMark: 0 });
    return new Response(body, { status: 200, headers: headers({ 'content-type': `multipart/x-mixed-replace; boundary=${boundary}` }) });
  };

  const input = async (share: Share, request: Request): Promise<Response> => {
    if (!share.interact) return text(403, 'This link is view only.');
    // A JSON body cannot be sent across sites without a preflight, which is never allowed; nor from another site.
    if (!/^application\/json(?:;|$)/iu.test(request.headers.get('content-type') ?? '')) return text(415, 'Send JSON.');
    const site = request.headers.get('sec-fetch-site');
    if (site !== null && site !== 'same-origin') return text(403, 'Not from this page.');
    const now = Date.now();
    share.inputs = share.inputs.filter(time => now - time < 1_000);
    if (share.inputs.length >= maxInput) return text(429, 'Too many inputs.');
    share.inputs.push(now);
    const raw = await bodyText(request, 4_096);
    if (raw === undefined) return text(413, 'Too large.');
    let event: ViewerInput;
    try { event = JSON.parse(raw) as ViewerInput; } catch { return text(400, 'Send JSON.'); }
    // Input goes to the page as the newest viewer shows it.
    const cast = [...share.casts].at(-1);
    if (!cast) return text(409, 'Nothing is being watched.');
    try { await cast.input(event); }
    catch (error) { return text(error instanceof MayuraError && error.code === 'INVALID_INPUT' ? 400 : 409, error instanceof MayuraError && error.code === 'INVALID_INPUT' ? error.message : 'The browser did not take that.'); }
    return new Response(null, { status: 204, headers: headers() });
  };

  return {
    share: async (browser: Browser, shareOptions: ViewerShareOptions = {}) => {
      if (closed) throw new MayuraError('INVALID_CONFIG', 'The viewer was closed.');
      if (!browser || typeof browser.tabs !== 'function') throw new MayuraError('INVALID_CONFIG', 'share() needs a browser.');
      if (!browser.cdp) throw new MayuraError('INVALID_CONFIG', `The ${browser.provider} provider's browsers cannot be joined: each connection starts a browser of its own.`);
      if (browser.ended) throw new MayuraError('INVALID_INPUT', 'The browser has ended.');
      if (shareOptions.interact !== undefined && typeof shareOptions.interact !== 'boolean') throw new MayuraError('INVALID_CONFIG', 'share(): interact must be a boolean.');
      const expiresInMs = shareOptions.expiresInMs ?? 3_600_000;
      if (!Number.isSafeInteger(expiresInMs) || expiresInMs < 1_000 || expiresInMs > 86_400_000) throw new MayuraError('INVALID_CONFIG', 'share(): expiresInMs is 1 s to 24 hours.');
      for (const key of [...shares.keys()]) find(key);
      if (shares.size >= maxShares) throw new MayuraError('LIMIT_EXCEEDED', 'Too many shares are open: revoke one first.');
      const token = base64Url(crypto.getRandomValues(new Uint8Array(32)));
      const key = await digest(token);
      const expiresAt = Date.now() + expiresInMs;
      const timer = setTimeout(() => revoke(key), expiresInMs);
      // An open link does not keep the process running.
      (timer as { unref?: () => void }).unref?.();
      shares.set(key, { browser, interact: shareOptions.interact === true, timer, casts: new Set(), inputs: [], revoked: false });
      return Object.freeze({ path: `${basePath}v/${token}/`, interact: shareOptions.interact === true, expiresAt, revoke: () => revoke(key) });
    },
    handle: async (request: Request) => {
      const { pathname } = new URL(request.url);
      if (!pathname.startsWith(`${basePath}v/`)) return undefined;
      const match = /^([A-Za-z0-9_-]{43})\/(stream|input)?$/u.exec(pathname.slice(basePath.length + 2));
      const share = match ? find(await digest(match[1]!)) : undefined;
      if (!match || !share) return text(404, 'Not found.');
      const part = match[2];
      if (part === 'input') return request.method === 'POST' ? input(share, request) : text(405, 'Use POST.');
      if (request.method !== 'GET') return text(405, 'Use GET.');
      if (part === 'stream') return stream(share);
      const nonce = base64Url(crypto.getRandomValues(new Uint8Array(16)));
      return new Response(viewerPage({ interact: share.interact, nonce }), { status: 200, headers: headers({
        'content-type': 'text/html; charset=utf-8',
        'content-security-policy': `default-src 'none'; img-src 'self'; connect-src 'self'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; frame-ancestors ${ancestors}; base-uri 'none'; form-action 'none'`,
      }) });
    },
    get size() { for (const key of [...shares.keys()]) find(key); return shares.size; },
    close: () => { closed = true; for (const key of [...shares.keys()]) revoke(key); },
  };
}
