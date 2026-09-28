import { afterEach, describe, expect, it, vi } from 'vitest';
import { createClient, ClientError, type ClientOptions } from '../src/index.js';
import { createAgentServer, type AgentServer, type ServerIdentity } from '../../server/src/index.js';
import { defineAgent } from '../../runtime/dist/index.js';
import type { Schema } from '../../core/src/index.js';

const origin = 'https://mayura.test';
const servers: AgentServer[] = [];
afterEach(async () => { await Promise.all(servers.splice(0).map(server => server.close())); });
const jsonResponse = (value: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json', ...headers } });
function fake(response: () => Response | Promise<Response>, options: Partial<ClientOptions> = {}) {
  return createClient({ baseUrl: origin, token: () => 'test-token', fetch: vi.fn<typeof fetch>(async () => response()), ...options });
}
const schema: Schema<unknown> = { '~standard': { version: 1, vendor: 'fixture', validate: value => ({ value }) } };
function real(identity: () => ServerIdentity | null, options: { maxBodyBytes?: number } = {}) {
  const agent = defineAgent({ id: 'fixture.agent', version: '1', instructions: 'Fixture.', input: schema, output: schema, tools: [],
    model: { id: 'fixture.model', capabilities: { tools: true, structuredOutput: true }, maxCostMicros: 0, generate: async () => ({ type: 'final', output: 1, usage: { costMicros: 0 } }) } });
  const server = createAgentServer({ publicOrigin: origin, agents: [{ agent, permissions: { allow: ['model:fixture.model'] } }], authenticate: async () => identity(),
    ...(options.maxBodyBytes ? { limits: { maxBodyBytes: options.maxBodyBytes } } : {}) });
  servers.push(server);
  return createClient({ baseUrl: origin, token: () => 'test-token', fetch: async (input, init) => server.fetch(new Request(input, init)) });
}
const person = (overrides: Partial<ServerIdentity> = {}): ServerIdentity => ({ scope: { principalId: 'dev', projectId: 'project' }, agentIds: ['fixture.agent'],
  capabilities: ['runs:read', 'runs:submit'], expiresAtMs: Date.now() + 60_000, ...overrides });

describe('ClientError carries the server\'s precise code', () => {
  it('tells apart the answers that used to be one HTTP_ERROR', async () => {
    let identity: ServerIdentity | null = person();
    const client = real(() => identity);
    const run = await client.submit('fixture.agent', 1, { idempotencyKey: 'key-1' });
    await expect(client.submit('fixture.agent', 2, { idempotencyKey: 'key-1' })).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT', status: 409,
      message: expect.stringContaining('Idempotency-Key was already used') });
    await expect(client.submit('missing.agent', 1, { idempotencyKey: 'key-2' })).rejects.toMatchObject({ code: 'AGENT_NOT_FOUND', status: 404 });
    await expect(client.run('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb').inspect()).rejects.toMatchObject({ code: 'RUN_NOT_FOUND', status: 404 });
    await expect(run.cancel()).rejects.toMatchObject({ code: 'CAPABILITY_REQUIRED', status: 403, details: { capability: 'runs:cancel' } });
    await expect(client.workflows()).rejects.toMatchObject({ code: 'CAPABILITY_REQUIRED', details: { capability: 'workflows:read' } });
    identity = person({ capabilities: ['runs:read', 'runs:submit', 'workflows:read'] });
    await expect(client.workflows()).rejects.toMatchObject({ code: 'NOT_ENABLED', status: 404, details: { option: 'workflowIndex' } });
    identity = null; await expect(client.agents()).rejects.toMatchObject({ code: 'AUTH_INVALID', status: 401 });
    identity = person({ expiresAtMs: 1 }); await expect(client.agents()).rejects.toMatchObject({ code: 'AUTH_EXPIRED', status: 401 });
    identity = person({ scope: { principalId: 'auth0|user', projectId: 'project' } });
    await expect(client.agents()).rejects.toMatchObject({ code: 'IDENTITY_INVALID', status: 500, message: expect.stringContaining('principalId') });
    const small = real(() => person(), { maxBodyBytes: 32 });
    await expect(small.submit('fixture.agent', 'x'.repeat(64), { idempotencyKey: 'big' })).rejects.toMatchObject({ code: 'BODY_TOO_LARGE', status: 413, details: { limitBytes: 32 } });
  });

  it('keeps retry hints and revision facts, validated', async () => {
    const limited = await fake(() => jsonResponse({ error: { code: 'RUN_LIMIT', message: 'The server holds as many runs as it allows (maxRuns).', retryAfterMs: 1_000 } }, 429))
      .agents().then(() => { throw new Error('expected a failure'); }, (error: unknown) => error as ClientError);
    expect(limited).toBeInstanceOf(ClientError); expect(limited).toMatchObject({ code: 'RUN_LIMIT', status: 429, retryAfterMs: 1_000, details: { retryAfterMs: 1_000 } });
    // Retry-After is used when the body has no hint.
    expect(await fake(() => jsonResponse({ error: { code: 'SERVER_CLOSED', message: 'Closing.' } }, 503, { 'Retry-After': '3' })).agents().catch(error => error))
      .toMatchObject({ code: 'SERVER_CLOSED', retryAfterMs: 3_000 });
    const conflict = await fake(() => jsonResponse({ error: { code: 'WORKFLOW_CONFLICT', message: 'Changed.', currentRevision: 7 } }, 409))
      .cancelWorkflow('a'.repeat(64), 5, { commandId: 'cancel-1' }).catch(error => error as ClientError);
    expect(conflict).toMatchObject({ code: 'WORKFLOW_CONFLICT', details: { currentRevision: 7 } });
    // Unknown or malformed facts are dropped, never passed on.
    const odd = await fake(() => jsonResponse({ error: { code: 'CAPABILITY_REQUIRED', message: 'Nope.', capability: 'admin:all', retryAfterMs: -1, currentRevision: 'x', extra: 'PRIVATE' } }, 403))
      .agents().then(() => { throw new Error('expected a failure'); }, (error: unknown) => error as ClientError);
    expect(odd.details).toEqual({}); expect(odd.retryAfterMs).toBeUndefined(); expect(JSON.stringify(odd)).not.toContain('PRIVATE');
  });

  it('never passes through an unknown code or unprintable message', async () => {
    for (const [body, status] of [
      [{ error: { code: 'PRIVATE_THING', message: 'PRIVATE key' } }, 500], [{ error: { code: 'auth_required' } }, 401], [{ error: 'AUTH_REQUIRED' }, 401],
      [{ message: 'PRIVATE' }, 502], ['PRIVATE', 502],
    ] as const) {
      const error = await fake(() => jsonResponse(body, status)).agents().catch(value => value as ClientError);
      expect(error).toMatchObject({ code: 'HTTP_ERROR', status }); expect(String(error)).not.toContain('PRIVATE');
    }
    const html = await fake(() => new Response('<html>PRIVATE proxy page</html>', { status: 502, headers: { 'Content-Type': 'text/html' } })).agents().catch(value => value as ClientError);
    expect(html).toMatchObject({ code: 'HTTP_ERROR', status: 502 }); expect(String(html)).not.toContain('PRIVATE');
    const escape = await fake(() => jsonResponse({ error: { code: 'AUTH_INVALID', message: 'Visit \u001b[31mPRIVATE\u001b[0m' } }, 401)).agents()
      .then(() => { throw new Error('expected a failure'); }, (value: unknown) => value as ClientError);
    expect(escape).toMatchObject({ code: 'AUTH_INVALID', status: 401 }); expect(escape.message).not.toContain('PRIVATE');
    const huge = await fake(() => jsonResponse({ error: { code: 'AUTH_INVALID', message: 'x'.repeat(20_000) } }, 401)).agents().catch(value => value as ClientError);
    expect(huge).toMatchObject({ code: 'HTTP_ERROR', status: 401 });
  });

  it('gives transport failures their own codes', async () => {
    await expect(fake(() => { throw new Error('PRIVATE socket'); }).agents()).rejects.toMatchObject({ code: 'TRANSPORT_FAILED', status: undefined });
    await expect(fake(() => new Promise<Response>(() => {}), { requestTimeoutMs: 20 }).agents()).rejects.toMatchObject({ code: 'TIMEOUT' });
    const controller = new AbortController(); const pending = fake(() => new Promise<Response>(() => {})).agents({ signal: controller.signal }); controller.abort();
    await expect(pending).rejects.toMatchObject({ code: 'ABORTED' });
    await expect(fake(() => new Response('{bad', { headers: { 'Content-Type': 'application/json' } })).agents()).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
    const error = new ClientError('TIMEOUT'); expect(error.message).toContain('requestTimeoutMs'); expect(Object.isFrozen(error)).toBe(true);
  });

  it('reads the token\'s own session and the APIs the server offers it', async () => {
    const client = real(() => person());
    expect(await client.session()).toEqual({ scope: { principalId: 'dev', projectId: 'project' }, agentIds: ['fixture.agent'], capabilities: ['runs:read', 'runs:submit'],
      expiresAtMs: expect.any(Number), features: [] });
    await expect(fake(() => jsonResponse({ session: { scope: { principalId: 'dev', projectId: 'p' }, agentIds: [], capabilities: ['admin'], expiresAtMs: 1, features: [] } })).session())
      .rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
  });
});
