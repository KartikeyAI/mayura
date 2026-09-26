import { describe, expect, it, vi } from 'vitest';
import type { RunEvent, RunHandle } from '@mayura/core';
import { createObserver } from '../src/index.js';

const invocationId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const base = { hookId: 'policy.check', hookVersion: 'v1.0/review', stage: 'beforeExecution', invocationId, step: 0, attempt: 1 };
const states = ['continued', 'blocked', 'failed', 'cancelled', 'outcome_unknown'] as const;
const stages = ['beforeExecution', 'beforeModelCall', 'beforeToolCall', 'beforeOutputRelease'] as const;
function event(sequence: number, type: string, metadata: Record<string, unknown>): unknown {
  return { runId: 'run', sequence, type, timestamp: '2026-09-20T00:00:00.000Z', metadata };
}
function handle(events: readonly unknown[]): RunHandle<unknown> {
  return { id: 'run', profile: 'ephemeral',
    get result(): RunHandle<unknown>['result'] { throw new Error('Observation must not read results.'); },
    get cancel(): RunHandle<unknown>['cancel'] { throw new Error('Observation must not obtain cancellation authority.'); },
    async *observe() { for (const entry of events) yield entry as RunEvent; },
  };
}

describe('observer hook metadata export boundary', () => {
  it.each(['request', 'modelId', 'purpose'])('rejects primary-model content field %s before retention or export', async field => {
    const sink = vi.fn(); const observer = createObserver({ sink });
    try {
      const metadata = { ...base, stage: 'beforeModelCall', step: 3, [field]: 'SECRET_MODEL_REQUEST' };
      expect(await observer.observe(handle([event(1, 'hook.started', metadata)])).done()).toMatchObject({ reason: 'invalid_event' });
      expect(observer.inspect('run')?.recent).toEqual([]); expect(sink).not.toHaveBeenCalled();
      expect(JSON.stringify(observer.inspect())).not.toContain('SECRET_MODEL_REQUEST');
    } finally { await observer.close(); }
  });
  it('counts hook events without fabricating model/tool calls or per-hook metrics', async () => {
    const values = [event(1, 'run.started', { profile: 'ephemeral' })];
    for (const [index, stage] of stages.entries()) {
      values.push(event(values.length + 1, 'hook.started', { ...base, stage, step: index }));
      for (const status of states) values.push(event(values.length + 1, 'hook.completed', { ...base, stage, step: index, status }));
    }
    values.push(event(values.length + 1, 'run.completed', { status: 'succeeded', spentMicros: 0, reservedMicros: 0, calls: 0 }));
    const observer = createObserver();
    try {
      expect(await observer.observe(handle(values)).done()).toMatchObject({ reason: 'terminal' });
      expect(observer.inspect('run')).toMatchObject({ coverage: 'complete', status: 'succeeded',
        counters: { events: values.length, modelStarted: 0, modelCompleted: 0, toolStarted: 0, toolCompleted: 0 } });
      expect(observer.inspect('run')?.recent).toEqual(values);
    } finally { await observer.close(); }
  });

  it('continues to admit generated hook-action call IDs on ordinary tool events', async () => {
    const observer = createObserver(); const callId = `hook:${invocationId}:0`;
    try {
      const observation = observer.observe(handle([
        event(1, 'tool.started', { callId, toolId: 'read.policy' }),
        event(2, 'tool.completed', { callId, toolId: 'read.policy', status: 'succeeded', execution: 'succeeded', disclosure: 'released' }),
      ]));
      expect(await observation.done()).toMatchObject({ reason: 'source_ended' });
      expect(observer.inspect('run')?.counters).toMatchObject({ events: 2, rejected: 0, toolStarted: 1, toolCompleted: 1 });
    } finally { await observer.close(); }
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
  ])('rejects invalid started metadata before retention or optional export %#', async change => {
    const sink = vi.fn(); const observer = createObserver({ sink });
    try {
      expect(await observer.observe(handle([event(1, 'hook.started', { ...base, ...change })])).done()).toMatchObject({ reason: 'invalid_event' });
      expect(observer.inspect('run')).toMatchObject({ cursor: 0, recent: [], counters: { events: 0, rejected: 1 } });
      expect(sink).not.toHaveBeenCalled(); expect(JSON.stringify(observer.inspect())).not.toContain('SECRET_HOOK_CONTENT');
    } finally { await observer.close(); }
  });

  it.each(['hookId', 'hookVersion', 'stage', 'invocationId', 'step', 'attempt', 'status'])('requires completed field %s', async missing => {
    const metadata: Record<string, unknown> = { ...base, status: 'continued' }; delete metadata[missing];
    const observer = createObserver();
    try { expect(await observer.observe(handle([event(1, 'hook.completed', metadata)])).done()).toMatchObject({ reason: 'invalid_event' }); }
    finally { await observer.close(); }
  });

  it.each(['running', 'succeeded', 'allow', 'SECRET_HOOK_CONTENT', 1])('rejects unknown completion status %s', async status => {
    const observer = createObserver();
    try { expect(await observer.observe(handle([event(1, 'hook.completed', { ...base, status })])).done()).toMatchObject({ reason: 'invalid_event' }); }
    finally { await observer.close(); }
  });

  it('accepts exact identifier bounds and rejects content on completed events before export', async () => {
    const metadata = { ...base, hookId: 'h'.repeat(128), hookVersion: 'v'.repeat(128), status: 'continued' };
    const sink = vi.fn(); const observer = createObserver({ sink });
    const first = event(1, 'hook.completed', metadata);
    try {
      expect(await observer.observe(handle([first, event(2, 'hook.completed', { ...metadata, content: 'SECRET_HOOK_CONTENT' })])).done())
        .toMatchObject({ reason: 'invalid_event' });
      expect(observer.inspect('run')?.recent).toEqual([first]);
      expect(observer.inspect('run')?.counters).toMatchObject({ events: 1, rejected: 1 });
      await vi.waitFor(() => expect(observer.inspect().metrics.sinkDelivered).toBe(1));
      expect(JSON.stringify(sink.mock.calls)).not.toContain('SECRET_HOOK_CONTENT');
    } finally { await observer.close(); }
  });
});

describe('lifecycle catalog events', () => {
  const child = 'child-run';
  it('accepts step, delegate and every agent hook stage', async () => {
    const observer = createObserver();
    try {
      const catalog = ['beforeStep', 'beforeDelegate', 'afterStep', 'afterModelCall', 'afterToolCall', 'afterDelegate', 'onViolation',
        'afterExecution', 'onError', 'onCancel', 'onBlocked', 'onFinally'];
      const events = [event(1, 'run.started', { profile: 'ephemeral' }), event(2, 'step.started', { step: 0 }),
        event(3, 'delegate.started', { childRunId: child, childAgentId: 'helper' }), event(4, 'delegate.completed', { childRunId: child, status: 'succeeded' }),
        ...catalog.map((stage, index) => event(5 + index, 'hook.completed', { ...base, stage, status: 'continued' })),
        event(5 + catalog.length, 'step.completed', { step: 0, result: 'final' })];
      const summary = await observer.observe(handle(events)).done();
      expect(summary).not.toMatchObject({ reason: 'invalid_event' });
      expect(observer.inspect('run')?.recent).toHaveLength(events.length);
    } finally { await observer.close(); }
  });

  it.each([
    ['step.started', { step: -1 }], ['step.started', { step: 0, extra: 1 }], ['step.completed', { step: 0, result: 'maybe' }],
    ['delegate.started', { childRunId: 'run', childAgentId: 'self' }], ['delegate.started', { childRunId: child }],
    ['delegate.completed', { childRunId: child, status: 'running' }], ['delegate.completed', { childRunId: child, status: 'failed', output: 'SECRET' }],
  ] as const)('rejects malformed %s metadata', async (type, metadata) => {
    const observer = createObserver();
    try { expect(await observer.observe(handle([event(1, type, metadata)])).done()).toMatchObject({ reason: 'invalid_event' }); }
    finally { await observer.close(); }
  });
});
