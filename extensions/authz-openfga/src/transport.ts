import { jsonValue, MayuraError, type AuthorizationDenyReason } from 'mayura';
import type { OpenFgaTupleKey } from './index.js';

/** Web-standard, explicit-service transport settings. Credentials never come from an incoming request. */
export interface CheckTransportOptions {
  readonly headers?: Readonly<Record<string, string>>;
  readonly fetch?: typeof globalThis.fetch;
  /** Development exception for literal 127.0.0.1 / ::1, not a hostname or production endpoint. */
  readonly allowInsecureLoopback?: boolean;
  /** Per-check wall-clock deadline, default 1000 ms; 1–30000. */
  readonly timeoutMs?: number;
  /** Outstanding I/O tasks, default 32; 1–256. Ignored aborts retain their slots. */
  readonly maxConcurrent?: number;
  /** UTF-8 request bytes, default 8192; 1024–16384. */
  readonly maxRequestBytes?: number;
  /** Decoded response bytes, default 2048; 256–16384. */
  readonly maxResponseBytes?: number;
}
function invalid(): never { throw new MayuraError('INVALID_CONFIG', 'Invalid bounded OpenFGA transport configuration.'); }
function bound(value: number | undefined, fallback: number, min: number, max: number): number {
  const result = value ?? fallback; if (!Number.isSafeInteger(result) || result < min || result > max) return invalid(); return result;
}
/** Snapshot fixed headers; prohibit routing/framing, browser credentials, and alternate model-selection fields. */
function headers(input: CheckTransportOptions['headers']): Headers {
  const value = jsonValue(input ?? {}, { maxBytes: 8192, maxDepth: 1, maxNodes: 33 });
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length > 16) return invalid();
  const result = new Headers({ 'content-type': 'application/json', accept: 'application/json' }); const seen = new Set<string>();
  for (const [key, entry] of Object.entries(value)) {
    const name = key.toLowerCase();
    if (!/^[a-z0-9!#$%&'*+.^_`|~-]{1,128}$/.test(name) || seen.has(name) || /^(?:sec-|proxy-)/.test(name)
      || ['host', 'cookie', 'set-cookie', 'connection', 'content-length', 'content-type', 'accept', 'transfer-encoding', 'upgrade', 'te', 'trailer',
        'origin', 'referer', 'user-agent', 'accept-encoding', 'openfga-authorization-model-id', 'x-openfga-authorization-model-id'].includes(name)
      || typeof entry !== 'string' || !entry.length || /[^\x20-\x7e]/.test(entry)) return invalid();
    seen.add(name); result.set(name, entry);
  }
  return result;
}
/** The native API supplies a boolean, not a policy revision or rule receipt. Trace data is bounded and discarded. */
function allowed(text: string): boolean | null {
  const raw = jsonValue(JSON.parse(text), { maxBytes: 16_384, maxDepth: 1, maxNodes: 4 });
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || typeof raw['allowed'] !== 'boolean'
    || Object.keys(raw).some(key => key !== 'allowed' && key !== 'resolution')
    || (raw['resolution'] !== undefined && typeof raw['resolution'] !== 'string')) return null;
  return raw['allowed'];
}
/** One native Check per evaluation. No automatic retry, redirects, cookies, discovery or local decision cache. */
export function createCheckTransport(destination: string, modelId: string, options: CheckTransportOptions) {
  const fixedHeaders = headers(options.headers); const transport = options.fetch ?? globalThis.fetch;
  if (typeof transport !== 'function') return invalid();
  const timeoutMs = bound(options.timeoutMs, 1000, 1, 30_000); const maxConcurrent = bound(options.maxConcurrent, 32, 1, 256);
  const maxRequestBytes = bound(options.maxRequestBytes, 8192, 1024, 16_384); const maxResponseBytes = bound(options.maxResponseBytes, 2048, 256, 16_384);
  const active = new Set<AbortController>(); let closed = false;
  type Result = boolean | AuthorizationDenyReason;
  const check = async (tuple: OpenFgaTupleKey, signal: AbortSignal): Promise<Result> => {
    if (closed || signal.aborted) return 'cancelled';
    if (active.size >= maxConcurrent) return 'limit_exceeded';
    const payload = JSON.stringify({ tuple_key: tuple, authorization_model_id: modelId, consistency: 'HIGHER_CONSISTENCY' });
    if (new TextEncoder().encode(payload).byteLength > maxRequestBytes) return 'limit_exceeded';
    const control = new AbortController(); const deadline = Date.now() + timeoutMs; active.add(control);
    return await new Promise<Result>(resolve => {
      let finished = false; let expired = false; let timer: ReturnType<typeof setTimeout> | undefined;
      const finish = (result: Result) => {
        if (finished) return; finished = true; clearTimeout(timer);
        signal.removeEventListener('abort', relay); control.signal.removeEventListener('abort', aborted); resolve(result);
      };
      const relay = () => control.abort(); const aborted = () => finish(expired ? 'unavailable' : 'cancelled');
      control.signal.addEventListener('abort', aborted, { once: true }); signal.addEventListener('abort', relay, { once: true });
      timer = setTimeout(() => { expired = true; control.abort(); }, timeoutMs); if (signal.aborted) relay();
      // The observed decision can finish early. The I/O slot remains held until fetch/read/cancellation really settles.
      const work = async (): Promise<Result> => {
        if (control.signal.aborted) return expired ? 'unavailable' : 'cancelled';
        let response: Response | undefined; let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
        let cancellation: Promise<void> | undefined;
        const cancelBody = (): Promise<void> | undefined => {
          if (cancellation) return cancellation;
          try { if (reader) cancellation = reader.cancel().catch(() => {}); else if (response?.body) cancellation = response.body.cancel().catch(() => {}); }
          catch { cancellation = Promise.resolve(); }
          return cancellation;
        };
        const stopBody = () => { void cancelBody(); }; control.signal.addEventListener('abort', stopBody, { once: true });
        try {
          response = await transport(destination, { method: 'POST', headers: new Headers(fixedHeaders), body: payload,
            signal: control.signal, redirect: 'error', credentials: 'omit', cache: 'no-store', referrerPolicy: 'no-referrer' });
          if (control.signal.aborted || closed) return expired ? 'unavailable' : 'cancelled';
          if (response.status !== 200 || response.redirected || (response.url && response.url !== destination)
            || !/^application\/json(?:\s*;|$)/i.test(response.headers.get('content-type') ?? '') || !response.body) return 'unavailable';
          const length = response.headers.get('content-length');
          if (length !== null && (!/^[0-9]{1,9}$/.test(length) || Number(length) > maxResponseBytes)) return 'unavailable';
          reader = response.body.getReader(); const chunks: Uint8Array[] = []; let size = 0;
          for (;;) {
            if (control.signal.aborted) return expired ? 'unavailable' : 'cancelled';
            const item = await reader.read(); if (item.done) break;
            size += item.value.byteLength; if (size > maxResponseBytes) return 'unavailable';
            if (item.value.byteLength) chunks.push(new Uint8Array(item.value));
          }
          const bytes = new Uint8Array(size); let offset = 0; for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
          const decision = allowed(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
          if (Date.now() >= deadline && !control.signal.aborted) { expired = true; control.abort(); }
          return control.signal.aborted || closed ? expired ? 'unavailable' : 'cancelled' : decision ?? 'unavailable';
        } catch { return control.signal.aborted ? expired ? 'unavailable' : 'cancelled' : 'unavailable'; }
        finally { control.signal.removeEventListener('abort', stopBody); await cancelBody(); if (reader) reader.releaseLock(); }
      };
      void Promise.resolve().then(work).then(result => {
        active.delete(control);
        if (Date.now() >= deadline && !control.signal.aborted) { expired = true; control.abort(); }
        finish(control.signal.aborted || closed ? expired ? 'unavailable' : 'cancelled' : result);
      }, () => { active.delete(control); finish('unavailable'); });
    });
  };
  return Object.freeze({ check, close() { if (closed) return; closed = true; for (const controller of active) controller.abort(); } });
}
