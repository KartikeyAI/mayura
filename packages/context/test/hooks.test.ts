import { describe, expect, it, vi } from 'vitest';
import type { Scope } from '@mayura/core';
import { assembleContext, type AfterContextBuildEvent, type AssembleContextOptions, type BeforeContextBuildEvent, type ContextCandidate } from '../src/index.js';

const scope: Scope = { principalId: 'alice', projectId: 'project-a' };
const item = (id: string): ContextCandidate => ({ id, scope, source: { id: `source.${id}`, revision: '1', kind: 'document' },
  provenance: { reference: `document://${id}`, observedAt: '2026-09-20T00:00:00.000Z', origin: 'observed', confidence: 0.9 },
  kind: 'evidence', sensitivity: 'internal', trust: 'untrusted', content: { note: `content of ${id}` } });
const options = (overrides: Partial<AssembleContextOptions> = {}): AssembleContextOptions => ({
  scope, policyVersion: 'policy-1', asOf: '2026-09-20T12:00:00.000Z', candidates: [item('one'), item('two')],
  sources: ['one', 'two'].map(id => ({ scope, id: `source.${id}`, revision: '1', status: 'active' as const })),
  allowedSensitivities: ['internal'], budget: { maxBytes: 100_000, maxEstimatedTokens: 100_000 }, ...overrides,
});

describe('context build lifecycle hooks', () => {
  it('delivers metadata-only before/after views in order and returns the unchanged assembly', async () => {
    const calls: string[] = [];
    const before = vi.fn((_event: BeforeContextBuildEvent, _context: { stage: string }) => { calls.push('before'); return { decision: 'continue' as const }; });
    const after = vi.fn((_event: AfterContextBuildEvent) => { calls.push('after'); return { decision: 'continue' as const }; });
    const plain = await assembleContext(options());
    const hooked = await assembleContext(options({ hooks: { beforeContextBuild: before, afterContextBuild: after } }));
    expect(calls).toEqual(['before', 'after']);
    expect(hooked.fingerprint).toBe(plain.fingerprint);
    const beforeEvent = before.mock.calls[0]![0];
    expect(beforeEvent).toMatchObject({ scope, policyVersion: 'policy-1', candidateCount: 2, sourceCount: 2,
      budget: { maxBytes: 100_000, maxEstimatedTokens: 100_000, reservedBytes: 0, reservedTokens: 0 } });
    const afterEvent = after.mock.calls[0]![0];
    expect(afterEvent.fingerprint).toBe(plain.fingerprint);
    expect(afterEvent.selected.map(entry => entry.id)).toEqual(['one', 'two']);
    expect(Object.isFrozen(afterEvent) && Object.isFrozen(afterEvent.selected[0])).toBe(true);
    // Views carry digests, never content.
    expect(JSON.stringify([beforeEvent, afterEvent])).not.toContain('content of');
    expect(before.mock.calls[0]![1]).toMatchObject({ stage: 'beforeContextBuild' });
  });

  it('fails closed when either hook blocks, throws, returns garbage or times out', async () => {
    await expect(assembleContext(options({ hooks: { beforeContextBuild: () => ({ decision: 'block' }) } }))).rejects.toMatchObject({ code: 'GUARD_BLOCKED' });
    await expect(assembleContext(options({ hooks: { afterContextBuild: () => ({ decision: 'block' }) } }))).rejects.toMatchObject({ code: 'GUARD_BLOCKED' });
    await expect(assembleContext(options({ hooks: { afterContextBuild: () => { throw new Error('x'); } } }))).rejects.toMatchObject({ code: 'GUARD_UNAVAILABLE' });
    await expect(assembleContext(options({ hooks: { beforeContextBuild: (() => ({ decision: 'maybe' })) as never } }))).rejects.toMatchObject({ code: 'GUARD_UNAVAILABLE' });
    await expect(assembleContext(options({ hooks: { beforeContextBuild: () => new Promise(() => {}), timeoutMs: 20 } }))).rejects.toMatchObject({ code: 'TIMEOUT' });
  });

  it('does not run the after hook when assembly itself fails, and honors cancellation', async () => {
    const after = vi.fn(() => ({ decision: 'continue' as const }));
    await expect(assembleContext(options({ budget: { maxBytes: 10, maxEstimatedTokens: 10, reservedBytes: 11 }, hooks: { afterContextBuild: after } })))
      .rejects.toMatchObject({ code: 'LIMIT_EXCEEDED' });
    expect(after).not.toHaveBeenCalled();
    const controller = new AbortController(); controller.abort();
    await expect(assembleContext(options({ signal: controller.signal, hooks: { beforeContextBuild: () => ({ decision: 'continue' }) } })))
      .rejects.toMatchObject({ code: 'CANCELLED' });
  });

  it('rejects malformed hook options before any callback', async () => {
    for (const hooks of [{ unknown: () => {} }, { beforeContextBuild: 'x' }, { timeoutMs: 0 }]) {
      await expect(assembleContext(options({ hooks: hooks as never }))).rejects.toMatchObject({ code: 'INVALID_CONFIG' });
    }
  });
});
