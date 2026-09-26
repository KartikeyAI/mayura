import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFile } from 'node:fs/promises';
import { createClient, ClientError, escapeHtmlText, type ClientEvent, type ClientJson, type ClientOptions, type ClientSchema } from '../src/index.js';
import { createAgentServer, type AgentServer, type AgentServerOptions } from '../../server/src/index.js';
import { createWorkflowGraphProjection } from '../src/workflows.js';
import { defineAgent } from '../../runtime/dist/index.js';
import { defineTool } from '../../tools/dist/index.js';
import { createSqliteStore } from '../../storage/dist/index.js';
import { createWorkflowFleetControl, lifecycleFleetTarget } from '../../workflows/dist/index.js';
import { createWorkflowLifecycleFleetRuntime, defineWorkflowLifecycle } from '../../workflows/dist/lifecycle.js';
import { MayuraError } from '../../core/dist/index.js';
import type { Guard, JsonValue, ModelAdapter, ModelResponse, Schema } from '../../core/src/index.js';

const origin = 'https://mayura.test';
const id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const encoder = new TextEncoder();
const numberSchema: Schema<number> = { '~standard': { version: 1, vendor: 'fixture', validate: value => typeof value === 'number' ? { value } : { issues: [{ message: 'number required' }] } } };
const identitySchema: ClientSchema<unknown> = { '~standard': { version: 1, validate: value => ({ value }) } };
const servers: AgentServer[] = [];
afterEach(async () => { await Promise.all(servers.splice(0).map(server => server.close())); vi.useRealTimers(); });

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void; let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
async function collect<T>(source: AsyncIterable<T>): Promise<T[]> { const values: T[] = []; for await (const value of source) values.push(value); return values; }
function final(output: JsonValue): ModelResponse { return { type: 'final', output, usage: { costMicros: 0 } }; }
function jsonResponse(value: unknown, status = 200) { return new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } }); }
function remoteSnapshot(overrides: Record<string, unknown> = {}) {
  return { id, status: 'succeeded', budget: { spentMicros: 0, reservedMicros: 0, calls: 1 }, evidence: [], outcome: { status: 'succeeded', output: 4 }, ...overrides };
}
function fakeClient(response: () => Response | Promise<Response>, options: Partial<ClientOptions> = {}) {
  const transport = vi.fn<typeof fetch>(async () => response());
  return { client: createClient({ baseUrl: origin, token: () => 'test-token', fetch: transport, ...options }), transport };
}
function fixture(options: {
  responses?: ModelResponse[]; generate?: ModelAdapter['generate']; output?: Schema; guards?: readonly Guard[];
  authenticate?: AgentServerOptions['authenticate']; limits?: AgentServerOptions['limits']; useTool?: boolean; humanRequests?: AgentServerOptions['humanRequests'];
  workflowViews?: AgentServerOptions['workflowViews'];
  workflowIndex?: AgentServerOptions['workflowIndex'];
  workflowControls?: AgentServerOptions['workflowControls'];
  workflowSignals?: AgentServerOptions['workflowSignals'];
  workflowResumes?: AgentServerOptions['workflowResumes'];
  workflowPauses?: AgentServerOptions['workflowPauses'];
  workflowFleet?: AgentServerOptions['workflowFleet'];
} = {}) {
  let index = 0;
  const generate = vi.fn<ModelAdapter['generate']>(options.generate ?? (async () => (options.responses ?? [final(4)])[index++]!));
  const effect = vi.fn((input: number) => input * 2);
  const tool = defineTool({ id: 'fixture.write', version: '1', description: 'Controlled fixture effect', input: numberSchema, output: numberSchema, effects: 'write', capabilities: [], execute: effect });
  const agent = defineAgent({ id: 'fixture.agent', version: '1', instructions: 'PRIVATE SYSTEM PROMPT',
    input: numberSchema, output: options.output ?? numberSchema,
    model: { id: 'fixture.model', capabilities: { tools: true, structuredOutput: true }, maxCostMicros: 0, generate },
    tools: options.useTool ? [tool] : [], ...(options.guards ? { guards: { output: options.guards } } : {}),
  });
  const server = createAgentServer({ publicOrigin: origin, agents: [{ agent, permissions: { allow: ['model:fixture.model','tool:fixture.write','effect:write'] } }],
    authenticate: options.authenticate ?? (async ({ token }) => token === 'test-token' ? {
      scope: { principalId: 'developer', projectId: 'project' }, agentIds: [agent.id], capabilities: ['runs:read','runs:submit','runs:cancel','humans:read','humans:respond','workflows:read','workflows:control','workflows:fleet'], expiresAtMs: Date.now() + 60_000,
    } : null), ...(options.limits ? { limits: options.limits } : {}), ...(options.humanRequests ? { humanRequests: options.humanRequests } : {}),
    ...(options.workflowViews ? { workflowViews: options.workflowViews } : {}),
    ...(options.workflowIndex ? { workflowIndex: options.workflowIndex } : {}),
    ...(options.workflowControls ? { workflowControls: options.workflowControls } : {}),
    ...(options.workflowSignals ? { workflowSignals: options.workflowSignals } : {}),
    ...(options.workflowResumes ? { workflowResumes: options.workflowResumes } : {}),
    ...(options.workflowPauses ? { workflowPauses: options.workflowPauses } : {}),
    ...(options.workflowFleet ? { workflowFleet: options.workflowFleet } : {}),
  });
  servers.push(server);
  const transport = vi.fn<typeof fetch>(async (input, init) => server.fetch(new Request(input, init)));
  const client = createClient({ baseUrl: origin, token: () => 'test-token', fetch: transport });
  return { server, client, transport, generate, effect };
}
function event(sequence: number, type: ClientEvent['type'] = 'model.completed', metadata: Record<string, string | number | boolean> = {}): ClientEvent {
  return { runId: id, sequence, type, timestamp: '2026-09-20T00:00:00.000Z', metadata };
}
function frame(value: ClientEvent, newline = '\n'): string {
  return `id: ${value.sequence}${newline}event: ${value.type}${newline}data: ${JSON.stringify(value)}${newline}${newline}`;
}
function stream(chunks: readonly Uint8Array[], cancel = vi.fn()): Response {
  let index = 0;
  return new Response(new ReadableStream<Uint8Array>({
    pull(controller) { if (index === chunks.length) controller.close(); else controller.enqueue(chunks[index++]!); },
    cancel,
  }, { highWaterMark: 0 }), { headers: { 'Content-Type': 'text/event-stream' } });
}

describe('browser client against actual authenticated server Fetch facade', () => {
  it('sends explicit bearer credentials, omits cookies, denies redirects and uses exact request paths', async () => {
    const { client, transport } = fixture();
    expect(await client.agents()).toEqual([{ id: 'fixture.agent', version: '1' }]);
    const run = await client.submit('fixture.agent', 2, { idempotencyKey: 'request-1' });
    await collect(run.events());
    const result = await run.result(numberSchema);
    expect(result).toEqual({ status: 'succeeded', output: 4, evidence: [] });
    for (const [url, options] of transport.mock.calls) {
      expect(new URL(String(url)).origin).toBe(origin);
      expect(options).toMatchObject({ redirect: 'error', credentials: 'omit', cache: 'no-store' });
      expect(new Headers(options?.headers).get('authorization')).toBe('Bearer test-token');
      expect(new Headers(options?.headers).has('cookie')).toBe(false);
    }
    const submit = transport.mock.calls.find(([, options]) => options?.method === 'POST')!;
    expect(new URL(String(submit[0])).pathname).toBe('/v1/runs');
    expect(new Headers(submit[1]?.headers).get('idempotency-key')).toBe('request-1');
    expect(JSON.parse(submit[1]?.body as string)).toEqual({ agentId: 'fixture.agent', input: 2 });
  });

  it('validates the wire output and preserves an explicit client-side transformation', async () => {
    const serverOutput: Schema<number, string> = { '~standard': { version: 1, vendor: 'fixture', validate: value => typeof value === 'number' ? { value: String(value) } : { issues: [] } } };
    const { client } = fixture({ output: serverOutput, responses: [final(12)] });
    const run = await client.submit('fixture.agent', 2, { idempotencyKey: 'transformed' }); await collect(run.events());
    const wireSchema: ClientSchema<{ count: number }> = { '~standard': { version: 1, validate: value => typeof value === 'string' ? { value: { count: Number(value) } } : { issues: [] } } };
    const result = await run.result(wireSchema);
    expect(result).toEqual({ status: 'succeeded', output: { count: 12 }, evidence: [] });
    if (result?.status === 'succeeded') expect(Object.isFrozen(result.output)).toBe(true);
  });

  it('preserves terminal successful-effect evidence when guards block disclosure', async () => {
    const { client, effect } = fixture({ useTool: true, responses: [{ type: 'tool_calls', calls: [{ id: 'call-1', toolId: 'fixture.write', input: 2 }], usage: { costMicros: 0 } }],
      guards: [{ id: 'deny', check: () => ({ decision: 'block', reason: 'PRIVATE DENIAL DETAILS' }) }],
    });
    const run = await client.submit('fixture.agent', 2, { idempotencyKey: 'blocked' }); await collect(run.events());
    const result = await run.result(identitySchema); const inspected = await run.inspect();
    expect(result).toMatchObject({ status: 'blocked', error: { code: 'GUARD_BLOCKED' }, evidence: [{ receipt: { execution: 'succeeded', disclosure: 'withheld' } }] });
    expect(inspected.evidence).toEqual(result?.evidence); expect(effect).toHaveBeenCalledOnce();
    expect(JSON.stringify(result)).not.toMatch(/PRIVATE|SYSTEM PROMPT/);
  });

  it('keeps successful released effect evidence in both the result and inspection', async () => {
    const { client, effect } = fixture({ useTool: true, responses: [
      { type: 'tool_calls', calls: [{ id: 'call-1', toolId: 'fixture.write', input: 2 }], usage: { costMicros: 0 } }, final(4),
    ] });
    const run = await client.submit('fixture.agent', 2, { idempotencyKey: 'released' }); await collect(run.events());
    const result = await run.result(numberSchema); const inspected = await run.inspect();
    expect(result).toMatchObject({ status: 'succeeded', output: 4, evidence: [{ runId: run.id, receipt: { callId: 'call-1', toolId: 'fixture.write', execution: 'succeeded', disclosure: 'released' } }] });
    expect(inspected.evidence).toEqual(result?.evidence); expect(effect).toHaveBeenCalledOnce();
    expect(Object.isFrozen(result?.evidence[0]?.receipt)).toBe(true);
  });

  it('never retries an ambiguously accepted command; an explicit identical retry is deduplicated by the server', async () => {
    const { server, generate } = fixture(); let first = true; let acceptedId = '';
    const transport = vi.fn<typeof fetch>(async (url, options) => {
      const response = await server.fetch(new Request(url, options));
      if (first) { first = false; acceptedId = (await response.clone().json() as { id: string }).id; throw new Error('PRIVATE NETWORK DETAILS'); }
      return response;
    });
    const client = createClient({ baseUrl: origin, token: () => 'test-token', fetch: transport });
    await expect(client.submit('fixture.agent', 2, { idempotencyKey: 'ambiguous' })).rejects.toMatchObject({ code: 'TRANSPORT_FAILED' });
    expect(transport).toHaveBeenCalledOnce();
    const retried = await client.submit('fixture.agent', 2, { idempotencyKey: 'ambiguous' });
    expect(retried.id).toBe(acceptedId); await collect(retried.events()); expect(generate).toHaveBeenCalledOnce();
  });

  it('returns undefined while running and sends cancellation without a command body', async () => {
    const started = deferred<void>(); const release = deferred<ModelResponse>();
    const { client, transport } = fixture({ generate: async () => { started.resolve(); return release.promise; } });
    const run = await client.submit('fixture.agent', 2, { idempotencyKey: 'cancel' }); await started.promise;
    expect(await run.result(numberSchema)).toBeUndefined(); await run.cancel();
    const cancellation = transport.mock.calls.find(([url]) => String(url).endsWith('/cancel'))!;
    expect(cancellation[1]?.method).toBe('POST'); expect(cancellation[1]?.body).toBeUndefined();
    await collect(run.events()); expect(await run.result(numberSchema)).toMatchObject({ status: 'cancelled' });
    release.resolve(final(4));
  });

  it('aborting only an observer does not cancel its running agent', async () => {
    const started = deferred<void>(); const release = deferred<ModelResponse>();
    const { client, transport } = fixture({ generate: async () => { started.resolve(); return release.promise; } });
    const run = await client.submit('fixture.agent', 2, { idempotencyKey: 'observe' }); await started.promise;
    const iterator = run.events()[Symbol.asyncIterator](); expect((await iterator.next()).value?.type).toBe('run.started');
    await iterator.return?.(); expect((await run.inspect()).status).toBe('running');
    expect(transport.mock.calls.some(([url]) => String(url).endsWith('/cancel'))).toBe(false);
    release.resolve(final(4));
  });

  it('rejects server body-limit failure without retry or model dispatch', async () => {
    const { client, generate, transport } = fixture({ limits: { maxBodyBytes: 16 } });
    await expect(client.submit('fixture.agent', 2, { idempotencyKey: 'too-large' })).rejects.toMatchObject({ code: 'HTTP_ERROR', status: 413 });
    expect(transport).toHaveBeenCalledOnce(); expect(generate).not.toHaveBeenCalled();
  });

  it('withholds authentication exception text across the actual boundary', async () => {
    const { client, generate } = fixture({ authenticate: async () => { throw new Error('PRIVATE TOKEN DATABASE PASSWORD'); } });
    const error = await client.agents().catch(value => value as Error);
    expect(error).toMatchObject({ code: 'HTTP_ERROR', status: 503 }); expect(String(error)).not.toContain('PRIVATE'); expect(generate).not.toHaveBeenCalled();
  });
});

describe('browser human request client', () => {
  const digest = 'a'.repeat(64); const request = { id: 'review', agentId: 'fixture.agent', kind: 'information' as const, schemaId: 'text-v1',
    schemaDigest: 'b'.repeat(64), prompt: 'Provide deployment evidence.', digest, status: 'waiting' as const };

  it('lists, inspects and submits a digest-bound typed value through the authenticated facade', async () => {
    const respond = vi.fn(async () => ({ ...request, status: 'answered' as const }));
    const { client } = fixture({ humanRequests: { list: async () => ({ items: [request], next: 'cursor-1' }), inspect: async () => request, respond } });
    expect(await client.humanRequests({ limit: 1 })).toEqual({ items: [request], next: 'cursor-1' });
    expect(await client.humanRequest('review')).toEqual(request);
    expect(await client.respondHumanRequest('review', digest, { evidence: true }, { commandId: 'answer-1' })).toEqual({ ...request, status: 'answered' });
    expect(respond).toHaveBeenCalledWith(expect.objectContaining({ actorId: 'developer', requestDigest: digest, value: { evidence: true } }));
  });

  it('rejects invalid local identifiers, cursors and hostile response fields', async () => {
    const { client } = fixture({ humanRequests: { list: async () => ({ items: [{ ...request, handler: 'PRIVATE' } as never], next: null }), inspect: async () => request, respond: async () => request } });
    await expect(client.humanRequest('../private')).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
    await expect(client.humanRequests({ limit: 101 })).rejects.toMatchObject({ code: 'INVALID_CURSOR' });
    await expect(client.humanRequests()).rejects.toMatchObject({ code: 'HTTP_ERROR', status: 503 });
  });
});

describe('browser durable workflow view client', () => {
  const runId = 'a'.repeat(64); const view = { format: 4 as const, definitionId: 'deployment', definitionVersion: '1', runId, revision: 2,
    status: 'running' as const, nodes: [{ id: 'prepare', kind: 'tool' as const, dependsOn: [] }, { id: 'child', kind: 'child' as const, dependsOn: ['prepare'] }],
    steps: [{ id: 'prepare', kind: 'tool' as const, status: 'succeeded' as const }, { id: 'child', kind: 'child' as const, status: 'waiting' as const, childRunId: 'b'.repeat(64) }] };

  it('reads an authenticated view and hands its deeply frozen data to the strict projector', async () => {
    const inspect = vi.fn(async () => view); const { client, transport } = fixture({ workflowViews: { inspect } });
    const received = await client.workflow(runId); expect(received).toEqual(view); expect(Object.isFrozen(received)).toBe(true); expect(Object.isFrozen(received.nodes[0])).toBe(true);
    expect(createWorkflowGraphProjection(received)).toMatchObject({ runId, nodes: [{ id: 'prepare', status: 'succeeded' }, { id: 'child', childRunId: 'b'.repeat(64) }] });
    expect(inspect).toHaveBeenCalledWith(expect.objectContaining({ runId, scope: { principalId: 'developer', projectId: 'project' } }));
    expect(new URL(String(transport.mock.calls[0]?.[0])).pathname).toBe(`/v1/workflow-runs/${runId}`);
  });

  it('rejects invalid local IDs and malformed workflow envelopes without retry', async () => {
    const { client, transport } = fakeClient(() => jsonResponse({ workflow: { ...view, privatePrompt: 'PRIVATE' } }));
    await expect(client.workflow('../private')).rejects.toMatchObject({ code: 'INVALID_REQUEST' }); expect(transport).not.toHaveBeenCalled();
    await expect(client.workflow(runId)).rejects.toMatchObject({ code: 'INVALID_RESPONSE' }); expect(transport).toHaveBeenCalledOnce();
  });

  it('sends exact cancellation and child-approval commands once through the authenticated facade', async () => {
    const cancel = vi.fn(async () => ({ status: 'applied' as const, workflow: { ...view, revision: 3, status: 'cancelled' as const } }));
    const approve = vi.fn(async () => ({ status: 'applied' as const, workflow: { ...view, revision: 3 } }));
    const { client, transport } = fixture({ workflowControls: { cancel, approve } });
    expect(await client.cancelWorkflow(runId, 2, { commandId: 'cancel-1' })).toMatchObject({ revision: 3, status: 'cancelled' });
    expect(await client.approveWorkflow(runId, { revision: 2, nodeId: 'child', approvalDigest: 'd'.repeat(64), childRunId: 'b'.repeat(64) },
      { commandId: 'approve-1' })).toMatchObject({ revision: 3 });
    expect(cancel).toHaveBeenCalledWith(expect.objectContaining({ actorId: 'developer', revision: 2, commandId: 'cancel-1' }));
    expect(approve).toHaveBeenCalledWith(expect.objectContaining({ actorId: 'developer', nodeId: 'child', childRunId: 'b'.repeat(64) }));
    const bodies = transport.mock.calls.map(([, options]) => options?.body && JSON.parse(options.body as string));
    expect(bodies).toEqual([{ commandId: 'cancel-1', revision: 2 }, { commandId: 'approve-1', revision: 2, nodeId: 'child', approvalDigest: 'd'.repeat(64), childRunId: 'b'.repeat(64) }]);
  });

  it('does not retry conflicts and rejects malformed mutation arguments before transport', async () => {
    const { client, transport } = fakeClient(() => jsonResponse({ error: { code: 'WORKFLOW_CONFLICT' } }, 409));
    await expect(client.cancelWorkflow(runId, 2, { commandId: 'cancel-1' })).rejects.toMatchObject({ code: 'HTTP_ERROR', status: 409 });
    expect(transport).toHaveBeenCalledOnce();
    await expect(client.approveWorkflow(runId, { revision: 0, nodeId: '../bad', approvalDigest: 'bad' }, { commandId: '' }))
      .rejects.toMatchObject({ code: 'INVALID_REQUEST' }); expect(transport).toHaveBeenCalledOnce();
  });

  it('delivers one exact revision-bound durable signal and rejects invalid or oversized input locally', async () => {
    const deliver = vi.fn(async () => ({ status: 'applied' as const, workflow: { ...view, revision: 3 } }));
    const { client, transport } = fixture({ workflowSignals: { deliver } });
    expect(await client.signalWorkflow(runId, { revision: 2, signalId: 'deployment.ready/1', signalName: 'deployment.ready', value: { ready: true } },
      { commandId: 'signal-command-1' })).toMatchObject({ revision: 3 });
    expect(deliver).toHaveBeenCalledWith(expect.objectContaining({ actorId: 'developer', revision: 2, commandId: 'signal-command-1',
      signalId: 'deployment.ready/1', signalName: 'deployment.ready', value: { ready: true } }));
    expect(JSON.parse(transport.mock.calls[0]![1]?.body as string)).toEqual({ commandId: 'signal-command-1', revision: 2,
      signalId: 'deployment.ready/1', signalName: 'deployment.ready', value: { ready: true } });
    await expect(client.signalWorkflow(runId, { revision: 2, signalId: '../bad', signalName: 'ready', value: true }, { commandId: 'signal-2' }))
      .rejects.toMatchObject({ code: 'INVALID_REQUEST' });
    await expect(client.signalWorkflow(runId, { revision: 2, signalId: 'ready', signalName: 'ready', value: 'x'.repeat(4097) }, { commandId: 'signal-2' }))
      .rejects.toMatchObject({ code: 'INVALID_REQUEST' });
    expect(transport).toHaveBeenCalledOnce();
  });

  it('requests durable continuation once and preserves conflict truth', async () => {
    const resume = vi.fn(async () => ({ status: 'applied' as const, workflow: { ...view, revision: 3 } }));
    const { client, transport } = fixture({ workflowResumes: { resume } });
    expect(await client.resumeWorkflow(runId, 2, { commandId: 'resume-1' })).toMatchObject({ revision: 3 });
    expect(resume).toHaveBeenCalledWith(expect.objectContaining({ actorId: 'developer', runId, revision: 2, commandId: 'resume-1' }));
    expect(JSON.parse(transport.mock.calls[0]![1]?.body as string)).toEqual({ commandId: 'resume-1', revision: 2 });
    const conflict = fakeClient(() => jsonResponse({ error: { code: 'WORKFLOW_CONFLICT' } }, 409));
    await expect(conflict.client.resumeWorkflow(runId, 2, { commandId: 'resume-1' })).rejects.toMatchObject({ code: 'HTTP_ERROR', status: 409 });
    expect(conflict.transport).toHaveBeenCalledOnce();
  });

  it('holds, sweeps and releases the fleet through the authenticated boundary', async () => {
    const runId2 = 'e'.repeat(64);
    const workflowFleet = {
      inspect: vi.fn(async () => ({ held: false, generation: 0, changedAtMs: null })),
      hold: vi.fn(async () => ({ held: true, generation: 1, changedAtMs: 10 })),
      release: vi.fn(async () => ({ held: false, generation: 1, changedAtMs: 20 })),
      sweep: vi.fn(async (input: { readonly cursor: unknown }) => ({ status: 'applied' as const, sweep: input.cursor === null
        ? { outcomes: [{ target: 'graphs', runId: runId2, outcome: 'paused' as const }], nextCursor: { next: 1 } }
        : { outcomes: [{ target: 'graphs', runId: runId2, outcome: 'failed' as const, code: 'CONFLICT' }], nextCursor: null } })),
    };
    const { client, transport } = fixture({ workflowFleet });
    expect(await client.workflowFleet()).toEqual({ held: false, generation: 0, changedAtMs: null });
    expect(await client.holdWorkflowFleet()).toMatchObject({ held: true, generation: 1 });
    const first = await client.sweepWorkflowFleet('pause', { cursor: null, limit: 4 });
    expect(first).toEqual({ outcomes: [{ target: 'graphs', runId: runId2, outcome: 'paused' }], nextCursor: { next: 1 } });
    expect((await client.sweepWorkflowFleet('pause', { cursor: first.nextCursor })).nextCursor).toBeNull();
    expect(workflowFleet.sweep).toHaveBeenLastCalledWith(expect.objectContaining({ phase: 'pause', cursor: { next: 1 }, limit: 32 }));
    expect((await client.releaseWorkflowFleet()).held).toBe(false);
    await expect(client.sweepWorkflowFleet('pause', { cursor: null, limit: 0 })).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
    await expect(client.sweepWorkflowFleet('drain' as never, { cursor: null })).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
    expect(transport).toHaveBeenCalledTimes(5);
    const conflict = fakeClient(() => jsonResponse({ error: { code: 'WORKFLOW_CONFLICT' } }, 409));
    await expect(conflict.client.sweepWorkflowFleet('resume', { cursor: null })).rejects.toMatchObject({ code: 'HTTP_ERROR', status: 409 });
    expect(conflict.transport).toHaveBeenCalledOnce();
    const lying = fakeClient(() => jsonResponse({ fleet: { held: false, generation: 0, changedAtMs: null } }));
    await expect(lying.client.holdWorkflowFleet()).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
  });

  it('pauses and resumes a real lifecycle fleet end to end through the authenticated adapter', async () => {
    const store = createSqliteStore({ filename: ':memory:' }); await store.initialize();
    try {
      const scope = { principalId: 'developer', projectId: 'project' };
      const any: Schema<JsonValue> = { '~standard': { version: 1, vendor: 'fleet-e2e', validate: value => ({ value: value as JsonValue }) } };
      const timer = defineWorkflowLifecycle({ id: 'e2e-timer', version: '1', input: any, output: any,
        nodes: [{ kind: 'timer', id: 'wake', fireAtMs: { kind: 'input', path: ['fireAtMs'] } }], result: { kind: 'step', stepId: 'wake', path: [] } });
      const runtime = createWorkflowLifecycleFleetRuntime({ store, scope, permissions: { allow: [] }, policyVersion: '1', maxCostMicros: 0, now: () => 100 });
      const run = await runtime.submit(timer, { input: { fireAtMs: 500 }, idempotencyKey: 'e2e' }); await runtime.runUntilSettled(timer, run.id);
      const control = createWorkflowFleetControl({ store, scope }); const targets = [lifecycleFleetTarget(runtime)];
      // The same adapter shape documented in docs/how-to/fleet-control.md.
      const workflowFleet: NonNullable<AgentServerOptions['workflowFleet']> = {
        inspect: () => control.inspect(), hold: () => control.hold(), release: () => control.release(),
        sweep: async ({ phase, cursor, limit }) => {
          try {
            const page = phase === 'pause' ? await control.sweepPause(targets, { cursor: cursor as never, limit })
              : await control.sweepResume(targets, { cursor: cursor as never, limit });
            return { status: 'applied', sweep: page as never };
          } catch (error) { if (error instanceof MayuraError && error.code === 'CONFLICT') return { status: 'conflict' }; throw error; }
        },
      };
      const { client } = fixture({ workflowFleet });
      const drain = async (phase: 'pause' | 'resume') => {
        const outcomes: unknown[] = []; let cursor: ClientJson | null = null; let pages = 0;
        do { const page = await client.sweepWorkflowFleet(phase, { cursor, limit: 64 }); outcomes.push(...page.outcomes); cursor = page.nextCursor; pages++; } while (cursor && pages < 600);
        return outcomes;
      };
      await expect(client.sweepWorkflowFleet('pause', { cursor: null })).rejects.toMatchObject({ status: 409 });
      expect(await client.holdWorkflowFleet()).toMatchObject({ held: true, generation: 1 });
      expect(await drain('pause')).toEqual([{ target: 'lifecycle', runId: run.id, outcome: 'paused' }]);
      expect((await runtime.inspect(run.id)).status).toBe('paused');
      await expect(client.sweepWorkflowFleet('resume', { cursor: null })).rejects.toMatchObject({ status: 409 });
      expect((await client.releaseWorkflowFleet()).held).toBe(false);
      expect(await drain('resume')).toEqual([{ target: 'lifecycle', runId: run.id, outcome: 'resumed' }]);
      expect((await runtime.inspect(run.id)).status).toBe('waiting'); expect(await client.workflowFleet()).toMatchObject({ held: false, generation: 1 });
      runtime.close();
    } finally { await store.close(); }
  });

  it('requests one operator pause and never retries a conflict', async () => {
    const pause = vi.fn(async () => ({ status: 'applied' as const, workflow: { ...view, revision: 3, status: 'paused' as const } }));
    const { client, transport } = fixture({ workflowPauses: { pause } });
    expect(await client.pauseWorkflow(runId, 2, { commandId: 'pause-1' })).toMatchObject({ revision: 3, status: 'paused' });
    expect(pause).toHaveBeenCalledWith(expect.objectContaining({ actorId: 'developer', runId, revision: 2, commandId: 'pause-1' }));
    expect(JSON.parse(transport.mock.calls[0]![1]?.body as string)).toEqual({ commandId: 'pause-1', revision: 2 });
    expect(String(transport.mock.calls[0]![0])).toMatch(new RegExp(`/v1/workflow-runs/${runId}/pause$`));
    const conflict = fakeClient(() => jsonResponse({ error: { code: 'WORKFLOW_CONFLICT' } }, 409));
    await expect(conflict.client.pauseWorkflow(runId, 2, { commandId: 'pause-1' })).rejects.toMatchObject({ code: 'HTTP_ERROR', status: 409 });
    expect(conflict.transport).toHaveBeenCalledOnce();
    await expect(client.pauseWorkflow(runId, 0, { commandId: 'pause-1' })).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
  });
});

describe('browser durable workflow index client', () => {
  const indexedRunId = 'a'.repeat(64);
  it('reads one explicit authenticated page without following its cursor', async () => {
    const item = Object.freeze({ format: 4 as const, definitionId: 'workflow', definitionVersion: '1', runId: indexedRunId, revision: 2, status: 'running' as const });
    const list = vi.fn(async () => ({ items: [item], next: 'cursor-2' })); const { client, transport } = fixture({ workflowIndex: { list } });
    const page = await client.workflows({ after: 'cursor-1', limit: 5 }); expect(page).toEqual({ items: [item], next: 'cursor-2' });
    expect(Object.isFrozen(page)).toBe(true); expect(Object.isFrozen(page.items)).toBe(true); expect(list).toHaveBeenCalledOnce(); expect(transport).toHaveBeenCalledOnce();
    expect(new URL(String(transport.mock.calls[0]?.[0])).searchParams.get('after')).toBe('cursor-1');
  });

  it('rejects malformed local pagination and duplicate or private summaries without retry', async () => {
    const item = Object.freeze({ format: 4, definitionId: 'workflow', definitionVersion: '1', runId: indexedRunId, revision: 2, status: 'running' });
    const { client, transport } = fakeClient(() => jsonResponse({ items: [item, { ...item, privatePrompt: 'PRIVATE' }], next: null }));
    await expect(client.workflows({ after: '../bad', limit: 101 })).rejects.toMatchObject({ code: 'INVALID_REQUEST' }); expect(transport).not.toHaveBeenCalled();
    await expect(client.workflows({ limit: 2 })).rejects.toMatchObject({ code: 'INVALID_RESPONSE' }); expect(transport).toHaveBeenCalledOnce();
  });
});

describe('client response admission and safe failures', () => {
  it('V16 keeps hostile output as data and provides bounded HTML text encoding', async () => {
    const hostile = `<img src=x onerror="globalThis.pwned=true">&'`;
    const { client } = fakeClient(() => jsonResponse(remoteSnapshot({ outcome: { status: 'succeeded', output: hostile, evidence: [] } })));
    const outcome = await client.run(id).result(identitySchema);
    expect(outcome).toMatchObject({ status: 'succeeded', output: hostile });
    expect(escapeHtmlText(hostile)).toBe('&lt;img src=x onerror=&quot;globalThis.pwned=true&quot;&gt;&amp;&#39;');
    expect(() => escapeHtmlText('xx', 1)).toThrow(expect.objectContaining({ code: 'RESPONSE_LIMIT' }));
  });

  it.each(['file:///private', 'https://user:secret@mayura.test', `${origin}/nested`, `${origin}/?token=secret`, `${origin}/#secret`])('rejects unsafe configuration %s', baseUrl => {
    expect(() => createClient({ baseUrl, token: () => 'token' })).toThrow(ClientError);
  });
  it.each(['bad token', 'token\r\nInjected: true', '', 'x'.repeat(8193)])('rejects invalid credential %# before transport', async token => {
    const { client, transport } = fakeClient(() => jsonResponse({ agents: [] }), { token: () => token });
    await expect(client.agents()).rejects.toMatchObject({ code: 'INVALID_CREDENTIAL' }); expect(transport).not.toHaveBeenCalled();
  });
  it.each([undefined, NaN, Infinity, new Date(), { value: undefined }, { get secret() { throw new Error('PRIVATE'); } }])('rejects unsupported request JSON %# before transport', async value => {
    const { client, transport } = fakeClient(() => jsonResponse({ id, profile: 'ephemeral' }));
    await expect(client.submit('fixture.agent', value, { idempotencyKey: 'json' })).rejects.toMatchObject({ code: 'INVALID_JSON' }); expect(transport).not.toHaveBeenCalled();
  });
  it('rejects malformed, wrong-content-type and oversized JSON bodies safely', async () => {
    for (const response of [() => new Response('{PRIVATE', { headers: { 'Content-Type': 'application/json' } }), () => new Response('PRIVATE', { headers: { 'Content-Type': 'text/html' } }), () => jsonResponse({ agents: 'PRIVATE' })]) {
      const { client } = fakeClient(response);
      const error = await client.agents().catch(value => value as Error); expect(error).toBeInstanceOf(ClientError); expect(String(error)).not.toContain('PRIVATE');
    }
    const { client } = fakeClient(() => jsonResponse({ agents: [], excess: 'x'.repeat(100) }), { maxResponseBytes: 32 });
    await expect(client.agents()).rejects.toMatchObject({ code: 'RESPONSE_LIMIT' });
  });
  it('never trusts error response text or retries HTTP failures', async () => {
    const { client, transport } = fakeClient(() => jsonResponse({ error: { message: 'PRIVATE API KEY', code: 'PRIVATE' } }, 500));
    const error = await client.agents().catch(value => value as Error);
    expect(error).toMatchObject({ code: 'HTTP_ERROR', status: 500 }); expect(String(error)).not.toContain('PRIVATE'); expect(transport).toHaveBeenCalledOnce();
  });
  it('rejects a followed redirect and a cross-origin successful response', async () => {
    for (const property of ['redirected','url']) {
      const response = jsonResponse({ agents: [] });
      Object.defineProperty(response, property, { value: property === 'redirected' ? true : 'https://other.test/v1/agents' });
      const { client, transport } = fakeClient(() => response);
      await expect(client.agents()).rejects.toBeInstanceOf(ClientError); expect(transport).toHaveBeenCalledOnce();
    }
  });
  it('rejects output validation failure, thrown secrets and non-JSON transformed output', async () => {
    const schemas: ClientSchema<unknown>[] = [
      { '~standard': { version: 1, validate: () => ({ issues: ['PRIVATE VALIDATION ERROR'] }) } },
      { '~standard': { version: 1, validate: () => { throw new Error('PRIVATE SCHEMA ERROR'); } } },
      { '~standard': { version: 1, validate: () => ({ value: new Date() }) } },
    ];
    for (const schema of schemas) {
      const { client } = fakeClient(() => jsonResponse(remoteSnapshot()));
      const error = await client.run(id).result(schema).catch(value => value as Error);
      expect(error).toMatchObject({ code: 'INVALID_OUTPUT' }); expect(String(error)).not.toContain('PRIVATE');
    }
  });
  it('preserves parent and child terminal evidence without admitting raw exception details or internal fields', async () => {
    const evidence = [
      { runId: id, receipt: { callId: 'parent-call', toolId: 'child.agent', execution: 'unknown', disclosure: 'withheld' } },
      { runId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', receipt: { callId: 'child-call', toolId: 'fixture.write', execution: 'succeeded', disclosure: 'released' } },
    ];
    const { client } = fakeClient(() => jsonResponse(remoteSnapshot({ status: 'outcome_unknown', evidence,
      outcome: { status: 'outcome_unknown', error: { code: 'OUTCOME_UNKNOWN', message: 'PRIVATE ERROR', details: 'PRIVATE PAYLOAD' } },
      state: { prompt: 'PRIVATE SYSTEM PROMPT' },
    })));
    const result = await client.run(id).result(identitySchema); const inspected = await client.run(id).inspect();
    expect(result).toEqual({ status: 'outcome_unknown', error: { code: 'OUTCOME_UNKNOWN' }, evidence });
    expect(inspected.evidence).toEqual(evidence); expect(JSON.stringify({ result, inspected })).not.toContain('PRIVATE');
  });
  it.each([
    { id: 'wrong' }, { status: 'unknown-state' }, { budget: { spentMicros: -1, reservedMicros: 0, calls: 1 } },
    { evidence: [{ runId: id, receipt: { callId: 'call', toolId: 'tool', execution: 'impossible', disclosure: 'released' } }] },
    { outcome: { status: 'failed', error: { code: 'PRIVATE' } } },
  ])('rejects inconsistent run envelopes %#', async overrides => {
    const { client } = fakeClient(() => jsonResponse(remoteSnapshot(overrides)));
    await expect(client.run(id).result(identitySchema)).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
  });
});

describe('client SSE parsing and admission', () => {
  it('preserves UTF-8 through one-byte chunks and split CRLF frame boundaries', async () => {
    const first = event(1, 'run.started', { label: 'नमस्ते 🦚' }); const second = event(2, 'run.completed');
    const bytes = encoder.encode(`: heartbeat\r\n\r\n${frame(first, '\r\n')}${frame(second)}`);
    const { client } = fakeClient(() => stream([...bytes].map(byte => Uint8Array.of(byte))));
    const values = await collect(client.run(id).events()); expect(values).toEqual([first, second]);
    expect(Object.isFrozen(values[0]?.metadata)).toBe(true);
  });
  it('supports multiline data and explicit reconnect gaps', async () => {
    const gap = event(4, 'events.gap', { from: 2, to: 4 }); const next = event(5, 'run.completed');
    const multiline = frame(gap).replace(',"sequence"', ',\ndata: "sequence"');
    const { client, transport } = fakeClient(() => stream([encoder.encode(multiline + frame(next))]));
    expect(await collect(client.run(id).events({ after: 1 }))).toEqual([gap, next]);
    expect(new URL(String(transport.mock.calls[0]?.[0])).search).toBe('?after=1');
  });
  it.each([
    frame(event(1)) + frame(event(1)), frame(event(2)) + frame(event(1)),
    frame({ ...event(1), runId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' }),
    frame(event(1)).replace('id: 1', 'id: 2'),
  ])('rejects invalid ordering or frame identity %#', async wire => {
    const { client } = fakeClient(() => stream([encoder.encode(wire)]));
    await expect(collect(client.run(id).events())).rejects.toMatchObject({ code: 'INVALID_STREAM' });
  });
  it('rejects an unannounced sequence gap', async () => {
    const { client } = fakeClient(() => stream([encoder.encode(frame(event(1)) + frame(event(3)))]));
    await expect(collect(client.run(id).events())).rejects.toMatchObject({ code: 'INVALID_STREAM' });
  });
  it('rejects a gap whose metadata disagrees with its sequence', async () => {
    const { client } = fakeClient(() => stream([encoder.encode(frame(event(4, 'events.gap', { from: 5, to: 2 })))]));
    await expect(collect(client.run(id).events())).rejects.toMatchObject({ code: 'INVALID_STREAM' });
  });
  it.each([
    [() => stream([Uint8Array.of(0xff)]), 'INVALID_STREAM'],
    [() => stream([encoder.encode(frame(event(1)).trimEnd())]), 'TRUNCATED_STREAM'],
    [() => stream([encoder.encode('event: stream.error\ndata: {"secret":"PRIVATE"}\n\n')]), 'OBSERVATION_FAILED'],
    [() => stream([encoder.encode('id: 1\nevent: run.started\ndata: PRIVATE\n\n')]), 'INVALID_STREAM'],
  ] as const)('rejects malformed, truncated or failed observations %#', async (response, code) => {
    const { client } = fakeClient(response);
    const error = await collect(client.run(id).events()).catch(value => value as Error);
    expect(error).toMatchObject({ code }); expect(String(error)).not.toContain('PRIVATE');
  });
  it('bounds complete frames, unfinished frames and oversized transport chunks', async () => {
    for (const wire of [frame(event(1, 'run.started', { oversized: 'x'.repeat(512) })), 'x'.repeat(512)]) {
      const { client } = fakeClient(() => stream([encoder.encode(wire)]), { maxEventBytes: 128 });
      await expect(collect(client.run(id).events())).rejects.toMatchObject({ code: 'STREAM_LIMIT' });
    }
    const { client } = fakeClient(() => stream([encoder.encode(': heartbeat\n\n'.repeat(20))]), { maxResponseBytes: 64 });
    await expect(collect(client.run(id).events())).rejects.toMatchObject({ code: 'STREAM_LIMIT' });
  });
});

describe('client cancellation boundaries and browser import graph', () => {
  it('does not call a token callback or transport for an already aborted command', async () => {
    const signal = new AbortController(); signal.abort(); const token = vi.fn(() => 'test-token');
    const { client, transport } = fakeClient(() => jsonResponse({ agents: [] }), { token });
    await expect(client.agents({ signal: signal.signal })).rejects.toMatchObject({ code: 'ABORTED' });
    await Promise.resolve(); expect(token).not.toHaveBeenCalled(); expect(transport).not.toHaveBeenCalled();
  });
  it('never dispatches after aborting pending credential resolution, even when it later succeeds', async () => {
    const credential = deferred<string>(); const began = deferred<void>(); const controller = new AbortController();
    const { client, transport } = fakeClient(() => jsonResponse({ agents: [] }), { token: () => { began.resolve(); return credential.promise; } });
    const pending = client.submit('fixture.agent', 2, { idempotencyKey: 'abort-token', signal: controller.signal });
    await began.promise; controller.abort(); await expect(pending).rejects.toMatchObject({ code: 'ABORTED' });
    credential.resolve('test-token'); await Promise.resolve(); await Promise.resolve(); expect(transport).not.toHaveBeenCalled();
  });
  it('observes a late credential rejection without an unhandled error or transport dispatch', async () => {
    const credential = deferred<string>(); const began = deferred<void>(); const controller = new AbortController();
    const { client, transport } = fakeClient(() => jsonResponse({ agents: [] }), { token: () => { began.resolve(); return credential.promise; } });
    const pending = client.agents({ signal: controller.signal }); await began.promise; controller.abort();
    await expect(pending).rejects.toMatchObject({ code: 'ABORTED' }); credential.reject(new Error('PRIVATE TOKEN ERROR'));
    await Promise.resolve(); await Promise.resolve(); expect(transport).not.toHaveBeenCalled();
  });
  it('times out pending credentials and never dispatches when they resolve late', async () => {
    vi.useFakeTimers(); const credential = deferred<string>(); const began = deferred<void>();
    const { client, transport } = fakeClient(() => jsonResponse({ agents: [] }), {
      requestTimeoutMs: 20, token: () => { began.resolve(); return credential.promise; },
    });
    const pending = client.agents(); const assertion = expect(pending).rejects.toMatchObject({ code: 'ABORTED' });
    await began.promise; await vi.advanceTimersByTimeAsync(20); await assertion;
    credential.resolve('test-token'); await Promise.resolve(); await Promise.resolve(); expect(transport).not.toHaveBeenCalled();
  });
  it('snapshots the original submission before an asynchronous credential callback resolves', async () => {
    const credential = deferred<string>(); const began = deferred<void>(); const input = { value: 2 };
    const settings = { idempotencyKey: 'original-key' };
    const { client, transport } = fakeClient(() => jsonResponse({ id, profile: 'ephemeral' }), {
      token: () => { began.resolve(); return credential.promise; },
    });
    const pending = client.submit('fixture.agent', input, settings); await began.promise;
    input.value = 99; settings.idempotencyKey = 'changed-key'; credential.resolve('test-token'); await pending;
    const options = transport.mock.calls[0]?.[1];
    expect(JSON.parse(options?.body as string)).toEqual({ agentId: 'fixture.agent', input: { value: 2 } });
    expect(new Headers(options?.headers).get('idempotency-key')).toBe('original-key');
  });
  it('preserves cancellation classification while asynchronous output validation is pending', async () => {
    const validation = deferred<{ value: number }>(); const began = deferred<void>(); const controller = new AbortController();
    const { client } = fakeClient(() => jsonResponse(remoteSnapshot()));
    const schema: ClientSchema<number> = { '~standard': { version: 1, validate: () => { began.resolve(); return validation.promise; } } };
    const pending = client.run(id).result(schema, { signal: controller.signal }); await began.promise; controller.abort();
    await expect(pending).rejects.toMatchObject({ code: 'ABORTED' }); validation.resolve({ value: 4 });
  });
  it.each(['json','sse'] as const)('aborts a pending %s body read and cancels its reader', async kind => {
    const began = deferred<void>(); const cancel = vi.fn(); const controller = new AbortController();
    const body = new ReadableStream<Uint8Array>({ pull() { began.resolve(); }, cancel }, { highWaterMark: 0 });
    const { client } = fakeClient(() => new Response(body, { headers: { 'Content-Type': kind === 'json' ? 'application/json' : 'text/event-stream' } }));
    const pending = kind === 'json' ? client.agents({ signal: controller.signal }) : collect(client.run(id).events({ signal: controller.signal }));
    await began.promise; controller.abort(); await expect(pending).rejects.toMatchObject({ code: 'ABORTED' });
    await Promise.resolve(); expect(cancel).toHaveBeenCalledOnce();
  });
  it('cancels a response body returned after its Fetch request was already aborted', async () => {
    const response = deferred<Response>(); const began = deferred<void>(); const controller = new AbortController(); const cancel = vi.fn();
    const { client, transport } = fakeClient(() => { began.resolve(); return response.promise; });
    const pending = client.agents({ signal: controller.signal }); await began.promise; controller.abort();
    await expect(pending).rejects.toMatchObject({ code: 'ABORTED' });
    response.resolve(new Response(new ReadableStream({ cancel }, { highWaterMark: 0 }), { headers: { 'Content-Type': 'application/json' } }));
    await vi.waitFor(() => expect(cancel).toHaveBeenCalledOnce(), { timeout: 200, interval: 10 });
    expect(transport).toHaveBeenCalledOnce();
  });
  it('has no privileged source imports or runtime dependency graph', async () => {
    const source = await readFile(new URL('../src/index.ts', import.meta.url), 'utf8');
    const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')) as { dependencies?: Record<string, string> };
    expect(source).not.toMatch(/\b(?:from\s+['"](?:node:|@mayura\/)|require\s*\(|import\s*\()/);
    expect(manifest.dependencies ?? {}).toEqual({});
  });
});
