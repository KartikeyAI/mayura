import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { createSqliteStore } from '@mayura/storage';
import { defineAgent } from '@mayura/runtime';
import { createAgentServer, type AgentServer } from '@mayura/server';
import { agentAsDurableWorkflow, createScheduledWorkflowRuntime } from '../src/index.js';

const scope = { principalId: 'v20-user', projectId: 'v20-project' };
const servers: AgentServer[] = [];

describe('V20 same-definition progressive adoption', () => {
  afterEach(async () => { await Promise.all(servers.splice(0).map(server => server.close())); vi.restoreAllMocks(); });

  it('runs one exact agent definition through explicit durable and authenticated server profiles', async () => {
    const input = z.object({ value: z.number() });
    const output = z.object({ answer: z.number() });
    const generate = vi.fn(async request => ({ type: 'final' as const,
      output: { answer: (request.messages[0]?.role === 'user' ? request.messages[0].content as { value: number } : { value: 0 }).value + 1 },
      usage: { costMicros: 0 } }));
    const definition = defineAgent({ id: 'v20.agent', version: '1', instructions: 'Return the next number.', tools: [], input, output,
      model: { id: 'v20.model', capabilities: { tools: true, structuredOutput: true }, maxCostMicros: 0, generate } });

    const durable = agentAsDurableWorkflow(definition, { id: 'v20.durable', permissions: { allow: ['model:v20.model'] },
      limits: { maxCostMicros: 0, maxDurationMs: 2_000 }, approval: false });
    const store = createSqliteStore({ filename: ':memory:' });
    await store.initialize();
    const worker = createScheduledWorkflowRuntime({ store, scope,
      permissions: { allow: ['tool:v20.durable.agent', 'effect:host', 'agent:durable', 'model:v20.model'] },
      policyVersion: 'v20', maxCostMicros: 0, maxOutputBytes: 4_096, workerId: 'v20-worker' });
    try {
      const submitted = await worker.submit(durable, { input: { value: 4 }, idempotencyKey: 'v20-durable' });
      await expect(worker.runUntilSettled(durable, submitted.id)).resolves.toMatchObject({ status: 'succeeded', output: { answer: 5 } });
    } finally { await worker.close(); await store.close(); }

    const server = createAgentServer({ publicOrigin: 'https://agents.example.test',
      agents: [{ agent: definition, permissions: { allow: ['model:v20.model'] } }],
      authenticate: async () => ({ scope, agentIds: [definition.id], capabilities: ['runs:read', 'runs:submit'], expiresAtMs: Date.now() + 60_000 }) });
    servers.push(server);
    const headers = { authorization: 'Bearer v20-token', 'content-type': 'application/json', 'idempotency-key': 'v20-server' };
    const admitted = await server.fetch(new Request('https://agents.example.test/v1/runs', { method: 'POST', headers,
      body: JSON.stringify({ agentId: definition.id, input: { value: 8 } }) }));
    expect(admitted.status).toBe(202);
    const runId = String((await admitted.json() as { id: string }).id);
    let snapshot: { outcome?: { status: string; output?: unknown } } = {};
    await vi.waitFor(async () => {
      const response = await server.fetch(new Request(`https://agents.example.test/v1/runs/${runId}`, { headers: { authorization: 'Bearer v20-token' } }));
      expect(response.status).toBe(200); snapshot = await response.json() as typeof snapshot; expect(snapshot.outcome).toBeDefined();
    }, { interval: 1, timeout: 1_000 });
    expect(snapshot.outcome).toEqual({ status: 'succeeded', output: { answer: 9 } });
    expect(generate).toHaveBeenCalledTimes(2);
  });
});
