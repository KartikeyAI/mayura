import { afterEach, describe, expect, it } from 'vitest';
import { publicError, type Schema } from '@mayura/core';
import { defineAgent } from '../../runtime/dist/index.js';
import { createAgentServer, type AgentServer, type ServerIdentity } from '../../server/src/index.js';
import { cancelRun, cancelWorkflow, inspectRun, inspectWorkflows, waitForRun } from '../src/index.js';

const publicOrigin = 'https://agents.example.test';
const schema: Schema<unknown> = { '~standard': { version: 1, vendor: 'test', validate: value => ({ value }) } };
const servers: AgentServer[] = [];
afterEach(async () => { await Promise.all(servers.splice(0).map(server => server.close())); });

function operational(identity: () => ServerIdentity) {
  const agent = defineAgent({ id: 'echo', version: '1', instructions: 'Fixture.', tools: [], input: schema, output: schema,
    model: { id: 'fixture', capabilities: { tools: true, structuredOutput: true }, maxCostMicros: 0, generate: async () => ({ type: 'final', output: 'PRIVATE OUTPUT', usage: { costMicros: 0 } }) } });
  const server = createAgentServer({ publicOrigin, agents: [{ agent, permissions: { allow: ['model:fixture'] } }], authenticate: async () => identity(),
    workflowControls: { cancel: async () => ({ status: 'conflict' }), approve: async () => ({ status: 'conflict' }) } });
  servers.push(server);
  return { server, settings: { baseUrl: publicOrigin, token: () => 'TOKEN_PRIVATE', fetch: async (input: string | URL | Request, init?: RequestInit) => server.fetch(new Request(input, init)) } };
}
const person = (capabilities: ServerIdentity['capabilities']): ServerIdentity => ({ scope: { principalId: 'ops', projectId: 'project' }, agentIds: ['echo'], capabilities,
  expiresAtMs: Date.now() + 60_000 });

describe('operational commands surface the server\'s precise error', () => {
  it('reports the server code, status and message next to the stable class', async () => {
    let identity = person(['runs:read', 'runs:submit']);
    const { server, settings } = operational(() => identity);
    const missing = await inspectRun(settings, 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa').then(() => { throw new Error('expected a failure'); }, (error: unknown) => error as Error);
    expect(missing).toMatchObject({ code: 'NOT_FOUND', serverCode: 'RUN_NOT_FOUND', status: 404, message: expect.stringContaining('HTTP 404 RUN_NOT_FOUND') });
    expect(publicError(missing)).toMatchObject({ code: 'NOT_FOUND', serverCode: 'RUN_NOT_FOUND', status: 404 });
    const denied = await inspectWorkflows(settings).catch(error => error as Error);
    expect(denied).toMatchObject({ code: 'PERMISSION_DENIED', serverCode: 'CAPABILITY_REQUIRED', capability: 'workflows:read' });
    expect(publicError(denied)).toMatchObject({ capability: 'workflows:read' });
    identity = person(['workflows:control']);
    expect(await cancelWorkflow(settings, { id: 'a'.repeat(64), revision: 1, commandId: 'cancel-1' }).catch(error => error)).toMatchObject({ code: 'CONFLICT', serverCode: 'WORKFLOW_CONFLICT' });
    // A run read from a real server has exactly the fields the CLI shows, and never its output.
    identity = person(['runs:read', 'runs:submit', 'runs:cancel']);
    const submitted = await server.fetch(new Request(`${publicOrigin}/v1/runs`, { method: 'POST', headers: { authorization: 'Bearer T', 'content-type': 'application/json',
      'idempotency-key': 'cli-1' }, body: JSON.stringify({ agentId: 'echo', input: 1 }) }));
    const { id } = await submitted.json() as { id: string };
    const finished = await waitForRun(settings, id, { pollIntervalMs: 250, maxWaitMs: 5_000 });
    expect(finished).toMatchObject({ id, status: 'succeeded' }); expect(JSON.stringify(finished)).not.toContain('PRIVATE');
    await cancelRun(settings, id);
  });

  it('keeps unknown or unsafe error bodies out of its output', async () => {
    const reply = (body: string, status: number, type = 'application/json') => ({ baseUrl: publicOrigin, token: () => 'TOKEN_PRIVATE',
      fetch: async () => new Response(body, { status, headers: { 'content-type': type } }) });
    const escape = await inspectRun(reply(JSON.stringify({ error: { code: 'AUTH_INVALID', message: '\u001b]0;PRIVATE\u0007' } }), 401), 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa').then(() => { throw new Error('expected a failure'); }, (error: unknown) => error as Error);
    expect(escape).toMatchObject({ code: 'PERMISSION_DENIED', serverCode: 'AUTH_INVALID' }); expect(escape.message).not.toContain('PRIVATE');
    const html = await inspectRun(reply('<p>PRIVATE</p>', 502, 'text/html'), 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa').then(() => { throw new Error('expected a failure'); }, (error: unknown) => error as Error);
    expect(html).toMatchObject({ code: 'TOOL_FAILED', serverCode: null, status: 502 }); expect(html.message).not.toContain('PRIVATE');
    const odd = await inspectRun(reply(JSON.stringify({ error: { code: 'lower case', message: 'PRIVATE' } }), 429), 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa').then(() => { throw new Error('expected a failure'); }, (error: unknown) => error as Error);
    expect(odd).toMatchObject({ code: 'LIMIT_EXCEEDED', serverCode: null }); expect(JSON.stringify(publicError(odd))).not.toContain('PRIVATE');
    const lost = await inspectRun(reply(JSON.stringify({ error: { code: 'SUBMISSION_OUTCOME_UNKNOWN', message: 'Unknown.' } }), 409), 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa').catch(error => error);
    expect(lost).toMatchObject({ code: 'OUTCOME_UNKNOWN', serverCode: 'SUBMISSION_OUTCOME_UNKNOWN' });
  });
});
