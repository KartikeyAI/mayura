import { afterEach, describe, expect, it } from 'vitest';
import type { JsonObject, JsonValue, Schema } from '@mayura/core';
import { defineAgent } from '@mayura/runtime';
import { createAgentServer, type AgentServer } from '@mayura/server';
import { createWorkflowLifecycleHumanTransport, createWorkflowLifecycleRuntime, defineWorkflowLifecycle } from '../src/lifecycle.js';
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
});
