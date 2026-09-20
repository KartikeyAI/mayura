import { describe, expect, it } from 'vitest';
import { createCommand, nextCounter, submissionDigest } from '@mayura/storage-sql/host';
import type { CreateRecord } from '@mayura/storage-contracts';

describe('storage submission encoding', () => {
  const command = (): CreateRecord => ({
    scope: 'scope', id: 'id', idempotencyKey: 'key', definitionHash: 'hash',
    state: { z: '日本語', a: -0 }, events: [],
  });

  it('matches a fixed UTF-8 canonical encoding vector, including negative zero', () => {
    expect(submissionDigest(createCommand(command()))).toBe('e4d2b9963c3a491dc747689ac88b089d57bef9a0ba5fc593e2cd5257bbf97658');
    expect(submissionDigest(createCommand({ ...command(), state: { a: 0, z: '日本語' } }))).toBe(submissionDigest(createCommand(command())));
  });

  it('preserves array and initial-event ordering in the digest', () => {
    const first = createCommand({ ...command(), state: { values: [1, 2] }, events: [{ type: 'a', data: {} }, { type: 'b', data: {} }] });
    const second = createCommand({ ...first, state: { values: [2, 1] } });
    const third = createCommand({ ...first, events: [...first.events].reverse() });
    expect(submissionDigest(first)).not.toBe(submissionDigest(second));
    expect(submissionDigest(first)).not.toBe(submissionDigest(third));
  });

  it('rejects counter overflow and excessive events', () => {
    expect(() => nextCounter(Number.MAX_SAFE_INTEGER, 1)).toThrow();
    expect(() => createCommand({ ...command(), events: Array.from({ length: 1_001 }, () => ({ type: 'item', data: {} })) })).toThrow();
  });
});
