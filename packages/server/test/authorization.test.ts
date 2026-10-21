import { createHttpAuthorizationPolicy, HTTP_AUTHORIZATION_PROTOCOL } from '../../../extensions/authz-http/src/index.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { z } from 'zod';
import { defineAgent } from '@mayura/runtime';
import { scriptedModel } from '@mayura/testing';
import { defineTool } from '@mayura/tools';
import { createSqliteStore } from '@mayura/storage-sqlite';
import { createThreads } from '@mayura/threads';
import type { AuthorizationAuditEvent, AuthorizationPolicy, AuthorizationDecision } from '@mayura/core';
import { createRbacPolicy, type RbacRule } from '../../authz/src/index.js';
import { createClient } from '../../client/src/index.js';
import { createAgentServer, type AgentServer, type AgentServerOptions, type ServerIdentity } from '../src/index.js';

const origin = 'https://authorization.test'; const scope = { principalId: 'alice', projectId: 'shop' };
const caps = ['runs:read', 'runs:submit', 'runs:cancel', 'runs:approve', 'threads:read', 'threads:write', 'threads:delete', 'threads:compact', 'operations:read', 'humans:read', 'humans:respond', 'workflows:read', 'workflows:control', 'workflows:fleet', 'workflows:migrate'] as const;
let directory: string; let store: ReturnType<typeof createSqliteStore>; const servers: AgentServer[] = [];
beforeEach(async () => { directory = await mkdtemp(join(tmpdir(), 'mayura-http-authz-')); store = createSqliteStore({ filename: join(directory, 'chat.sqlite') }); store = { ...store, threads: { ...store.threads }, runCheckpoints: { ...store.runCheckpoints } }; await store.initialize(); await store.threads.initialize(); });
afterEach(async () => { await Promise.all(servers.splice(0).map(server => server.close())); await store.close();
  if (!resolve(directory).startsWith(`${resolve(tmpdir())}${sep}mayura-http-authz-`)) throw new Error('Unsafe cleanup path'); await rm(directory, { recursive: true, force: true }); });
function policy(extra: readonly RbacRule[] = [], version = 'v1'): AuthorizationPolicy {
  return createRbacPolicy({ version, roles: [{ id: 'member', rules: [
    { id: 'threads', effect: 'allow', actions: ['list', 'read', 'create', 'update', 'delete', 'archive', 'restore', 'append', 'approve', 'recover', 'inspect_approval', 'reconcile_approval', 'compact', 'inspect_compaction', 'cancel_compaction'], resource: { kind: 'thread', id: '*' } },
    { id: 'agents', effect: 'allow', actions: ['list', 'read', 'submit', 'execute', 'delegate', 'handoff'], resource: { kind: 'agent', id: '*' } },
    { id: 'runs', effect: 'allow', actions: ['read', 'cancel', 'approve', 'execute'], resource: { kind: 'run', id: '*' } },
    { id: 'tools', effect: 'allow', actions: ['list', 'read', 'execute'], resource: { kind: 'tool', id: '*' } },
    { id: 'workflows', effect: 'allow', actions: ['list', 'read', 'cancel', 'approve', 'signal', 'pause', 'resume', 'migrate'], resource: { kind: 'workflow', id: '*' } },
    { id: 'humans', effect: 'allow', actions: ['list', 'read', 'respond'], resource: { kind: 'human_request', id: '*' } },
    { id: 'server', effect: 'allow', actions: ['read', 'hold', 'release', 'sweeps_pause', 'sweeps_resume'], resource: { kind: 'server', id: '*' } }, ...extra,
  ] }], bindings: [{ subject: scope, roles: ['member'] }, { subject: { ...scope, principalId: 'bob' }, roles: ['member'] }] });
}
function fixture(override: Partial<AgentServerOptions> = {}, authorizationPolicy = policy()) {
  const model = scriptedModel(Array.from({ length: 12 }, () => ({ type: 'final' as const, output: { reply: 'Hello' }, usage: { costMicros: 0 } })));
  const generate = vi.fn(model.generate.bind(model));
  const agent = defineAgent({ id: 'support', version: '1', tools: [], instructions: 'Help', input: z.object({ message: z.string() }), output: z.object({ reply: z.string() }), model: { ...model, generate } });
  const api = createAgentServer({ publicOrigin: origin, agents: [{ agent, permissions: { allow: ['model:scripted'] } }], threads: { store },
    authorization: { policy: authorizationPolicy, permissions: { allow: ['authz:evaluate'] }, cursorKey: new Uint8Array(32).fill(7) },
    authenticate: async ({ token }) => ({ scope: { ...scope, ...(token === 'bob' ? { principalId: 'bob' } : {}) }, agentIds: ['support'], capabilities: token === 'no-cap' ? ['runs:read'] : caps, expiresAtMs: Date.now() + 60_000 } satisfies ServerIdentity), ...override });
  servers.push(api); return { api, generate, agent };
}
const call = (api: AgentServer, path: string, method = 'GET', body?: unknown, token = 'alice', headers: Record<string, string> = {}) => api.fetch(new Request(origin + path,
  { method, headers: { authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }));
const payload = async (response: Response) => response.json() as Promise<Record<string, any>>;
async function seed() {
  const threads = createThreads({ store, scope, permissions: { allow: ['thread:read', 'thread:write'] } });
  await threads.create({ id: 'visible', agentId: 'support', title: 'Visible' }); await threads.create({ id: 'secret', agentId: 'support', title: 'Private title' }); return threads;
}
const deny = (kind: RbacRule['resource']['kind'], id: string, actions: readonly string[]): RbacRule => ({ id: `deny-${kind}-${id.replace('*', 'all')}`, effect: 'deny', actions, resource: { kind, id } });

describe('scoped server authorization', () => {
  it('forwards server-owned authorization into runtime execution after HTTP submission admission', async () => {
    const { api, generate } = fixture({}, policy([deny('agent', 'support', ['execute'])]));
    const submitted = await payload(await call(api, '/v1/runs', 'POST', { agentId: 'support', input: { message: 'Hello' } }, 'alice', { 'idempotency-key': 'execute-denied' }));
    await vi.waitFor(async () => {
      const view = await payload(await call(api, `/v1/runs/${submitted.id}`));
      expect(view.outcome).toMatchObject({ status: 'blocked', error: { code: 'PERMISSION_DENIED' } });
    });
    expect(generate).not.toHaveBeenCalled();
  });

  it('enforces a remote policy and emits its final denial through the core audit boundary', async () => {
    const events: AuthorizationAuditEvent[] = [];
    const fetch = vi.fn<typeof globalThis.fetch>(async (_url, init) => {
      const frame = JSON.parse(String(init!.body));
      return new Response(JSON.stringify({ protocol: HTTP_AUTHORIZATION_PROTOCOL, requestId: frame.requestId,
        decision: { effect: 'deny', reason: 'explicit_deny', policyVersion: 'v1', ruleId: 'remote-rule' } }), { headers: { 'content-type': 'application/json' } });
    });
    const remote = createHttpAuthorizationPolicy({ endpoint: 'https://policy.test/check', version: 'v1', permissions: { allow: ['authz:http'] }, fetch });
    try {
      const { api, generate } = fixture({ authorization: { policy: remote, permissions: { allow: ['authz:evaluate', 'authz:audit'] }, audit: { sink: event => { events.push(event); } } } });
      expect((await call(api, '/v1/runs', 'POST', { agentId: 'support', input: { message: 'SECRET' } }, 'alice', { 'idempotency-key': 'remote' })).status).toBe(403);
      await api.flushAuthorizationAudit(); expect(generate).not.toHaveBeenCalled(); expect(fetch).toHaveBeenCalledTimes(1);
      expect(events).toHaveLength(1); expect(events[0]?.decision).toMatchObject({ reason: 'explicit_deny', ruleId: 'remote-rule' });
      expect(JSON.stringify(events) + String(fetch.mock.calls[0]![1]!.body)).not.toContain('SECRET');
    } finally { remote.close(); }
  });

  it('delivers scoped decision audits without changing denials or exposing host audit controls over HTTP', async () => {
    const events: AuthorizationAuditEvent[] = [];
    const { api, generate } = fixture({ authorization: { policy: policy([deny('agent', 'support', ['submit'])]),
      permissions: { allow: ['authz:evaluate', 'authz:audit'] }, audit: { sink: event => { events.push(event); } } } });
    expect((await call(api, '/v1/runs', 'POST', { agentId: 'support', input: { message: 'SECRET input' } }, 'alice', { 'idempotency-key': 'audited' })).status).toBe(403);
    await api.flushAuthorizationAudit(); expect(generate).not.toHaveBeenCalled();
    expect(events).toHaveLength(1); expect(events[0]).toMatchObject({ request: { subject: scope, action: 'submit', resource: { kind: 'agent', id: 'support' } }, decision: { effect: 'deny' } });
    expect(JSON.stringify(events)).not.toContain('SECRET'); expect(api.inspectAuthorizationAudit()).toMatchObject({ produced: 1, delivered: 1 });
    expect((await call(api, '/v1/authorization/audit')).status).toBe(403);
  });

  it('keeps the legacy server opt-in and exposes the configured boundary through the existing client', async () => {
    const setup = fixture(); const client = createClient({ baseUrl: origin, token: () => 'alice', fetch: (url, init) => setup.api.fetch(new Request(url, init)) });
    expect((await client.session()).features).toContain('authorization'); await client.createThread({ id: 'chat', agentId: 'support' });
    const legacy = fixture({ authorization: undefined } as unknown as Partial<AgentServerOptions>); expect((await call(legacy.api, '/v1/threads/chat')).status).toBe(200);
  });
  it('filters rows and seals cursors without exposing denied IDs, while preserving bounded pagination', async () => {
    await seed(); const { api } = fixture({}, policy([deny('thread', 'secret', ['read'])]));
    const first = await payload(await call(api, '/v1/threads?limit=1')); expect(first.threads.every((thread: { id: string }) => thread.id !== 'secret')).toBe(true);
    expect(first.cursor).toMatch(/^authz1\./); expect(first.cursor).not.toContain('secret');
    const second = await payload(await call(api, `/v1/threads?limit=1&cursor=${encodeURIComponent(first.cursor)}`)); expect(second.threads.every((thread: { id: string }) => thread.id !== 'secret')).toBe(true);
    expect([...first.threads, ...second.threads]).toHaveLength(1);
    expect((await call(api, `/v1/threads?cursor=${encodeURIComponent(first.cursor)}`, 'GET', undefined, 'bob')).status).toBe(400);
    expect((await call(api, `/v1/threads?status=archived&cursor=${encodeURIComponent(first.cursor)}`)).status).toBe(400);
    expect((await call(api, `/v1/threads?cursor=${encodeURIComponent(first.cursor.slice(0, 12) + (first.cursor[12] === 'A' ? 'B' : 'A') + first.cursor.slice(13))}`)).status).toBe(400);
    const replica = fixture({}, policy([deny('thread', 'secret', ['read'])])); expect((await call(replica.api, `/v1/threads?limit=1&cursor=${encodeURIComponent(first.cursor)}`)).status).toBe(200);
    const changed = fixture({}, policy([], 'v2')); expect((await call(changed.api, `/v1/threads?cursor=${encodeURIComponent(first.cursor)}`)).status).toBe(400);
    const client = createClient({ baseUrl: origin, token: () => 'alice', fetch: (url, init) => api.fetch(new Request(url, init)) }); const page = await client.threads({ limit: 1 }); if (page.cursor) await client.threads({ limit: 1, cursor: page.cursor });
  });
  it('denies thread reads and mutations without letting read-denied records leak through update/create responses', async () => {
    const threads = await seed(); const { api } = fixture({}, policy([deny('thread', 'secret', ['read'])]));
    for (const [path, method, body] of [['/v1/threads/secret', 'GET', undefined], ['/v1/threads/secret/entries', 'GET', undefined],
      ['/v1/threads/secret', 'POST', { title: 'Changed' }], ['/v1/threads/secret/archive', 'POST', undefined], ['/v1/threads', 'POST', { id: 'secret' }]] as const) {
      const response = await call(api, path, method, body); expect(response.status).toBe(403); expect((await payload(response)).error.code).toBe('AUTHORIZATION_DENIED');
    }
    expect((await threads.get('secret'))?.title).toBe('Private title');
    expect((await call(api, '/v1/threads/visible', 'GET', undefined, 'bob')).status).toBe(404);
  });
  it('checks capabilities before policy callbacks and never takes scope or roles from request bodies', async () => {
    const authorize = vi.fn(policy().authorize); const { api } = fixture({}, { version: 'v1', authorize });
    expect((await call(api, '/v1/threads/visible', 'GET', undefined, 'no-cap')).status).toBe(403); expect(authorize).not.toHaveBeenCalled();
    expect((await call(api, '/v1/threads', 'POST', { id: 'spoof', scope: { principalId: 'bob', projectId: 'other' }, roles: ['admin'] })).status).toBe(400);
    expect(authorize).not.toHaveBeenCalled();
  });
  it('denies agent submission and thread history admission before paid work or idempotency claims', async () => {
    await seed(); const blocked = fixture({}, policy([deny('agent', 'support', ['submit'])]));
    expect((await call(blocked.api, '/v1/runs', 'POST', { agentId: 'support', input: { message: 'Hello' } }, 'alice', { 'idempotency-key': 'send-1' })).status).toBe(403); expect(blocked.generate).not.toHaveBeenCalled();
    const bound = fixture({}, policy([deny('thread', 'visible', ['append'])]));
    expect((await call(bound.api, '/v1/runs', 'POST', { agentId: 'support', threadId: 'visible', input: { message: 'Hello' } }, 'alice', { 'idempotency-key': 'send-1' })).status).toBe(403); expect(bound.generate).not.toHaveBeenCalled();
  });
  it('denies compaction commands and inspection before accessing storage or invoking a summarizer', async () => {
    await seed();
    const { api, generate } = fixture({}, policy([deny('thread', 'visible', ['compact', 'inspect_compaction', 'cancel_compaction'])]));
    const inspect = vi.spyOn(store.threads, 'compaction');
    for (const [path, method, body] of [
      ['/v1/threads/visible/compactions', 'POST', { commandId: 'summary', through: 1 }],
      ['/v1/threads/visible/compactions/summary', 'GET', undefined],
      ['/v1/threads/visible/compactions/summary/cancel', 'POST', undefined],
    ] as const) expect((await call(api, path, method, body)).status).toBe(403);
    expect(inspect).not.toHaveBeenCalled(); expect(generate).not.toHaveBeenCalled();
    inspect.mockRestore();
  });
  it('rechecks an idempotent replay against the run read policy', async () => {
    let forbidden: string | null = null; const base = policy(); const changing: AuthorizationPolicy = { version: base.version, authorize(request, context) {
      if (request.resource.kind === 'run' && request.resource.id === forbidden) return { effect: 'deny', reason: 'explicit_deny', policyVersion: base.version, ruleId: null };
      return base.authorize(request, context);
    } };
    const { api, generate } = fixture({}, changing); const body = { agentId: 'support', input: { message: 'Hello' } }; const headers = { 'idempotency-key': 'same' };
    const first = await payload(await call(api, '/v1/runs', 'POST', body, 'alice', headers));
    await vi.waitFor(() => expect(generate).toHaveBeenCalledTimes(1)); forbidden = first.id;
    expect((await call(api, '/v1/runs', 'POST', body, 'alice', headers)).status).toBe(403); expect(generate).toHaveBeenCalledTimes(1);
  });
  it('rechecks a changing policy immediately before mutations and fails closed on unavailable policies', async () => {
    const threads = await seed(); const base = policy(); let updates = 0;
    const changing: AuthorizationPolicy = { version: 'v1', authorize(request, context) {
      if (request.action === 'update' && ++updates > 1) return { effect: 'deny', reason: 'explicit_deny', policyVersion: 'v1', ruleId: null };
      return base.authorize(request, context);
    } };
    const { api } = fixture({}, changing); expect((await call(api, '/v1/threads/visible', 'POST', { title: 'Changed' })).status).toBe(403); expect((await threads.get('visible'))?.title).toBe('Visible');
    const unavailable = fixture({}, { version: 'v1', authorize() { throw new Error('private backend credential'); } });
    const response = await call(unavailable.api, '/v1/threads'); expect(response.status).toBe(403); expect(await response.text()).not.toContain('credential');
  });
  it('protects workflow commands before calling the transport', async () => {
    const cancel = vi.fn(async () => ({ status: 'not_found' as const })); const approve = vi.fn(async () => ({ status: 'not_found' as const })); const runId = 'a'.repeat(64);
    const { api } = fixture({ workflowControls: { cancel, approve } }, policy([deny('workflow', runId, ['cancel'])]));
    expect((await call(api, `/v1/workflow-runs/${runId}/cancel`, 'POST', { commandId: 'c1', revision: 1 })).status).toBe(403); expect(cancel).not.toHaveBeenCalled();
  });
  it('protects approval decisions without dispatching an approved tool', async () => {
    const execute = vi.fn(() => ({ saved: true })); const tool = defineTool({ id: 'save', version: '1', description: 'Save', effects: 'write', capabilities: [], approval: 'required', input: z.object({}), output: z.object({ saved: z.boolean() }), execute });
    const agent = defineAgent({ id: 'support', version: '1', instructions: 'Help', tools: [tool], input: z.object({ message: z.string() }), output: z.object({ reply: z.string() }), model: scriptedModel([{ type: 'tool_calls', calls: [{ id: 'write1', toolId: 'save', input: {} }], usage: { costMicros: 0 } }]) });
    const { api } = fixture({ agents: [{ agent, permissions: { allow: ['model:scripted', 'tool:save', 'effect:write'] } }] }, policy([deny('run', '*', ['approve'])]));
    const first = await payload(await call(api, '/v1/runs', 'POST', { agentId: 'support', input: { message: 'Hi' } }, 'alice', { 'idempotency-key': 'waiting' }));
    let view: Record<string, any> = {}; await vi.waitFor(async () => { view = await payload(await call(api, `/v1/runs/${first.id}`)); expect(view.approval).toBeDefined(); });
    expect((await call(api, `/v1/runs/${first.id}/approvals`, 'POST', { callId: view.approval.callId, digest: view.approval.digest, decision: 'approved' })).status).toBe(403); expect(execute).not.toHaveBeenCalled();
  });
  it('terminates event observation on revocation without reconnecting the denied stream', async () => {
    let permitted = true; const base = policy();
    const live: AuthorizationPolicy = { version: base.version, authorize(request, context) {
      if (!permitted && request.resource.kind === 'run' && request.action === 'read') return { effect: 'deny', reason: 'explicit_deny', policyVersion: base.version, ruleId: null };
      return base.authorize(request, context);
    } };
    const { api } = fixture({}, live); const transport = vi.fn<typeof fetch>((url, init) => api.fetch(new Request(url, init)));
    const client = createClient({ baseUrl: origin, token: () => 'alice', fetch: transport });
    const run = await client.submit('support', { message: 'Hello' }, { idempotencyKey: 'stream' }); let frames = 0;
    const observe = async () => { for await (const _event of run.events()) { frames++; permitted = false; } };
    await expect(observe()).rejects.toMatchObject({ code: 'AUTHORIZATION_DENIED' }); expect(frames).toBeGreaterThan(0);
    expect(transport.mock.calls.filter(([url]) => String(url).includes('/events'))).toHaveLength(1);
  });
  it('fails closed on policy timeout without starting model work', async () => {
    let release!: (decision: AuthorizationDecision) => void; const late = new Promise<AuthorizationDecision>(resolve => { release = resolve; });
    const delayed: AuthorizationPolicy = { version: 'v1', authorize: () => late };
    const { api, generate } = fixture({ authorization: { policy: delayed, permissions: { allow: ['authz:evaluate'] }, limits: { timeoutMs: 5 } } });
    try { expect((await call(api, '/v1/runs', 'POST', { agentId: 'support', input: { message: 'Hello' } }, 'alice', { 'idempotency-key': 'timeout' })).status).toBe(403); expect(generate).not.toHaveBeenCalled(); }
    finally { release({ effect: 'allow', reason: 'allowed', policyVersion: 'v1', ruleId: null }); }
  });
  it('propagates cancellation and closes policy work without allowing late decisions', async () => {
    let started!: () => void; const waiting = new Promise<void>(resolve => { started = resolve; }); let release!: (decision: AuthorizationDecision) => void;
    const late = new Promise<AuthorizationDecision>(resolve => { release = resolve; }); let observed: AbortSignal | undefined;
    const { api } = fixture({}, { version: 'v1', authorize(_request, context) { observed = context.signal; started(); return late; } });
    const abort = new AbortController(); const work = api.fetch(new Request(origin + '/v1/threads', { headers: { authorization: 'Bearer alice' }, signal: abort.signal }));
    await waiting; abort.abort(); expect((await work).status).not.toBe(200); expect(observed?.aborted).toBe(true);
    release({ effect: 'allow', reason: 'allowed', policyVersion: 'v1', ruleId: null });
  });
});
