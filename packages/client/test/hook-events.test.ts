import { describe, expect, it } from 'vitest';
import { createClient, type ClientEvent } from '../src/index.js';

const runId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const invocationId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const base = { hookId: 'policy.check', hookVersion: 'v1.0/review', stage: 'beforeExecution', invocationId, step: 0, attempt: 1 };
const states = ['continued', 'blocked', 'failed', 'cancelled', 'outcome_unknown'] as const;
const stages = ['beforeExecution', 'beforeModelCall', 'beforeToolCall', 'beforeOutputRelease'] as const;

function event(sequence: number, type: string, metadata: Record<string, unknown>) {
  return { runId, sequence, type, timestamp: '2026-09-20T00:00:00.000Z', metadata };
}
async function receive(values: readonly ReturnType<typeof event>[]): Promise<ClientEvent[]> {
  const encoded = new TextEncoder().encode(values.map(value => `id: ${value.sequence}\nevent: ${value.type}\ndata: ${JSON.stringify(value)}\n\n`).join(''));
  const client = createClient({ baseUrl: 'https://mayura.test', token: () => 'test-only', fetch: async () => new Response(encoded,
    { headers: { 'Content-Type': 'text/event-stream' } }) });
  const result: ClientEvent[] = [];
  // One recorded connection: without reconnecting, the stream's end is the end of the test input.
  for await (const entry of client.run(runId).events({ reconnect: false })) result.push(entry);
  return result;
}

describe('browser hook event compatibility', () => {
  it('accepts all four stages and five completion statuses as immutable metadata only', async () => {
    const values = stages.flatMap((stage, index) => {
      const metadata = { ...base, stage, step: index };
      return [event(index * 6 + 1, 'hook.started', metadata),
        ...states.map((status, offset) => event(index * 6 + offset + 2, 'hook.completed', { ...metadata, status }))];
    });
    const result = await receive(values);
    expect(result).toEqual(values);
    expect(result.every(value => Object.isFrozen(value) && Object.isFrozen(value.metadata))).toBe(true);
  });

  it.each(['request', 'modelId', 'purpose'])('rejects primary-model content field %s on hook observations', async field => {
    const metadata = { ...base, stage: 'beforeModelCall', step: 3, [field]: 'SECRET_MODEL_REQUEST' };
    const result = await receive([event(1, 'hook.started', metadata)]).catch(error => error as Error);
    expect(result).toMatchObject({ code: 'INVALID_STREAM' }); expect(String(result)).not.toContain('SECRET_MODEL_REQUEST');
  });

  it.each([
    { hookId: '' }, { hookId: 'x'.repeat(129) }, { hookId: 'policy:unexpected' },
    { hookVersion: 'private version text' }, { hookVersion: 'x'.repeat(129) },
    { stage: 'afterEverything' }, { invocationId: 'not-a-uuid' }, { invocationId: invocationId.toUpperCase() },
    { invocationId: 'bbbbbbbb-bbbb-5bbb-8bbb-bbbbbbbbbbbb' }, { invocationId: 'bbbbbbbb-bbbb-4bbb-1bbb-bbbbbbbbbbbb' },
    { step: -1 }, { step: 0.5 }, { step: Number.MAX_SAFE_INTEGER + 1 }, { step: null }, { step: 1 },
    { attempt: 0 }, { attempt: 2 }, { attempt: true }, { attempt: '1' },
    { input: 'SECRET_HOOK_CONTENT' }, { output: 'SECRET_HOOK_CONTENT' }, { error: 'SECRET_HOOK_CONTENT' },
    { status: 'continued' },
  ])('rejects invalid or additional started metadata %#', async change => {
    const result = await receive([event(1, 'hook.started', { ...base, ...change })]).catch(error => error as Error);
    expect(result).toMatchObject({ code: 'INVALID_STREAM' });
    expect(String(result)).not.toContain('SECRET_HOOK_CONTENT');
  });

  it.each(['hookId', 'hookVersion', 'stage', 'invocationId', 'step', 'attempt', 'status'])('requires completed field %s', async missing => {
    const metadata: Record<string, unknown> = { ...base, status: 'continued' }; delete metadata[missing];
    await expect(receive([event(1, 'hook.completed', metadata)])).rejects.toMatchObject({ code: 'INVALID_STREAM' });
  });

  it.each(['running', 'succeeded', 'allow', 'SECRET_HOOK_CONTENT', 1])('rejects unknown completion status %s', async status => {
    await expect(receive([event(1, 'hook.completed', { ...base, status })])).rejects.toMatchObject({ code: 'INVALID_STREAM' });
  });

  it('accepts the exact hook identifier bounds and rejects content on completed events', async () => {
    const metadata = { ...base, hookId: 'h'.repeat(128), hookVersion: 'v'.repeat(128), status: 'continued' };
    const value = event(1, 'hook.completed', metadata);
    expect(await receive([value])).toEqual([value]);
    await expect(receive([event(1, 'hook.completed', { ...metadata, content: 'SECRET_HOOK_CONTENT' })]))
      .rejects.toMatchObject({ code: 'INVALID_STREAM' });
  });
});

describe('lifecycle catalog stream events', () => {
  it('admits step, delegate and observer-stage hook events', async () => {
    const received = await receive([event(1, 'step.started', { step: 0 }), event(2, 'delegate.started', { childRunId: 'child', childAgentId: 'helper' }),
      event(3, 'hook.started', { ...base, stage: 'afterDelegate' }), event(4, 'delegate.completed', { childRunId: 'child', status: 'succeeded' }),
      event(5, 'step.completed', { step: 0, result: 'final' })]);
    expect(received.map(item => item.type)).toEqual(['step.started', 'delegate.started', 'hook.started', 'delegate.completed', 'step.completed']);
  });
});
