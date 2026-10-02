import { MayuraError } from '@mayura/core';
import { BrowserError } from './contracts.js';

/** A WebSocket as the CDP client uses it: the standard browser shape, which Node, Bun, Deno and Workers share. */
export interface CdpSocket {
  /** 1 once open. A socket handed over already open (such as a Worker's, after `accept()`) sends no open event. */
  readonly readyState?: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  addEventListener(type: 'open' | 'close' | 'error', listener: () => void): void;
  addEventListener(type: 'message', listener: (event: { readonly data: unknown }) => void): void;
}
/**
 * Opens a WebSocket to a CDP endpoint, with headers when the endpoint needs them. The default uses the runtime's
 * `WebSocket`, passing headers as Node (undici) and Bun accept them; elsewhere (Workers, Deno) give your own.
 */
export type CdpSocketFactory = (url: string, headers: Readonly<Record<string, string>>) => CdpSocket | Promise<CdpSocket>;

/**
 * The browser refused a command. Its message names the command only: what the browser wrote can carry page content, so
 * it stays out (`cdpCode` keeps the protocol's code).
 */
export class CdpError extends MayuraError {
  readonly method: string;
  readonly cdpCode: number;
  constructor(method: string, code: number) {
    super('TOOL_FAILED', `The browser refused ${method}.`);
    this.method = method; this.cdpCode = code;
  }
}

export interface CdpConnectOptions {
  /** Headers for the WebSocket upgrade, such as `authorization`. */
  readonly headers?: Readonly<Record<string, string>>;
  readonly webSocket?: CdpSocketFactory;
  /** The longest wait to connect; 30 s by default. */
  readonly timeoutMs?: number;
  /** The largest message accepted from the browser; 64 MiB by default (screenshots are large). */
  readonly maxMessageBytes?: number;
  readonly signal?: AbortSignal;
}
export interface CdpSendOptions {
  /** The flattened session to send to (`Target.attachToTarget` with `flatten`); the browser itself otherwise. */
  readonly sessionId?: string;
  readonly signal?: AbortSignal;
  /** The longest wait for the reply; 30 s by default. */
  readonly timeoutMs?: number;
}
export type CdpEventHandler = (params: Record<string, unknown>, sessionId: string | undefined) => void;

/** One connection to a browser over the Chrome DevTools Protocol. */
export interface CdpConnection {
  send<T = Record<string, unknown>>(method: string, params?: Record<string, unknown>, options?: CdpSendOptions): Promise<T>;
  /** Calls `handler` for each `method` event (of `sessionId` only, when given); returns the way to stop. */
  on(method: string, handler: CdpEventHandler, sessionId?: string): () => void;
  /** Settles when the connection closed, from either side. */
  readonly closed: Promise<void>;
  readonly isClosed: boolean;
  close(): void;
}

const defaultSocket: CdpSocketFactory = (url, headers) => {
  const WebSocketClass = (globalThis as { WebSocket?: new (url: string, options?: unknown) => CdpSocket }).WebSocket;
  if (!WebSocketClass) throw new MayuraError('INVALID_CONFIG', 'This runtime has no WebSocket: pass webSocket to connect to a browser.');
  return Object.keys(headers).length > 0 ? new WebSocketClass(url, { headers }) : new WebSocketClass(url);
};

/**
 * Finds a browser's WebSocket URL: `ws(s)://` URLs are used as they are, and `http(s)://host:port` asks the browser's
 * `/json/version`.
 */
export async function resolveCdpUrl(endpoint: string, options: { readonly headers?: Readonly<Record<string, string>>; readonly fetch?: typeof fetch; readonly signal?: AbortSignal } = {}): Promise<string> {
  let url: URL;
  try { url = new URL(endpoint); } catch { throw new MayuraError('INVALID_CONFIG', 'The browser endpoint must be a ws(s):// or http(s):// URL.'); }
  if (url.protocol === 'ws:' || url.protocol === 'wss:') return url.href;
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new MayuraError('INVALID_CONFIG', 'The browser endpoint must be a ws(s):// or http(s):// URL.');
  const reply = await (options.fetch ?? fetch)(new URL('/json/version', url), { headers: options.headers ?? {}, signal: options.signal ?? AbortSignal.timeout(30_000) });
  if (!reply.ok) { void reply.body?.cancel().catch(() => undefined); throw new BrowserError('unavailable'); }
  const found = (await reply.json().catch(() => undefined) as { webSocketDebuggerUrl?: unknown } | undefined)?.webSocketDebuggerUrl;
  if (typeof found !== 'string' || !/^wss?:\/\//u.test(found)) throw new BrowserError('unavailable');
  // A browser reports its own idea of its host, such as 127.0.0.1 inside a container: keep the host asked for.
  const socket = new URL(found); socket.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'; socket.host = url.host;
  return socket.href;
}

/** Connects to a browser's CDP WebSocket. */
export async function connectCdp(webSocketUrl: string, options: CdpConnectOptions = {}): Promise<CdpConnection> {
  const maxMessageBytes = options.maxMessageBytes ?? 64 * 1_048_576;
  const socket = await (options.webSocket ?? defaultSocket)(webSocketUrl, options.headers ?? {});
  const pending = new Map<number, { readonly method: string; resolve(value: unknown): void; reject(error: unknown): void }>();
  const handlers = new Map<string, Set<{ readonly handler: CdpEventHandler; readonly sessionId: string | undefined }>>();
  let nextId = 1; let isClosed = false; let markClosed!: () => void;
  const closed = new Promise<void>(resolve => { markClosed = resolve; });
  const fail = (error: unknown) => {
    if (isClosed) return; isClosed = true;
    for (const call of pending.values()) call.reject(error);
    pending.clear(); markClosed();
    try { socket.close(); } catch { /* already closed */ }
  };

  if (socket.readyState !== 1) await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => { reject(new MayuraError('TIMEOUT', 'The browser did not accept the connection in time.')); try { socket.close(); } catch { /* not open */ } }, options.timeoutMs ?? 30_000);
    const onAbort = () => { clearTimeout(timer); reject(new MayuraError('CANCELLED', 'Connecting to the browser was cancelled.')); try { socket.close(); } catch { /* not open */ } };
    if (options.signal?.aborted) { onAbort(); return; }
    options.signal?.addEventListener('abort', onAbort, { once: true });
    socket.addEventListener('open', () => { clearTimeout(timer); options.signal?.removeEventListener('abort', onAbort); resolve(); });
    socket.addEventListener('error', () => { clearTimeout(timer); options.signal?.removeEventListener('abort', onAbort); reject(new BrowserError('unavailable')); });
  });
  socket.addEventListener('close', () => fail(new BrowserError('unavailable')));
  socket.addEventListener('error', () => fail(new BrowserError('unavailable')));
  socket.addEventListener('message', event => {
    // CDP is text: anything else is no JSON, and closes the connection like other nonsense.
    const data = typeof event.data === 'string' ? event.data : '';
    // A JavaScript string's length bounds its UTF-8 size from below; three times it bounds it from above.
    if (data.length > maxMessageBytes) return fail(new MayuraError('LIMIT_EXCEEDED', `The browser sent a message over ${maxMessageBytes} bytes.`));
    let message: { id?: unknown; result?: unknown; error?: { code?: unknown; message?: unknown }; method?: unknown; params?: unknown; sessionId?: unknown };
    try { message = JSON.parse(data) as typeof message; } catch { return fail(new BrowserError('unavailable')); }
    if (typeof message.id === 'number') {
      const call = pending.get(message.id); if (!call) return;
      pending.delete(message.id);
      if (message.error) call.reject(new CdpError(call.method, typeof message.error.code === 'number' ? message.error.code : 0));
      else call.resolve(message.result ?? {});
      return;
    }
    if (typeof message.method !== 'string') return;
    const sessionId = typeof message.sessionId === 'string' ? message.sessionId : undefined;
    const params = message.params && typeof message.params === 'object' ? message.params as Record<string, unknown> : {};
    for (const entry of handlers.get(message.method) ?? []) {
      if (entry.sessionId !== undefined && entry.sessionId !== sessionId) continue;
      try { entry.handler(params, sessionId); } catch { /* a handler's failure is its own */ }
    }
  });

  return {
    closed,
    get isClosed() { return isClosed; },
    close: () => fail(new MayuraError('CANCELLED', 'The browser connection was closed.')),
    on: (method, handler, sessionId) => {
      const entry = { handler, sessionId };
      let set = handlers.get(method); if (!set) { set = new Set(); handlers.set(method, set); }
      set.add(entry);
      return () => { set.delete(entry); };
    },
    send: <T>(method: string, params: Record<string, unknown> = {}, sendOptions: CdpSendOptions = {}) => new Promise<T>((resolve, reject) => {
      if (isClosed) { reject(new BrowserError('unavailable')); return; }
      const id = nextId++;
      const timer = setTimeout(() => { pending.delete(id); reject(new MayuraError('TIMEOUT', `${method} got no reply in time.`)); }, sendOptions.timeoutMs ?? 30_000);
      const onAbort = () => { clearTimeout(timer); pending.delete(id); reject(new MayuraError('CANCELLED', `${method} was cancelled.`)); };
      if (sendOptions.signal?.aborted) { onAbort(); return; }
      sendOptions.signal?.addEventListener('abort', onAbort, { once: true });
      const settle = () => { clearTimeout(timer); sendOptions.signal?.removeEventListener('abort', onAbort); };
      pending.set(id, { method, resolve: value => { settle(); resolve(value as T); }, reject: error => { settle(); reject(error); } });
      try { socket.send(JSON.stringify({ id, method, params, ...(sendOptions.sessionId ? { sessionId: sendOptions.sessionId } : {}) })); }
      catch { pending.delete(id); settle(); reject(new BrowserError('unavailable')); }
    }),
  };
}
