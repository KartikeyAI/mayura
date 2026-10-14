import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRuntime, defineAgent, defineTool, z } from 'mayura';
import { scriptedModel } from 'mayura/testing';
import { createAgentFirewall, type FirewallAction, type FirewallDecision } from '../src/index.js';

const runtimes: Array<{ close(): Promise<void> }> = [];
afterEach(async () => { await Promise.all(runtimes.splice(0).map(r => r.close())); });

function fixture(effect: FirewallDecision['effect']) {
  const authorize = vi.fn(async (_action: FirewallAction) =>
    ({ effect, ruleId: 'test.rule', reasonCode: 'test.decision' }));
  const recordOutcome = vi.fn(async () => {});
  const tool = defineTool({
    id: 'orders.read', version: '1', description: 'Read an order.',
    input: z.object({ id: z.string() }), output: z.object({ id: z.string() }),
    effects: 'read', capabilities: ['orders:read'],
    execute: vi.fn(async ({ id }) => ({ id }))
  });
  const firewall = createAgentFirewall({
    environment: 'test', tools: [tool], dvar: { authorize, recordOutcome }
  });
  const agent = defineAgent({
    id: 'orders-agent', version: '1', instructions: 'Read orders.',
    input: z.string(), output: z.string(),
    model: scriptedModel([
      { type: 'tool_calls', calls: [{ id: 'call-1', toolId: 'orders.read', input: { id: '42' } }], usage: { costMicros: 0 } },
      { type: 'final', output: 'done', usage: { costMicros: 0 } }
    ]),
    tools: [tool], hooks: firewall.hooks
  });
  const runtime = createRuntime({
    profile: 'ephemeral', scope: { principalId: 'alice', projectId: 'shop' },
    permissions: { allow: ['model:scripted', 'tool:orders.read', 'effect:read', 'orders:read'] },
    limits: { maxCostMicros: 10000 }
  });
  runtimes.push(runtime);
  return { runtime, agent, tool, authorize, recordOutcome };
}

describe('Firewall for Agents', () => {
  it('permits execution and records outcome when Dvar allows it', async () => {
    const f = fixture('allow');
    const outcome = await f.runtime.submit(f.agent, { input: 'read order' }).result();
    expect(outcome.status).toBe('succeeded');
    expect(f.tool.id).toBe('orders.read');
    expect(f.authorize).toHaveBeenCalledWith(expect.objectContaining({
      principal: { id: 'alice', type: 'user' },
      agent: { id: 'orders-agent', framework: 'mayura' },
      tenant: { id: 'shop' },
      tool: { name: 'orders.read', capabilities: ['orders:read'] },
      arguments: { id: '42' }
    }), undefined);
    expect(f.recordOutcome).toHaveBeenCalledWith(expect.any(Object), { success: true });
  });

  it.each(['deny', 'require_approval'] as const)('stops tool execution on Dvar %s', async effect => {
    const f = fixture(effect);
    const outcome = await f.runtime.submit(f.agent, { input: 'read order' }).result();
    expect(outcome).toMatchObject({ status: 'blocked', error: { code: 'GUARD_BLOCKED' } });
    expect(f.recordOutcome).not.toHaveBeenCalled();
  });

  it('delegates output redaction to Dvar output filter', async () => {
    const f = fixture('allow');
    const guard = createAgentFirewall({
      dvar: { authorize: f.authorize, recordOutcome: f.recordOutcome },
      environment: 'test', tools: [],
      outputFilter: { filter: <T>(_input: { value: T }) => ({
        value: { token: '[REDACTED]' } as T,
        summary: { status: 'redacted' as const }
      }) }
    }).outputGuard;
    const verdict = await guard?.check({ token: 'hidden' }, {
      runId: 'r', callId: 'c', scope: { principalId: 'p', projectId: 'x' },
      boundary: 'output', signal: new AbortController().signal
    });
    expect(verdict).toEqual({ decision: 'rewrite', value: { token: '[REDACTED]' } });
  });
});
