import { describe, expect, it, vi } from 'vitest';
import type { ExecutionCompletion, ExecutionRef, ExecutionWaitSnapshot } from '@mayura/storage-contracts';
import { executionWaitFacade } from '@mayura/storage-sql/host';

const key = { scope: 'a'.repeat(64), streamId: 'release.joins', policyHash: 'b'.repeat(64) };
function reference(index = 1): ExecutionRef { return { kind: 'scheduled-workflow', runId: index.toString(16).padStart(64, '0'), definitionHash: 'c'.repeat(64), policyHash: key.policyHash }; }
function completion(index = 1): ExecutionCompletion { return { reference: reference(index), outcome: 'outcome_unknown', sourceVersion: 3, sourceEventSequence: 4 }; }
function snapshot(status: ExecutionWaitSnapshot['status'] = 'resolved'): ExecutionWaitSnapshot {
  return { id: 'join.release', version: status === 'cancelled' ? 2 : 1, definitionHash: 'd'.repeat(64), status,
    targets: [reference()], observations: status === 'resolved' ? [completion()] : [] };
}
const event = (sequence: number, type = 'wait.registered') => ({ sequence, type, createdAt: '2026-09-20T00:00:00.000Z', data: type === 'stream.created' ? {} : { waitId: 'join.release' } });

describe('execution wait driver boundary', () => {
  it('rejects input before calling the driver and captures the full immutable command before await', async () => {
    const request = vi.fn(async (_method: unknown, _input: unknown) => snapshot()); const store = executionWaitFacade(request);
    await expect(store.register({ ...key, id: 'invalid space', targets: [reference()] })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    expect(request).not.toHaveBeenCalled();
    const original = { ...key, id: 'join.release', targets: [reference()] }; const pending = store.register(original);
    original.targets.length = 0; original.streamId = 'changed';
    await expect(pending).resolves.toEqual(snapshot());
    const received = request.mock.calls[0]?.[1] as unknown as { targets: ExecutionRef[]; streamId: string };
    expect(received.targets).toEqual([reference()]); expect(received.streamId).toBe(key.streamId);
    expect(Object.isFrozen(received)).toBe(true); expect(Object.isFrozen(received.targets[0])).toBe(true);
  });
  it('exposes only finite store methods and snapshots successful responses deeply', async () => {
    const original = snapshot(); const store = executionWaitFacade(async () => original);
    const result = await store.inspect({ ...key, id: original.id });
    expect(Object.isFrozen(store)).toBe(true); expect(Object.keys(store).sort()).toEqual(['cancel', 'drainReady', 'events', 'initialize', 'inspect', 'materialize', 'open', 'register']);
    expect(result).toEqual(original); expect(result).not.toBe(original); expect(Object.isFrozen(result?.observations[0]?.reference)).toBe(true);
    expect(Object.isFrozen(original)).toBe(false);
  });
  it('permits void initialization/open and undefined missing/nonterminal reads only', async () => {
    const store = executionWaitFacade(async () => undefined);
    await expect(store.initialize()).resolves.toBeUndefined(); await expect(store.open(key)).resolves.toBeUndefined();
    await expect(store.inspect({ ...key, id: 'wait' })).resolves.toBeUndefined();
    await expect(store.materialize({ scope: key.scope, reference: reference() })).resolves.toBeUndefined();
    await expect(store.register({ ...key, id: 'wait', targets: [reference()] })).rejects.toMatchObject({ code: 'STORAGE_UNAVAILABLE' });
    await expect(store.cancel({ ...key, id: 'wait' })).rejects.toMatchObject({ code: 'STORAGE_UNAVAILABLE' });
    await expect(executionWaitFacade(async () => ({ secret: 'SECRET' })).open(key)).rejects.toMatchObject({ code: 'STORAGE_UNAVAILABLE' });
  });
  it('requires materialized observations to match the requested immutable reference', async () => {
    await expect(executionWaitFacade(async () => completion()).materialize({ scope: key.scope, reference: reference() })).resolves.toEqual(completion());
    await expect(executionWaitFacade(async () => completion(2)).materialize({ scope: key.scope, reference: reference() })).rejects.toMatchObject({ code: 'STORAGE_UNAVAILABLE' });
  });
  it('matches wait reply identity/policy and registration target order to the captured request', async () => {
    await expect(executionWaitFacade(async () => snapshot()).inspect({ ...key, id: 'another' })).rejects.toMatchObject({ code: 'STORAGE_UNAVAILABLE' });
    await expect(executionWaitFacade(async () => snapshot()).inspect({ ...key, policyHash: 'e'.repeat(64), id: 'join.release' })).rejects.toMatchObject({ code: 'STORAGE_UNAVAILABLE' });
    await expect(executionWaitFacade(async () => snapshot()).register({ ...key, id: 'join.release', targets: [reference(2)] })).rejects.toMatchObject({ code: 'STORAGE_UNAVAILABLE' });
    await expect(executionWaitFacade(async () => snapshot('waiting')).cancel({ ...key, id: 'join.release' })).rejects.toMatchObject({ code: 'STORAGE_UNAVAILABLE' });
    await expect(executionWaitFacade(async () => snapshot()).cancel({ ...key, id: 'join.release' })).resolves.toEqual(snapshot());
  });
  it.each([
    null, { ...snapshot(), rawOutput: 'SECRET' }, { ...snapshot(), observations: [{ ...completion(), error: 'SECRET' }] },
    { ...snapshot(), targets: 'SECRET'.repeat(65_536) },
  ])('redacts malformed result details (%#)', async value => {
    const pending = executionWaitFacade(async () => value).inspect({ ...key, id: 'join.release' });
    await expect(pending).rejects.toMatchObject({ code: 'STORAGE_UNAVAILABLE', message: 'Invalid execution-wait storage response.' });
  });
  it('does not execute output accessors and sanitizes hostile reflection failures', async () => {
    const get = vi.fn(() => { throw new Error('SECRET'); }); const value = { ...snapshot() };
    Object.defineProperty(value, 'targets', { enumerable: true, get });
    await expect(executionWaitFacade(async () => value).inspect({ ...key, id: 'join.release' })).rejects.toMatchObject({ code: 'STORAGE_UNAVAILABLE' });
    expect(get).not.toHaveBeenCalled();
    await expect(executionWaitFacade(async () => new Proxy({}, { ownKeys: get })).inspect({ ...key, id: 'join.release' })).rejects.toMatchObject({ message: 'Invalid execution-wait storage response.' });
  });
  it('supports full finite drains, freezes page elements and rejects duplicate or unready replies', async () => {
    const page = Array.from({ length: 32 }, (_, i) => ({ ...snapshot(), id: `wait.${i}` }));
    const result = await executionWaitFacade(async () => page).drainReady({ ...key, limit: 32 });
    expect(result).toEqual(page); expect(Object.isFrozen(result)).toBe(true); expect(Object.isFrozen(result[0]?.targets[0])).toBe(true);
    for (const bad of [[snapshot(), snapshot()], [snapshot('waiting')], Array(33).fill(snapshot()), { length: 0 }]) {
      await expect(executionWaitFacade(async () => bad).drainReady({ ...key, limit: 32 })).rejects.toMatchObject({ code: 'STORAGE_UNAVAILABLE' });
    }
    await expect(executionWaitFacade(async () => page).drainReady({ ...key, limit: 1 })).rejects.toMatchObject({ code: 'STORAGE_UNAVAILABLE' });
  });
  it('accepts exact contiguous metadata-only journal entries and empty pages', async () => {
    const page = [event(1, 'stream.created'), event(2), event(3, 'wait.resolved'), event(4, 'wait.cancelled')];
    const result = await executionWaitFacade(async () => page).events({ ...key, after: 0 });
    expect(result).toEqual(page); expect(Object.isFrozen(result)).toBe(true); expect(Object.isFrozen(result[0]?.data)).toBe(true);
    await expect(executionWaitFacade(async () => [event(3, 'wait.resolved')]).events({ ...key, after: 2 })).resolves.toEqual([event(3, 'wait.resolved')]);
    await expect(executionWaitFacade(async () => []).events({ ...key, after: Number.MAX_SAFE_INTEGER })).resolves.toEqual([]);
  });
  it.each([
    { page: [event(1)] }, { page: [event(2, 'stream.created')] }, { page: [event(1, 'stream.created'), event(3)] },
    { page: [event(1, 'stream.created'), event(2), event(2)] }, { page: [event(1, 'stream.created'), event(2, 'raw.payload')] },
    { page: [{ ...event(1, 'stream.created'), createdAt: '2026-09-20' }] },
    { page: [{ ...event(1, 'stream.created'), data: { waitId: 'wait' } }] },
    { page: [event(1, 'stream.created'), { ...event(2), data: { waitId: 'wait', output: 'SECRET' } }] },
    { page: [event(1, 'stream.created'), { ...event(2), data: { waitId: 'invalid space' } }] },
    { page: Array.from({ length: 258 }, (_, i) => event(i + 1, i === 0 ? 'stream.created' : 'wait.registered')) },
  ])('rejects event gaps, unsupported fields/types/times and impossible heads (%#)', async ({ page }) => {
    await expect(executionWaitFacade(async () => page).events({ ...key, after: 0 })).rejects.toMatchObject({ code: 'STORAGE_UNAVAILABLE' });
  });
});
