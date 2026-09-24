import { afterEach, describe, expect, it, vi } from 'vitest';
import { MayuraError, type JsonObject, type ModelAdapter, type ModelResponse, type Schema } from '@mayura/core';
import { defineAgent } from '@mayura/runtime';
import { defineTool } from '@mayura/tools';
import { createAgentServer, type AgentServer, type AgentServerOptions, type ServerIdentity } from '../src/index.js';

const publicOrigin = 'https://agents.example.test';
const browserOrigin = 'https://app.example.test';
const identitySchema: Schema<unknown> = { '~standard': { version: 1, vendor: 'test', validate: value => ({ value }) } };
const servers: AgentServer[] = [];
function identity(overrides: Partial<ServerIdentity> = {}): ServerIdentity {
  return { scope: { principalId: 'alice', projectId: 'project' }, agentIds: ['echo'],
    capabilities: ['runs:read', 'runs:submit', 'runs:cancel', 'operations:read'], expiresAtMs: Date.now() + 60_000, ...overrides };
}
function fixture(generate: ModelAdapter['generate'] = async request => ({ type: 'final', output: request.messages[0]!.role === 'user' ? request.messages[0]!.content : null, usage: { costMicros: 0 } })) {
  return defineAgent({ id: 'echo', version: '1', instructions: 'PRIVATE_INSTRUCTIONS', tools: [], input: identitySchema, output: identitySchema,
    model: { id: 'fixture', capabilities: { tools: true, structuredOutput: true }, maxCostMicros: 0, generate } });
}
function server(options: Partial<AgentServerOptions> = {}): AgentServer {
  const value = createAgentServer({ publicOrigin, agents: [{ agent: fixture(), permissions: { allow: ['model:fixture'] } }],
    authenticate: async () => identity(), ...options });
  servers.push(value); return value;
}
function request(path = '/v1/agents', init: RequestInit = {}, token: string | null = 'TOKEN_PRIVATE'): Request {
  const headers = new Headers(init.headers);
  if (token !== null && !headers.has('authorization')) headers.set('authorization', `Bearer ${token}`);
  return new Request(new URL(path, publicOrigin), { ...init, headers });
}
function submission(input: unknown = 'INPUT_PRIVATE', key = 'request.1', init: RequestInit = {}): Request {
  return request('/v1/runs', { method: 'POST', body: JSON.stringify({ agentId: 'echo', input }), ...init,
    headers: { 'content-type': 'application/json', 'idempotency-key': key, ...Object.fromEntries(new Headers(init.headers)) } });
}
async function json(response: Response): Promise<JsonObject> { return await response.json() as JsonObject; }
async function admitted(value: AgentServer, input: unknown = 'INPUT_PRIVATE', key = 'request.1'): Promise<string> {
  const response = await value.fetch(submission(input, key));
  expect(response.status).toBe(202);
  const result = await json(response); expect(result['profile']).toBe('ephemeral');
  expect(result['id']).toEqual(expect.any(String)); return result['id'] as string;
}
async function snapshot(value: AgentServer, id: string): Promise<JsonObject> {
  const response = await value.fetch(request(`/v1/runs/${id}`)); expect(response.status).toBe(200); return json(response);
}
async function terminal(value: AgentServer, id: string): Promise<JsonObject> {
  let result: JsonObject = {};
  await vi.waitFor(async () => { result = await snapshot(value, id); expect(result['outcome']).toBeDefined(); }, { interval: 1, timeout: 1_000 });
  return result;
}
async function error(response: Response, status: number, code: string): Promise<void> {
  expect(response.status).toBe(status); expect(await json(response)).toEqual({ error: { code } });
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
function pending() {
  const started = deferred<AbortSignal>(); const completed = deferred<ModelResponse>();
  const agent = fixture(async request => { started.resolve(request.signal); return completed.promise; });
  return { agent, started, completed };
}
function events(value: AgentServer, id: string, init: RequestInit = {}, suffix = '') {
  return value.fetch(request(`/v1/runs/${id}/events${suffix}`, init));
}
afterEach(async () => { await Promise.all(servers.splice(0).map(value => value.close())); vi.restoreAllMocks(); });

describe('authenticated Fetch server admission', () => {
  it.each([null, '', 'Basic PRIVATE', 'Bearer', 'Bearer invalid token'])('requires a valid Bearer header (%s)', async header => {
    const authenticate = vi.fn(async () => identity()); const value = server({ authenticate });
    await error(await value.fetch(request('/v1/agents', { headers: header === null ? {} : { authorization: header } }, null)), 401, 'UNAUTHORIZED');
    expect(authenticate).not.toHaveBeenCalled();
  });

  it.each([
    null,
    identity({ expiresAtMs: 1 }),
    { ...identity(), scope: { principalId: 'alice', projectId: 'project', extra: 'SECRET' } },
    { ...identity(), capabilities: ['runs:read', 'admin'] },
    { ...identity(), arbitrary: 'SECRET' },
  ])('uniformly rejects absent, expired or malformed verified identities %#', async supplied => {
    const value = server({ authenticate: async () => supplied as ServerIdentity | null });
    await error(await value.fetch(request()), 401, 'UNAUTHORIZED');
  });

  it('sanitizes raw and framework-shaped authenticator exceptions', async () => {
    for (const failure of [new Error('TOKEN_PRIVATE'), new MayuraError('PERMISSION_DENIED', 'TOKEN_PRIVATE')]) {
      const value = server({ authenticate: async () => { throw failure; } });
      await error(await value.fetch(request()), 503, 'AUTH_UNAVAILABLE');
    }
  });

  it('bounds hanging authentication and forwards a cancelled signal without late admission', async () => {
    const waiting = deferred<ServerIdentity>(); const started = deferred<AbortSignal>();
    const generate = vi.fn(async (): Promise<ModelResponse> => ({ type: 'final', output: 1, usage: { costMicros: 0 } }));
    const value = server({ limits: { requestTimeoutMs: 25 }, agents: [{ agent: fixture(generate), permissions: { allow: ['model:fixture'] } }],
      authenticate: async ({ signal }) => { started.resolve(signal); return waiting.promise; } });
    const response = value.fetch(submission()); const signal = await started.promise;
    await error(await response, 408, 'REQUEST_TIMEOUT'); expect(signal.aborted).toBe(true);
    waiting.resolve(identity()); await new Promise(resolve => setTimeout(resolve, 5));
    expect(generate).not.toHaveBeenCalled();
  });

  it('aborts authentication promptly when the incoming request is cancelled', async () => {
    const started = deferred<AbortSignal>(); const controller = new AbortController();
    const value = server({ authenticate: async ({ signal }) => { started.resolve(signal); return new Promise(() => {}); } });
    const response = value.fetch(request('/v1/agents', { signal: controller.signal }));
    const signal = await started.promise; controller.abort('SECRET');
    await error(await response, 408, 'REQUEST_TIMEOUT'); expect(signal.aborted).toBe(true);
  });

  it('does not invoke authentication for an already cancelled request or leak a late rejection', async () => {
    const authenticate = vi.fn(async () => { throw new Error('PRIVATE'); });
    const controller = new AbortController(); controller.abort(); const value = server({ authenticate });
    await error(await value.fetch(request('/v1/agents', { signal: controller.signal })), 408, 'REQUEST_TIMEOUT');
    await new Promise(resolve => setTimeout(resolve, 0)); expect(authenticate).not.toHaveBeenCalled();
  });

  it('lists only authorized IDs and versions, with no definitions, credentials or input content', async () => {
    const other = defineAgent({ ...fixture(), id: 'other' });
    const value = server({ agents: [fixture(), other].map(agent => ({ agent, permissions: { allow: ['model:fixture'] } })) });
    const response = await value.fetch(request());
    expect(response.status).toBe(200); expect(await json(response)).toEqual({ agents: [{ id: 'echo', version: '1' }] });
    expect(response.headers.get('cache-control')).toBe('no-store'); expect(response.headers.get('x-content-type-options')).toBe('nosniff');
  });

  it.each(['runs:read', 'runs:submit', 'runs:cancel'] as const)('checks the %s command capability separately', async denied => {
    let supplied = identity(); const value = server({ authenticate: async () => supplied }); const id = await admitted(value);
    supplied = identity({ capabilities: supplied.capabilities.filter(capability => capability !== denied) });
    const route = denied === 'runs:read' ? request(`/v1/runs/${id}`) : denied === 'runs:submit' ? submission(2, 'two') : request(`/v1/runs/${id}/cancel`, { method: 'POST' });
    await error(await value.fetch(route), 403, 'FORBIDDEN');
  });

  it.each(['principal', 'project', 'agent'] as const)('hides reads, cancellations and streams after a foreign %s identity change', async changed => {
    let supplied = identity(); const waiting = pending();
    const value = server({ authenticate: async () => supplied, agents: [{ agent: waiting.agent, permissions: { allow: ['model:fixture'] } }] });
    const id = await admitted(value); const signal = await waiting.started.promise;
    supplied = changed === 'principal' ? identity({ scope: { principalId: 'bob', projectId: 'project' } })
      : changed === 'project' ? identity({ scope: { principalId: 'alice', projectId: 'other' } }) : identity({ agentIds: [] });
    for (const [suffix, method] of [['', 'GET'], ['/cancel', 'POST'], ['/events', 'GET']] as const) {
      await error(await value.fetch(request(`/v1/runs/${id}${suffix}`, { method })), 404, 'NOT_FOUND');
    }
    expect(signal.aborted).toBe(false);
  });

  it('rechecks authorization on every read and denies an expired token without cancelling its run', async () => {
    let supplied = identity(); const waiting = pending();
    const value = server({ authenticate: async () => supplied, agents: [{ agent: waiting.agent, permissions: { allow: ['model:fixture'] } }] });
    const id = await admitted(value); const signal = await waiting.started.promise;
    supplied = identity({ expiresAtMs: 1 });
    await error(await value.fetch(request(`/v1/runs/${id}`)), 401, 'UNAUTHORIZED');
    await error(await events(value, id), 401, 'UNAUTHORIZED'); expect(signal.aborted).toBe(false);
  });

  it.each(['permissions', 'scope', 'instructions', 'tools', 'model', 'limits', 'profile', 'version'])('rejects injected %s before model execution', async field => {
    const generate = vi.fn(async (): Promise<ModelResponse> => ({ type: 'final', output: 1, usage: { costMicros: 0 } }));
    const value = server({ agents: [{ agent: fixture(generate), permissions: { allow: ['model:fixture'] } }] });
    await error(await value.fetch(submission(1, 'key', { body: JSON.stringify({ agentId: 'echo', input: 1, [field]: 'SECRET' }) })), 400, 'INVALID_REQUEST');
    expect(generate).not.toHaveBeenCalled();
  });

  it('uses configured grants and the verified scope even when input contains authority-shaped fields', async () => {
    const seen: unknown[] = [];
    const tool = defineTool({ id: 'scope', version: '1', description: 'scope', input: identitySchema, output: identitySchema, effects: 'none', capabilities: [],
      execute: async (_input, context) => { seen.push(context.scope); return 1; } });
    let calls = 0;
    const agent = defineAgent({ ...fixture(async (): Promise<ModelResponse> => ++calls === 1
      ? { type: 'tool_calls', calls: [{ id: 'one', toolId: 'scope', input: null }], usage: { costMicros: 0 } }
      : { type: 'final', output: 1, usage: { costMicros: 0 } }), tools: [tool] });
    const allow = ['model:fixture', 'tool:scope'];
    const value = server({ agents: [{ agent, permissions: { allow } }] }); allow.splice(0);
    const id = await admitted(value, { scope: { principalId: 'root', projectId: 'production' }, permissions: { allow: ['*'] } });
    expect((await terminal(value, id))['outcome']).toEqual({ status: 'succeeded', output: 1 });
    expect(seen).toEqual([{ principalId: 'alice', projectId: 'project' }]);
  });

  it('keeps configured permission denial fail-closed', async () => {
    const generate = vi.fn(async (): Promise<ModelResponse> => ({ type: 'final', output: 1, usage: { costMicros: 0 } }));
    const value = server({ agents: [{ agent: fixture(generate), permissions: { allow: [] } }] });
    const id = await admitted(value, { permissions: { allow: ['model:fixture'] } });
    expect((await terminal(value, id))['outcome']).toMatchObject({ status: 'blocked', error: { code: 'PERMISSION_DENIED' } });
    expect(generate).not.toHaveBeenCalled();
  });

  it('does not expose raw model exceptions or rejected output in snapshots or event streams', async () => {
    const value = server({ agents: [{ agent: fixture(async () => { throw new MayuraError('MODEL_FAILED', 'MODEL_SECRET'); }), permissions: { allow: ['model:fixture'] } }] });
    const id = await admitted(value, 'INPUT_SECRET'); const state = await terminal(value, id);
    expect(state['outcome']).toMatchObject({ status: 'failed', error: { code: 'MODEL_FAILED' } });
    const stream = await (await events(value, id)).text();
    expect(JSON.stringify(state) + stream).not.toMatch(/MODEL_SECRET|INPUT_SECRET|PRIVATE_INSTRUCTIONS|TOKEN_PRIVATE/);
  });

  it('withholds an unapproved final candidate during and after the final output barrier', async () => {
    const started = deferred<void>(); const verdict = deferred<{ decision: 'block'; reason: string }>();
    const agent = defineAgent({ ...fixture(async () => ({ type: 'final', output: 'PRIVATE_CANDIDATE', usage: { costMicros: 0 } })),
      guards: { output: [{ id: 'review', check: async () => { started.resolve(); return verdict.promise; } }] } });
    const value = server({ agents: [{ agent, permissions: { allow: ['model:fixture'] } }] });
    const id = await admitted(value); await started.promise;
    const inFlight = await snapshot(value, id); expect(inFlight['status']).toBe('running'); expect(inFlight['outcome']).toBeUndefined();
    expect(JSON.stringify(inFlight)).not.toContain('PRIVATE_CANDIDATE');
    verdict.resolve({ decision: 'block', reason: 'PRIVATE_REASON' });
    const state = await terminal(value, id); expect(state['outcome']).toMatchObject({ status: 'blocked', error: { code: 'GUARD_BLOCKED' } });
    expect(JSON.stringify(state) + await (await events(value, id)).text()).not.toMatch(/PRIVATE_CANDIDATE|PRIVATE_REASON/);
  });
});

describe('operational health and tool discovery', () => {
  it('keeps public liveness opt-in and content-free', async () => {
    const authenticate = vi.fn(async () => identity()); const disabled = server({ authenticate });
    await error(await disabled.fetch(request('/healthz', {}, null)), 401, 'UNAUTHORIZED');
    const enabled = server({ publicLiveness: true, authenticate });
    const response = await enabled.fetch(request('/healthz', {}, null));
    expect(response.status).toBe(200); expect(await json(response)).toEqual({ status: 'ok' });
    expect(authenticate).not.toHaveBeenCalled();
  });

  it('runs access-controlled readiness checks in parallel and sanitizes failures', async () => {
    const first = deferred<boolean>(); const second = deferred<boolean>(); const started: string[] = [];
    const value = server({ healthChecks: [
      { id: 'database', check: async () => { started.push('database'); return first.promise; } },
      { id: 'queue', check: async () => { started.push('queue'); return second.promise; } },
      { id: 'provider', check: async () => { throw new Error('CREDENTIAL_PRIVATE'); } },
    ] });
    const pending = value.fetch(request('/v1/operations/health'));
    await vi.waitFor(() => expect(started).toEqual(['database', 'queue'])); first.resolve(true); second.resolve(false);
    const response = await pending; expect(response.status).toBe(503);
    const text = await response.text(); expect(text).not.toContain('CREDENTIAL_PRIVATE');
    expect(JSON.parse(text)).toEqual({ status: 'degraded', checks: [
      { id: 'server', status: 'ready' }, { id: 'database', status: 'ready' },
      { id: 'queue', status: 'unavailable' }, { id: 'provider', status: 'unavailable' },
    ] });
  });

  it('requires separate operational authority and retains hanging-check admission', async () => {
    const hanging = deferred<boolean>(); const check = vi.fn(() => hanging.promise);
    const value = server({ limits: { requestTimeoutMs: 25, maxHealthOperations: 1 }, healthChecks: [{ id: 'database', check }],
      authenticate: async () => identity({ capabilities: ['runs:read'] }) });
    await error(await value.fetch(request('/v1/operations/health')), 403, 'FORBIDDEN'); expect(check).not.toHaveBeenCalled();
    const authorized = server({ limits: { requestTimeoutMs: 25, maxHealthOperations: 1 }, healthChecks: [{ id: 'database', check }] });
    await error(await authorized.fetch(request('/v1/operations/health')), 408, 'REQUEST_TIMEOUT');
    const unavailable = await authorized.fetch(request('/v1/operations/health')); expect(unavailable.status).toBe(503); expect(check).toHaveBeenCalledTimes(1);
    hanging.resolve(true);
  });

  it('returns a bounded authorized metadata-only tool catalog', async () => {
    const tool = defineTool({ id: 'lookup', version: '2', description: 'PRIVATE_DESCRIPTION', input: identitySchema, output: identitySchema,
      inputJsonSchema: { type: 'string', description: 'PRIVATE_SCHEMA' }, effects: 'read', capabilities: ['network:public'], timeoutMs: 500, costMicros: 7,
      execute: async value => value });
    const echo = defineAgent({ ...fixture(), tools: [tool] }); const other = defineAgent({ ...fixture(), id: 'other', tools: [tool] });
    const value = server({ agents: [echo, other].map(agent => ({ agent, permissions: { allow: ['model:fixture', 'tool:lookup', 'network:public'] } })) });
    const response = await value.fetch(request('/v1/tools?limit=1')); expect(response.status).toBe(200);
    const text = await response.text(); expect(text).not.toMatch(/PRIVATE_DESCRIPTION|PRIVATE_SCHEMA|instructions|execute/);
    expect(JSON.parse(text)).toEqual({ tools: [{ agentId: 'echo', agentVersion: '1', id: 'lookup', version: '2', effects: 'read',
      capabilities: ['network:public'], timeoutMs: 500, costMicros: 7 }], next: null });
  });

  it('validates operational configuration and catalog cursors', async () => {
    expect(() => server({ publicLiveness: 'yes' as unknown as boolean })).toThrow();
    expect(() => server({ healthChecks: [{ id: 'same', check: () => true }, { id: 'same', check: () => true }] })).toThrow();
    expect(() => server({ limits: { maxHealthOperations: 0 } })).toThrow();
    const value = server();
    for (const suffix of ['?after=-1', '?limit=0', '?limit=101', '?after=1', '?token=PRIVATE']) {
      await error(await value.fetch(request(`/v1/tools${suffix}`)), 400, suffix.includes('token') ? 'INVALID_QUERY' : 'INVALID_CURSOR');
    }
  });
});

describe('HTTP command shape, idempotency and finite capacity', () => {
  it.each([undefined, '', 'bad key', 'x'.repeat(129)])('requires a bounded stable idempotency key %#', async key => {
    const headers = new Headers({ 'content-type': 'application/json' }); if (key !== undefined) headers.set('idempotency-key', key);
    await error(await server().fetch(request('/v1/runs', { method: 'POST', headers, body: JSON.stringify({ agentId: 'echo', input: 1 }) })), 400, 'IDEMPOTENCY_REQUIRED');
  });

  it('atomically deduplicates simultaneous equivalent JSON payloads and conflicts on a changed payload', async () => {
    const generate = vi.fn(async (): Promise<ModelResponse> => ({ type: 'final', output: 1, usage: { costMicros: 0 } }));
    const value = server({ agents: [{ agent: fixture(generate), permissions: { allow: ['model:fixture'] } }] });
    const replies = await Promise.all(Array.from({ length: 12 }, (_, index) => value.fetch(submission(index % 2 ? { a: 1, b: 2 } : { b: 2, a: 1 }))));
    expect(replies.filter(reply => reply.status === 202)).toHaveLength(1);
    expect(replies.every(reply => [200, 202].includes(reply.status))).toBe(true);
    const payloads = await Promise.all(replies.map(json)); const ids = new Set(payloads.map(payload => payload['id'])); expect(ids.size).toBe(1);
    const id = [...ids][0] as string; await terminal(value, id); expect(generate).toHaveBeenCalledOnce();
    await error(await value.fetch(submission({ a: 2, b: 2 })), 409, 'IDEMPOTENCY_CONFLICT');
    expect(generate).toHaveBeenCalledOnce();
  });

  it('scopes idempotency to both verified principal and project', async () => {
    let supplied = identity(); const value = server({ authenticate: async () => supplied });
    const first = await admitted(value, 1);
    supplied = identity({ scope: { principalId: 'bob', projectId: 'project' } }); const second = await admitted(value, 2);
    supplied = identity({ scope: { principalId: 'alice', projectId: 'other' } }); const third = await admitted(value, 3);
    expect(new Set([first, second, third]).size).toBe(3);
  });

  it('retains full idempotency evidence at the run cap and admits no replacement after terminal completion', async () => {
    const value = server({ limits: { maxRuns: 1 } }); const id = await admitted(value); await terminal(value, id);
    await error(await value.fetch(submission(2, 'new')), 429, 'RUN_LIMIT');
    const retry = await value.fetch(submission()); expect(retry.status).toBe(200); expect((await json(retry))['id']).toBe(id);
  });

  it('bounds runtime ownership without evicting another scope', async () => {
    let supplied = identity(); const value = server({ limits: { maxRuntimes: 1 }, authenticate: async () => supplied }); const id = await admitted(value);
    supplied = identity({ scope: { principalId: 'bob', projectId: 'project' } });
    await error(await value.fetch(submission(2, 'new')), 429, 'RUNTIME_LIMIT');
    supplied = identity(); expect((await snapshot(value, id))['id']).toBe(id);
  });

  it('bounds active requests and releases capacity after the first request finishes', async () => {
    const started = deferred<void>(); const waiting = deferred<ServerIdentity>(); let calls = 0;
    const value = server({ limits: { maxRequests: 1 }, authenticate: async () => { if (++calls === 1) { started.resolve(); return waiting.promise; } return identity(); } });
    const first = value.fetch(request()); await started.promise;
    await error(await value.fetch(request()), 429, 'REQUEST_LIMIT'); expect(calls).toBe(1);
    waiting.resolve(identity()); expect((await first).status).toBe(200); expect((await value.fetch(request())).status).toBe(200);
  });

  it('bounds both declared and streamed body bytes and cancels an oversized stream', async () => {
    const value = server({ limits: { maxBodyBytes: 64 } });
    await error(await value.fetch(submission(1, 'declared', { headers: { 'content-length': '65' } })), 413, 'BODY_LIMIT');
    const cancel = vi.fn();
    const stream = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new Uint8Array(65)); }, cancel });
    const bodyRequest = submission(1, 'streamed', { body: stream, duplex: 'half' } as RequestInit);
    await error(await value.fetch(bodyRequest), 413, 'BODY_LIMIT'); expect(cancel).toHaveBeenCalledOnce();
  });

  it('honors an explicitly raised body limit when the registered runtime permits the same input', async () => {
    const value = server({ limits: { maxBodyBytes: 2_000_000 }, agents: [{
      agent: fixture(async () => ({ type: 'final', output: 1, usage: { costMicros: 0 } })),
      permissions: { allow: ['model:fixture'] }, limits: { maxInputBytes: 2_000_000, maxContextBytes: 4_000_000 },
    }] });
    const id = await admitted(value, 'x'.repeat(1_100_000));
    expect((await terminal(value, id))['outcome']).toEqual({ status: 'succeeded', output: 1 });
  });

  it('bounds a hanging body, cancels its reader and never invokes a model', async () => {
    const cancel = vi.fn(); const stream = new ReadableStream<Uint8Array>({ cancel });
    const value = server({ limits: { requestTimeoutMs: 25 } });
    await error(await value.fetch(submission(1, 'key', { body: stream, duplex: 'half' } as RequestInit)), 408, 'REQUEST_TIMEOUT');
    await vi.waitFor(() => expect(cancel).toHaveBeenCalledOnce(), { interval: 1 });
  });

  it.each(['text/plain', 'application/json; charset=latin1', 'application/x-www-form-urlencoded'])('rejects unsupported media type %s', async contentType => {
    await error(await server().fetch(submission(1, 'key', { headers: { 'content-type': contentType } })), 415, 'UNSUPPORTED_MEDIA_TYPE');
  });

  it('rejects compressed request bodies', async () => {
    await error(await server().fetch(submission(1, 'key', { headers: { 'content-encoding': 'gzip' } })), 415, 'UNSUPPORTED_MEDIA_TYPE');
  });

  it.each(['null', '[]', '42', '{}', '{"agentId":"echo"}', '{"agentId":"echo","input":NaN}', '{'])('rejects malformed command JSON %#', async body => {
    await error(await server().fetch(submission(1, 'key', { body })), 400, 'INVALID_REQUEST');
  });

  it('rejects malformed UTF-8 instead of silently substituting input bytes', async () => {
    await error(await server().fetch(submission(1, 'key', { body: new Uint8Array([0xc3, 0x28]) })), 400, 'INVALID_REQUEST');
  });

  it('bounds response bodies without reflecting candidate content in an error', async () => {
    const value = server({ limits: { maxResponseBytes: 128 } }); const id = await admitted(value, 'OUTPUT_SECRET'.repeat(64));
    await vi.waitFor(async () => { await error(await value.fetch(request(`/v1/runs/${id}`)), 503, 'RESPONSE_LIMIT'); }, { interval: 1 });
  });

  it('rejects duplicate or oversized configured agent registries and invalid server limits', () => {
    const config = { agent: fixture(), permissions: { allow: [] } };
    expect(() => server({ agents: [config, config] })).toThrow();
    expect(() => server({ agents: Array.from({ length: 257 }, () => config) })).toThrow();
    for (const maxRuns of [0, -1, 1.5, Infinity, 16_777_217]) expect(() => server({ limits: { maxRuns } })).toThrow();
  });

  it('fails closed on unknown limit names instead of silently retaining a permissive default', () => {
    expect(() => server({ limits: { maxStrams: 1 } as NonNullable<AgentServerOptions['limits']> })).toThrow();
  });

  it('rejects unregistered or unauthorized agents without disclosing their definitions', async () => {
    const value = server({ authenticate: async () => identity({ agentIds: [] }) });
    await error(await value.fetch(submission()), 404, 'NOT_FOUND');
  });

  it('rejects cancellation bodies and keeps cancellation requests idempotent', async () => {
    const waiting = pending(); const value = server({ agents: [{ agent: waiting.agent, permissions: { allow: ['model:fixture'] } }] });
    const id = await admitted(value); const signal = await waiting.started.promise;
    await error(await value.fetch(request(`/v1/runs/${id}/cancel`, { method: 'POST', body: '{}' })), 400, 'INVALID_REQUEST');
    expect(signal.aborted).toBe(false);
    for (let index = 0; index < 2; index++) {
      const response = await value.fetch(request(`/v1/runs/${id}/cancel`, { method: 'POST' }));
      expect(response.status).toBe(202); expect(await json(response)).toEqual({ id, cancellationRequested: true });
    }
    expect(signal.aborted).toBe(true); expect((await terminal(value, id))['outcome']).toMatchObject({ status: 'cancelled' });
  });
});

describe('origin and credential transport boundaries', () => {
  it('requires an exact public destination origin', async () => {
    const authenticate = vi.fn(async () => identity()); const value = server({ authenticate });
    await error(await value.fetch(new Request('https://attacker.example.test/v1/agents', { headers: { authorization: 'Bearer SECRET' } })), 400, 'INVALID_DESTINATION');
    expect(authenticate).not.toHaveBeenCalled();
  });

  it.each(['/v1/agents?token=SECRET', '/v1/runs?api_key=SECRET', '/v1/agents?after=0'])('rejects unexpected query parameters before authentication: %s', async path => {
    const authenticate = vi.fn(async () => identity()); const value = server({ authenticate });
    await error(await value.fetch(request(path)), 400, 'INVALID_QUERY'); expect(authenticate).not.toHaveBeenCalled();
  });

  it.each(['https://attacker.example.test', 'null', `${browserOrigin}/`])('rejects browser origin %s without credential exposure', async origin => {
    const authenticate = vi.fn(async () => identity()); const value = server({ allowedOrigins: [browserOrigin], authenticate });
    await error(await value.fetch(request('/v1/agents', { headers: { origin } })), 403, 'ORIGIN_DENIED'); expect(authenticate).not.toHaveBeenCalled();
  });

  it('uses exact CORS responses with no wildcard or cookie authority', async () => {
    const value = server({ allowedOrigins: [browserOrigin] });
    const response = await value.fetch(request('/v1/agents', { headers: { origin: browserOrigin } }));
    expect(response.headers.get('access-control-allow-origin')).toBe(browserOrigin);
    expect(response.headers.get('vary')).toBe('Origin'); expect(response.headers.has('access-control-allow-credentials')).toBe(false);
    await error(await value.fetch(request('/v1/agents', { headers: { cookie: 'Authorization=Bearer SECRET', origin: browserOrigin } }, null)), 401, 'UNAUTHORIZED');
  });

  it('limits unauthenticated preflight to declared methods and headers', async () => {
    const authenticate = vi.fn(async () => identity()); const value = server({ allowedOrigins: [browserOrigin], authenticate });
    const headers = { origin: browserOrigin, 'access-control-request-method': 'POST', 'access-control-request-headers': 'Authorization, Content-Type, Idempotency-Key' };
    const accepted = await value.fetch(request('/v1/runs', { method: 'OPTIONS', headers }, null));
    expect(accepted.status).toBe(204); expect(accepted.headers.get('access-control-allow-methods')).toBe('GET, POST');
    await error(await value.fetch(request('/v1/runs', { method: 'OPTIONS', headers: { ...headers, 'access-control-request-method': 'DELETE' } }, null)), 403, 'ORIGIN_DENIED');
    await error(await value.fetch(request('/v1/runs', { method: 'OPTIONS', headers: { ...headers, 'access-control-request-headers': 'X-Admin' } }, null)), 403, 'ORIGIN_DENIED');
    expect(authenticate).not.toHaveBeenCalled();
  });

  it('rejects query credentials on preflight as well as on authenticated routes', async () => {
    const value = server({ allowedOrigins: [browserOrigin] });
    await error(await value.fetch(request('/v1/runs?token=PRIVATE', { method: 'OPTIONS',
      headers: { origin: browserOrigin, 'access-control-request-method': 'POST' } }, null)), 400, 'INVALID_QUERY');
  });
});

describe('bounded metadata SSE observations and shutdown', () => {
  it('streams ordered metadata without raw model content and resumes after the supplied cursor', async () => {
    const value = server(); const id = await admitted(value, 'INPUT_SECRET'); await terminal(value, id);
    const response = await events(value, id); expect(response.headers.get('content-type')).toBe('text/event-stream');
    const text = await response.text(); expect(text).toContain('event: run.completed');
    expect(text).not.toMatch(/INPUT_SECRET|PRIVATE_INSTRUCTIONS|TOKEN_PRIVATE/);
    expect([...text.matchAll(/^id: (\d+)$/gm)].map(match => Number(match[1]))).toEqual([1, 2, 3, 4]);
    const resumed = await (await events(value, id, {}, '?after=3')).text();
    expect(resumed).toContain('id: 4'); expect(resumed).not.toContain('id: 3');
    expect(await (await events(value, id, {}, '?after=4')).text()).toBe('');
  });

  it('emits explicit replay gaps with metadata that can recover through an authorized snapshot', async () => {
    const value = server({ agents: [{ agent: fixture(), permissions: { allow: ['model:fixture'] }, limits: { maxEventRetention: 2 } }] });
    const id = await admitted(value); await terminal(value, id);
    const text = await (await events(value, id)).text();
    expect(text).toContain('event: events.gap'); expect(text).toContain('"from":1,"to":2');
    expect([...text.matchAll(/^id: (\d+)$/gm)].map(match => Number(match[1]))).toEqual([2, 3, 4]);
    expect((await snapshot(value, id))['status']).toBe('succeeded');
  });

  it('emits a safe terminal stream error for future cursors instead of inventing successful completion', async () => {
    const value = server(); const id = await admitted(value); await terminal(value, id);
    const response = await events(value, id, {}, '?after=999'); expect(response.status).toBe(200);
    expect(await response.text()).toBe('event: stream.error\ndata: {"code":"OBSERVATION_FAILED"}\n\n');
  });

  it.each(['?after=-1', '?after=1.5', '?after=9007199254740992', '?after=NaN', '?after=1&after=2', '?after=1&token=SECRET'])('rejects invalid event query %s', async suffix => {
    const value = server(); const id = await admitted(value);
    await error(await events(value, id, {}, suffix), 400, suffix.includes('&') ? 'INVALID_QUERY' : 'INVALID_CURSOR');
  });

  it('bounds simultaneous connections and releases their capacity on reader cancellation without cancelling execution', async () => {
    const waiting = pending(); const value = server({ limits: { maxStreams: 1 }, agents: [{ agent: waiting.agent, permissions: { allow: ['model:fixture'] } }] });
    const id = await admitted(value); const signal = await waiting.started.promise;
    const first = await events(value, id); const reader = first.body!.getReader(); await reader.read();
    await error(await events(value, id), 429, 'STREAM_LIMIT');
    await reader.cancel(); expect(signal.aborted).toBe(false);
    const replacement = await events(value, id); expect(replacement.status).toBe(200); await replacement.body!.cancel();
  });

  it('closes request-aborted streams without cancelling the run and permits an authenticated reconnect', async () => {
    const waiting = pending(); const value = server({ limits: { maxStreams: 1 }, agents: [{ agent: waiting.agent, permissions: { allow: ['model:fixture'] } }] });
    const id = await admitted(value); const runSignal = await waiting.started.promise; const controller = new AbortController();
    const response = await events(value, id, { signal: controller.signal }); const text = response.text(); controller.abort();
    expect(await text).not.toContain('run.completed'); expect(runSignal.aborted).toBe(false);
    const replacement = await events(value, id); expect(replacement.status).toBe(200); await replacement.body!.cancel();
  });

  it.each(['duration', 'expiry'] as const)('caps observation lifetime at %s without implying run completion', async limit => {
    const waiting = pending(); let supplied = identity();
    const value = server({ limits: { streamDurationMs: limit === 'duration' ? 30 : 5_000, maxStreams: 1 }, authenticate: async () => supplied,
      agents: [{ agent: waiting.agent, permissions: { allow: ['model:fixture'] } }] });
    const id = await admitted(value); const runSignal = await waiting.started.promise;
    if (limit === 'expiry') supplied = identity({ expiresAtMs: Date.now() + 30 });
    const response = await events(value, id); const text = await response.text();
    expect(text).not.toContain('run.completed'); expect(runSignal.aborted).toBe(false);
    supplied = identity(); const replacement = await events(value, id); expect(replacement.status).toBe(200); await replacement.body!.cancel();
  });

  it('does not consume a completed run into an unbounded per-observer queue while a reader stalls', async () => {
    const tool = defineTool({ id: 'noop', version: '1', description: 'noop', effects: 'none', capabilities: [], input: identitySchema, output: identitySchema, execute: async value => value });
    const waiting = deferred<ModelResponse>(); const started = deferred<void>(); let calls = 0;
    const agent = defineAgent({ ...fixture(async (): Promise<ModelResponse> => {
      calls++; if (calls === 1) { started.resolve(); return waiting.promise; }
      return calls <= 12 ? { type: 'tool_calls', calls: [{ id: `call.${calls}`, toolId: 'noop', input: null }], usage: { costMicros: 0 } }
        : { type: 'final', output: 'PRIVATE_RESULT', usage: { costMicros: 0 } };
    }), tools: [tool] });
    const value = server({ agents: [{ agent, permissions: { allow: ['model:fixture', 'tool:noop'] }, limits: { maxEventRetention: 2 } }] });
    const id = await admitted(value); await started.promise;
    const response = await events(value, id); // Deliberately do not acquire/read the body yet.
    waiting.resolve({ type: 'tool_calls', calls: [{ id: 'call.1', toolId: 'noop', input: null }], usage: { costMicros: 0 } });
    await terminal(value, id);
    const text = await response.text(); const frames = text.trim().split('\n\n');
    expect(frames.length).toBeLessThanOrEqual(5); expect(text).toContain('event: events.gap'); expect(text).not.toContain('PRIVATE_RESULT');
  });

  it('returns truthful unknown write receipts when cancellation races a dispatched effect', async () => {
    const started = deferred<void>(); const executed = deferred<unknown>();
    const tool = defineTool({ id: 'write', version: '1', description: 'write', effects: 'write', capabilities: [], input: identitySchema, output: identitySchema,
      execute: async () => { started.resolve(); return executed.promise; } });
    const agent = defineAgent({ ...fixture(async () => ({ type: 'tool_calls', calls: [{ id: 'write.1', toolId: 'write', input: null }], usage: { costMicros: 0 } })), tools: [tool] });
    const value = server({ agents: [{ agent, permissions: { allow: ['model:fixture', 'tool:write', 'effect:write'] } }] });
    const id = await admitted(value); await started.promise;
    expect((await value.fetch(request(`/v1/runs/${id}/cancel`, { method: 'POST' }))).status).toBe(202);
    const initial = await terminal(value, id);
    expect(initial['outcome']).toMatchObject({ status: 'outcome_unknown', receipt: { execution: 'unknown', disclosure: 'withheld' } });
    executed.resolve('PRIVATE_LATE_OUTPUT');
    await vi.waitFor(async () => expect((await snapshot(value, id))['evidence']).toMatchObject([{ receipt: { execution: 'succeeded', disclosure: 'withheld' } }]), { interval: 1 });
    const later = await snapshot(value, id);
    expect(later['outcome']).toEqual(initial['outcome']); expect(JSON.stringify(later)).not.toContain('PRIVATE_LATE_OUTPUT');
  });

  it('closes observers, cancels owned runs and rejects all future requests on repeated close', async () => {
    const waiting = pending(); const value = server({ agents: [{ agent: waiting.agent, permissions: { allow: ['model:fixture'] } }] });
    const id = await admitted(value); const runSignal = await waiting.started.promise; const observation = await events(value, id); const text = observation.text();
    await value.close(); await value.close(); expect(runSignal.aborted).toBe(true); expect(await text).not.toContain('PRIVATE');
    await error(await value.fetch(request()), 503, 'SERVER_CLOSED'); await error(await value.fetch(submission(2, 'two')), 503, 'SERVER_CLOSED');
  });

  it('cannot open a new observer when authentication completes after server shutdown', async () => {
    const started = deferred<void>(); const authenticated = deferred<ServerIdentity>(); let defer = false;
    const value = server({ authenticate: async () => { if (defer) { started.resolve(); return authenticated.promise; } return identity(); } });
    const id = await admitted(value); await terminal(value, id); defer = true;
    const response = events(value, id); await started.promise; await value.close(); authenticated.resolve(identity());
    await error(await response, 503, 'SERVER_CLOSED');
  });
});
