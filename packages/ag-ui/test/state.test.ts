import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Authorizer } from '@mayura/core';
import { stateReader, type AgUiStateVersion, type AgUiStateContext, type StateLimits } from '../src/state.js';
import type { AgUiState, AgUiStatePatchOperation } from '../src/index.js';

const limits: StateLimits = { maxStateBytes: 4096, maxStatePatchBytes: 2048, maxStatePatchOperations: 32,
  maxStateReads: 20, maxConcurrentStateReads: 2, stateReadTimeoutMs: 100 };
const context = (signal = new AbortController().signal) => ({ scope: { principalId: 'alice', projectId: 'shop' }, agentId: 'support', threadId: 'thread-1', runId: 'ui-1', signal });
afterEach(() => vi.useRealTimers());
// Independent RFC 6902 subset applier: assert semantic reconstruction, not just a particular generated patch shape.
function apply(initial: any, operations: readonly AgUiStatePatchOperation[]): any {
  let document = structuredClone(initial);
  for (const operation of operations) {
    if (operation.path === '') { if (operation.op === 'remove') throw new Error('Cannot remove root'); document = structuredClone(operation.value); continue; }
    const path = operation.path.slice(1).split('/').map(part => part.replace(/~1/g, '/').replace(/~0/g, '~'));
    let target = document; for (const token of path.slice(0, -1)) target = target[token]; const key = path.at(-1)!;
    if (operation.op === 'remove') delete target[key]; else target[key] = structuredClone(operation.value);
  }
  return document;
}
describe('AG-UI producer state cursor', () => {
  it('reconstructs nested removals/additions, escaped pointers, atomic arrays and root type changes', async () => {
    const states: AgUiState[] = [
      { 'a/b': { '~key': 1, gone: true }, list: [1, 2], nullable: null },
      { 'a/b': { '~key': 2, added: true }, list: [2], nullable: { value: 3 } }, null, ['root array'], false, 'root string', 7,
    ];
    let revision = 0; const stream = await stateReader({ read: () => ({ revision, state: states[revision]! }) }, limits)(context(), async () => {});
    const initial = stream.initial(); if (initial.type !== 'STATE_SNAPSHOT') throw new Error('Snapshot required');
    let state: any = initial.snapshot;
    for (revision = 1; revision < states.length; revision++) {
      const event = await stream.refresh(); if (event?.type !== 'STATE_DELTA') throw new Error('Delta required');
      state = apply(state, event.delta); expect(state).toEqual(states[revision]);
      expect(event.metadata.mayura).toEqual({ previousStateRevision: revision - 1, stateRevision: revision });
    }
  });
  it('copies/freeze state and treats reordered object keys as the same value', async () => {
    const object = { a: 1, b: 2 }; let value: AgUiStateVersion = { revision: 0, state: object };
    const stream = await stateReader({ read: () => value }, limits)(context(), async () => {});
    object.a = 99; const initial = stream.initial(); expect(initial).toMatchObject({ snapshot: { a: 1, b: 2 } });
    value = { revision: 0, state: { b: 2, a: 1 } }; expect(await stream.refresh()).toBeUndefined();
    value = { revision: 1, state: { b: 2, a: 1 } }; expect(await stream.refresh()).toMatchObject({ type: 'STATE_DELTA', delta: [] });
  });
  it.each(['backwards', 'changed-without-revision'] as const)('refuses %s revisions', async kind => {
    let value = { revision: 2, state: { count: 1 } };
    const stream = await stateReader({ read: () => value }, limits)(context(), async () => {});
    value = { revision: kind === 'backwards' ? 1 : 2, state: { count: 2 } };
    await expect(stream.refresh()).rejects.toMatchObject({ code: 'STATE_REVISION_CONFLICT' });
  });
  it.each([{ maxStatePatchOperations: 1 }, { maxStatePatchBytes: 2 }])('resynchronizes with a complete snapshot when patch limits are reached: %j', async changes => {
    let value = { revision: 0, state: { a: 1, b: 2 } };
    const stream = await stateReader({ read: () => value }, { ...limits, ...changes })(context(), async () => {});
    value = { revision: 3, state: { a: 4, b: 5 } };
    expect(await stream.refresh()).toMatchObject({ type: 'STATE_SNAPSHOT', snapshot: value.state, metadata: { mayura: { previousStateRevision: 0, stateRevision: 3 } } });
  });
  it.each([undefined, { revision: -1, state: {} }, { revision: 1.5, state: {} }, { revision: 0 }, { revision: 0, state: {}, extra: true },
    { revision: 0, state: { get value() { throw new Error('GETTER_MUST_NOT_RUN'); } } }, { revision: 0, state: 'x'.repeat(5000) }])('rejects invalid or oversized producer state without leaking source errors', async raw => {
    const read = vi.fn(() => raw as AgUiStateVersion);
    await expect(stateReader({ read }, limits)(context(), async () => {})).rejects.toMatchObject({ code: 'INVALID_STATE' });
  });
  it('requires scoped thread disclosure before reading and again before publication', async () => {
    const check = vi.fn(async () => {}); const require = vi.fn(async () => {});
    const read = vi.fn(() => ({ revision: 0, state: {} }));
    const stream = await stateReader({ read, authorization: { require } as unknown as Authorizer }, limits)(context(), check);
    expect(require).toHaveBeenCalledWith({ principalId: 'alice', projectId: 'shop' }, 'read_state',
      { kind: 'thread', id: 'thread-1', scope: { principalId: 'alice', projectId: 'shop' }, ownerId: 'alice' }, { signal: expect.any(AbortSignal) });
    require.mockRejectedValueOnce(new Error('PRIVATE_POLICY')); await expect(stream.authorize()).rejects.toMatchObject({ code: 'STATE_ACCESS_DENIED' });
    check.mockRejectedValueOnce(new Error('denied')); await expect(stream.refresh()).rejects.toThrow('denied'); expect(read).toHaveBeenCalledTimes(1);
  });
  it('bounds callback attempts per stream', async () => {
    const read = vi.fn(() => ({ revision: 0, state: {} }));
    const stream = await stateReader({ read }, { ...limits, maxStateReads: 1 })(context(), async () => {});
    await expect(stream.refresh()).rejects.toMatchObject({ code: 'STATE_READ_LIMIT' }); expect(read).toHaveBeenCalledTimes(1);
  });
  it('times out without releasing an uncooperative source slot, and frees it only on settlement', async () => {
    vi.useFakeTimers(); let resolve!: (value: AgUiStateVersion) => void; let signal: AbortSignal | undefined;
    const read = vi.fn((ctx: AgUiStateContext) => { signal = ctx.signal; return new Promise<AgUiStateVersion>(yes => { resolve = yes; }); });
    const prepare = stateReader({ read }, { ...limits, maxConcurrentStateReads: 1 });
    const first = prepare(context(), async () => {}); const rejected = expect(first).rejects.toMatchObject({ code: 'STATE_READ_TIMEOUT' });
    await vi.advanceTimersByTimeAsync(101); await rejected; expect(signal?.aborted).toBe(true);
    await expect(prepare(context(), async () => {})).rejects.toMatchObject({ code: 'STATE_READ_BUSY' }); expect(read).toHaveBeenCalledTimes(1);
    resolve({ revision: 0, state: {} }); await vi.advanceTimersByTimeAsync(0);
    read.mockImplementationOnce(() => Promise.resolve({ revision: 0, state: {} }));
    expect((await prepare(context(), async () => {})).initial()).toMatchObject({ type: 'STATE_SNAPSHOT' });
  });
  it('cancels source reads using the observer signal without exposing arbitrary exceptions', async () => {
    const controller = new AbortController(); let readSignal: AbortSignal | undefined;
    let entered!: () => void; const ready = new Promise<void>(yes => { entered = yes; });
    const prepare = stateReader({ read: ctx => { readSignal = ctx.signal; entered(); return new Promise<AgUiStateVersion>(() => {}); } }, limits);
    const pending = prepare(context(controller.signal), async () => {}); await ready; controller.abort();
    await expect(pending).rejects.toMatchObject({ code: 'ABORTED' }); expect(readSignal?.aborted).toBe(true);
  });
});
