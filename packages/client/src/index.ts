/** Browser-safe wire values; this package has no privileged runtime or Node imports. */
export type ClientJson = null | boolean | number | string | readonly ClientJson[] | { readonly [key: string]: ClientJson };
export interface ClientSchema<T> {
  readonly '~standard': { readonly version: 1; validate(value: unknown): { readonly value: T; readonly issues?: undefined } | { readonly issues: readonly unknown[] } | PromiseLike<{ readonly value: T; readonly issues?: undefined } | { readonly issues: readonly unknown[] }> };
}
export type RemoteStatus = 'running' | 'succeeded' | 'failed' | 'blocked' | 'cancelled' | 'outcome_unknown';
export type RemoteOutcome<T> = { readonly status: 'succeeded'; readonly output: T; readonly evidence: readonly RemoteReceipt[] }
  | { readonly status: Exclude<RemoteStatus, 'running' | 'succeeded'>; readonly error: { readonly code: string }; readonly evidence: readonly RemoteReceipt[] };
export interface RemoteReceipt {
  readonly runId: string;
  readonly receipt: { readonly callId: string; readonly toolId: string; readonly execution: 'not_started' | 'succeeded' | 'failed' | 'unknown'; readonly disclosure: 'released' | 'withheld' };
}
export interface RemoteSnapshot {
  readonly id: string; readonly status: RemoteStatus;
  readonly budget: { readonly spentMicros: number | string; readonly reservedMicros: number; readonly calls: number };
  readonly evidence: readonly RemoteReceipt[];
}
export interface ClientEvent {
  readonly runId: string; readonly sequence: number; readonly timestamp: string;
  readonly type: 'run.started' | 'model.started' | 'model.completed' | 'tool.started' | 'tool.completed'
    | 'hook.started' | 'hook.completed' | 'run.completed' | 'events.gap';
  readonly metadata: Readonly<Record<string, string | number | boolean>>;
}
export interface RemoteRun {
  readonly id: string;
  inspect(options?: { readonly signal?: AbortSignal }): Promise<RemoteSnapshot>;
  /** Returns undefined while running; terminal output requires a wire-output schema. No polling/retry is implicit. */
  result<T>(schema: ClientSchema<T>, options?: { readonly signal?: AbortSignal }): Promise<RemoteOutcome<T> | undefined>;
  cancel(options?: { readonly signal?: AbortSignal }): Promise<void>;
  events(options?: { readonly after?: number; readonly signal?: AbortSignal }): AsyncIterable<ClientEvent>;
}
export interface ClientOptions {
  readonly baseUrl: string;
  readonly token: () => string | Promise<string>;
  readonly fetch?: typeof globalThis.fetch;
  readonly maxResponseBytes?: number;
  readonly maxEventBytes?: number;
  readonly requestTimeoutMs?: number;
}
export interface MayuraClient {
  agents(options?: { readonly signal?: AbortSignal }): Promise<readonly { readonly id: string; readonly version: string }[]>;
  submit(agentId: string, input: unknown, options: { readonly idempotencyKey: string; readonly signal?: AbortSignal }): Promise<RemoteRun>;
  run(id: string): RemoteRun;
}
/** Safe machine-readable transport error; server/provider response bodies are never used as its message. */
export class ClientError extends Error {
  constructor(readonly code: string, readonly status?: number) { super(`Mayura request failed (${code}).`); this.name = 'ClientError'; Object.freeze(this); }
}
const encoder = new TextEncoder();

/** Encode untrusted text for an HTML text node. Prefer DOM `textContent` when a DOM is available. */
export function escapeHtmlText(value: string, maxBytes = 1_048_576): string {
  if (typeof value !== 'string' || !Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 1_048_576) throw new ClientError('INVALID_RENDER_INPUT');
  if (encoder.encode(value).length > maxBytes) throw new ClientError('RESPONSE_LIMIT');
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;');
}
const statuses: readonly string[] = ['running', 'succeeded', 'failed', 'blocked', 'cancelled', 'outcome_unknown'];
const eventTypes: readonly string[] = ['run.started', 'model.started', 'model.completed', 'tool.started', 'tool.completed', 'hook.started', 'hook.completed', 'run.completed', 'events.gap'];
const hookFields = ['hookId', 'hookVersion', 'stage', 'invocationId', 'step', 'attempt'] as const;
const hookStages: readonly string[] = ['beforeExecution', 'beforeModelCall', 'beforeToolCall', 'beforeOutputRelease'];
const hookStatuses: readonly string[] = ['continued', 'blocked', 'failed', 'cancelled', 'outcome_unknown'];
/** Hook observations have an exact content-free schema; the browser never admits hook arguments or messages. */
function hookMetadata(metadata: Record<string, unknown>, completed: boolean): void {
  const required = completed ? [...hookFields, 'status'] : hookFields;
  if (Object.keys(metadata).length !== required.length || required.some(key => !Object.hasOwn(metadata, key))) throw new ClientError('INVALID_STREAM');
  for (const key of ['hookId', 'hookVersion']) {
    if (typeof metadata[key] !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/.test(metadata[key] as string)) throw new ClientError('INVALID_STREAM');
  }
  const stage = metadata['stage']; const invocation = metadata['invocationId']; const step = metadata['step'];
  if (typeof stage !== 'string' || !hookStages.includes(stage)
    || typeof invocation !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(invocation)
    || typeof step !== 'number' || !Number.isSafeInteger(step) || step < 0 || (stage === 'beforeExecution' && step !== 0)
    || metadata['attempt'] !== 1 || (completed && (typeof metadata['status'] !== 'string' || !hookStatuses.includes(metadata['status'] as string)))) {
    throw new ClientError('INVALID_STREAM');
  }
}
function fail(): never { throw new ClientError('INVALID_RESPONSE'); }
function record(value: unknown): Record<string, unknown> { if (typeof value !== 'object' || value === null || Array.isArray(value)) return fail(); return value as Record<string, unknown>; }
function text(value: unknown, maximum = 256): string { if (typeof value !== 'string' || value.length === 0 || value.length > maximum) return fail(); return value; }
function natural(value: unknown): number { if (!Number.isSafeInteger(value) || (value as number) < 0) return fail(); return value as number; }
function runId(value: unknown): string { const id = text(value, 36); if (!/^[a-f0-9-]{36}$/.test(id)) return fail(); return id; }
function json(value: unknown, maximum: number): ClientJson {
  let nodes = 0;
  const seen = new Set<object>();
  const copy = (item: unknown, depth: number): ClientJson => {
    if (++nodes > 100_000 || depth > 32) return fail();
    if (typeof item === 'string' && item.length > maximum) return fail();
    if (item === null || typeof item === 'boolean' || typeof item === 'string') return item;
    if (typeof item === 'number' && Number.isFinite(item) && (!Number.isInteger(item) || Number.isSafeInteger(item))) return item;
    if (typeof item !== 'object' || seen.has(item) || (!Array.isArray(item) && ![null, Object.prototype].includes(Object.getPrototypeOf(item)))) return fail();
    seen.add(item);
    const descriptors = Object.getOwnPropertyDescriptors(item);
    let result: ClientJson;
    if (Array.isArray(item)) {
      const entries: ClientJson[] = [];
      for (let index = 0; index < item.length; index++) {
        const descriptor = descriptors[String(index)]; if (!descriptor || !('value' in descriptor)) return fail();
        entries.push(copy(descriptor.value, depth + 1));
      }
      result = Object.freeze(entries);
    } else {
      const entries: Record<string, ClientJson> = {};
      for (const key of Reflect.ownKeys(descriptors)) {
        if (typeof key !== 'string' || ['__proto__', 'constructor', 'prototype'].includes(key)) return fail();
        const descriptor = descriptors[key]!;
        if (!('value' in descriptor) || !descriptor.enumerable) return fail();
        entries[key] = copy(descriptor.value, depth + 1);
      }
      result = Object.freeze(entries);
    }
    seen.delete(item); return result;
  };
  try {
    const result = copy(value, 0);
    if (encoder.encode(JSON.stringify(result)).byteLength > maximum) throw new Error();
    return result;
  } catch { throw new ClientError('INVALID_JSON'); }
}
async function race<T>(work: PromiseLike<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) { void Promise.resolve(work).catch(() => {}); throw new ClientError('ABORTED'); }
  return await new Promise<T>((resolve, reject) => {
    const abort = (): void => { cleanup(); reject(new ClientError('ABORTED')); };
    const cleanup = (): void => { signal.removeEventListener('abort', abort); };
    signal.addEventListener('abort', abort, { once: true });
    Promise.resolve(work).then(value => { cleanup(); resolve(value); }, () => { cleanup(); reject(new ClientError('TRANSPORT_FAILED')); });
    if (signal.aborted) abort();
  });
}

/** Explicit credentials and destination. Commands never retry automatically or follow redirects. */
export function createClient(options: ClientOptions): MayuraClient {
  const base = new URL(options.baseUrl);
  if (!['https:', 'http:'].includes(base.protocol) || base.username || base.password || base.pathname !== '/' || base.search || base.hash) throw new ClientError('INVALID_CONFIG');
  if (base.protocol === 'http:' && !['localhost', '127.0.0.1', '[::1]'].includes(base.hostname)) throw new ClientError('INVALID_CONFIG');
  if (typeof options.token !== 'function') throw new ClientError('INVALID_CONFIG');
  const token = options.token; const transport = options.fetch ?? globalThis.fetch.bind(globalThis);
  const maxBytes = options.maxResponseBytes ?? 4_194_304; const frameBytes = options.maxEventBytes ?? 16_384; const timeout = options.requestTimeoutMs ?? 30_000;
  if ([maxBytes, frameBytes, timeout].some(value => !Number.isSafeInteger(value) || value < 1 || value > 16_777_216)) throw new ClientError('INVALID_CONFIG');

  const request = async (path: string, method: 'GET' | 'POST', signal: AbortSignal, body?: ClientJson, key?: string): Promise<Response> => {
    const credential = await race(Promise.resolve().then(() => { if (signal.aborted) throw new ClientError('ABORTED'); return token(); }), signal);
    if (typeof credential !== 'string' || !/^[\x21-\x7e]{1,8192}$/.test(credential)) throw new ClientError('INVALID_CREDENTIAL');
    const headers: Record<string, string> = { Authorization: `Bearer ${credential}` };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (key !== undefined) headers['Idempotency-Key'] = key;
    if (signal.aborted) throw new ClientError('ABORTED');
    const response = await race(Promise.resolve().then(() => {
      if (signal.aborted) throw new ClientError('ABORTED');
      return transport(new URL(path, base), {
      method, headers, signal, redirect: 'error', credentials: 'omit', cache: 'no-store',
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    }).then(response => {
      if (signal.aborted) {
        void response.body?.cancel().catch(() => {});
        throw new ClientError('ABORTED');
      }
      return response;
    }), signal);
    if (response.redirected || (response.url && new URL(response.url).origin !== base.origin) || !response.ok) {
      void response.body?.cancel().catch(() => {});
      throw new ClientError(response.redirected ? 'REDIRECT_DENIED' : 'HTTP_ERROR', response.status);
    }
    return response;
  };
  const scope = (external?: AbortSignal) => {
    const controller = new AbortController(); const abort = (): void => { controller.abort(); };
    external?.addEventListener('abort', abort, { once: true }); if (external?.aborted) abort();
    const timer = setTimeout(abort, timeout);
    return { signal: controller.signal, close() { clearTimeout(timer); external?.removeEventListener('abort', abort); controller.abort(); } };
  };
  const readJson = async (response: Response, signal: AbortSignal): Promise<Record<string, unknown>> => {
    if (!/^application\/json(?:\s*;|$)/i.test(response.headers.get('content-type') ?? '')) { void response.body?.cancel().catch(() => {}); return fail(); }
    const reader = response.body?.getReader(); if (!reader) return fail();
    const chunks: Uint8Array[] = []; let size = 0; let done = false;
    try {
      while (true) {
        const next = await race(reader.read(), signal); if (next.done) { done = true; break; }
        size += next.value.byteLength; if (size > maxBytes) throw new ClientError('RESPONSE_LIMIT'); chunks.push(next.value);
      }
      const bytes = new Uint8Array(size); let offset = 0;
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
      try { return record(json(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)), maxBytes)); }
      catch { return fail(); }
    } finally { if (!done) void reader.cancel().catch(() => {}); reader.releaseLock(); }
  };
  const command = async (path: string, method: 'GET' | 'POST', external?: AbortSignal, body?: ClientJson, key?: string) => {
    const control = scope(external);
    try { return await readJson(await request(path, method, control.signal, body, key), control.signal); }
    finally { control.close(); }
  };
  const snapshot = (raw: Record<string, unknown>, id: string): RemoteSnapshot => {
    if (raw['id'] !== id || !statuses.includes(String(raw['status']))) return fail();
    const budget = record(raw['budget']); const spent = budget['spentMicros'];
    if (typeof spent === 'string' ? !/^\d{1,64}$/.test(spent) : natural(spent) < 0) return fail();
    if (!Array.isArray(raw['evidence']) || raw['evidence'].length > 4096) return fail();
    const evidence = raw['evidence'].map(value => {
      const entry = record(value); const receipt = record(entry['receipt']);
      if (!['not_started', 'succeeded', 'failed', 'unknown'].includes(String(receipt['execution'])) || !['released', 'withheld'].includes(String(receipt['disclosure']))) return fail();
      return Object.freeze({ runId: runId(entry['runId']), receipt: Object.freeze({ callId: text(receipt['callId']), toolId: text(receipt['toolId']), execution: receipt['execution'], disclosure: receipt['disclosure'] }) }) as RemoteReceipt;
    });
    return Object.freeze({ id, status: raw['status'] as RemoteStatus, budget: Object.freeze({ spentMicros: spent as number | string, reservedMicros: natural(budget['reservedMicros']), calls: natural(budget['calls']) }), evidence: Object.freeze(evidence) });
  };
  const run = (id: string): RemoteRun => {
    runId(id); const path = `/v1/runs/${id}`;
    return Object.freeze({
      id,
      async inspect(settings?: { readonly signal?: AbortSignal }) { return snapshot(await command(path, 'GET', settings?.signal), id); },
      async result<T>(schema: ClientSchema<T>, settings?: { readonly signal?: AbortSignal }): Promise<RemoteOutcome<T> | undefined> {
        const raw = await command(path, 'GET', settings?.signal); const state = snapshot(raw, id);
        if (state.status === 'running') return undefined;
        const outcome = record(raw['outcome']); if (outcome['status'] !== state.status) return fail();
        if (outcome['status'] !== 'succeeded') return Object.freeze({ status: state.status as Exclude<RemoteStatus, 'running' | 'succeeded'>, error: Object.freeze({ code: text(record(outcome['error'])['code'], 128) }), evidence: state.evidence });
        let validationAborted = false;
        try {
          if (schema['~standard'].version !== 1) throw new Error();
          const control = scope(settings?.signal);
          try {
            const validated = await race(Promise.resolve(schema['~standard'].validate(outcome['output'])), control.signal);
            if (validated.issues) throw new Error();
            return Object.freeze({ status: 'succeeded' as const, output: json(validated.value, maxBytes) as T, evidence: state.evidence });
          } catch (error) { validationAborted = control.signal.aborted; throw error; }
          finally { control.close(); }
        } catch { throw new ClientError(validationAborted ? 'ABORTED' : 'INVALID_OUTPUT'); }
      },
      async cancel(settings?: { readonly signal?: AbortSignal }) {
        const value = await command(`${path}/cancel`, 'POST', settings?.signal);
        if (value['id'] !== id || value['cancellationRequested'] !== true) fail();
      },
      async *events(settings?: { readonly after?: number; readonly signal?: AbortSignal }): AsyncIterable<ClientEvent> {
        let cursor = natural(settings?.after ?? 0); const control = scope(settings?.signal);
        let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
        try {
          const response = await request(`${path}/events?after=${cursor}`, 'GET', control.signal);
          if (!/^text\/event-stream(?:\s*;|$)/i.test(response.headers.get('content-type') ?? '')) { void response.body?.cancel().catch(() => {}); fail(); }
          reader = response.body?.getReader(); if (!reader) fail();
          const decoder = new TextDecoder('utf-8', { fatal: true }); let pending = '';
          while (true) {
            const next = await race(reader.read(), control.signal);
            if (!next.done && next.value.byteLength > maxBytes) throw new ClientError('STREAM_LIMIT');
            try { pending += next.done ? decoder.decode() : decoder.decode(next.value, { stream: true }); }
            catch { throw new ClientError('INVALID_STREAM'); }
            // Handle LF/CRLF independently of how UTF-8/network chunks were split.
            while (true) {
              const boundary = /\r?\n\r?\n/.exec(pending); if (!boundary || boundary.index === undefined) break;
              const frame = pending.slice(0, boundary.index); pending = pending.slice(boundary.index + boundary[0].length);
              if (encoder.encode(frame).byteLength > frameBytes) throw new ClientError('STREAM_LIMIT');
              let event = ''; let eventId = ''; const data: string[] = [];
              for (const line of frame.split(/\r?\n/)) {
                if (!line || line.startsWith(':')) continue;
                const colon = line.indexOf(':'); const key = colon < 0 ? line : line.slice(0, colon); const value = colon < 0 ? '' : line.slice(colon + 1).replace(/^ /, '');
                if (key === 'event') event = value; else if (key === 'id') eventId = value; else if (key === 'data') data.push(value);
              }
              if (data.length === 0) continue;
              if (event === 'stream.error') throw new ClientError('OBSERVATION_FAILED');
              let raw: Record<string, unknown>;
              try { raw = record(json(JSON.parse(data.join('\n')), frameBytes)); } catch { throw new ClientError('INVALID_STREAM'); }
              const sequence = natural(raw['sequence']);
              if (!eventTypes.includes(event) || raw['type'] !== event || raw['runId'] !== id || String(sequence) !== eventId || sequence <= cursor) throw new ClientError('INVALID_STREAM');
              const metadata = record(raw['metadata']);
              if (Object.keys(metadata).length > 64 || Object.values(metadata).some(value => !['string', 'number', 'boolean'].includes(typeof value))) throw new ClientError('INVALID_STREAM');
              if (event === 'hook.started' || event === 'hook.completed') hookMetadata(metadata, event === 'hook.completed');
              if (event === 'events.gap') {
                if (metadata['from'] !== cursor + 1 || metadata['to'] !== sequence
                  || !Number.isSafeInteger(metadata['from']) || !Number.isSafeInteger(metadata['to']) || (metadata['to'] as number) < (metadata['from'] as number)) throw new ClientError('INVALID_STREAM');
              } else if (sequence !== cursor + 1) throw new ClientError('INVALID_STREAM');
              const timestamp = text(raw['timestamp'], 64); if (!Number.isFinite(Date.parse(timestamp))) throw new ClientError('INVALID_STREAM');
              cursor = sequence;
              yield Object.freeze({ runId: id, sequence, timestamp, type: event as ClientEvent['type'], metadata: Object.freeze(metadata) as ClientEvent['metadata'] });
            }
            if (encoder.encode(pending).byteLength > frameBytes) throw new ClientError('STREAM_LIMIT');
            if (next.done) { if (pending.trim()) throw new ClientError('TRUNCATED_STREAM'); break; }
          }
        } finally { control.close(); if (reader) { void reader.cancel().catch(() => {}); reader.releaseLock(); } }
      },
    });
  };
  return Object.freeze({
    run,
    async agents(settings?: { readonly signal?: AbortSignal }) {
      const raw = await command('/v1/agents', 'GET', settings?.signal);
      if (!Array.isArray(raw['agents']) || raw['agents'].length > 256) return fail();
      return Object.freeze(raw['agents'].map(value => { const item = record(value); return Object.freeze({ id: text(item['id']), version: text(item['version']) }); }));
    },
    async submit(agentId: string, input: unknown, settings: { readonly idempotencyKey: string; readonly signal?: AbortSignal }) {
      if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(settings.idempotencyKey)) throw new ClientError('INVALID_IDEMPOTENCY_KEY');
      const raw = await command('/v1/runs', 'POST', settings.signal, json({ agentId, input }, maxBytes), settings.idempotencyKey);
      if (raw['profile'] !== 'ephemeral') return fail(); return run(runId(raw['id']));
    },
  });
}
