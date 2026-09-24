import { describe, expect, it, vi } from 'vitest';
import { ClientError, type ClientEvent, type RemoteHumanRequest, type RemoteRun, type RemoteSnapshot } from '../src/index.js';
import { createHeadlessRunStore, createHumanRequestView } from '../src/headless.js';

const id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
function deferred<T>() { let resolve!: (value: T) => void; let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
function snapshot(status: RemoteSnapshot['status'] = 'running'): RemoteSnapshot { return Object.freeze({ id, status,
  budget: Object.freeze({ spentMicros: 1, reservedMicros: 2, calls: 3 }), evidence: Object.freeze([]) }); }
function event(sequence: number, type: ClientEvent['type']): ClientEvent { return Object.freeze({ runId: id, sequence, type,
  timestamp: '2026-09-24T00:00:00.000Z', metadata: Object.freeze(type === 'events.gap' ? { from: sequence - 1, to: sequence } : {}) }); }
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
