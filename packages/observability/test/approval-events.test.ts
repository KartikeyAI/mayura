import { describe, expect, it } from 'vitest';
import { eventSnapshot } from '../src/validation.js';

const base = { runId: 'run-1', sequence: 4, timestamp: new Date(0).toISOString() };
const digest = 'a'.repeat(64);

describe('approval events', () => {
  it('carry the call, the digest and the decision', () => {
    const requested = { callId: 'c1', toolId: 'orders.refund', digest, expiresAtMs: 1_000 };
    expect(eventSnapshot({ ...base, type: 'approval.requested', metadata: requested }).metadata).toEqual(requested);
    const resolved = { callId: 'c1', toolId: 'orders.refund', decision: 'approved', actorId: 'user-7' };
    expect(eventSnapshot({ ...base, type: 'approval.resolved', metadata: resolved }).metadata).toEqual(resolved);
    expect(eventSnapshot({ ...base, type: 'approval.resolved', metadata: { callId: 'c1', toolId: 't', decision: 'expired' } }).metadata['decision']).toBe('expired');
  });

  it('refuse malformed approval metadata', () => {
    const bad = [
      { type: 'approval.requested', metadata: { callId: 'c1', toolId: 't', digest: 'not-hex', expiresAtMs: 1 } },
      { type: 'approval.requested', metadata: { callId: 'c1', toolId: 't', digest, expiresAtMs: 1, input: 'PRIVATE' } },
      { type: 'approval.resolved', metadata: { callId: 'c1', toolId: 't', decision: 'maybe' } },
      { type: 'approval.resolved', metadata: { callId: 'c1', toolId: 't', decision: 'rejected', reason: 'PRIVATE' } },
    ];
    for (const event of bad) expect(() => eventSnapshot({ ...base, ...event }), JSON.stringify(event)).toThrow();
  });
});
