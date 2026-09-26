import { afterEach, describe, expect, it, vi } from 'vitest';
import { MayuraError, type JsonObject, type ModelAdapter, type ModelResponse, type Schema } from '@mayura/core';
import { defineAgent } from '@mayura/runtime';
import { defineTool } from '@mayura/tools';
import { createAgentServer, type AgentServer, type AgentServerOptions, type ServerIdentity, type WorkflowSignalTransport } from '../src/index.js';

const publicOrigin = 'https://agents.example.test';
const browserOrigin = 'https://app.example.test';
const identitySchema: Schema<unknown> = { '~standard': { version: 1, vendor: 'test', validate: value => ({ value }) } };
const servers: AgentServer[] = [];
function identity(overrides: Partial<ServerIdentity> = {}): ServerIdentity {
  return { scope: { principalId: 'alice', projectId: 'project' }, agentIds: ['echo'],
    capabilities: ['runs:read', 'runs:submit', 'runs:cancel', 'operations:read', 'humans:read', 'humans:respond', 'workflows:read', 'workflows:control'], expiresAtMs: Date.now() + 60_000, ...overrides };
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
const workflowId = 'a'.repeat(64);
const workflow = () => ({ format: 4 as const, definitionId: 'deployment', definitionVersion: '1', runId: workflowId, revision: 2,
  status: 'running' as const, nodes: [{ id: 'prepare', kind: 'tool' as const, dependsOn: [] }, { id: 'child', kind: 'child' as const, dependsOn: ['prepare'] }],
  steps: [{ id: 'prepare', kind: 'tool' as const, status: 'succeeded' as const }, { id: 'child', kind: 'child' as const, status: 'waiting' as const, childRunId: 'b'.repeat(64) }] });
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

describe('authenticated human request transport', () => {
  const digest = 'a'.repeat(64);
  const waiting = { id: 'review', agentId: 'echo', kind: 'plan_selection' as const, schemaId: 'choice-v1', schemaDigest: 'b'.repeat(64),
    prompt: 'Select the deployment plan.', digest, status: 'waiting' as const, context: { environment: 'production' } };

  it('lists, inspects and responds with verified scope and actor identity', async () => {
    const list = vi.fn(async () => ({ items: [waiting], next: null })); const inspect = vi.fn(async () => waiting);
    const respond = vi.fn(async () => ({ ...waiting, status: 'answered' as const }));
    const value = server({ humanRequests: { list, inspect, respond } });
    expect(await json(await value.fetch(request('/v1/human-requests?limit=1')))).toEqual({ items: [waiting], next: null });
    expect(await json(await value.fetch(request('/v1/human-requests/review')))).toEqual({ request: waiting });
    const response = await value.fetch(request('/v1/human-requests/review/responses', { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ commandId: 'answer-1', requestDigest: digest, value: { choice: 'accept' } }) }));
    expect(response.status).toBe(200); expect(await json(response)).toEqual({ request: { ...waiting, status: 'answered' } });
    expect(respond).toHaveBeenCalledWith(expect.objectContaining({ actorId: 'alice', id: 'review', requestDigest: digest, commandId: 'answer-1',
      scope: { principalId: 'alice', projectId: 'project' }, agentIds: ['echo'], value: { choice: 'accept' }, signal: expect.any(AbortSignal) }));
    expect(list).toHaveBeenCalledWith(expect.objectContaining({ after: null, limit: 1 })); expect(inspect).toHaveBeenCalledTimes(1);
  });

  it('separates read/respond authority and rejects unauthorized adapter records', async () => {
    const transport = { list: async () => ({ items: [waiting], next: null }), inspect: async () => waiting, respond: async () => waiting };
    const reader = server({ humanRequests: transport, authenticate: async () => identity({ capabilities: ['humans:read'] }) });
    await error(await reader.fetch(request('/v1/human-requests/review/responses', { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ commandId: 'answer', requestDigest: digest, value: true }) })), 403, 'FORBIDDEN');
    const hostile = server({ humanRequests: { ...transport, inspect: async () => ({ ...waiting, agentId: 'other', prompt: 'PRIVATE' }) } });
    await error(await hostile.fetch(request('/v1/human-requests/review')), 503, 'HUMAN_TRANSPORT_INVALID');
  });

  it('bounds non-cooperative transport admission and sanitizes failures', async () => {
    const held = deferred<null>(); const inspect = vi.fn(() => held.promise);
    const value = server({ limits: { requestTimeoutMs: 20, maxHumanOperations: 1 }, humanRequests: {
      list: async () => ({ items: [], next: null }), inspect, respond: async () => { throw new Error('PRIVATE'); },
    } });
    await error(await value.fetch(request('/v1/human-requests/review')), 408, 'REQUEST_TIMEOUT');
    await error(await value.fetch(request('/v1/human-requests/review')), 429, 'HUMAN_LIMIT'); expect(inspect).toHaveBeenCalledTimes(1); held.resolve(null); await new Promise(resolve => setTimeout(resolve, 0));
    await error(await value.fetch(request('/v1/human-requests/review/responses', { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ commandId: 'answer', requestDigest: digest, value: true }) })), 503, 'HUMAN_UNAVAILABLE');
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

  it('refuses a retried submission after a restart instead of starting a duplicate run', async () => {
    const claims = new Map<string, string>();
    const claim = vi.fn(async (input: { owner: string; key: string; digest: string }) => {
      const id = JSON.stringify([input.owner, input.key]); const existing = claims.get(id);
      if (existing !== undefined) return { status: 'existing' as const, digest: existing }; claims.set(id, input.digest); return { status: 'claimed' as const };
    });
    const generate = vi.fn(async (): Promise<ModelResponse> => ({ type: 'final', output: 1, usage: { costMicros: 0 } }));
    const first = server({ agents: [{ agent: fixture(generate), permissions: { allow: ['model:fixture'] } }], submissionJournal: { claim } });
    const replies = await Promise.all([first.fetch(submission('same')), first.fetch(submission('same'))]);
    expect(replies.map(reply => reply.status).sort()).toEqual([200, 202]); expect(claim).toHaveBeenCalledOnce();
    await terminal(first, (await json(replies[0]!))['id'] as string); await first.close();
    // A new process with the same durable journal: the earlier run's outcome is unknowable here, so nothing starts.
    const second = server({ agents: [{ agent: fixture(generate), permissions: { allow: ['model:fixture'] } }], submissionJournal: { claim } });
    await error(await second.fetch(submission('same')), 409, 'SUBMISSION_OUTCOME_UNKNOWN');
    await error(await second.fetch(submission('different')), 409, 'IDEMPOTENCY_CONFLICT');
    expect(generate).toHaveBeenCalledOnce(); expect((await second.fetch(submission('fresh', 'request.2'))).status).toBe(202);
  });

  it('starts no run when the submission journal cannot confirm a claim', async () => {
    const generate = vi.fn(async (): Promise<ModelResponse> => ({ type: 'final', output: 1, usage: { costMicros: 0 } }));
    for (const claim of [async () => { throw new Error('PRIVATE storage outage'); }, async () => ({ status: 'maybe' }) as never]) {
      const value = server({ agents: [{ agent: fixture(generate), permissions: { allow: ['model:fixture'] } }], submissionJournal: { claim } });
      const reply = await value.fetch(submission('journal-down')); await error(reply, 503, 'SUBMISSION_JOURNAL_UNAVAILABLE');
    }
    expect(generate).not.toHaveBeenCalled();
    expect(() => server({ submissionJournal: {} as never })).toThrow();
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

describe('authenticated durable workflow view transport', () => {
  it('returns one strictly validated content-free view with verified scope and agent bounds', async () => {
    const inspect = vi.fn(async () => workflow()); const value = server({ workflowViews: { inspect } });
    const response = await value.fetch(request(`/v1/workflow-runs/${workflowId}`));
    expect(response.status).toBe(200); expect(await json(response)).toEqual({ workflow: workflow() });
    expect(inspect).toHaveBeenCalledWith(expect.objectContaining({ scope: { principalId: 'alice', projectId: 'project' }, agentIds: ['echo'], runId: workflowId,
      signal: expect.any(AbortSignal) }));
  });

  it('checks workflow authority before transport access and hides absent records', async () => {
    const inspect = vi.fn(async () => null); let supplied = identity({ capabilities: ['runs:read'] });
    const value = server({ authenticate: async () => supplied, workflowViews: { inspect } });
    await error(await value.fetch(request(`/v1/workflow-runs/${workflowId}`)), 403, 'FORBIDDEN'); expect(inspect).not.toHaveBeenCalled();
    supplied = identity(); await error(await value.fetch(request(`/v1/workflow-runs/${workflowId}`)), 404, 'NOT_FOUND'); expect(inspect).toHaveBeenCalledOnce();
  });

  it('rejects malformed, cross-run and cyclic adapter data without reflecting private fields', async () => {
    const candidates = [
      { ...workflow(), runId: 'c'.repeat(64) },
      { ...workflow(), privatePrompt: 'PRIVATE' },
      { ...workflow(), nodes: [{ id: 'prepare', kind: 'tool', dependsOn: ['child'] }, { id: 'child', kind: 'child', dependsOn: ['prepare'] }] },
    ];
    for (const candidate of candidates) {
      const value = server({ workflowViews: { inspect: async () => candidate as never } }); const response = await value.fetch(request(`/v1/workflow-runs/${workflowId}`));
      await error(response, 503, 'WORKFLOW_TRANSPORT_INVALID');
    }
  });

  it('sanitizes adapter failures and bounds concurrent inspections', async () => {
    const started = deferred<void>(); const pending = deferred<ReturnType<typeof workflow> | null>(); let calls = 0;
    const value = server({ limits: { maxWorkflowOperations: 1 }, workflowViews: { inspect: async () => { calls += 1; started.resolve(); return pending.promise; } } });
    const first = value.fetch(request(`/v1/workflow-runs/${workflowId}`)); await started.promise;
    await error(await value.fetch(request(`/v1/workflow-runs/${workflowId}`)), 429, 'WORKFLOW_LIMIT'); expect(calls).toBe(1);
    pending.resolve(workflow()); expect((await first).status).toBe(200);
    const failed = server({ workflowViews: { inspect: async () => { throw new Error('PRIVATE STORAGE DETAILS'); } } });
    await error(await failed.fetch(request(`/v1/workflow-runs/${workflowId}`)), 503, 'WORKFLOW_UNAVAILABLE');
  });
});

describe('authenticated durable workflow index transport', () => {
  const summary = (overrides: Record<string, unknown> = {}) => ({ format: 4 as const, definitionId: 'workflow', definitionVersion: '1',
    runId: workflowId, revision: 2, status: 'running' as const, ...overrides });

  it('passes verified pagination and returns exact immutable content-free summaries', async () => {
    const list = vi.fn(async () => ({ items: [summary()], next: 'cursor-2' })); const value = server({ workflowIndex: { list } });
    const response = await value.fetch(request('/v1/workflow-runs?after=cursor-1&limit=5')); expect(response.status).toBe(200);
    expect(await json(response)).toEqual({ items: [summary()], next: 'cursor-2' });
    expect(list).toHaveBeenCalledWith(expect.objectContaining({ scope: { principalId: 'alice', projectId: 'project' }, agentIds: ['echo'],
      after: 'cursor-1', limit: 5 }));
  });

  it('denies listing before adapter access and rejects malformed cursors locally', async () => {
    const list = vi.fn(async () => ({ items: [], next: null }));
    const denied = server({ authenticate: async () => identity({ capabilities: ['runs:read'] }), workflowIndex: { list } });
    await error(await denied.fetch(request('/v1/workflow-runs?limit=5')), 403, 'FORBIDDEN'); expect(list).not.toHaveBeenCalled();
    const value = server({ workflowIndex: { list } });
    await error(await value.fetch(request('/v1/workflow-runs?after=../private&limit=101')), 400, 'INVALID_CURSOR'); expect(list).not.toHaveBeenCalled();
  });

  it('fails closed on duplicate, private or cursor-loop adapter pages', async () => {
    for (const page of [
      { items: [summary(), summary()], next: null },
      { items: [summary({ privatePrompt: 'PRIVATE' })], next: null },
      { items: [summary()], next: 'same' },
    ]) {
      const value = server({ workflowIndex: { list: async () => page as never } });
      await error(await value.fetch(request('/v1/workflow-runs?after=same&limit=2')), 503, 'WORKFLOW_TRANSPORT_INVALID');
    }
  });
});

describe('authenticated durable workflow controls', () => {
  it('passes exact verified cancellation and approval commands and returns admitted views', async () => {
    const cancel = vi.fn(async () => ({ status: 'applied' as const, workflow: { ...workflow(), revision: 3, status: 'cancelled' as const } }));
    const approve = vi.fn(async () => ({ status: 'applied' as const, workflow: { ...workflow(), revision: 3 } }));
    const value = server({ workflowControls: { cancel, approve } });
    const cancelled = await value.fetch(request(`/v1/workflow-runs/${workflowId}/cancel`, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ commandId: 'cancel-1', revision: 2 }) }));
    expect(cancelled.status).toBe(200); expect((await json(cancelled))['workflow']).toMatchObject({ revision: 3, status: 'cancelled' });
    expect(cancel).toHaveBeenCalledWith(expect.objectContaining({ actorId: 'alice', runId: workflowId, revision: 2, commandId: 'cancel-1' }));
    const approved = await value.fetch(request(`/v1/workflow-runs/${workflowId}/approvals`, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ commandId: 'approve-1', revision: 2, nodeId: 'child', approvalDigest: 'd'.repeat(64), childRunId: 'b'.repeat(64) }) }));
    expect(approved.status).toBe(200); expect(approve).toHaveBeenCalledWith(expect.objectContaining({ actorId: 'alice', nodeId: 'child',
      approvalDigest: 'd'.repeat(64), childRunId: 'b'.repeat(64) }));
  });

  it('denies control before body parsing or adapter access', async () => {
    const cancel = vi.fn(async () => ({ status: 'conflict' as const })); const approve = vi.fn(async () => ({ status: 'conflict' as const }));
    const value = server({ authenticate: async () => identity({ capabilities: ['workflows:read'] }), workflowControls: { cancel, approve } });
    await error(await value.fetch(request(`/v1/workflow-runs/${workflowId}/cancel`, { method: 'POST', body: 'PRIVATE' })), 403, 'FORBIDDEN');
    expect(cancel).not.toHaveBeenCalled(); expect(approve).not.toHaveBeenCalled();
  });

  it('maps explicit conflict/not-found results and performs no retry', async () => {
    const cancel = vi.fn(async () => ({ status: 'conflict' as const })); const approve = vi.fn(async () => ({ status: 'not_found' as const }));
    const value = server({ workflowControls: { cancel, approve } });
    await error(await value.fetch(request(`/v1/workflow-runs/${workflowId}/cancel`, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ commandId: 'cancel-1', revision: 2 }) })), 409, 'WORKFLOW_CONFLICT'); expect(cancel).toHaveBeenCalledOnce();
    await error(await value.fetch(request(`/v1/workflow-runs/${workflowId}/approvals`, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ commandId: 'approve-1', revision: 2, nodeId: 'child', approvalDigest: 'd'.repeat(64), childRunId: null }) })), 404, 'NOT_FOUND');
    expect(approve).toHaveBeenCalledOnce();
  });

  it('rejects malformed commands and stale or hostile adapter acknowledgements', async () => {
    const value = server({ workflowControls: { cancel: async () => ({ status: 'applied', workflow: { ...workflow(), revision: 1 } }),
      approve: async () => ({ status: 'applied', workflow: { ...workflow(), privateOutput: 'PRIVATE' } } as never) } });
    await error(await value.fetch(request(`/v1/workflow-runs/${workflowId}/cancel`, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ commandId: 'cancel-1', revision: 2 }) })), 503, 'WORKFLOW_TRANSPORT_INVALID');
    await error(await value.fetch(request(`/v1/workflow-runs/${workflowId}/approvals`, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ commandId: 'approve-1', revision: 2, nodeId: '../bad', approvalDigest: 'd'.repeat(64), childRunId: null }) })), 400, 'INVALID_REQUEST');
  });
});

describe('authenticated durable workflow signals', () => {
  it('passes one exact revision-bound signal with verified authority and an immutable bounded value', async () => {
    const deliver = vi.fn(async (_input: Parameters<WorkflowSignalTransport['deliver']>[0]) => ({ status: 'applied' as const, workflow: { ...workflow(), revision: 3 } }));
    const value = server({ workflowSignals: { deliver } });
    const response = await value.fetch(request(`/v1/workflow-runs/${workflowId}/signals`, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ commandId: 'signal-command-1', revision: 2, signalId: 'deployment.ready/1', signalName: 'deployment.ready', value: { ready: true } }) }));
    expect(response.status).toBe(200); expect((await json(response))['workflow']).toMatchObject({ revision: 3 });
    expect(deliver).toHaveBeenCalledWith(expect.objectContaining({ actorId: 'alice', scope: { principalId: 'alice', projectId: 'project' },
      agentIds: ['echo'], runId: workflowId, revision: 2, commandId: 'signal-command-1', signalId: 'deployment.ready/1',
      signalName: 'deployment.ready', value: { ready: true } }));
    expect(Object.isFrozen(deliver.mock.calls[0]![0].value)).toBe(true);
  });

  it('denies before parsing, rejects malformed or oversized values and performs no retry on conflicts', async () => {
    const deniedDeliver = vi.fn(async () => ({ status: 'conflict' as const }));
    const denied = server({ authenticate: async () => identity({ capabilities: ['workflows:read'] }), workflowSignals: { deliver: deniedDeliver } });
    await error(await denied.fetch(request(`/v1/workflow-runs/${workflowId}/signals`, { method: 'POST', body: 'PRIVATE' })), 403, 'FORBIDDEN');
    expect(deniedDeliver).not.toHaveBeenCalled();
    const deliver = vi.fn(async () => ({ status: 'conflict' as const })); const value = server({ workflowSignals: { deliver } });
    await error(await value.fetch(request(`/v1/workflow-runs/${workflowId}/signals`, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ commandId: 'signal-1', revision: 2, signalId: '../bad', signalName: 'ready', value: true }) })), 400, 'INVALID_REQUEST');
    await error(await value.fetch(request(`/v1/workflow-runs/${workflowId}/signals`, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ commandId: 'signal-1', revision: 2, signalId: 'ready-1', signalName: 'ready', value: 'x'.repeat(4097) }) })), 400, 'INVALID_REQUEST');
    expect(deliver).not.toHaveBeenCalled();
    await error(await value.fetch(request(`/v1/workflow-runs/${workflowId}/signals`, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ commandId: 'signal-1', revision: 2, signalId: 'ready-1', signalName: 'ready', value: true }) })), 409, 'WORKFLOW_CONFLICT');
    expect(deliver).toHaveBeenCalledOnce();
  });

  it('fails closed on absent, unavailable, not-found and hostile adapters', async () => {
    const command = { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ commandId: 'signal-1', revision: 2, signalId: 'ready-1', signalName: 'ready', value: true }) } satisfies RequestInit;
    await error(await server().fetch(request(`/v1/workflow-runs/${workflowId}/signals`, command)), 404, 'NOT_FOUND');
    await error(await server({ workflowSignals: { deliver: async () => { throw new Error('PRIVATE'); } } })
      .fetch(request(`/v1/workflow-runs/${workflowId}/signals`, command)), 503, 'WORKFLOW_UNAVAILABLE');
    await error(await server({ workflowSignals: { deliver: async () => ({ status: 'not_found' }) } })
      .fetch(request(`/v1/workflow-runs/${workflowId}/signals`, command)), 404, 'NOT_FOUND');
    await error(await server({ workflowSignals: { deliver: async () => ({ status: 'applied', workflow: { ...workflow(), privateValue: 'PRIVATE' } } as never) } })
      .fetch(request(`/v1/workflow-runs/${workflowId}/signals`, command)), 503, 'WORKFLOW_TRANSPORT_INVALID');
  });
});

describe('authenticated durable workflow resume', () => {
  it('passes one exact revision-bound continuation request with verified authority', async () => {
    const resume = vi.fn(async () => ({ status: 'applied' as const, workflow: { ...workflow(), revision: 3 } }));
    const value = server({ workflowResumes: { resume } });
    const response = await value.fetch(request(`/v1/workflow-runs/${workflowId}/resume`, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ commandId: 'resume-1', revision: 2 }) }));
    expect(response.status).toBe(200); expect((await json(response))['workflow']).toMatchObject({ revision: 3 });
    expect(resume).toHaveBeenCalledWith(expect.objectContaining({ actorId: 'alice', scope: { principalId: 'alice', projectId: 'project' },
      agentIds: ['echo'], runId: workflowId, revision: 2, commandId: 'resume-1' }));
  });

  it('denies before body parsing and maps conflict without retry', async () => {
    const deniedResume = vi.fn(async () => ({ status: 'conflict' as const }));
    const denied = server({ authenticate: async () => identity({ capabilities: ['workflows:read'] }), workflowResumes: { resume: deniedResume } });
    await error(await denied.fetch(request(`/v1/workflow-runs/${workflowId}/resume`, { method: 'POST', body: 'PRIVATE' })), 403, 'FORBIDDEN');
    expect(deniedResume).not.toHaveBeenCalled();
    const resume = vi.fn(async () => ({ status: 'conflict' as const })); const value = server({ workflowResumes: { resume } });
    await error(await value.fetch(request(`/v1/workflow-runs/${workflowId}/resume`, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ commandId: 'resume-1', revision: 2 }) })), 409, 'WORKFLOW_CONFLICT'); expect(resume).toHaveBeenCalledOnce();
  });

  it('fails closed on malformed commands and stale or hostile acknowledgements', async () => {
    const resume = vi.fn(async () => ({ status: 'applied' as const, workflow: { ...workflow(), revision: 1 } }));
    const value = server({ workflowResumes: { resume } });
    await error(await value.fetch(request(`/v1/workflow-runs/${workflowId}/resume`, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ commandId: '../bad', revision: 2 }) })), 400, 'INVALID_REQUEST'); expect(resume).not.toHaveBeenCalled();
    await error(await value.fetch(request(`/v1/workflow-runs/${workflowId}/resume`, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ commandId: 'resume-1', revision: 2 }) })), 503, 'WORKFLOW_TRANSPORT_INVALID');
    const hostile = server({ workflowResumes: { resume: async () => ({ status: 'applied', workflow: { ...workflow(), privateValue: 'PRIVATE' } } as never) } });
    await error(await hostile.fetch(request(`/v1/workflow-runs/${workflowId}/resume`, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ commandId: 'resume-1', revision: 2 }) })), 503, 'WORKFLOW_TRANSPORT_INVALID');
  });
});

describe('authenticated durable workflow pause', () => {
  it('passes one exact revision-bound pause request to its separate adapter', async () => {
    const pause = vi.fn(async () => ({ status: 'applied' as const, workflow: { ...workflow(), revision: 3, status: 'paused' as const } }));
    const resume = vi.fn(async () => ({ status: 'conflict' as const }));
    const value = server({ workflowPauses: { pause }, workflowResumes: { resume } });
    const response = await value.fetch(request(`/v1/workflow-runs/${workflowId}/pause`, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ commandId: 'pause-1', revision: 2 }) }));
    expect(response.status).toBe(200); expect((await json(response))['workflow']).toMatchObject({ revision: 3, status: 'paused' });
    expect(pause).toHaveBeenCalledWith(expect.objectContaining({ actorId: 'alice', scope: { principalId: 'alice', projectId: 'project' },
      agentIds: ['echo'], runId: workflowId, revision: 2, commandId: 'pause-1' }));
    expect(resume).not.toHaveBeenCalled();
  });

  it('is unavailable without its adapter even when continuation is configured', async () => {
    const resume = vi.fn(async () => ({ status: 'applied' as const, workflow: { ...workflow(), revision: 3 } }));
    const value = server({ workflowResumes: { resume } });
    await error(await value.fetch(request(`/v1/workflow-runs/${workflowId}/pause`, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ commandId: 'pause-1', revision: 2 }) })), 404, 'NOT_FOUND'); expect(resume).not.toHaveBeenCalled();
    expect(() => server({ workflowPauses: { pause: async () => ({ status: 'conflict' as const }), extra: () => undefined } as never })).toThrow();
  });

  it('denies before body parsing, maps conflict once and rejects stale acknowledgements', async () => {
    const deniedPause = vi.fn(async () => ({ status: 'conflict' as const }));
    const denied = server({ authenticate: async () => identity({ capabilities: ['workflows:read'] }), workflowPauses: { pause: deniedPause } });
    await error(await denied.fetch(request(`/v1/workflow-runs/${workflowId}/pause`, { method: 'POST', body: 'PRIVATE' })), 403, 'FORBIDDEN');
    expect(deniedPause).not.toHaveBeenCalled();
    const pause = vi.fn(async () => ({ status: 'conflict' as const })); const value = server({ workflowPauses: { pause } });
    await error(await value.fetch(request(`/v1/workflow-runs/${workflowId}/pause`, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ commandId: 'pause-1', revision: 2 }) })), 409, 'WORKFLOW_CONFLICT'); expect(pause).toHaveBeenCalledOnce();
    const stale = server({ workflowPauses: { pause: async () => ({ status: 'applied' as const, workflow: { ...workflow(), revision: 1 } }) } });
    await error(await stale.fetch(request(`/v1/workflow-runs/${workflowId}/pause`, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ commandId: 'pause-1', revision: 2 }) })), 503, 'WORKFLOW_TRANSPORT_INVALID');
    await error(await value.fetch(request(`/v1/workflow-runs/${workflowId}/pause`, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ commandId: 'pause-1', revision: 2, force: true }) })), 400, 'INVALID_REQUEST'); expect(pause).toHaveBeenCalledOnce();
  });
});

describe('authenticated workflow fleet control', () => {
  const fleetIdentity = () => identity({ capabilities: ['workflows:read', 'workflows:control', 'workflows:fleet'] });
  const runId = 'c'.repeat(64);
  const adapter = (overrides: Partial<NonNullable<AgentServerOptions['workflowFleet']>> = {}) => ({
    inspect: vi.fn(async () => ({ held: false, generation: 0, changedAtMs: null })),
    hold: vi.fn(async () => ({ held: true, generation: 1, changedAtMs: 5 })),
    release: vi.fn(async () => ({ held: false, generation: 1, changedAtMs: 6 })),
    sweep: vi.fn(async () => ({ status: 'applied' as const, sweep: { outcomes: [{ target: 'lifecycle', runId, outcome: 'paused' as const }], nextCursor: { page: 2 } } })),
    ...overrides,
  });
  const post = (path: string, value: unknown) => request(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(value) });

  it('reads with workflows:read and holds, releases and sweeps with workflows:fleet only', async () => {
    const fleet = adapter(); const value = server({ authenticate: async () => fleetIdentity(), workflowFleet: fleet });
    expect(await json(await value.fetch(request('/v1/workflow-fleet')))).toEqual({ fleet: { held: false, generation: 0, changedAtMs: null } });
    expect(await json(await value.fetch(post('/v1/workflow-fleet/hold', {})))).toEqual({ fleet: { held: true, generation: 1, changedAtMs: 5 } });
    expect(fleet.hold).toHaveBeenCalledWith(expect.objectContaining({ actorId: 'alice', scope: { principalId: 'alice', projectId: 'project' }, agentIds: ['echo'] }));
    expect(await json(await value.fetch(post('/v1/workflow-fleet/sweeps/pause', { cursor: { page: 1 }, limit: 16 }))))
      .toEqual({ sweep: { outcomes: [{ target: 'lifecycle', runId, outcome: 'paused' }], nextCursor: { page: 2 } } });
    expect(fleet.sweep).toHaveBeenCalledWith(expect.objectContaining({ phase: 'pause', cursor: { page: 1 }, limit: 16 }));
    expect((await json(await value.fetch(post('/v1/workflow-fleet/release', {}))))['fleet']).toMatchObject({ held: false });
    const controlOnly = adapter(); const denied = server({ workflowFleet: controlOnly });
    for (const path of ['/v1/workflow-fleet/hold', '/v1/workflow-fleet/release', '/v1/workflow-fleet/sweeps/resume']) {
      await error(await denied.fetch(request(path, { method: 'POST', body: 'PRIVATE' })), 403, 'FORBIDDEN');
    }
    expect(controlOnly.hold).not.toHaveBeenCalled(); expect(controlOnly.release).not.toHaveBeenCalled(); expect(controlOnly.sweep).not.toHaveBeenCalled();
    expect((await denied.fetch(request('/v1/workflow-fleet'))).status).toBe(200);
    await error(await server({ authenticate: async () => fleetIdentity() }).fetch(post('/v1/workflow-fleet/hold', {})), 404, 'NOT_FOUND');
  });

  it('maps a wrong-phase sweep to conflict and rejects malformed commands before the adapter', async () => {
    const fleet = adapter({ sweep: vi.fn(async () => ({ status: 'conflict' as const })) });
    const value = server({ authenticate: async () => fleetIdentity(), workflowFleet: fleet });
    await error(await value.fetch(post('/v1/workflow-fleet/sweeps/resume', { cursor: null, limit: 8 })), 409, 'WORKFLOW_CONFLICT'); expect(fleet.sweep).toHaveBeenCalledOnce();
    await error(await value.fetch(post('/v1/workflow-fleet/hold', { force: true })), 400, 'INVALID_REQUEST');
    await error(await value.fetch(post('/v1/workflow-fleet/sweeps/pause', { cursor: null, limit: 129 })), 400, 'INVALID_REQUEST');
    await error(await value.fetch(post('/v1/workflow-fleet/sweeps/pause', { cursor: { value: 'x'.repeat(5_000) }, limit: 8 })), 400, 'INVALID_REQUEST');
    await error(await value.fetch(post('/v1/workflow-fleet/sweeps/pause', { cursor: [], limit: 8 })), 400, 'INVALID_REQUEST');
    expect(fleet.sweep).toHaveBeenCalledOnce(); expect(fleet.hold).not.toHaveBeenCalled();
    expect(() => server({ workflowFleet: { ...adapter(), extra: () => undefined } as never })).toThrow();
  });

  it('fails closed on inconsistent or content-bearing acknowledgements', async () => {
    const cases: [string, unknown, Partial<NonNullable<AgentServerOptions['workflowFleet']>>][] = [
      ['/v1/workflow-fleet/hold', {}, { hold: vi.fn(async () => ({ held: false, generation: 0, changedAtMs: null })) }],
      ['/v1/workflow-fleet/release', {}, { release: vi.fn(async () => ({ held: true, generation: 1, changedAtMs: 1 })) }],
      ['/v1/workflow-fleet/sweeps/pause', { cursor: null, limit: 1 }, { sweep: vi.fn(async () => ({ status: 'applied' as const, sweep: {
        outcomes: [{ target: 'lifecycle', runId, outcome: 'paused' as const, output: 'PRIVATE' }], nextCursor: null } }) as never) }],
      ['/v1/workflow-fleet/sweeps/pause', { cursor: null, limit: 1 }, { sweep: vi.fn(async () => ({ status: 'applied' as const, sweep: {
        outcomes: [{ target: 'lifecycle', runId, outcome: 'paused' as const }, { target: 'lifecycle', runId: 'd'.repeat(64), outcome: 'paused' as const }], nextCursor: null } })) }],
    ];
    for (const [path, body, overrides] of cases) {
      const value = server({ authenticate: async () => fleetIdentity(), workflowFleet: adapter(overrides) });
      const response = await value.fetch(post(path, body)); await error(response, 503, 'WORKFLOW_TRANSPORT_INVALID');
    }
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

  it('accepts a browser preflight for paginated reads that carry query parameters', async () => {
    const authenticate = vi.fn(async () => identity()); const value = server({ allowedOrigins: [browserOrigin], authenticate });
    const headers = { origin: browserOrigin, 'access-control-request-method': 'GET', 'access-control-request-headers': 'authorization' };
    for (const path of ['/v1/workflow-runs?limit=50', '/v1/human-requests?after=a&limit=5', `/v1/runs/${'a'.repeat(8)}-aaaa-4aaa-8aaa-${'a'.repeat(12)}/events?after=3`]) {
      const preflight = await value.fetch(request(path, { method: 'OPTIONS', headers }, null));
      expect(preflight.status).toBe(204); expect(preflight.headers.get('access-control-allow-origin')).toBe(browserOrigin);
    }
    expect(authenticate).not.toHaveBeenCalled();
    await error(await value.fetch(request('/v1/workflow-runs?limit=50', { method: 'OPTIONS', headers: { ...headers, origin: 'https://attacker.example.test' } }, null)), 403, 'ORIGIN_DENIED');
    await error(await value.fetch(request('/v1/workflow-runs?unknown=1', { headers: { origin: browserOrigin } })), 400, 'INVALID_QUERY');
    await error(await value.fetch(request('/v1/workflow-runs?access_token=PRIVATE', { method: 'OPTIONS', headers }, null)), 400, 'INVALID_QUERY');
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
    expect([...text.matchAll(/^id: (\d+)$/gm)].map(match => Number(match[1]))).toEqual([1, 2, 3, 4, 5, 6]);
    expect(text).toContain('event: step.started'); expect(text).toContain('event: step.completed');
    const resumed = await (await events(value, id, {}, '?after=5')).text();
    expect(resumed).toContain('id: 6'); expect(resumed).not.toContain('id: 5');
    expect(await (await events(value, id, {}, '?after=6')).text()).toBe('');
  });

  it('emits explicit replay gaps with metadata that can recover through an authorized snapshot', async () => {
    const value = server({ agents: [{ agent: fixture(), permissions: { allow: ['model:fixture'] }, limits: { maxEventRetention: 2 } }] });
    const id = await admitted(value); await terminal(value, id);
    const text = await (await events(value, id)).text();
    expect(text).toContain('event: events.gap'); expect(text).toContain('"from":1,"to":4');
    expect([...text.matchAll(/^id: (\d+)$/gm)].map(match => Number(match[1]))).toEqual([4, 5, 6]);
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
