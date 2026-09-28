import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFile } from 'node:fs/promises';
import type { JsonObject, Schema } from '@mayura/core';
import { defineAgent } from '@mayura/runtime';
import { createAgentServer, type AgentServer, type AgentServerOptions, type ServerIdentity } from '../src/index.js';

const publicOrigin = 'https://agents.example.test';
const schema: Schema<unknown> = { '~standard': { version: 1, vendor: 'test', validate: value => ({ value }) } };
const servers: AgentServer[] = [];
afterEach(async () => { await Promise.all(servers.splice(0).map(server => server.close())); });
const identity = (overrides: Partial<ServerIdentity> = {}): ServerIdentity => ({ scope: { principalId: 'alice', projectId: 'project' }, agentIds: ['echo'],
  capabilities: ['runs:read', 'runs:submit', 'workflows:read', 'workflows:control'], expiresAtMs: Date.now() + 60_000, ...overrides });
function server(options: Partial<AgentServerOptions> = {}, generate = async () => ({ type: 'final' as const, output: 1, usage: { costMicros: 0 } })): AgentServer {
  const agent = defineAgent({ id: 'echo', version: '1', instructions: 'Fixture.', tools: [], input: schema, output: schema,
    model: { id: 'fixture', capabilities: { tools: true, structuredOutput: true }, maxCostMicros: 0, generate } });
  const value = createAgentServer({ publicOrigin, agents: [{ agent, permissions: { allow: ['model:fixture'] } }], authenticate: async () => identity(), ...options });
  servers.push(value); return value;
}
const call = (value: AgentServer, url: string, init: RequestInit = {}) => {
  const headers = new Headers(init.headers); if (!headers.has('authorization')) headers.set('authorization', 'Bearer TOKEN');
  return value.fetch(new Request(new URL(url, publicOrigin), { ...init, headers }));
};
const json = async (response: Response) => await response.json() as JsonObject;
const workflowId = 'a'.repeat(64);
const view = (revision: number) => ({ format: 2 as const, definitionId: 'deploy', definitionVersion: '1', runId: workflowId, revision, status: 'running' as const,
  nodes: [{ id: 'a', kind: 'tool' as const, dependsOn: [] }], steps: [{ id: 'a', kind: 'tool' as const, status: 'pending' as const }] });

describe('server errors a developer can decode', () => {
  it('documents every error code the server can send, with its status, in the server guide', async () => {
    const source = await readFile(new URL('../src/index.ts', import.meta.url), 'utf8');
    const catalog = /const errorMessages = Object\.freeze\(\{([\s\S]*?)\} satisfies/.exec(source)![1]!;
    const codes = [...catalog.matchAll(/^ {2}([A-Z_]+):/gm)].map(match => match[1]!);
    const thrown = new Map<string, Set<number>>();
    for (const match of source.matchAll(/HttpFailure\((\d{3}), '([A-Z_]+)'/g)) thrown.set(match[2]!, (thrown.get(match[2]!) ?? new Set()).add(Number(match[1])));
    // Every thrown code has a message, and each code has exactly one status.
    for (const [code, statuses] of thrown) { expect(codes).toContain(code); expect(statuses.size, code).toBe(1); }
    const guide = await readFile(new URL('../../../docs/guides/server-and-client.md', import.meta.url), 'utf8');
    for (const code of codes) {
      const row = new RegExp(`^\\| \`${code}\` \\| (\\d{3}|stream) \\|`, 'm').exec(guide);
      expect(row, `docs table row for ${code}`).not.toBeNull();
      const status = thrown.get(code); if (status) expect(Number(row![1]), code).toBe([...status][0]);
    }
    for (const code of ['HOST_UNAVAILABLE', 'MISDIRECTED_REQUEST']) expect(guide).toMatch(new RegExp(`^\\| \`${code}\` \\|`, 'm'));
  });

  it('answers unexpected failures with INTERNAL_ERROR, never a 400 or the thrown text', async () => {
    const value = server();
    vi.spyOn(globalThis.crypto.subtle, 'digest').mockRejectedValueOnce(new Error('PRIVATE digest failure'));
    const response = await call(value, '/v1/runs', { method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': 'boom' },
      body: JSON.stringify({ agentId: 'echo', input: 1 }) });
    expect(response.status).toBe(500); const body = await json(response);
    expect(body['error']).toMatchObject({ code: 'INTERNAL_ERROR', message: expect.stringContaining('same idempotency key') }); expect(JSON.stringify(body)).not.toContain('PRIVATE');
    vi.restoreAllMocks();
  });

  it('sends Retry-After with capacity errors and exposes it to allowed browser origins', async () => {
    const value = server({ allowedOrigins: ['https://app.example.test'], limits: { maxRequests: 1 }, authenticate: () => new Promise(() => {}) });
    void call(value, '/v1/agents');
    const busy = await call(value, '/v1/agents', { headers: { origin: 'https://app.example.test' } });
    expect(busy.status).toBe(429); expect(busy.headers.get('retry-after')).toBe('1');
    expect(busy.headers.get('access-control-allow-origin')).toBe('https://app.example.test');
    expect(busy.headers.get('access-control-expose-headers')).toBe('Retry-After');
    expect(await json(busy)).toEqual({ error: { code: 'REQUEST_LIMIT', message: expect.stringContaining('maxRequests'), retryAfterMs: 1_000 } });
  });

  it('tells a stale workflow command the current revision when the token may read the run', async () => {
    const cancel = vi.fn(async () => ({ status: 'conflict' as const }));
    let supplied = identity(); const inspect = vi.fn(async () => view(9));
    const value = server({ authenticate: async () => supplied, workflowControls: { cancel, approve: cancel }, workflowViews: { inspect } });
    const command = { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ commandId: 'c-1', revision: 3 }) };
    const stale = await call(value, `/v1/workflow-runs/${workflowId}/cancel`, command);
    expect(stale.status).toBe(409); expect((await json(stale))['error']).toMatchObject({ code: 'WORKFLOW_CONFLICT', currentRevision: 9 });
    supplied = identity({ capabilities: ['workflows:control'] });
    expect((await json(await call(value, `/v1/workflow-runs/${workflowId}/cancel`, command)))['error']).not.toHaveProperty('currentRevision');
    expect(inspect).toHaveBeenCalledOnce(); expect(cancel).toHaveBeenCalledTimes(2);
  });

  it('keeps a keep-alive comment flowing on a quiet event stream', async () => {
    let finish!: (value: { type: 'final'; output: number; usage: { costMicros: number } }) => void;
    const pending = new Promise<{ type: 'final'; output: number; usage: { costMicros: number } }>(resolve => { finish = resolve; });
    const value = server({ limits: { streamHeartbeatMs: 10, streamDurationMs: 200 } }, () => pending);
    const submitted = await json(await call(value, '/v1/runs', { method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': 'quiet' },
      body: JSON.stringify({ agentId: 'echo', input: 1 }) }));
    const text = await (await call(value, `/v1/runs/${submitted['id'] as string}/events`)).text();
    expect(text).toContain(': keep-alive\n\n'); expect(text).toContain('event: run.started');
    finish({ type: 'final', output: 1, usage: { costMicros: 0 } });
  });
});

describe('mounted behind a trusted proxy', () => {
  it('takes publicOrigin as the destination when mounted, and refuses other origins otherwise', async () => {
    const internal = 'http://agents.internal:3000';
    const plain = server();
    const refused = await plain.fetch(new Request(`${internal}/v1/agents`, { headers: { authorization: 'Bearer TOKEN' } }));
    expect(refused.status).toBe(400); expect((await json(refused))['error']).toMatchObject({ code: 'INVALID_DESTINATION', message: expect.stringContaining('mounted: true') });
    const mounted = server({ mounted: true });
    const accepted = await mounted.fetch(new Request(`${internal}/v1/agents`, { headers: { authorization: 'Bearer TOKEN', 'x-forwarded-host': 'evil.example' } }));
    expect(accepted.status).toBe(200); expect(await json(accepted)).toEqual({ agents: [{ id: 'echo', version: '1' }] });
    // A browser on the public origin is same-origin; any other origin still needs allowedOrigins.
    expect((await mounted.fetch(new Request(`${internal}/v1/agents`, { headers: { authorization: 'Bearer TOKEN', origin: publicOrigin } }))).status).toBe(200);
    expect((await mounted.fetch(new Request(`${internal}/v1/agents`, { headers: { authorization: 'Bearer TOKEN', origin: internal } }))).status).toBe(403);
    // A path cannot smuggle in another authority, and credentials in the URL are still refused.
    expect((await mounted.fetch(new Request(`${internal}//evil.example/v1/agents`, { headers: { authorization: 'Bearer TOKEN' } }))).status).toBe(404);
    expect(() => server({ mounted: 'yes' as never })).toThrow();
  });

  it('reports the token\'s own session and the optional APIs it can use', async () => {
    let supplied = identity({ capabilities: ['runs:read'] });
    const value = server({ authenticate: async () => supplied, workflowViews: { inspect: async () => null },
      humanRequests: { list: async () => ({ items: [], next: null }), inspect: async () => null, respond: async () => { throw new Error('unused'); } } });
    expect(await json(await call(value, '/v1/session'))).toEqual({ session: { scope: { principalId: 'alice', projectId: 'project' }, agentIds: ['echo'],
      capabilities: ['runs:read'], expiresAtMs: supplied.expiresAtMs, features: [] } });
    supplied = identity({ capabilities: ['workflows:read', 'humans:read'] });
    expect((await json(await call(value, '/v1/session')))['session']).toMatchObject({ features: ['humanRequests', 'workflowViews'] });
    supplied = identity({ capabilities: [] }); expect((await call(value, '/v1/session')).status).toBe(200);
    expect((await json(await call(value, '/v1/session?x=1')))['error']).toMatchObject({ code: 'INVALID_QUERY' });
  });
});
