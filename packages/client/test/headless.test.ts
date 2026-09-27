import { describe, expect, it, vi } from 'vitest';
import { ClientError, type ClientEvent, type RemoteHumanRequest, type RemoteRun, type RemoteSnapshot } from '../src/index.js';
import { createHeadlessRunStore, createHumanRequestView, createRunActivityProjection } from '../src/headless.js';

const id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
function deferred<T>() { let resolve!: (value: T) => void; let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
function snapshot(status: RemoteSnapshot['status'] = 'running'): RemoteSnapshot { return Object.freeze({ id, status,
  budget: Object.freeze({ spentMicros: 1, reservedMicros: 2, calls: 3 }), evidence: Object.freeze([]) }); }
function event(sequence: number, type: ClientEvent['type'], metadata?: ClientEvent['metadata']): ClientEvent { return Object.freeze({ runId: id, sequence, type,
  timestamp: '2026-09-24T00:00:00.000Z', metadata: Object.freeze(metadata ?? (type === 'events.gap' ? { from: sequence - 1, to: sequence } : {})) }); }
function run(overrides: Partial<RemoteRun> = {}): RemoteRun { return Object.freeze({ id, inspect: async () => snapshot(), cancel: async () => {},
  result: async () => undefined, events: async function* () {}, ...overrides }); }

describe('headless run UI store', () => {
  it('is inert at construction and publishes immutable explicit refreshes', async () => {
    const inspect = vi.fn(async () => snapshot()); const remote = run({ inspect }); const store = createHeadlessRunStore({ run: remote });
    expect(inspect).not.toHaveBeenCalled(); expect(store.getSnapshot()).toMatchObject({ connection: 'idle', revision: 0 });
    const listener = vi.fn(); store.subscribe(() => { listener(); throw new Error('PRIVATE UI FAILURE'); });
    const current = await store.refresh(); expect(current).toMatchObject({ connection: 'stopped', snapshot: { status: 'running' } });
    expect(listener).toHaveBeenCalledTimes(2); expect(Object.isFrozen(current)).toBe(true); expect(Object.isFrozen(current.activity)).toBe(true);
  });

  it('projects bounded activity, explicit gaps and a terminal refresh', async () => {
    const remote = run({ inspect: async () => snapshot('succeeded'), events: async function* () {
      yield event(1, 'model.started'); yield event(2, 'model.completed'); yield event(4, 'events.gap'); yield event(5, 'run.completed');
    } });
    const store = createHeadlessRunStore({ run: remote, maxEvents: 3 }); const result = await store.observe();
    expect(result).toMatchObject({ connection: 'stopped', lastSequence: 5, hasGap: true, activity: { models: 0, tools: 0, hooks: 0 }, snapshot: { status: 'succeeded' } });
    expect(result.events.map(item => item.sequence)).toEqual([2, 4, 5]); expect(Object.isFrozen(result.events)).toBe(true);
  });

  it('does not retry an ambiguous cancellation and blocks a concurrent duplicate', async () => {
    const pending = deferred<void>(); const cancel = vi.fn(() => pending.promise); const store = createHeadlessRunStore({ run: run({ cancel }) });
    const first = store.cancel(); await vi.waitFor(() => expect(cancel).toHaveBeenCalledOnce());
    await expect(store.cancel()).rejects.toMatchObject({ code: 'VIEW_BUSY' }); pending.reject(new Error('PRIVATE TRANSPORT DETAIL'));
    const error: unknown = await first.catch(caught => caught); expect(error).toMatchObject({ code: 'VIEW_FAILED' }); expect(String(error)).not.toContain('PRIVATE');
    expect(cancel).toHaveBeenCalledOnce();
  });

  it('disposal aborts an active observer without turning it into a UI error', async () => {
    const began = deferred<void>(); const remote = run({ events: async function* (options) { began.resolve();
      await new Promise<void>((_resolve, reject) => options?.signal?.addEventListener('abort', () => reject(new ClientError('ABORTED')), { once: true }));
    } });
    const store = createHeadlessRunStore({ run: remote }); const observing = store.observe(); await began.promise; store.dispose();
    expect((await observing).connection).toBe('disposed'); expect(store.getSnapshot().errorCode).toBeNull();
    await expect(store.refresh()).rejects.toMatchObject({ code: 'VIEW_DISPOSED' });
  });

  it('allows only one explicit observer and bounds subscribers', async () => {
    const began = deferred<void>(); const remote = run({ events: async function* (options) { began.resolve();
      await new Promise<void>((_resolve, reject) => options?.signal?.addEventListener('abort', () => reject(new ClientError('ABORTED')), { once: true }));
    } });
    const store = createHeadlessRunStore({ run: remote, maxSubscribers: 1 }); const stop = store.subscribe(() => {});
    expect(() => store.subscribe(() => {})).toThrow(expect.objectContaining({ code: 'VIEW_SUBSCRIBER_LIMIT' })); stop();
    const first = store.observe(); await began.promise; await expect(store.observe()).rejects.toMatchObject({ code: 'VIEW_BUSY' }); store.dispose(); await first;
  });

  it('rejects mutable or cross-run data before exposing it to subscribers', async () => {
    const mutable = { id, status: 'running', budget: { spentMicros: 0, reservedMicros: 0, calls: 0 }, evidence: [] } as RemoteSnapshot;
    const store = createHeadlessRunStore({ run: run({ inspect: async () => mutable }) });
    await expect(store.refresh()).rejects.toMatchObject({ code: 'INVALID_VIEW_INPUT' }); expect(store.getSnapshot().errorCode).toBe('INVALID_VIEW_INPUT');
  });
});

describe('headless human request views', () => {
  const request = (overrides: Partial<RemoteHumanRequest> = {}): RemoteHumanRequest => Object.freeze({ id: 'review', agentId: 'agent', kind: 'information',
    schemaId: 'answer-v1', schemaDigest: 'a'.repeat(64), prompt: '<strong>Untrusted prompt</strong>', digest: 'b'.repeat(64), status: 'waiting', ...overrides });

  it('returns text-only actionable metadata without interpreting markup', () => {
    expect(createHumanRequestView(request({ deadlineAtMs: 1_200 }), 1_000)).toEqual({ id: 'review', agentId: 'agent', kind: 'information', status: 'waiting',
      prompt: '<strong>Untrusted prompt</strong>', canRespond: true, urgency: 'due_soon', statusText: 'Response required', actionText: 'Provide information', deadlineAtMs: 1_200 });
  });

  it('makes expired and resolved requests non-actionable', () => {
    expect(createHumanRequestView(request({ deadlineAtMs: 999 }), 1_000)).toMatchObject({ canRespond: false, urgency: 'expired', actionText: null });
    expect(createHumanRequestView(request({ status: 'answered' }), 1_000)).toMatchObject({ canRespond: false, urgency: 'resolved', statusText: 'Answered' });
    expect(() => createHumanRequestView({ ...request() }, 1_000)).toThrow(expect.objectContaining({ code: 'INVALID_VIEW_INPUT' }));
    expect(() => createHumanRequestView(request({ kind: 'correction' }), 1_000)).toThrow(expect.objectContaining({ code: 'INVALID_VIEW_INPUT' }));
  });
});

describe('headless run activity projection', () => {
  it('pairs content-free model, tool and run events into stable immutable activity', async () => {
    const remote = run({ inspect: async () => snapshot('succeeded'), events: async function* () {
      yield event(1, 'run.started'); yield event(2, 'model.started', { step: 1, modelCall: 1 });
      yield event(3, 'model.completed', { step: 1, response: 'tool_calls' });
      yield event(4, 'tool.started', { callId: 'call-1', toolId: 'catalog.lookup' });
      yield event(5, 'tool.completed', { callId: 'call-1', toolId: 'catalog.lookup', status: 'succeeded' });
      yield event(6, 'run.completed', { status: 'succeeded' });
    } });
    const projection = createRunActivityProjection(await createHeadlessRunStore({ run: remote }).observe());
    expect(projection).toMatchObject({ complete: true, items: [
      { id: 'run', kind: 'run', status: 'completed', startedSequence: 1, completedSequence: 6 },
      { id: 'model:primary:step:1', kind: 'model', status: 'completed', startedSequence: 2, completedSequence: 3 },
      { id: 'tool:call-1', kind: 'tool', label: 'catalog.lookup', status: 'completed', startedSequence: 4, completedSequence: 5 },
    ] });
    expect(Object.isFrozen(projection)).toBe(true); expect(projection.items.every(Object.isFrozen)).toBe(true);
  });

  it('marks incomplete active work unknown after a gap or bounded-history truncation', async () => {
    const remote = run({ events: async function* () { yield event(3, 'events.gap', { from: 1, to: 3 }); yield event(4, 'tool.started', { callId: 'call-2', toolId: 'write.record' }); } });
    const projection = createRunActivityProjection(await createHeadlessRunStore({ run: remote }).observe());
    expect(projection).toMatchObject({ complete: false, items: [{ id: 'tool:call-2', status: 'unknown', completedSequence: null }] });
  });

  it('does not leave an operation active after a terminal run event', async () => {
    const remote = run({ inspect: async () => snapshot('failed'), events: async function* () {
      yield event(1, 'run.started'); yield event(2, 'model.started', { step: 1, modelCall: 1 }); yield event(3, 'run.completed', { status: 'failed' });
    } });
    const projection = createRunActivityProjection(await createHeadlessRunStore({ run: remote }).observe());
    expect(projection).toMatchObject({ complete: true, items: [{ status: 'failed' }, { kind: 'model', status: 'unknown' }] });
  });

  it('does not expose hostile metadata as an activity identity or label', async () => {
    const hostile = '<img src=x onerror=alert(1)>'.repeat(20); const remote = run({ events: async function* () {
      yield event(1, 'tool.started', { callId: hostile, toolId: hostile }); yield event(2, 'tool.completed', { callId: hostile, toolId: hostile, status: 'failed' });
    } });
    const projection = createRunActivityProjection(await createHeadlessRunStore({ run: remote }).observe());
    expect(JSON.stringify(projection)).not.toContain('<img'); expect(projection.items.every(item => item.label === 'Tool call')).toBe(true);
  });

  it('rejects mutable forged state', () => {
    expect(() => createRunActivityProjection({ revision: 0, connection: 'idle', snapshot: null, events: [], lastSequence: 0, hasGap: false,
      activity: { models: 0, tools: 0, hooks: 0 }, errorCode: null, streamedOutput: null })).toThrow(expect.objectContaining({ code: 'INVALID_VIEW_INPUT' }));
  });
});

describe('lifecycle catalog activity', () => {
  it('projects step and delegation items alongside observer hook events', async () => {
    const child = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
    const remote = run({ inspect: async () => snapshot('failed'), events: async function* () {
      yield event(1, 'run.started'); yield event(2, 'step.started', { step: 0 });
      yield event(3, 'delegate.started', { childRunId: child, childAgentId: 'researcher' });
      yield event(4, 'delegate.completed', { childRunId: child, status: 'failed' });
      yield event(5, 'hook.started', { hookId: 'audit', hookVersion: '1', stage: 'afterStep', invocationId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', step: 0, attempt: 1 });
      yield event(6, 'hook.completed', { hookId: 'audit', hookVersion: '1', stage: 'afterStep', invocationId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', step: 0, attempt: 1, status: 'continued' });
      yield event(7, 'step.completed', { step: 0, result: 'stopped' });
      yield event(8, 'run.completed', { status: 'failed' });
    } });
    const projection = createRunActivityProjection(await createHeadlessRunStore({ run: remote }).observe());
    expect(projection).toMatchObject({ complete: true, items: [
      { id: 'run', kind: 'run', status: 'failed' },
      { id: 'step:0', kind: 'step', label: 'Step 1', status: 'completed', startedSequence: 2, completedSequence: 7 },
      { id: `delegate:${child}`, kind: 'delegate', label: 'researcher', status: 'failed', startedSequence: 3, completedSequence: 4 },
      { id: 'hook:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', kind: 'hook', label: 'audit', status: 'completed' },
    ] });
  });
});
