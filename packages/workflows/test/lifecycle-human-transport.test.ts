import { afterEach, describe, expect, it } from 'vitest';
import { MayuraError, type JsonObject, type JsonValue, type Schema } from '@mayura/core';
import { defineAgent } from '@mayura/runtime';
import { createAgentServer, type AgentServer } from '@mayura/server';
import { createWorkflowLifecycleFleetRuntime, createWorkflowLifecycleHumanTransport, createWorkflowLifecycleRuntime, defineWorkflowLifecycle } from '../src/lifecycle.js';
import { sqliteFixture, type WorkflowFixture } from './fixtures.js';

const any: Schema<JsonValue> = { '~standard': { version: 1, vendor: 'lifecycle-transport-test',
  validate: value => ({ value: value as JsonValue }) } };
const definition = defineWorkflowLifecycle({ id: 'transport-review', version: '1', input: any, output: any,
  nodes: [{ kind: 'human', id: 'review', request: { kind: 'information', schemaId: 'fixture/answer',
    schemaDigest: 'a'.repeat(64), prompt: 'Review the operation.', response: any,
    context: { kind: 'input', path: ['context'] } } }], result: { kind: 'step', stepId: 'review', path: [] } });
const agent = defineAgent({ id: 'echo', version: '1', instructions: 'Fixture.', input: any, output: any, tools: [],
  model: { id: 'fixture', capabilities: { tools: true, structuredOutput: true }, maxCostMicros: 0,
    generate: async () => ({ type: 'final', output: null, usage: { costMicros: 0 } }) } });

describe('format-5 authenticated human transport binding', () => {
  let fixture: WorkflowFixture | undefined; let server: AgentServer | undefined;
  afterEach(async () => { await server?.close(); await fixture?.store.close(); await fixture?.cleanup(); server = undefined; fixture = undefined; });

  it('lists, inspects and answers a registered durable request through the Fetch server', async () => {
    fixture = await sqliteFixture(); await fixture.store.initialize();
    const scope = { principalId: 'alice', projectId: 'project' };
    const runtime = createWorkflowLifecycleRuntime({ store: fixture.store, scope, permissions: { allow: [] }, policyVersion: '1', maxCostMicros: 0 });
    const submitted = await runtime.submit(definition, { input: { context: { environment: 'production' } }, idempotencyKey: 'request' });
    await runtime.runUntilSettled(definition, submitted.id);
    const controller = createWorkflowLifecycleHumanTransport({ scope });
    const [requestId] = controller.register({ agentId: 'echo', definition, runtime, runId: submitted.id });
    server = createAgentServer({ publicOrigin: 'https://agents.example.test', agents: [{ agent, permissions: { allow: ['model:fixture'] } }],
      humanRequests: controller.transport, authenticate: async () => ({ scope, agentIds: ['echo'], capabilities: ['humans:read', 'humans:respond'], expiresAtMs: Date.now() + 60_000 }) });
    const request = (path: string, init: RequestInit = {}) => new Request(new URL(path, 'https://agents.example.test'), {
      ...init, headers: { authorization: 'Bearer opaque', ...Object.fromEntries(new Headers(init.headers)) },
    });
    const list = await server.fetch(request('/v1/human-requests')); expect(list.status).toBe(200);
    const page = await list.json() as JsonObject;
    expect(page).toMatchObject({ items: [{ id: requestId, agentId: 'echo', status: 'waiting',
      context: { environment: 'production' } }], next: null });
    const item = (page['items'] as JsonObject[])[0]!; const requestDigest = item['digest'] as string;
    expect(await (await server.fetch(request(`/v1/human-requests/${requestId}`))).json()).toEqual({ request: item });
    const response = await server.fetch(request(`/v1/human-requests/${requestId}/responses`, { method: 'POST',
      headers: { 'content-type': 'application/json' }, body: JSON.stringify({ commandId: 'answer-1', requestDigest, value: { accepted: true } }) }));
    expect(response.status).toBe(200); expect(await response.json()).toMatchObject({ request: { id: requestId, status: 'answered' } });
    expect(await runtime.runUntilSettled(definition, submitted.id)).toMatchObject({ status: 'succeeded', output: { accepted: true },
      steps: { review: { actorId: 'alice' } } });
    runtime.close();
  });

  it('uses opaque stable route IDs and enforces registration, scope and agent visibility', async () => {
    fixture = await sqliteFixture(); await fixture.store.initialize();
    const scope = { principalId: 'alice', projectId: 'project' };
    const runtime = createWorkflowLifecycleRuntime({ store: fixture.store, scope, permissions: { allow: [] }, policyVersion: '1', maxCostMicros: 0 });
    const submitted = await runtime.submit(definition, { input: { context: null }, idempotencyKey: 'request' });
    await runtime.runUntilSettled(definition, submitted.id);
    const controller = createWorkflowLifecycleHumanTransport({ scope });
    const first = controller.register({ agentId: 'echo', definition, runtime, runId: submitted.id });
    expect(controller.register({ agentId: 'echo', definition, runtime, runId: submitted.id })).toEqual(first);
    expect(first[0]).toMatch(/^[a-f0-9]{64}$/);
    const signal = new AbortController().signal;
    expect(await controller.transport.inspect({ scope, agentIds: ['other'], id: first[0]!, signal })).toBeNull();
    await expect(controller.transport.inspect({ scope: { ...scope, projectId: 'other' }, agentIds: ['echo'], id: first[0]!, signal })).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
    controller.unregister(submitted.id);
    expect(await controller.transport.inspect({ scope, agentIds: ['echo'], id: first[0]!, signal })).toBeNull();
    runtime.close();
  });
  it('finds pending requests in storage: listed, read and answered after a restart without registration', async () => {
    fixture = await sqliteFixture(); await fixture.store.initialize();
    const scope = { principalId: 'alice', projectId: 'project' };
    const other = defineWorkflowLifecycle({ id: 'transport-other', version: '1', input: any, output: any,
      nodes: [{ kind: 'human', id: 'confirm', request: { kind: 'information', schemaId: 'fixture/answer', schemaDigest: 'b'.repeat(64),
        prompt: 'Confirm.', response: any } }], result: { kind: 'step', stepId: 'confirm', path: [] } });
    const open = (store: WorkflowFixture['store']) => createWorkflowLifecycleFleetRuntime({ store, scope, permissions: { allow: [] }, policyVersion: '1', maxCostMicros: 0 });
    let runtime = open(fixture.store);
    const runs: { readonly id: string }[] = [];
    for (const key of ['r1', 'r2', 'r3']) { const run = await runtime.submit(definition, { input: { context: { key } }, idempotencyKey: key }); await runtime.runUntilSettled(definition, run.id); runs.push(run); }
    // A run whose definition the transport does not serve is never listed.
    const hidden = await runtime.submit(other, { input: null, idempotencyKey: 'hidden' }); await runtime.runUntilSettled(other, hidden.id);
    runtime.close(); await fixture.store.close();

    // A fresh process: a new store handle, runtime and transport, and nothing registered.
    const store = fixture.reopen(); await store.initialize(); runtime = open(store);
    try {
      const controller = createWorkflowLifecycleHumanTransport({ scope, runtime, definitions: [{ agentId: 'echo', definition }] });
      expect(() => controller.register({ agentId: 'echo', definition, runtime, runId: runs[0]!.id })).toThrow(MayuraError);
      const signal = new AbortController().signal;
      const seen: string[] = []; let after: string | null = null;
      do {
        const page: { items: readonly { id: string; status: string; context?: unknown }[]; next: string | null } =
          await controller.transport.list({ scope, agentIds: ['echo'], after, limit: 1, signal });
        expect(page.items.length).toBeLessThanOrEqual(1); seen.push(...page.items.map(item => item.id)); after = page.next;
      } while (after !== null);
      expect(seen).toHaveLength(3); expect([...seen].sort()).toEqual(seen);
      expect(seen.map(id => id.slice(0, 2)).sort()).toEqual(runs.map(run => run.id.slice(0, 2)).sort());
      const first = await controller.transport.inspect({ scope, agentIds: ['echo'], id: seen[0]!, signal });
      expect(first).toMatchObject({ agentId: 'echo', status: 'waiting', kind: 'information' });
      // The same guarantees as registration: exact scope, agent visibility, and the verified caller answers.
      expect(await controller.transport.inspect({ scope, agentIds: ['other'], id: seen[0]!, signal })).toBeNull();
      expect((await controller.transport.list({ scope, agentIds: ['other'], after: null, limit: 10, signal })).items).toEqual([]);
      await expect(controller.transport.inspect({ scope: { ...scope, projectId: 'other' }, agentIds: ['echo'], id: seen[0]!, signal })).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
      await expect(controller.transport.respond({ scope, agentIds: ['other'], actorId: 'mallory', id: seen[0]!, requestDigest: first!.digest,
        commandId: 'answer-x', value: { accepted: false }, signal })).rejects.toMatchObject({ code: 'NOT_FOUND' });
      expect(await controller.transport.inspect({ scope, agentIds: ['echo'], id: 'f'.repeat(64), signal })).toBeNull();
      const answered = await controller.transport.respond({ scope, agentIds: ['echo'], actorId: 'bob', id: seen[0]!, requestDigest: first!.digest,
        commandId: 'answer-1', value: { accepted: true }, signal });
      expect(answered).toMatchObject({ id: seen[0], status: 'answered' });
      const settled = await Promise.all(runs.map(run => runtime.runUntilSettled(definition, run.id)));
      expect(settled.filter(snapshot => snapshot.status === 'succeeded')).toEqual([expect.objectContaining({ output: { accepted: true }, steps: expect.objectContaining({
        review: expect.objectContaining({ actorId: 'bob' }) }) })]);
      // A settled run leaves the index, and with it the list.
      expect((await controller.transport.list({ scope, agentIds: ['echo'], after: null, limit: 10, signal })).items.map(item => item.id)).toEqual(seen.slice(1));
      // A transport for another scope than its runtime is refused rather than showing nothing.
      const mismatched = createWorkflowLifecycleHumanTransport({ scope: { principalId: 'carol', projectId: 'project' }, runtime, definitions: [{ agentId: 'echo', definition }] });
      await expect(mismatched.transport.list({ scope: { principalId: 'carol', projectId: 'project' }, agentIds: ['echo'], after: null, limit: 1, signal }))
        .rejects.toMatchObject({ code: 'INVALID_CONFIG' });
      expect(() => createWorkflowLifecycleHumanTransport({ scope, runtime, definitions: [] })).toThrow(MayuraError);
      expect(() => createWorkflowLifecycleHumanTransport({ scope, definitions: [{ agentId: 'echo', definition }] })).toThrow(MayuraError);
      expect(() => createWorkflowLifecycleHumanTransport({ scope, runtime, definitions: [{ agentId: 'echo', definition }, { agentId: 'echo', definition }] })).toThrow(MayuraError);
    } finally { runtime.close(); await store.close(); }
  });
});
