import { jsonValue, MayuraError, type AuthorizationDenyReason } from 'mayura';
import type { PermitAuthorizationInput } from './index.js';

/** Web-standard, explicit-service transport settings. Credentials never come from an incoming request. */
export interface PermitTransportOptions {
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
function invalid(): never { throw new MayuraError('INVALID_CONFIG', 'Invalid bounded Permit.io transport configuration.'); }
function bound(value: number | undefined, fallback: number, min: number, max: number): number {
  const result = value ?? fallback; if (!Number.isSafeInteger(result) || result < min || result > max) return invalid(); return result;
}
/** Explicit environment credential; never forwarded from a user request or discovered from the environment. */
function headers(apiKey: string): Headers {
  if (typeof apiKey !== 'string' || !/^[A-Za-z0-9._~+\/-]{1,4096}={0,2}$/u.test(apiKey)) return invalid();
  return new Headers({ 'content-type': 'application/json', accept: 'application/json', authorization: `Bearer ${apiKey}` });
}
/** Native PDP /allowed response only. Do not coerce truthy values or accept OPA/bulk response envelopes. */
function allowed(text: string): boolean | null {
  const raw = jsonValue(JSON.parse(text), { maxBytes: 16_384, maxDepth: 8, maxNodes: 1024 });
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || typeof raw['allow'] !== 'boolean'
    || Object.keys(raw).some(key => !['allow', 'result', 'query', 'debug'].includes(key))
    || (Object.hasOwn(raw, 'result') && raw['result'] !== raw['allow'])
    || ['query', 'debug'].some(key => Object.hasOwn(raw, key) && raw[key] !== null && (typeof raw[key] !== 'object' || Array.isArray(raw[key])))) return null;
  return raw['allow'];
}
/** One native PDP /allowed check per evaluation. No automatic retry, redirects, cookies, discovery or local decision cache. */
export function createPermitTransport(destination: string, apiKey: string, options: PermitTransportOptions) {
  const fixedHeaders = headers(apiKey); const transport = options.fetch ?? globalThis.fetch;
  if (typeof transport !== 'function') return invalid();
  const timeoutMs = bound(options.timeoutMs, 1000, 1, 30_000); const maxConcurrent = bound(options.maxConcurrent, 32, 1, 256);
  const maxRequestBytes = bound(options.maxRequestBytes, 8192, 1024, 16_384); const maxResponseBytes = bound(options.maxResponseBytes, 2048, 256, 16_384);
  const active = new Set<AbortController>(); let closed = false;
  type Result = boolean | AuthorizationDenyReason;
  const check = async (input: PermitAuthorizationInput, signal: AbortSignal): Promise<Result> => {
    if (closed || signal.aborted) return 'cancelled';
    if (active.size >= maxConcurrent) return 'limit_exceeded';
    const payload = JSON.stringify(input);
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
