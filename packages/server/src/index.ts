import { freezeJson, jsonValue, type JsonObject, type JsonValue, type Outcome, type Permissions, type RunHandle, type Scope } from '@mayura/core';
import { assertAgent, createRuntime, type AgentDefinition, type Runtime, type RuntimeLimits } from '@mayura/runtime';

export interface ServerIdentity {
  readonly scope: Scope;
  readonly agentIds: readonly string[];
  readonly capabilities: readonly ('runs:read' | 'runs:submit' | 'runs:cancel')[];
  readonly expiresAtMs: number;
}
export interface RegisteredAgent {
  readonly agent: AgentDefinition;
  readonly permissions: Permissions;
  readonly limits?: RuntimeLimits;
}
export interface AgentServerOptions {
  readonly publicOrigin: string;
  readonly allowedOrigins?: readonly string[];
  readonly agents: readonly RegisteredAgent[];
  /** Verify the token using trusted application authentication; never trust token claims without verification. */
  readonly authenticate: (request: { readonly token: string; readonly signal: AbortSignal }) => Promise<ServerIdentity | null>;
  readonly limits?: {
    readonly maxRuns?: number; readonly maxRuntimes?: number; readonly maxRequests?: number;
    readonly maxStreams?: number; readonly maxBodyBytes?: number; readonly maxResponseBytes?: number;
    readonly requestTimeoutMs?: number; readonly streamDurationMs?: number;
  };
}
export interface AgentServer { fetch(request: Request): Promise<Response>; close(): Promise<void> }
interface Entry {
  readonly owner: string; readonly agentId: string; readonly digest: string;
  readonly handle: RunHandle<unknown>; readonly runtime: Runtime;
  outcome?: Outcome<unknown>;
}
class HttpFailure extends Error {
  constructor(readonly status: number, readonly code: string) { super(code); }
}
const identifier = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/;
const encoder = new TextEncoder();
function object(value: unknown, maxBytes = 1_048_576): JsonObject {
  const copy = jsonValue(value, { maxBytes });
  if (copy === null || Array.isArray(copy) || typeof copy !== 'object') throw new HttpFailure(400, 'INVALID_REQUEST');
  return copy;
}
function exact(value: JsonObject, keys: readonly string[]): void {
  if (Object.keys(value).length !== keys.length || keys.some(key => !(key in value))) throw new HttpFailure(400, 'INVALID_REQUEST');
}
function canonical(value: JsonValue): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  return Array.isArray(value) ? `[${value.map(canonical).join(',')}]`
    : `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key]!)}`).join(',')}}`;
}
function origin(value: string): string {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new Error('Invalid server origin.');
  if (url.protocol === 'http:' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) throw new Error('Non-loopback origins require HTTPS.');
  return url.origin;
}
function assertActive(signal: AbortSignal): void { if (signal.aborted) throw new HttpFailure(408, 'REQUEST_TIMEOUT'); }
async function bounded<T>(operation: PromiseLike<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) { void Promise.resolve(operation).catch(() => {}); throw new HttpFailure(408, 'REQUEST_TIMEOUT'); }
  assertActive(signal);
  return await new Promise<T>((resolve, reject) => {
    const abort = (): void => { cleanup(); reject(new HttpFailure(408, 'REQUEST_TIMEOUT')); };
    const cleanup = (): void => { signal.removeEventListener('abort', abort); };
    signal.addEventListener('abort', abort, { once: true });
    Promise.resolve(operation).then(value => { cleanup(); resolve(value); }, (error: unknown) => { cleanup(); reject(error instanceof HttpFailure ? error : new HttpFailure(503, 'SERVICE_UNAVAILABLE')); });
    if (signal.aborted) abort();
  });
}

/** Authenticated Fetch facade. Hosting, TLS, durable execution, and token verification remain explicit. */
export function createAgentServer(options: AgentServerOptions): AgentServer {
  const publicOrigin = origin(options.publicOrigin);
  const origins = new Set((options.allowedOrigins ?? []).map(origin));
  if (typeof options.authenticate !== 'function' || !Array.isArray(options.agents) || options.agents.length > 256) throw new Error('Explicit authentication and a bounded agent registry are required.');
  const authenticate = options.authenticate;
  const limits = Object.freeze({ maxRuns: 512, maxRuntimes: 128, maxRequests: 64, maxStreams: 64,
    maxBodyBytes: 1_048_576, maxResponseBytes: 4_194_304, requestTimeoutMs: 10_000, streamDurationMs: 30_000, ...options.limits });
  if (Object.keys(limits).some(key => !['maxRuns', 'maxRuntimes', 'maxRequests', 'maxStreams', 'maxBodyBytes', 'maxResponseBytes', 'requestTimeoutMs', 'streamDurationMs'].includes(key))) throw new Error('Unknown server limit.');
  for (const value of Object.values(limits)) if (!Number.isSafeInteger(value) || value < 1 || value > 16_777_216) throw new Error('Server limits must be bounded positive integers.');
  const registry = new Map<string, RegisteredAgent>();
  for (const config of options.agents) {
    assertAgent(config.agent);
    if (registry.has(config.agent.id)) throw new Error('Agent registry IDs must be unique.');
    // Validate configuration now, not after accepting an HTTP command. No model work is performed.
    const permissions = Object.freeze({ allow: Object.freeze([...config.permissions.allow]) });
    const settings = config.limits === undefined ? {} : Object.freeze({ ...config.limits });
    const check = createRuntime({ profile: 'ephemeral', permissions, limits: settings });
    void check.close();
    registry.set(config.agent.id, Object.freeze({ agent: config.agent, permissions, limits: settings }));
  }
  const runtimes = new Map<string, Runtime>();
  const runs = new Map<string, Entry>();
  const submissions = new Map<string, Entry>();
  const streams = new Set<() => void>();
  let closed = false;
  let requests = 0;
  let authentications = 0;

  const response = (value: unknown, status = 200, extra: Record<string, string> = {}): Response => {
    let text: string;
    try { text = JSON.stringify(jsonValue(value, { maxBytes: limits.maxResponseBytes })); }
    catch { return new Response('{"error":{"code":"RESPONSE_LIMIT"}}', { status: 503, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } }); }
    return new Response(text, { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...extra } });
  };
  const session = async (request: Request, signal: AbortSignal): Promise<ServerIdentity> => {
    const authorization = request.headers.get('authorization') ?? '';
    if (!/^Bearer [\x21-\x7e]{1,8192}$/.test(authorization)) throw new HttpFailure(401, 'UNAUTHORIZED');
    let supplied: ServerIdentity | null;
    assertActive(signal);
    if (authentications >= limits.maxRequests) throw new HttpFailure(429, 'AUTH_LIMIT');
    authentications++;
    const verification = Promise.resolve().then(() => {
      assertActive(signal); return authenticate(Object.freeze({ token: authorization.slice(7), signal }));
    }).finally(() => { authentications--; });
    // A non-cooperative verifier retains its admission until it really completes.
    try { supplied = await bounded(verification, signal); }
    catch { assertActive(signal); throw new HttpFailure(503, 'AUTH_UNAVAILABLE'); }
    assertActive(signal);
    try {
      const raw = object(supplied, 65_536); const scope = object(raw['scope']);
      exact(raw, ['scope', 'agentIds', 'capabilities', 'expiresAtMs']); exact(scope, ['principalId', 'projectId']);
      if (typeof scope['principalId'] !== 'string' || !identifier.test(scope['principalId']) || typeof scope['projectId'] !== 'string' || !identifier.test(scope['projectId'])
        || !Array.isArray(raw['agentIds']) || raw['agentIds'].length > 256 || raw['agentIds'].some(id => typeof id !== 'string' || !identifier.test(id))
        || !Array.isArray(raw['capabilities']) || raw['capabilities'].length > 3 || raw['capabilities'].some(cap => !['runs:read', 'runs:submit', 'runs:cancel'].includes(String(cap)))
        || typeof raw['expiresAtMs'] !== 'number' || !Number.isSafeInteger(raw['expiresAtMs']) || raw['expiresAtMs'] <= Date.now()) throw new Error();
      return freezeJson(raw) as unknown as ServerIdentity;
    } catch { throw new HttpFailure(401, 'UNAUTHORIZED'); }
  };
  const requireCapability = (identity: ServerIdentity, capability: ServerIdentity['capabilities'][number]): void => {
    if (!identity.capabilities.includes(capability)) throw new HttpFailure(403, 'FORBIDDEN');
    if (identity.expiresAtMs <= Date.now()) throw new HttpFailure(401, 'UNAUTHORIZED');
  };
  const body = async (request: Request, signal: AbortSignal): Promise<JsonObject> => {
    if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(request.headers.get('content-type') ?? '') || request.headers.has('content-encoding')) throw new HttpFailure(415, 'UNSUPPORTED_MEDIA_TYPE');
    const declared = request.headers.get('content-length');
    if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > limits.maxBodyBytes)) throw new HttpFailure(413, 'BODY_LIMIT');
    const reader = request.body?.getReader();
    if (!reader) throw new HttpFailure(400, 'INVALID_REQUEST');
    const chunks: Uint8Array[] = []; let total = 0; let complete = false;
    try {
      while (true) {
        const item = await bounded(reader.read(), signal);
        if (item.done) { complete = true; break; }
        total += item.value.byteLength;
        if (total > limits.maxBodyBytes) throw new HttpFailure(413, 'BODY_LIMIT');
        chunks.push(item.value);
      }
      const data = new Uint8Array(total); let offset = 0;
      for (const chunk of chunks) { data.set(chunk, offset); offset += chunk.byteLength; }
      try { return object(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(data)), limits.maxBodyBytes); }
      catch { throw new HttpFailure(400, 'INVALID_REQUEST'); }
    } finally { if (!complete) void reader.cancel().catch(() => {}); reader.releaseLock(); }
  };

  const eventResponse = (entry: Entry, after: number, identity: ServerIdentity, request: Request): Response => {
    if (closed) throw new HttpFailure(503, 'SERVER_CLOSED');
    if (streams.size >= limits.maxStreams) throw new HttpFailure(429, 'STREAM_LIMIT');
    const controller = new AbortController();
    const iterator = entry.handle.observe({ after, signal: controller.signal })[Symbol.asyncIterator]();
    let sink: ReadableStreamDefaultController<Uint8Array>;
    let ended = false;
    const finish = (): void => {
      if (ended) return;
      ended = true; controller.abort(); clearTimeout(timer); streams.delete(finish);
      request.signal.removeEventListener('abort', finish);
      try { sink.close(); } catch { /* Consumer cancellation may already have closed the stream. */ }
      void iterator.return?.().catch(() => {});
    };
    const timer = setTimeout(finish, Math.max(0, Math.min(limits.streamDurationMs, identity.expiresAtMs - Date.now())));
    streams.add(finish);
    const stream = new ReadableStream<Uint8Array>({
      start(value) { sink = value; },
      async pull(value) {
        if (ended) return;
        try {
          const next = await iterator.next();
          if (ended) return;
          if (next.done) { finish(); return; }
          const event = JSON.stringify(jsonValue(next.value, { maxBytes: 16_384 }));
          value.enqueue(encoder.encode(`id: ${next.value.sequence}\nevent: ${next.value.type}\ndata: ${event}\n\n`));
        } catch {
          if (!ended) value.enqueue(encoder.encode('event: stream.error\ndata: {"code":"OBSERVATION_FAILED"}\n\n'));
          finish();
        }
      },
      cancel() { finish(); },
    }, { highWaterMark: 1 });
    request.signal.addEventListener('abort', finish, { once: true });
    if (request.signal.aborted) finish();
    return new Response(stream, { headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'X-Accel-Buffering': 'no' } });
  };

  const route = async (request: Request, signal: AbortSignal): Promise<Response> => {
    const url = new URL(request.url);
    if (url.origin !== publicOrigin || url.username || url.password || url.hash) throw new HttpFailure(400, 'INVALID_DESTINATION');
    const requestOrigin = request.headers.get('origin');
    if (requestOrigin !== null && !origins.has(requestOrigin)) throw new HttpFailure(403, 'ORIGIN_DENIED');
    const eventMatch = /^\/v1\/runs\/([a-f0-9-]{36})\/events$/.exec(url.pathname);
    if ([...url.searchParams.keys()].some(key => request.method !== 'GET' || !eventMatch || key !== 'after') || url.searchParams.getAll('after').length > 1) throw new HttpFailure(400, 'INVALID_QUERY');
    if (request.method === 'OPTIONS') {
      if (!requestOrigin || !['GET', 'POST'].includes(request.headers.get('access-control-request-method') ?? '')) throw new HttpFailure(403, 'ORIGIN_DENIED');
      const headers = (request.headers.get('access-control-request-headers') ?? '').toLowerCase().split(',').map(value => value.trim()).filter(Boolean);
      if (headers.some(value => !['authorization', 'content-type', 'idempotency-key'].includes(value))) throw new HttpFailure(403, 'ORIGIN_DENIED');
      return new Response(null, { status: 204, headers: { 'Access-Control-Allow-Methods': 'GET, POST', 'Access-Control-Allow-Headers': 'Authorization, Content-Type, Idempotency-Key' } });
    }
    const identity = await session(request, signal);
    if (closed) throw new HttpFailure(503, 'SERVER_CLOSED');
    const owner = canonical(identity.scope as unknown as JsonValue);
    if (request.method === 'GET' && url.pathname === '/v1/agents') {
      requireCapability(identity, 'runs:read');
      return response({ agents: [...registry.values()].filter(config => identity.agentIds.includes(config.agent.id)).map(config => ({ id: config.agent.id, version: config.agent.version })) });
    }
    if (request.method === 'POST' && url.pathname === '/v1/runs') {
      requireCapability(identity, 'runs:submit');
      const key = request.headers.get('idempotency-key') ?? '';
      if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(key)) throw new HttpFailure(400, 'IDEMPOTENCY_REQUIRED');
      const data = await body(request, signal); exact(data, ['agentId', 'input']);
      const agentId = data['agentId'];
      if (typeof agentId !== 'string' || !identity.agentIds.includes(agentId) || !registry.has(agentId)) throw new HttpFailure(404, 'NOT_FOUND');
      const config = registry.get(agentId)!;
      const digestBytes = await crypto.subtle.digest('SHA-256', encoder.encode(canonical({ agentId, version: config.agent.version, input: data['input']! })));
      const digest = [...new Uint8Array(digestBytes)].map(value => value.toString(16).padStart(2, '0')).join('');
      assertActive(signal); requireCapability(identity, 'runs:submit');
      if (closed) throw new HttpFailure(503, 'SERVER_CLOSED');
      const submissionKey = JSON.stringify([owner, key]);
      const previous = submissions.get(submissionKey);
      if (previous) {
        if (previous.digest !== digest) throw new HttpFailure(409, 'IDEMPOTENCY_CONFLICT');
        return response({ id: previous.handle.id, profile: 'ephemeral' }, 200);
      }
      if (runs.size >= limits.maxRuns) throw new HttpFailure(429, 'RUN_LIMIT');
      const runtimeKey = JSON.stringify([owner, agentId]);
      let runtime = runtimes.get(runtimeKey);
      if (!runtime) {
        if (runtimes.size >= limits.maxRuntimes) throw new HttpFailure(429, 'RUNTIME_LIMIT');
        runtime = createRuntime({ profile: 'ephemeral', scope: identity.scope, permissions: config.permissions, ...(config.limits ? { limits: config.limits } : {}) });
        runtimes.set(runtimeKey, runtime);
      }
      const handle = runtime.submit(config.agent, { input: data['input'] });
      const entry: Entry = { owner, agentId, digest, handle, runtime };
      runs.set(handle.id, entry); submissions.set(submissionKey, entry);
      void handle.result().then(outcome => { entry.outcome = outcome; });
      return response({ id: handle.id, profile: 'ephemeral' }, 202);
    }
    const match = /^\/v1\/runs\/([a-f0-9-]{36})(?:\/(cancel|events))?$/.exec(url.pathname);
    if (!match) throw new HttpFailure(404, 'NOT_FOUND');
    const entry = runs.get(match[1]!);
    if (!entry || entry.owner !== owner || !identity.agentIds.includes(entry.agentId)) throw new HttpFailure(404, 'NOT_FOUND');
    if (request.method === 'POST' && match[2] === 'cancel') {
      requireCapability(identity, 'runs:cancel');
      if (request.body !== null) throw new HttpFailure(400, 'INVALID_REQUEST');
      assertActive(signal); entry.handle.cancel();
      return response({ id: entry.handle.id, cancellationRequested: true }, 202);
    }
    if (request.method === 'GET' && match[2] === 'events') {
      requireCapability(identity, 'runs:read');
      const cursor = url.searchParams.get('after') ?? '0';
      if (!/^\d+$/.test(cursor) || !Number.isSafeInteger(Number(cursor))) throw new HttpFailure(400, 'INVALID_CURSOR');
      assertActive(signal); return eventResponse(entry, Number(cursor), identity, request);
    }
    if (request.method === 'GET' && !match[2]) {
      requireCapability(identity, 'runs:read');
      return response({ ...entry.runtime.inspect(entry.handle), ...(entry.outcome ? { outcome: entry.outcome } : {}) });
    }
    throw new HttpFailure(405, 'METHOD_NOT_ALLOWED');
  };

  return Object.freeze({
    async fetch(request: Request): Promise<Response> {
      if (closed) return response({ error: { code: 'SERVER_CLOSED' } }, 503);
      if (requests >= limits.maxRequests) return response({ error: { code: 'REQUEST_LIMIT' } }, 429);
      requests++;
      const controller = new AbortController();
      const abort = (): void => { controller.abort(); };
      request.signal.addEventListener('abort', abort, { once: true });
      if (request.signal.aborted) abort();
      const timer = setTimeout(abort, limits.requestTimeoutMs);
      let result: Response;
      try { result = await bounded(route(request, controller.signal).catch(error => {
        throw error instanceof HttpFailure ? error : new HttpFailure(400, 'INVALID_REQUEST');
      }), controller.signal); }
      catch (error) {
        const failure = error instanceof HttpFailure ? error : new HttpFailure(503, 'SERVICE_UNAVAILABLE');
        result = response({ error: { code: failure.code } }, failure.status);
      } finally { requests--; clearTimeout(timer); request.signal.removeEventListener('abort', abort); }
      const requestOrigin = request.headers.get('origin');
      if (requestOrigin && origins.has(requestOrigin)) {
        result.headers.set('Access-Control-Allow-Origin', requestOrigin); result.headers.set('Vary', 'Origin');
      }
      return result;
    },
    async close(): Promise<void> {
      closed = true;
      for (const finish of [...streams]) finish();
      await Promise.all([...runtimes.values()].map(runtime => runtime.close()));
    },
  });
}
