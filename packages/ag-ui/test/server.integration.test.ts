import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { z } from 'zod';
import { defineAgent } from '@mayura/runtime';
import { defineTool } from '@mayura/tools';
import { scriptedModel } from '@mayura/testing';
import { createSqliteStore } from '@mayura/storage-sqlite';
import { createAggregateFrontendToolStore, createAggregateRunRecords } from '@mayura/storage-contracts';
import { createAgentServer, type AgentServer } from '../../server/src/index.js';
import { frontendInternals } from '../src/frontend-tools.js';
import { createClient } from '../../client/src/index.js';
import { createAgUiAdapter, createAgUiFrontendTools, createAgUiFrontendExecutor, type AgUiFrontendTools, type AgUiAdapter, type AgUiEvent } from '../src/index.js';

// Real native HTTP boundary and local SQLite; no network, model provider or real credentials.
const origin = 'https://ag-ui.example.test';
let frontendTools: AgUiFrontendTools | undefined;
const replicas: { service: AgUiFrontendTools; adapter: AgUiAdapter }[] = [];
let directory: string; let store: ReturnType<typeof createSqliteStore>; let server: AgentServer | undefined; let adapter: AgUiAdapter | undefined;
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'mayura-ag-ui-')); store = createSqliteStore({ filename: join(directory, 'chat.sqlite') });
  await store.initialize(); await store.threads.initialize();
});
afterEach(async () => {
  for (const replica of replicas.splice(0)) { replica.adapter.close(); replica.service.close(); }
  adapter?.close(); frontendTools?.close(); frontendTools = undefined; await server?.close(); await store.close();
  if (!resolve(directory).startsWith(`${resolve(tmpdir())}${sep}mayura-ag-ui-`)) throw new Error('Unsafe cleanup path');
  await rm(directory, { recursive: true, force: true });
});
const request = (body: unknown) => new Request(`${origin}/ag-ui`, { method: 'POST',
  headers: { authorization: 'Bearer local-fixture', 'content-type': 'application/json' }, body: JSON.stringify(body) });
const events = async (response: Response): Promise<AgUiEvent[]> => {
  expect(response.status).toBe(200); return (await response.text()).split('\n\n').filter(Boolean).map(frame => JSON.parse(frame.slice(6)) as AgUiEvent);
};
it('continues the native budget, executes the approved write once and records the thread once across UI segments and submission replay', async () => {
  let stateRevision = 0;
  const write = vi.fn(() => { stateRevision++; return { refunded: true }; });
  const tool = defineTool({ id: 'refund', version: '1', description: 'Refund order 7.', input: z.object({ order: z.number() }), output: z.object({ refunded: z.boolean() }),
    effects: 'write', capabilities: [], approval: 'required', execute: write });
  const model = scriptedModel([
    { type: 'tool_calls', calls: [{ id: 'c1', toolId: 'refund', input: { order: 7 } }], usage: { costMicros: 1 } },
    { type: 'final', output: { reply: 'Refunded' }, usage: { costMicros: 1 } },
  ], { maxCostMicros: 1 });
  const agent = defineAgent({ id: 'support', version: '1', instructions: 'Help with refunds.', model, tools: [tool],
    input: z.object({ message: z.string() }), output: z.object({ reply: z.string() }) });
  server = createAgentServer({ publicOrigin: origin, threads: { store }, runRecords: createAggregateRunRecords(store),
    agents: [{ agent, permissions: { allow: ['model:scripted', 'tool:refund', 'effect:write'] }, limits: { maxCostMicros: 10 } }],
    authenticate: async () => ({ scope: { principalId: 'alice', projectId: 'shop' }, agentIds: ['support'],
      capabilities: ['runs:read', 'runs:submit', 'runs:approve', 'threads:read', 'threads:write'], expiresAtMs: Date.now() + 60_000 }),
    limits: { runRecordPollMs: 10 } });
  adapter = createAgUiAdapter({ server, publicOrigin: origin, agentId: 'support', interruptKey: new Uint8Array(32).fill(3),
    permissions: { allow: ['ag-ui:serve', 'ag-ui:state'] }, input: message => ({ message: message.content }),
    state: { read: context => { expect(context.scope).toEqual({ principalId: 'alice', projectId: 'shop' });
      return { revision: stateRevision, state: { refunded: stateRevision > 0 } }; } } });
  const firstInput = { threadId: 'thread-7', runId: 'ui-1', messages: [{ id: 'user-1', role: 'user', content: 'Refund order 7' }] };
  const firstResponse = await adapter.fetch(request(firstInput)); const nativeId = firstResponse.headers.get('x-mayura-run-id')!;
  const first = await events(firstResponse); const last = first.at(-1);
  if (last?.type !== 'RUN_FINISHED' || last.outcome.type !== 'interrupt') throw new Error('Expected pending tool approval');
  expect(first[1]).toMatchObject({ type: 'STATE_SNAPSHOT', snapshot: { refunded: false } });
  expect(write).not.toHaveBeenCalled();
  const client = createClient({ baseUrl: origin, token: () => 'local-fixture', fetch: (target, init) => server!.fetch(new Request(target, init)) });
  expect(BigInt((await client.run(nativeId).inspect()).budget.spentMicros)).toBe(1n);
  const resume = { threadId: 'thread-7', runId: 'ui-2', messages: [], resume: [{ interruptId: last.outcome.interrupts[0]!.id, status: 'resolved', payload: { approved: true } }] };
  const nextResponse = await adapter.fetch(request(resume)); expect(nextResponse.headers.get('x-mayura-run-id')).toBe(nativeId);
  const resumedEvents = await events(nextResponse);
  expect(resumedEvents[1]).toMatchObject({ type: 'STATE_SNAPSHOT', snapshot: { refunded: false } });
  expect(resumedEvents.find(event => event.type === 'STATE_DELTA')).toMatchObject({ delta: [{ op: 'replace', path: '/refunded', value: true }] });
  expect(resumedEvents.at(-1)).toMatchObject({ type: 'RUN_FINISHED', outcome: { type: 'success' } });
  expect(write).toHaveBeenCalledTimes(1); expect(BigInt((await client.run(nativeId).inspect()).budget.spentMicros)).toBe(2n);
  expect((await adapter.fetch(request({ ...resume, runId: 'ui-3' }))).status).toBe(409);
  const replay = await adapter.fetch(request(firstInput)); expect(replay.headers.get('x-mayura-run-id')).toBe(nativeId); await events(replay);
  expect(write).toHaveBeenCalledTimes(1);
  const entries = await client.threadEntries('thread-7');
  expect(entries.filter(entry => entry.kind === 'user')).toHaveLength(1);
  expect(entries.filter(entry => entry.kind === 'run' && entry.status === 'succeeded')).toHaveLength(1);
});

it.each(['live', 'durable'] as const)('runs a claimed frontend tool once with %s storage, retaining its native budget and validated result', async mode => {
  const require = vi.fn(async () => {});
  const sharedJournal = createAggregateFrontendToolStore(store, { permissions: { allow: ['frontend-tools:store'] } });
  frontendTools = createAgUiFrontendTools({ agentId: 'support', permissions: { allow: ['ag-ui:frontend-tools'] }, authorization: { require } as any,
    ...(mode === 'durable' ? { store: sharedJournal } : {}) });
  const tool = frontendTools.defineTool({ id: 'ui.select', version: '1', description: 'Choose an item.', input: z.object({ item: z.number() }), output: z.object({ selected: z.number() }),
    effects: 'none', capabilities: [], costMicros: 1, timeoutMs: 30_000 });
  const model = scriptedModel([
    { type: 'tool_calls', calls: [{ id: 'c1', toolId: 'ui.select', input: { item: 7 } }], usage: { costMicros: 1 } },
    request => { expect(request.messages).toContainEqual({ role: 'tool', callId: 'c1', toolId: 'ui.select', result: { selected: 7 } });
      return { type: 'final', output: { reply: 'Selected' }, usage: { costMicros: 1 } }; },
  ], { maxCostMicros: 1 });
  const agent = defineAgent({ id: 'support', version: '1', instructions: 'Help with choices.', model, tools: [tool], input: z.object({ message: z.string() }), output: z.object({ reply: z.string() }) });
  server = createAgentServer({ publicOrigin: origin, threads: { store }, runRecords: createAggregateRunRecords(store),
    agents: [{ agent, permissions: { allow: ['model:scripted', 'tool:ui.select', 'frontend:ui.select'] }, limits: { maxCostMicros: 10 } }],
    authenticate: async ({ token }) => ({ scope: { principalId: token === 'bob' ? 'bob' : 'alice', projectId: 'shop' }, agentIds: ['support'],
      capabilities: ['runs:read', 'runs:submit', 'threads:read', 'threads:write'], expiresAtMs: Date.now() + 60_000 }), limits: { runRecordPollMs: 10 } });
  adapter = createAgUiAdapter({ server, publicOrigin: origin, agentId: 'support', interruptKey: new Uint8Array(32).fill(3),
    permissions: { allow: ['ag-ui:serve', 'ag-ui:frontend-tools'] }, frontendTools, input: message => ({ message: message.content }) });
  const tools = [{ name: tool.id, description: tool.description, parameters: tool.inputJsonSchema! }];
  const response = await adapter.fetch(request({ threadId: 'frontend-thread', runId: 'ui-frontend-1', messages: [{ id: 'user-1', role: 'user', content: 'Select 7' }], tools }));
  const nativeId = response.headers.get('x-mayura-run-id'); const first = await events(response);
  const call = first.find(event => event.type === 'TOOL_CALL_START'); if (call?.type !== 'TOOL_CALL_START' || !call.metadata) throw new Error('Expected frontend dispatch');
  expect(first.at(-1)).toMatchObject({ type: 'RUN_FINISHED', outcome: { type: 'success', pendingToolCallIds: [call.toolCallId] } });
  // The native owner stays on its original bridge; fresh HTTP replicas only read/write the shared journal.
  const receivingReplica = () => {
    const service = createAgUiFrontendTools({ agentId: 'support', store: sharedJournal, permissions: { allow: ['ag-ui:frontend-tools'] }, authorization: { require } as any });
    service.defineTool({ id: 'ui.select', version: '1', description: 'Choose an item.', input: z.object({ item: z.number() }), output: z.object({ selected: z.number() }),
      effects: 'none', capabilities: [], costMicros: 1, timeoutMs: 30_000 });
    const receiver = createAgUiAdapter({ server: server!, publicOrigin: origin, agentId: 'support', interruptKey: new Uint8Array(32).fill(3),
      permissions: { allow: ['ag-ui:serve', 'ag-ui:frontend-tools'] }, frontendTools: service, input: message => ({ message: message.content }) });
    const replica = { service, adapter: receiver }; replicas.push(replica); return replica;
  };
  let receiver = mode === 'durable' ? receivingReplica() : { service: frontendTools!, adapter: adapter! };
  const handler = vi.fn(async () => ({ selected: 7 }));
  const executor = createAgUiFrontendExecutor({ publicOrigin: origin, token: () => 'local-fixture', permissions: { allow: ['ag-ui:frontend-execute', 'frontend:ui.select'] }, handlers: { 'ui.select': handler },
    fetch: (target, init) => receiver.adapter.fetch(new Request(target, init)) });
  const returned = await executor.execute({ toolCallId: call.toolCallId, toolCallName: call.toolCallName, metadata: call.metadata });
  await expect(executor.execute({ toolCallId: call.toolCallId, toolCallName: call.toolCallName, metadata: call.metadata })).rejects.toMatchObject({ code: 'FRONTEND_EXECUTOR_LIMIT' });
  if (mode === 'durable') { receiver.adapter.close(); receiver.service.close(); receiver = receivingReplica(); }
  const body = { threadId: 'frontend-thread', runId: 'ui-frontend-2', messages: [returned.message], forwardedProps: returned.forwardedProps, tools };
  const resumed = await receiver.adapter.fetch(request(body)); expect(resumed.headers.get('x-mayura-run-id')).toBe(nativeId);
  const next = await events(resumed); expect(next.find(event => event.type === 'TOOL_CALL_RESULT')).toMatchObject({ toolCallId: call.toolCallId });
  expect(next.at(-1)).toMatchObject({ type: 'RUN_FINISHED', outcome: { type: 'success' } });
  const replay = await receiver.adapter.fetch(request(body)); expect(replay.headers.get('x-mayura-run-id')).toBe(nativeId); await events(replay);
  expect(handler).toHaveBeenCalledTimes(1);
  const client = createClient({ baseUrl: origin, token: () => 'local-fixture', fetch: (target, init) => server!.fetch(new Request(target, init)) });
  expect(BigInt((await client.run(nativeId!).inspect()).budget.spentMicros)).toBe(3n);
  const entries = await client.threadEntries('frontend-thread'); expect(entries.filter(entry => entry.kind === 'user')).toHaveLength(1);
  expect(entries.filter(entry => entry.kind === 'tool_result')).toHaveLength(1);
  expect(require).toHaveBeenCalledWith({ principalId: 'alice', projectId: 'shop' }, 'frontend_execute', expect.objectContaining({ kind: 'tool', id: 'ui.select' }), expect.anything());
});


it.each(['request', 'worker'] as const)('recovers a parked native owner through %s without replaying browser or completed paid work', async recovery => {
  const scope = { principalId: 'alice', projectId: 'shop' };
  const nativeWrite = vi.fn(async () => ({ saved: true })); const inputGuard = vi.fn(async () => ({ decision: 'allow' as const }));
  const authorizeRecovery = vi.fn(async () => true);
  const boot = (afterRestart: boolean) => {
    const journal = createAggregateFrontendToolStore(store, { permissions: { allow: ['frontend-tools:store'] } });
    frontendTools = createAgUiFrontendTools({ agentId: 'support', store: journal, nativeRecovery: { permissions: { allow: ['ag-ui:frontend-recover'] } },
      permissions: { allow: ['ag-ui:frontend-tools'] }, authorization: { require: async () => {} } as any });
    const browserTool = frontendTools.defineTool({ id: 'ui.select', version: '1', description: 'Choose an item.', input: z.object({ item: z.number() }),
      output: z.object({ selected: z.number() }), effects: 'none', capabilities: [], costMicros: 1, timeoutMs: 30_000,
      guards: { input: [{ id: 'admit-input', check: inputGuard }] } });
    const paidTool = defineTool({ id: 'backend.save', version: '1', description: 'Save once.', input: z.object({}), output: z.object({ saved: z.boolean() }),
      effects: 'write', capabilities: [], costMicros: 2, execute: nativeWrite });
    const model = scriptedModel(afterRestart ? [request => {
      expect(request.messages).toContainEqual({ role: 'tool', callId: 'paid-1', toolId: 'backend.save', result: { saved: true } });
      expect(request.messages).toContainEqual({ role: 'tool', callId: 'c1', toolId: 'ui.select', result: { selected: 7 } });
      return { type: 'final', output: { reply: 'Recovered' }, usage: { costMicros: 1 } };
    }] : [{ type: 'tool_calls', calls: [{ id: 'paid-1', toolId: 'backend.save', input: {} }, { id: 'c1', toolId: 'ui.select', input: { item: 7 } }], usage: { costMicros: 1 } }], { maxCostMicros: 1 });
    const generate = vi.fn(model.generate.bind(model));
    const agent = defineAgent({ id: 'support', version: '1', instructions: 'Help with choices.', model: { ...model, generate }, tools: [paidTool, browserTool],
      input: z.object({ message: z.string() }), output: z.object({ reply: z.string() }) });
    server = createAgentServer({ publicOrigin: origin, threads: { store }, runRecords: createAggregateRunRecords(store),
      ...(afterRestart ? { conversationRecovery: { permissions: { allow: ['conversations:recover'] }, authorize: authorizeRecovery } } : {}),
      agents: [{ agent, permissions: { allow: ['model:scripted', 'tool:backend.save', 'effect:write', 'tool:ui.select', 'frontend:ui.select'] }, limits: { maxCostMicros: 10 } }],
      authenticate: async ({ token }) => ({ scope: token === 'other' ? { ...scope, projectId: 'other' } : scope, agentIds: ['support'],
        capabilities: token === 'read-only' ? ['runs:read', 'threads:read'] : ['runs:read', 'runs:submit', 'runs:resume', 'threads:read', 'threads:write'], expiresAtMs: Date.now() + 60_000 }),
      limits: { runRecordPollMs: 5 } });
    adapter = createAgUiAdapter({ server, publicOrigin: origin, agentId: 'support', interruptKey: new Uint8Array(32).fill(3),
      permissions: { allow: ['ag-ui:serve', 'ag-ui:frontend-tools'] }, frontendTools, input: message => ({ message: message.content }) });
    return { generate, journal, tools: [{ name: browserTool.id, description: browserTool.description, parameters: browserTool.inputJsonSchema! }] };
  };
  const first = boot(false); const started = await adapter!.fetch(request({ threadId: 'recover-thread', runId: 'ui-recovery-1',
    messages: [{ id: 'user-1', role: 'user', content: 'Select 7' }], tools: first.tools }));
  const nativeId = started.headers.get('x-mayura-run-id')!; const initial = await events(started);
  const call = initial.find(event => event.type === 'TOOL_CALL_START'); if (call?.type !== 'TOOL_CALL_START' || !call.metadata) throw new Error('Expected frontend call');
  const browserWrite = vi.fn(async () => ({ selected: 7 }));
  const executor = createAgUiFrontendExecutor({ publicOrigin: origin, token: () => 'local-fixture', permissions: { allow: ['ag-ui:frontend-execute', 'frontend:ui.select'] }, handlers: { 'ui.select': browserWrite },
    fetch: (target, init) => adapter!.fetch(new Request(target, init)) });
  const returned = await executor.execute({ toolCallId: call.toolCallId, toolCallName: call.toolCallName, metadata: call.metadata });
  expect(first.generate).toHaveBeenCalledTimes(1); expect(nativeWrite).toHaveBeenCalledTimes(1); expect(inputGuard).toHaveBeenCalledTimes(1);
  const saved = await store.runCheckpoints.get({ runId: nativeId }); expect(saved?.body['waitKind']).toBe('frontend');
  expect(saved?.body['spent']).toMatchObject({ micros: '4' });
  adapter!.close(); await server!.close(); frontendTools!.close(); const second = boot(true);
  const client = createClient({ baseUrl: origin, token: () => 'local-fixture', fetch: (target, init) => server!.fetch(new Request(target, init)) });
  const wait = (await client.run(nativeId).inspect()).toolWait!;
  const forbidden = createClient({ baseUrl: origin, token: () => 'read-only', fetch: (target, init) => server!.fetch(new Request(target, init)) });
  await expect(forbidden.run(nativeId).resumeTool({ callId: wait.callId, digest: wait.digest })).rejects.toMatchObject({ status: 403 });
  if (recovery === 'worker') {
    const continuation = returned.forwardedProps.mayuraFrontend;
    await frontendInternals(frontendTools!).result(continuation.token, continuation.claimId, scope, 'recover-thread', 'ui-recovery-2', returned.message, call.toolCallId, new AbortController().signal);
    const report = await server!.recoverConversations(); expect(report.outcomes).toContainEqual(expect.objectContaining({ id: nativeId, status: 'resumed' }));
    expect(authorizeRecovery).toHaveBeenCalledWith(expect.objectContaining({ kind: 'frontend', scope }));
  }
  const resumedBody = { threadId: 'recover-thread', runId: 'ui-recovery-2', messages: [returned.message], forwardedProps: returned.forwardedProps, tools: second.tools };
  const resumed = await adapter!.fetch(request(resumedBody)); expect(resumed.headers.get('x-mayura-run-id')).toBe(nativeId);
  expect((await events(resumed)).at(-1)).toMatchObject({ type: 'RUN_FINISHED', outcome: { type: 'success' } });
  await events(await adapter!.fetch(request(resumedBody)));
  expect(second.generate).toHaveBeenCalledTimes(1); expect(nativeWrite).toHaveBeenCalledTimes(1); expect(browserWrite).toHaveBeenCalledTimes(1); expect(inputGuard).toHaveBeenCalledTimes(1);
  expect(BigInt((await client.run(nativeId).inspect()).budget.spentMicros)).toBe(5n);
  const entries = await client.threadEntries('recover-thread'); expect(entries.filter(entry => entry.kind === 'user')).toHaveLength(1);
  expect(entries.filter(entry => entry.kind === 'tool_result')).toHaveLength(2);
  await expect(client.run(nativeId).resumeTool({ callId: wait.callId, digest: wait.digest })).rejects.toMatchObject({ status: 409 });
});
