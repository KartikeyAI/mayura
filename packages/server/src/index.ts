import { freezeJson, jsonValue, type JsonObject, type JsonValue, type Outcome, type Permissions, type RunHandle, type Scope } from '@mayura/core';
import { assertAgent, createRuntime, type AgentDefinition, type Runtime, type RuntimeLimits } from '@mayura/runtime';

export interface ServerIdentity {
  readonly scope: Scope;
  readonly agentIds: readonly string[];
  readonly capabilities: readonly ('runs:read' | 'runs:submit' | 'runs:cancel' | 'operations:read' | 'humans:read' | 'humans:respond' | 'workflows:read')[];
  readonly expiresAtMs: number;
}
export interface HealthCheck {
  readonly id: string;
  /** Trusted application callback. Returning false or throwing marks the dependency unavailable. */
  readonly check: (context: { readonly signal: AbortSignal; readonly scope: Scope }) => boolean | Promise<boolean>;
}
export interface HumanRequestRecord {
  readonly id: string; readonly agentId: string; readonly kind: 'information' | 'correction' | 'plan_selection';
  readonly schemaId: string; readonly schemaDigest: string; readonly prompt: string; readonly digest: string;
  readonly status: 'waiting' | 'answered' | 'cancelled' | 'timed_out'; readonly context?: JsonValue;
  readonly subjectDigest?: string; readonly deadlineAtMs?: number;
}
export interface HumanRequestTransport {
  readonly list: (input: { readonly scope: Scope; readonly agentIds: readonly string[]; readonly after: string | null; readonly limit: number; readonly signal: AbortSignal }) => Promise<{ readonly items: readonly HumanRequestRecord[]; readonly next: string | null }>;
  readonly inspect: (input: { readonly scope: Scope; readonly agentIds: readonly string[]; readonly id: string; readonly signal: AbortSignal }) => Promise<HumanRequestRecord | null>;
  readonly respond: (input: { readonly scope: Scope; readonly agentIds: readonly string[]; readonly actorId: string; readonly id: string;
    readonly requestDigest: string; readonly commandId: string; readonly value: JsonValue; readonly signal: AbortSignal }) => Promise<HumanRequestRecord>;
}
export interface WorkflowViewRecord {
  readonly format: 2 | 3 | 4 | 5; readonly definitionId: string; readonly definitionVersion: string; readonly runId: string;
  readonly revision: number; readonly status: 'running' | 'waiting' | 'succeeded' | 'failed' | 'blocked' | 'cancelled' | 'outcome_unknown';
  readonly nodes: readonly { readonly id: string; readonly kind: 'tool' | 'join' | 'wait' | 'child' | 'human' | 'timer'; readonly dependsOn: readonly string[] }[];
  readonly steps: readonly { readonly id: string; readonly kind: 'tool' | 'join' | 'wait' | 'child' | 'human' | 'timer';
    readonly status: 'pending' | 'waiting' | 'approved' | 'dispatching' | 'succeeded' | 'failed' | 'blocked' | 'unknown' | 'skipped' | 'timed_out';
    readonly childRunId?: string }[];
}
export interface WorkflowViewTransport {
  readonly inspect: (input: { readonly scope: Scope; readonly agentIds: readonly string[]; readonly runId: string;
    readonly signal: AbortSignal }) => Promise<WorkflowViewRecord | null>;
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
  /** Expose only a content-free process liveness response at GET /healthz. */
  readonly publicLiveness?: boolean;
  /** Access-controlled readiness checks. Credentials and exception details must remain inside callbacks. */
  readonly healthChecks?: readonly HealthCheck[];
  readonly humanRequests?: HumanRequestTransport;
  readonly workflowViews?: WorkflowViewTransport;
  /** Verify the token using trusted application authentication; never trust token claims without verification. */
  readonly authenticate: (request: { readonly token: string; readonly signal: AbortSignal }) => Promise<ServerIdentity | null>;
  readonly limits?: {
    readonly maxRuns?: number; readonly maxRuntimes?: number; readonly maxRequests?: number;
    readonly maxStreams?: number; readonly maxBodyBytes?: number; readonly maxResponseBytes?: number;
    readonly maxHealthOperations?: number; readonly maxHumanOperations?: number; readonly maxWorkflowOperations?: number;
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
const humanIdentifier = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/;
const encoder = new TextEncoder();
const workflowKinds = Object.freeze({ 2: new Set(['tool', 'join']), 3: new Set(['tool', 'join', 'wait']),
  4: new Set(['tool', 'join', 'child']), 5: new Set(['tool', 'join', 'human', 'timer']) });
const workflowStatuses = new Set(['running', 'waiting', 'succeeded', 'failed', 'blocked', 'cancelled', 'outcome_unknown']);
const workflowStepStatuses = new Set(['pending', 'waiting', 'approved', 'dispatching', 'succeeded', 'failed', 'blocked', 'unknown', 'skipped', 'timed_out']);
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
function workflowExact(value: JsonObject, keys: readonly string[]): void {
  if (Object.keys(value).length !== keys.length || keys.some(key => !Object.hasOwn(value, key))) throw new HttpFailure(503, 'WORKFLOW_TRANSPORT_INVALID');
}
function workflowRecord(value: unknown, expectedRunId: string): WorkflowViewRecord {
  let raw: JsonObject;
  try { raw = object(value, 262_144); } catch { throw new HttpFailure(503, 'WORKFLOW_TRANSPORT_INVALID'); }
  workflowExact(raw, ['format', 'definitionId', 'definitionVersion', 'runId', 'revision', 'status', 'nodes', 'steps']);
  const format = raw['format']; const nodes = raw['nodes']; const steps = raw['steps'];
  if (![2, 3, 4, 5].includes(format as number) || typeof raw['definitionId'] !== 'string' || !/^[A-Za-z][A-Za-z0-9._-]{0,127}$/.test(raw['definitionId'])
    || typeof raw['definitionVersion'] !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._+-]{0,127}$/.test(raw['definitionVersion'])
    || raw['runId'] !== expectedRunId || typeof raw['revision'] !== 'number' || !Number.isSafeInteger(raw['revision']) || raw['revision'] < 1
    || typeof raw['status'] !== 'string' || !workflowStatuses.has(raw['status']) || !Array.isArray(nodes) || nodes.length < 1 || nodes.length > 128
    || !Array.isArray(steps) || steps.length !== nodes.length) throw new HttpFailure(503, 'WORKFLOW_TRANSPORT_INVALID');
  const admittedKinds = workflowKinds[format as keyof typeof workflowKinds]; const graph = new Map<string, readonly string[]>(); const nodeKinds = new Map<string, string>(); let edges = 0;
  for (const candidate of nodes) {
    let node: JsonObject; try { node = object(candidate, 32_768); } catch { throw new HttpFailure(503, 'WORKFLOW_TRANSPORT_INVALID'); }
    workflowExact(node, ['id', 'kind', 'dependsOn']);
    if (typeof node['id'] !== 'string' || !/^[A-Za-z][A-Za-z0-9._-]{0,127}$/.test(node['id']) || graph.has(node['id'])
      || typeof node['kind'] !== 'string' || !admittedKinds.has(node['kind']) || !Array.isArray(node['dependsOn']) || node['dependsOn'].length > 127
      || node['dependsOn'].some(item => typeof item !== 'string' || !/^[A-Za-z][A-Za-z0-9._-]{0,127}$/.test(item))
      || new Set(node['dependsOn']).size !== node['dependsOn'].length) throw new HttpFailure(503, 'WORKFLOW_TRANSPORT_INVALID');
    edges += node['dependsOn'].length; if (edges > 512) throw new HttpFailure(503, 'WORKFLOW_TRANSPORT_INVALID');
    graph.set(node['id'], node['dependsOn'] as readonly string[]); nodeKinds.set(node['id'], node['kind']);
  }
  for (const [id, dependencies] of graph) if (dependencies.some(dependency => dependency === id || !graph.has(dependency))) throw new HttpFailure(503, 'WORKFLOW_TRANSPORT_INVALID');
  const seen = new Set<string>();
  for (const candidate of steps) {
    let step: JsonObject; try { step = object(candidate, 16_384); } catch { throw new HttpFailure(503, 'WORKFLOW_TRANSPORT_INVALID'); }
    const allowed = ['id', 'kind', 'status', 'childRunId'];
    if (Object.keys(step).some(key => !allowed.includes(key)) || !['id', 'kind', 'status'].every(key => Object.hasOwn(step, key)) || typeof step['id'] !== 'string'
      || seen.has(step['id']) || step['kind'] !== nodeKinds.get(step['id']) || typeof step['status'] !== 'string' || !workflowStepStatuses.has(step['status'])
      || (step['kind'] === 'human' && !['pending', 'waiting', 'succeeded', 'timed_out', 'skipped'].includes(step['status']))
      || (step['kind'] === 'timer' && !['pending', 'waiting', 'succeeded', 'skipped'].includes(step['status']))
      || (step['status'] === 'timed_out' && step['kind'] !== 'human')
      || (step['childRunId'] !== undefined && (step['kind'] !== 'child' || typeof step['childRunId'] !== 'string' || !/^[a-f0-9]{64}$/.test(step['childRunId'])))
      ) throw new HttpFailure(503, 'WORKFLOW_TRANSPORT_INVALID');
    seen.add(step['id']);
  }
  if (seen.size !== graph.size) throw new HttpFailure(503, 'WORKFLOW_TRANSPORT_INVALID');
  const remaining = new Map([...graph].map(([id, dependencies]) => [id, dependencies.length])); const dependents = new Map<string, string[]>();
  for (const [id, dependencies] of graph) for (const dependency of dependencies) { const list = dependents.get(dependency) ?? []; list.push(id); dependents.set(dependency, list); }
  const queue = [...remaining].filter(([, count]) => count === 0).map(([id]) => id);
  for (let cursor = 0; cursor < queue.length; cursor++) for (const dependent of dependents.get(queue[cursor]!) ?? []) {
    const count = remaining.get(dependent)! - 1; remaining.set(dependent, count); if (count === 0) queue.push(dependent);
  }
  if (queue.length !== graph.size) throw new HttpFailure(503, 'WORKFLOW_TRANSPORT_INVALID');
  return freezeJson(raw) as unknown as WorkflowViewRecord;
}
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
  if (options.publicLiveness !== undefined && typeof options.publicLiveness !== 'boolean') throw new Error('Public liveness must be explicit.');
  const limits = Object.freeze({ maxRuns: 512, maxRuntimes: 128, maxRequests: 64, maxStreams: 64,
    maxBodyBytes: 1_048_576, maxResponseBytes: 4_194_304, maxHealthOperations: 32, maxHumanOperations: 32, maxWorkflowOperations: 32,
    requestTimeoutMs: 10_000, streamDurationMs: 30_000, ...options.limits });
  if (Object.keys(limits).some(key => !['maxRuns', 'maxRuntimes', 'maxRequests', 'maxStreams', 'maxBodyBytes', 'maxResponseBytes', 'maxHealthOperations', 'maxHumanOperations', 'maxWorkflowOperations', 'requestTimeoutMs', 'streamDurationMs'].includes(key))) throw new Error('Unknown server limit.');
  for (const value of Object.values(limits)) if (!Number.isSafeInteger(value) || value < 1 || value > 16_777_216) throw new Error('Server limits must be bounded positive integers.');
  const healthChecks: readonly HealthCheck[] = (() => {
    const supplied = options.healthChecks ?? [];
    if (!Array.isArray(supplied) || supplied.length > 32) throw new Error('Health checks must be a bounded dense list.');
    const descriptors = Object.getOwnPropertyDescriptors(supplied);
    if (Reflect.ownKeys(descriptors).length !== supplied.length + 1) throw new Error('Health checks must be a bounded dense list.');
    const ids = new Set<string>(); const captured: HealthCheck[] = [];
    for (let index = 0; index < supplied.length; index++) {
      const entry = descriptors[String(index)];
      if (!entry || !('value' in entry) || entry.value === null || typeof entry.value !== 'object') throw new Error('Health checks must contain data entries.');
      const fields = Object.getOwnPropertyDescriptors(entry.value as object);
      if (Reflect.ownKeys(fields).some(key => !['id', 'check'].includes(String(key)))) throw new Error('Health checks contain unknown fields.');
      const id = fields['id']; const check = fields['check'];
      if (!id || !('value' in id) || typeof id.value !== 'string' || !identifier.test(id.value) || ids.has(id.value)
        || !check || !('value' in check) || typeof check.value !== 'function') throw new Error('Health checks require unique IDs and callbacks.');
      ids.add(id.value); captured.push(Object.freeze({ id: id.value, check: check.value as HealthCheck['check'] }));
    }
    return Object.freeze(captured);
  })();
  const humanRequests: HumanRequestTransport | undefined = (() => {
    if (options.humanRequests === undefined) return undefined;
    if (options.humanRequests === null || typeof options.humanRequests !== 'object') throw new Error('Human request transport is invalid.');
    const fields = Object.getOwnPropertyDescriptors(options.humanRequests);
    if (Reflect.ownKeys(fields).length !== 3 || ['list', 'inspect', 'respond'].some(key => !fields[key] || !('value' in fields[key]!) || typeof fields[key]!.value !== 'function')) throw new Error('Human request transport requires exact callbacks.');
    return Object.freeze({ list: fields['list']!.value, inspect: fields['inspect']!.value, respond: fields['respond']!.value }) as HumanRequestTransport;
  })();
  const workflowViews: WorkflowViewTransport | undefined = (() => {
    if (options.workflowViews === undefined) return undefined;
    if (options.workflowViews === null || typeof options.workflowViews !== 'object') throw new Error('Workflow view transport is invalid.');
    const fields = Object.getOwnPropertyDescriptors(options.workflowViews);
    if (Reflect.ownKeys(fields).length !== 1 || !fields['inspect'] || !('value' in fields['inspect']) || typeof fields['inspect'].value !== 'function')
      throw new Error('Workflow view transport requires one exact inspect callback.');
    return Object.freeze({ inspect: fields['inspect'].value as WorkflowViewTransport['inspect'] });
  })();
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
  const toolCatalog = Object.freeze([...registry.values()].flatMap(config => config.agent.tools.map(tool => Object.freeze({
    agentId: config.agent.id, agentVersion: config.agent.version, id: tool.id, version: tool.version,
    effects: tool.effects, capabilities: tool.capabilities, timeoutMs: tool.timeoutMs, costMicros: tool.costMicros,
  }))).sort((left, right) => left.agentId.localeCompare(right.agentId) || left.id.localeCompare(right.id) || left.version.localeCompare(right.version)));
  const runtimes = new Map<string, Runtime>();
  const runs = new Map<string, Entry>();
  const submissions = new Map<string, Entry>();
  const streams = new Set<() => void>();
  let closed = false;
  let requests = 0;
  let authentications = 0;
  let healthOperations = 0;
  let humanOperations = 0;
  let workflowOperations = 0;

  const humanRecord = (value: unknown, identity: ServerIdentity): HumanRequestRecord => {
    const raw = object(value, 16_384); const allowed = ['id', 'agentId', 'kind', 'schemaId', 'schemaDigest', 'prompt', 'digest', 'status', 'context', 'subjectDigest', 'deadlineAtMs'];
    if (Object.keys(raw).some(key => !allowed.includes(key)) || !['id', 'agentId', 'kind', 'schemaId', 'schemaDigest', 'prompt', 'digest', 'status'].every(key => Object.hasOwn(raw, key))
      || typeof raw['id'] !== 'string' || !humanIdentifier.test(raw['id']) || typeof raw['agentId'] !== 'string' || !identity.agentIds.includes(raw['agentId'])
      || !['information', 'correction', 'plan_selection'].includes(String(raw['kind'])) || typeof raw['schemaId'] !== 'string' || !identifier.test(raw['schemaId'])
      || typeof raw['schemaDigest'] !== 'string' || !/^[a-f0-9]{64}$/.test(raw['schemaDigest']) || typeof raw['digest'] !== 'string' || !/^[a-f0-9]{64}$/.test(raw['digest'])
      || typeof raw['prompt'] !== 'string' || encoder.encode(raw['prompt']).byteLength < 1 || encoder.encode(raw['prompt']).byteLength > 1_024
      || !['waiting', 'answered', 'cancelled', 'timed_out'].includes(String(raw['status']))
      || (raw['subjectDigest'] !== undefined && (typeof raw['subjectDigest'] !== 'string' || !/^[a-f0-9]{64}$/.test(raw['subjectDigest'])))
      || ((raw['kind'] === 'correction') !== (raw['subjectDigest'] !== undefined))
      || (raw['deadlineAtMs'] !== undefined && (!Number.isSafeInteger(raw['deadlineAtMs']) || (raw['deadlineAtMs'] as number) < 0))) throw new HttpFailure(503, 'HUMAN_TRANSPORT_INVALID');
    return freezeJson(raw) as unknown as HumanRequestRecord;
  };
  const humanCall = async <T>(callback: () => Promise<T>, signal: AbortSignal): Promise<T> => {
    if (humanOperations >= limits.maxHumanOperations) throw new HttpFailure(429, 'HUMAN_LIMIT');
    humanOperations++; const operation = Promise.resolve().then(callback).finally(() => { humanOperations--; });
    try { return await bounded(operation, signal); } catch (error) { if (error instanceof HttpFailure && error.status === 408) throw error; throw new HttpFailure(503, 'HUMAN_UNAVAILABLE'); }
  };

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
        || !Array.isArray(raw['capabilities']) || raw['capabilities'].length > 7 || raw['capabilities'].some(cap => !['runs:read', 'runs:submit', 'runs:cancel', 'operations:read', 'humans:read', 'humans:respond', 'workflows:read'].includes(String(cap)))
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
    const catalogQuery = request.method === 'GET' && url.pathname === '/v1/tools';
    const humanListQuery = request.method === 'GET' && url.pathname === '/v1/human-requests';
    if ([...url.searchParams.keys()].some(key => request.method !== 'GET' || (eventMatch ? key !== 'after' : catalogQuery || humanListQuery ? !['after', 'limit'].includes(key) : true))
      || url.searchParams.getAll('after').length > 1 || url.searchParams.getAll('limit').length > 1) throw new HttpFailure(400, 'INVALID_QUERY');
    if (request.method === 'OPTIONS') {
      if (!requestOrigin || !['GET', 'POST'].includes(request.headers.get('access-control-request-method') ?? '')) throw new HttpFailure(403, 'ORIGIN_DENIED');
      const headers = (request.headers.get('access-control-request-headers') ?? '').toLowerCase().split(',').map(value => value.trim()).filter(Boolean);
      if (headers.some(value => !['authorization', 'content-type', 'idempotency-key'].includes(value))) throw new HttpFailure(403, 'ORIGIN_DENIED');
      return new Response(null, { status: 204, headers: { 'Access-Control-Allow-Methods': 'GET, POST', 'Access-Control-Allow-Headers': 'Authorization, Content-Type, Idempotency-Key' } });
    }
    if (request.method === 'GET' && url.pathname === '/healthz' && options.publicLiveness === true) return response({ status: 'ok' });
    const identity = await session(request, signal);
    if (closed) throw new HttpFailure(503, 'SERVER_CLOSED');
    const owner = canonical(identity.scope as unknown as JsonValue);
    const workflowMatch = /^\/v1\/workflow-runs\/([a-f0-9]{64})$/.exec(url.pathname);
    if (workflowMatch && request.method === 'GET') {
      requireCapability(identity, 'workflows:read'); if (!workflowViews) throw new HttpFailure(404, 'NOT_FOUND');
      if (workflowOperations >= limits.maxWorkflowOperations) throw new HttpFailure(429, 'WORKFLOW_LIMIT');
      workflowOperations++;
      const operation = Promise.resolve().then(() => workflowViews.inspect(Object.freeze({ scope: identity.scope, agentIds: identity.agentIds,
        runId: workflowMatch[1]!, signal }))).finally(() => { workflowOperations--; });
      let item: WorkflowViewRecord | null;
      try { item = await bounded(operation, signal); } catch (error) { if (error instanceof HttpFailure && error.status === 408) throw error; throw new HttpFailure(503, 'WORKFLOW_UNAVAILABLE'); }
      if (item === null) throw new HttpFailure(404, 'NOT_FOUND'); const record = workflowRecord(item, workflowMatch[1]!);
      assertActive(signal); requireCapability(identity, 'workflows:read'); return response({ workflow: record });
    }
    if (request.method === 'GET' && url.pathname === '/v1/agents') {
      requireCapability(identity, 'runs:read');
      return response({ agents: [...registry.values()].filter(config => identity.agentIds.includes(config.agent.id)).map(config => ({ id: config.agent.id, version: config.agent.version })) });
    }
    if (request.method === 'GET' && url.pathname === '/v1/operations/health') {
      requireCapability(identity, 'operations:read');
      const results = await Promise.all(healthChecks.map(async health => {
        if (healthOperations >= limits.maxHealthOperations) return { id: health.id, status: 'unavailable' as const };
        healthOperations++;
        const operation = Promise.resolve().then(() => health.check(Object.freeze({ signal, scope: identity.scope })))
          .finally(() => { healthOperations--; });
        try { return { id: health.id, status: await bounded(operation, signal) === true ? 'ready' as const : 'unavailable' as const }; }
        catch { return { id: health.id, status: 'unavailable' as const }; }
      }));
      assertActive(signal); requireCapability(identity, 'operations:read');
      const checks = [{ id: 'server', status: 'ready' as const }, ...results];
      const ready = checks.every(check => check.status === 'ready');
      return response({ status: ready ? 'ready' : 'degraded', checks }, ready ? 200 : 503);
    }
    if (request.method === 'GET' && url.pathname === '/v1/tools') {
      requireCapability(identity, 'operations:read');
      const afterText = url.searchParams.get('after') ?? '0'; const limitText = url.searchParams.get('limit') ?? '50';
      if (!/^\d+$/.test(afterText) || !/^\d+$/.test(limitText)) throw new HttpFailure(400, 'INVALID_CURSOR');
      const after = Number(afterText); const limit = Number(limitText);
      if (!Number.isSafeInteger(after) || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new HttpFailure(400, 'INVALID_CURSOR');
      const visible = toolCatalog.filter(tool => identity.agentIds.includes(tool.agentId));
      if (after > visible.length) throw new HttpFailure(400, 'INVALID_CURSOR');
      const tools = visible.slice(after, after + limit); const next = after + tools.length;
      return response({ tools, next: next < visible.length ? next : null });
    }
    if (request.method === 'GET' && url.pathname === '/v1/human-requests') {
      requireCapability(identity, 'humans:read'); if (!humanRequests) throw new HttpFailure(404, 'NOT_FOUND');
      const after = url.searchParams.get('after'); const limitText = url.searchParams.get('limit') ?? '50';
      if ((after !== null && !/^[A-Za-z0-9._:-]{1,128}$/.test(after)) || !/^\d+$/.test(limitText) || Number(limitText) < 1 || Number(limitText) > 100) throw new HttpFailure(400, 'INVALID_CURSOR');
      const page = await humanCall(() => humanRequests.list(Object.freeze({ scope: identity.scope, agentIds: identity.agentIds, after, limit: Number(limitText), signal })), signal);
      const raw = object(page, 1_048_576); exact(raw, ['items', 'next']);
      if (!Array.isArray(raw['items']) || raw['items'].length > Number(limitText) || (raw['next'] !== null && (typeof raw['next'] !== 'string' || !/^[A-Za-z0-9._:-]{1,128}$/.test(raw['next'])))) throw new HttpFailure(503, 'HUMAN_TRANSPORT_INVALID');
      const items = raw['items'].map(item => humanRecord(item, identity));
      if (new Set(items.map(item => item.id)).size !== items.length) throw new HttpFailure(503, 'HUMAN_TRANSPORT_INVALID');
      assertActive(signal); requireCapability(identity, 'humans:read'); return response({ items, next: raw['next'] });
    }
    const humanMatch = /^\/v1\/human-requests\/([A-Za-z0-9][A-Za-z0-9._-]{0,79})(?:\/responses)?$/.exec(url.pathname);
    if (humanMatch && request.method === 'GET' && !url.pathname.endsWith('/responses')) {
      requireCapability(identity, 'humans:read'); if (!humanRequests) throw new HttpFailure(404, 'NOT_FOUND');
      const item = await humanCall(() => humanRequests.inspect(Object.freeze({ scope: identity.scope, agentIds: identity.agentIds, id: humanMatch[1]!, signal })), signal);
      if (item === null) throw new HttpFailure(404, 'NOT_FOUND'); const record = humanRecord(item, identity);
      if (record.id !== humanMatch[1]) throw new HttpFailure(503, 'HUMAN_TRANSPORT_INVALID');
      assertActive(signal); requireCapability(identity, 'humans:read'); return response({ request: record });
    }
    if (humanMatch && request.method === 'POST' && url.pathname.endsWith('/responses')) {
      requireCapability(identity, 'humans:respond'); if (!humanRequests) throw new HttpFailure(404, 'NOT_FOUND');
      const data = await body(request, signal); exact(data, ['commandId', 'requestDigest', 'value']);
      if (typeof data['commandId'] !== 'string' || !identifier.test(data['commandId']) || typeof data['requestDigest'] !== 'string' || !/^[a-f0-9]{64}$/.test(data['requestDigest'])) throw new HttpFailure(400, 'INVALID_REQUEST');
      const item = await humanCall(() => humanRequests.respond(Object.freeze({ scope: identity.scope, agentIds: identity.agentIds, actorId: identity.scope.principalId,
        id: humanMatch[1]!, commandId: data['commandId'] as string, requestDigest: data['requestDigest'] as string, value: data['value']!, signal })), signal);
      const record = humanRecord(item, identity);
      if (record.id !== humanMatch[1] || record.digest !== data['requestDigest'] || record.status === 'waiting') throw new HttpFailure(503, 'HUMAN_TRANSPORT_INVALID');
      assertActive(signal); requireCapability(identity, 'humans:respond'); return response({ request: record });
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
