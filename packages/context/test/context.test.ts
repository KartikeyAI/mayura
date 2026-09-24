import { describe, expect, it, vi } from 'vitest';
import fc from 'fast-check';
import { jsonValue, MayuraError, type Scope } from '@mayura/core';
import { assembleContext, byteTokenEstimator, type AssembleContextOptions, type ContextBudget, type ContextCandidate, type ContextKind, type SourceState } from '../src/index.js';

const scope: Scope = { principalId: 'alice', projectId: 'project-a' };
const asOf = '2026-09-20T12:00:00.000Z';
const continuity: readonly ContextKind[] = ['hard_constraint', 'pending_approval', 'unresolved_blocker', 'outstanding_task'];

function candidate(id: string, overrides: Partial<ContextCandidate> = {}): ContextCandidate {
  return { id, scope, source: { id: `source.${id}`, revision: '1', kind: 'document' },
    provenance: { reference: `document://${id}`, observedAt: '2026-09-20T00:00:00.000Z', origin: 'observed', confidence: 0.9 },
    kind: 'evidence', sensitivity: 'internal', trust: 'untrusted', content: { note: id }, ...overrides,
  };
}
function options(candidates: readonly ContextCandidate[], budget: Partial<ContextBudget> = {}, overrides: Partial<AssembleContextOptions> = {}): AssembleContextOptions {
  const sources: SourceState[] = candidates.map((item) => ({ scope: item.scope, id: item.source.id, revision: item.source.revision, status: 'active' }));
  return { scope, policyVersion: 'policy-1', asOf, candidates, sources, allowedSensitivities: ['public', 'internal'],
    budget: { maxBytes: 1_000_000, maxEstimatedTokens: 1_000_000, ...budget }, ...overrides,
  };
}

describe('native deterministic context assembly', () => {
  it('automatically preserves all unresolved continuity categories regardless of priority', async () => {
    const items = continuity.map((kind) => candidate(kind, { kind, priority: -100, pinned: false }));
    items.push(candidate('explicit-pin', { pinned: true }), candidate('optional', { priority: 100 }));
    const result = await assembleContext(options(items));
    expect(result.selected.slice(0, 5).map((item) => item.id).sort()).toEqual([...continuity, 'explicit-pin'].sort());
    expect(result.selected.filter((item) => item.required)).toHaveLength(5);
    expect(result.selected.find((item) => item.id === 'pending_approval')?.kind).toBe('pending_approval');
    expect(result.selected.find((item) => item.id === 'pending_approval')?.trust).toBe('untrusted');
  });

  it('fails explicitly rather than dropping a required item when either reserved budget overflows', async () => {
    const item = candidate('required', { pinned: true, content: 'x'.repeat(2_000) });
    await expect(assembleContext(options([item], { maxBytes: 500 }))).rejects.toMatchObject({ code: 'LIMIT_EXCEEDED' });
    await expect(assembleContext(options([item], { maxEstimatedTokens: 500 }))).rejects.toMatchObject({ code: 'LIMIT_EXCEEDED' });
    const reference = await assembleContext(options([item]));
    await expect(assembleContext(options([item], { maxBytes: reference.usage.bytes, reservedBytes: 1 }))).rejects.toMatchObject({ code: 'LIMIT_EXCEEDED' });
    await expect(assembleContext(options([item], { maxEstimatedTokens: reference.usage.estimatedTokens, reservedTokens: 1 }))).rejects.toMatchObject({ code: 'LIMIT_EXCEEDED' });
  });

  it('ranks required first, then priority, recency, and stable lexical ID deterministically', async () => {
    const old = candidate('old', { priority: 5 });
    const recent = candidate('z-recent', { priority: 5, provenance: { ...old.provenance, observedAt: '2026-09-21T00:00:00.000Z' } });
    const tie = candidate('a-recent', { priority: 5, provenance: recent.provenance });
    const items = [old, recent, tie, candidate('top', { priority: 6 }), candidate('required', { pinned: true, priority: -10 })];
    const first = await assembleContext(options(items)); const second = await assembleContext(options([...items].reverse()));
    expect(first.selected.map((item) => item.id)).toEqual(['required', 'top', 'a-recent', 'z-recent', 'old']);
    expect(first.serialized).toBe(second.serialized); expect(first.fingerprint).toBe(second.fingerprint);
  });

  it('skips an oversized high-priority optional item and admits a smaller lower-priority item', async () => {
    const small = candidate('small', { content: 'small' });
    const huge = candidate('huge', { priority: 100, content: 'x'.repeat(5_000) });
    const reference = await assembleContext(options([small]));
    const result = await assembleContext(options([huge, small], { maxBytes: reference.usage.bytes }));
    expect(result.selected.map((item) => item.id)).toEqual(['small']);
    expect(result.excluded).toEqual([{ position: 0, reason: 'byte_budget', candidateId: 'huge', sourceId: 'source.huge', revision: '1' }]);
  });

  it('records a distinct token-estimate exclusion when bytes fit but token capacity does not', async () => {
    const item = candidate('optional'); const reference = await assembleContext(options([item]));
    const result = await assembleContext(options([item], { maxEstimatedTokens: reference.usage.estimatedTokens - 1 }));
    expect(result.selected).toEqual([]); expect(result.excluded[0]?.reason).toBe('token_budget');
    expect(result.usage.bytes).toBe(new TextEncoder().encode(result.serialized).length);
    expect(result.usage.estimatedTokens).toBe(byteTokenEstimator.estimate(result.serialized));
  });

  it('excludes other scopes without disclosing their candidate identity, source, provenance, or content', async () => {
    const foreign = candidate('PRIVATE-ID', { scope: { principalId: 'bob', projectId: 'project-a' }, pinned: true, content: 'PRIVATE-CONTENT' });
    const otherProject = candidate('PRIVATE-PROJECT', { scope: { principalId: 'alice', projectId: 'project-b' }, kind: 'hard_constraint' });
    const result = await assembleContext(options([foreign, otherProject, candidate('ours')]));
    expect(result.selected.map((item) => item.id)).toEqual(['ours']);
    expect(result.excluded).toEqual([{ position: 0, reason: 'scope_mismatch' }, { position: 1, reason: 'scope_mismatch' }]);
    expect(JSON.stringify(result)).not.toContain('PRIVATE');
  });

  it('does not expose identity of sensitivity-denied optional evidence and fails when it is required', async () => {
    const privateItem = candidate('SECRET-ID', { sensitivity: 'restricted', content: 'SECRET-CONTENT' });
    const result = await assembleContext(options([privateItem]));
    expect(result.excluded).toEqual([{ position: 0, reason: 'sensitivity_denied' }]);
    expect(JSON.stringify(result)).not.toContain('SECRET');
    await expect(assembleContext(options([{ ...privateItem, pinned: true }]))).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
    expect((await assembleContext(options([privateItem], {}, { allowedSensitivities: ['restricted'] }))).selected).toHaveLength(1);
  });

  it.each(['source_missing', 'source_deleted', 'stale_revision'] as const)('records optional %s evidence and rejects required continuity at that boundary', async (reason) => {
    const item = candidate('source-item');
    const sources: SourceState[] = reason === 'source_missing' ? [] : [{ scope, id: item.source.id, revision: reason === 'stale_revision' ? '2' : '1', status: reason === 'source_deleted' ? 'deleted' : 'active' }];
    const result = await assembleContext(options([item], {}, { sources }));
    expect(result.selected).toEqual([]); expect(result.excluded[0]).toMatchObject({ reason, candidateId: item.id, sourceId: item.source.id });
    await expect(assembleContext(options([{ ...item, kind: 'outstanding_task' }], {}, { sources }))).rejects.toMatchObject({ code: 'CONFLICT' });
  });

  it('rechecks source revisions and deletions on every invocation without a stale cache', async () => {
    const item = candidate('memory', { source: { id: 'record-1', revision: '1', kind: 'memory' } });
    const first = await assembleContext(options([item]));
    const changed: SourceState[] = [{ scope, id: 'record-1', revision: '2', status: 'active' }];
    const stale = await assembleContext(options([item], {}, { sources: changed }));
    expect(stale.selected).toEqual([]);
    const current = await assembleContext(options([{ ...item, source: { ...item.source, revision: '2' }, content: 'corrected' }], {}, { sources: changed }));
    expect(current.selected[0]?.content).toBe('corrected'); expect(current.fingerprint).not.toBe(first.fingerprint);
    const removed = await assembleContext(options([item], {}, { sources: [{ ...changed[0]!, status: 'deleted' }] }));
    expect(removed.selected).toEqual([]); expect(removed.excluded[0]?.reason).toBe('source_deleted');
  });

  it('preserves source/provenance and never upgrades inferred observations into instructions', async () => {
    const item = candidate('inference', { source: { id: 'memory-record', revision: '7', kind: 'memory' },
      provenance: { reference: 'file:///original-source', observedAt: '2026-09-20T00:00:00.000Z', origin: 'inferred', confidence: 0.4, author: 'reviewer' },
    });
    const result = await assembleContext(options([item]));
    expect(result.selected[0]?.source).toEqual(item.source); expect(result.selected[0]?.provenance).toEqual(item.provenance);
    expect(result.selected[0]?.trust).toBe('untrusted'); expect(result.selected[0]?.kind).toBe('evidence');
    expect(JSON.parse(result.serialized)).not.toHaveProperty('messages');
  });

  it('retains upstream evidence separately from current memory identity with deep immutable snapshots', async () => {
    const upstream = { sourceId: 'repository-file', revision: 'commit-original', sha256: 'a'.repeat(64) };
    const validity = { from: '2026-09-20T00:00:00.000Z', until: null as string | null };
    const item = candidate('memory-evidence', { source: { id: 'memory-record', revision: '7', kind: 'memory' }, validity,
      provenance: { reference: 'repository://original', observedAt: validity.from, origin: 'inferred', confidence: 0.4, author: 'reviewer', upstream },
    });
    const pending = assembleContext(options([item]));
    upstream.revision = 'tampered'; upstream.sha256 = 'b'.repeat(64); validity.until = '2026-09-20T01:00:00.000Z';
    const result = await pending; const selected = result.selected[0]!;
    expect(selected.source).toEqual({ id: 'memory-record', revision: '7', kind: 'memory' });
    expect(selected.provenance.upstream).toEqual({ sourceId: 'repository-file', revision: 'commit-original', sha256: 'a'.repeat(64) });
    expect(selected.validity).toEqual({ from: '2026-09-20T00:00:00.000Z', until: null });
    expect(selected.trust).toBe('untrusted'); expect(selected.provenance.origin).toBe('inferred');
    expect(Object.isFrozen(selected.provenance.upstream)).toBe(true); expect(Object.isFrozen(selected.validity)).toBe(true);
    expect(JSON.parse(result.serialized).items[0].provenance.upstream).toEqual(selected.provenance.upstream);
  });

  it('admits inclusive validity starts and excludes exclusive ends without treating absence as expiry', async () => {
    const items = [candidate('starts-now', { validity: { from: asOf, until: null } }), candidate('timeless'),
      candidate('future', { validity: { from: '2026-09-20T12:00:00.001Z', until: null } }),
      candidate('ends-now', { validity: { from: '2026-09-20T00:00:00.000Z', until: asOf } }),
      candidate('ends-later', { validity: { from: '2026-09-20T00:00:00.000Z', until: '2026-09-20T12:00:00.001Z' } }),
    ];
    const result = await assembleContext(options(items));
    expect(result.selected.map(item => item.id)).toEqual(['ends-later', 'starts-now', 'timeless']);
    expect(result.excluded).toEqual([
      { position: 2, reason: 'not_yet_valid', candidateId: 'future', sourceId: 'source.future', revision: '1' },
      { position: 3, reason: 'expired', candidateId: 'ends-now', sourceId: 'source.ends-now', revision: '1' },
    ]);
  });

  it.each([...continuity, 'evidence'] as const)('fails closed for unavailable required %s validity', async (kind) => {
    for (const validity of [{ from: '2026-09-21T00:00:00.000Z', until: null }, { from: '2026-09-19T00:00:00.000Z', until: asOf }]) {
      await expect(assembleContext(options([candidate('required', { kind, pinned: kind === 'evidence', validity })])))
        .rejects.toMatchObject({ code: 'CONFLICT' });
    }
  });

  it('keeps scope/sensitivity denial ahead of validity evidence disclosure', async () => {
    const validity = { from: '2026-09-19T00:00:00.000Z', until: asOf };
    const result = await assembleContext(options([
      candidate('SECRET-FOREIGN', { scope: { ...scope, principalId: 'other' }, validity }),
      candidate('SECRET-SENSITIVE', { sensitivity: 'restricted', validity }),
    ]));
    expect(result.excluded).toEqual([{ position: 0, reason: 'scope_mismatch' }, { position: 1, reason: 'sensitivity_denied' }]);
    expect(JSON.stringify(result)).not.toContain('SECRET');
  });

  it('snapshots current time once when asOf is omitted and records the chosen time', async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date(asOf));
      const { asOf: _explicitTime, ...request } = options([candidate('time', { validity: { from: asOf, until: '2026-09-20T12:00:00.001Z' } })]);
      const pending = assembleContext(request);
      vi.setSystemTime(new Date('2026-09-21T00:00:00.000Z'));
      const result = await pending;
      expect(result.asOf).toBe(asOf); expect(result.selected).toHaveLength(1);
      expect(JSON.parse(result.serialized).asOf).toBe(asOf);
      expect(result.fingerprint).toBe((await assembleContext({ ...request, asOf })).fingerprint);
    } finally { vi.useRealTimers(); }
  });

  it('fingerprints the chosen time, upstream identity and validity independently of content digest', async () => {
    const upstream = { sourceId: 'source', revision: 'original', sha256: 'a'.repeat(64) };
    const item = candidate('fingerprint', { validity: { from: '2026-09-20T00:00:00.000Z', until: null },
      provenance: { ...candidate('base').provenance, upstream },
    });
    const first = await assembleContext(options([item]));
    const changed = [await assembleContext(options([item], {}, { asOf: '2026-09-20T13:00:00.000Z' })),
      await assembleContext(options([{ ...item, validity: { ...item.validity!, until: '2026-09-21T00:00:00.000Z' } }])),
      await assembleContext(options([{ ...item, provenance: { ...item.provenance, upstream: { ...upstream, sha256: 'b'.repeat(64) } } }])),
    ];
    for (const result of changed) {
      expect(result.fingerprint).not.toBe(first.fingerprint);
      expect(result.selected[0]?.contentDigest).toBe(first.selected[0]?.contentDigest);
    }
  });

  it('rejects malformed time/validity/upstream evidence without reflecting supplied secrets', async () => {
    const item = candidate('invalid');
    const malformed: AssembleContextOptions[] = [options([item], {}, { asOf: 'SECRET' }),
      options([item], {}, { asOf: '2026-09-20T12:00:00+00:00' }),
      ...[{ from: 'SECRET', until: null }, { from: asOf, until: asOf },
        { from: asOf, until: '2026-09-19T00:00:00.000Z' }, { from: asOf, until: undefined }].map(validity => options([{ ...item, validity: validity as never }])),
      ...[{ sourceId: '', revision: '1', sha256: 'a'.repeat(64) }, { sourceId: 'source', revision: '', sha256: 'a'.repeat(64) },
        { sourceId: 'source', revision: '1', sha256: 'A'.repeat(64) }, { sourceId: 'source', revision: '1', sha256: 'SECRET' }]
        .map(upstream => options([{ ...item, provenance: { ...item.provenance, upstream } }])),
    ];
    for (const request of malformed) {
      let error: unknown;
      try { await assembleContext(request); } catch (caught) { error = caught; }
      expect(error).toMatchObject({ code: 'INVALID_INPUT' }); expect(String(error)).not.toContain('SECRET');
    }
  });

  it('snapshots input before awaits and deeply freezes selected content and evidence', async () => {
    const input = { nested: { value: 'original' } };
    const item = candidate('immutable', { content: input }); const request = options([item]);
    const pending = assembleContext(request); input.nested.value = 'changed';
    const result = await pending;
    expect(result.selected[0]?.content).toEqual({ nested: { value: 'original' } });
    expect(Object.isFrozen(result)).toBe(true); expect(Object.isFrozen(result.selected)).toBe(true);
    expect(Object.isFrozen(result.selected[0]?.content)).toBe(true);
    const selectedContent = result.selected[0]?.content as { readonly nested: unknown };
    expect(Object.isFrozen(selectedContent.nested)).toBe(true); expect(Object.isFrozen(result.selected[0]?.provenance)).toBe(true);
    expect(Object.isFrozen(result.usage)).toBe(true); expect(Object.isFrozen(result.scope)).toBe(true);
  });

  it('fingerprints canonical content and relevant policy, scope, revision, budget, and estimator changes', async () => {
    const item = candidate('hash', { content: { b: 2, a: 1 } });
    const first = await assembleContext(options([item]));
    const reordered = await assembleContext(options([{ ...item, content: { a: 1, b: 2 } }]));
    expect(first.fingerprint).toBe(reordered.fingerprint); expect(first.selected[0]?.contentDigest).toBe(reordered.selected[0]?.contentDigest);
    const policies = await assembleContext(options([item], {}, { policyVersion: 'policy-2' }));
    const budgets = await assembleContext(options([item], { reservedTokens: 1 }));
    const estimator = await assembleContext(options([item], {}, { estimator: { id: 'other', estimate: byteTokenEstimator.estimate } }));
    const newScope = { principalId: 'alice', projectId: 'different' };
    const scoped = await assembleContext(options([{ ...item, scope: newScope }], {}, { scope: newScope }));
    for (const changed of [policies, budgets, estimator, scoped]) expect(changed.fingerprint).not.toBe(first.fingerprint);
  });

  it('supports an explicit local estimator for the measured payload without claiming actual provider token counts', async () => {
    const estimate = vi.fn((serialized: string) => Math.ceil(serialized.length / 4));
    const result = await assembleContext(options([candidate('custom')], {}, { estimator: { id: 'test-characters-four', estimate } }));
    expect(result.usage.estimatedTokens).toBe(Math.ceil(result.serialized.length / 4));
    expect(result.usage.estimatorId).toBe('test-characters-four'); expect(estimate).toHaveBeenCalled();
  });

  it.each([-1, NaN, Infinity, 1.5])('rejects invalid estimator count %s', async (value) => {
    await expect(assembleContext(options([], {}, { estimator: { id: 'invalid', estimate: () => value } }))).rejects.toMatchObject({ code: 'INVALID_CONFIG' });
  });

  it('sanitizes estimator exceptions rather than exposing provider/application content', async () => {
    await expect(assembleContext(options([], {}, { estimator: { id: 'throws', estimate: () => { throw new MayuraError('INVALID_INPUT', 'SECRET'); } } })))
      .rejects.toMatchObject({ code: 'INVALID_CONFIG', message: 'The token estimator failed; raw exception details are withheld.' });
  });

  it('fails closed on duplicate IDs, invalid timestamps, unsafe JSON, and impossible framing budgets', async () => {
    const item = candidate('duplicate');
    await expect(assembleContext(options([item, item]))).rejects.toMatchObject({ code: 'CONFLICT' });
    await expect(assembleContext(options([item], {}, { sources: [] }))).resolves.toMatchObject({ selected: [] });
    await expect(assembleContext(options([{ ...item, provenance: { ...item.provenance, observedAt: 'yesterday' } }]))).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await expect(assembleContext(options([{ ...item, content: { unsafe: undefined } as never }]))).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await expect(assembleContext(options([], { maxBytes: 1 }))).rejects.toMatchObject({ code: 'LIMIT_EXCEEDED' });
    await expect(assembleContext(options([], { maxBytes: 10, reservedBytes: 11 }))).rejects.toMatchObject({ code: 'LIMIT_EXCEEDED' });
  });

  it('V14 preserves every continuity category through repeated serialized compaction and resume', async () => {
    let candidates: ContextCandidate[] = continuity.map((kind) => candidate(kind, { kind }));
    for (let round = 0; round < 5; round++) {
      const result = await assembleContext(options(candidates));
      expect(result.selected.map((item) => item.kind).sort()).toEqual([...continuity].sort());
      const checkpoint = JSON.parse(result.serialized) as { readonly items: readonly ContextCandidate[] };
      candidates = checkpoint.items.map((item) => ({
        id: item.id, scope: item.scope, source: item.source, provenance: item.provenance, trust: item.trust,
        sensitivity: item.sensitivity, kind: item.kind,
        ...(item.priority === undefined ? {} : { priority: item.priority }),
        ...(item.pinned === undefined ? {} : { pinned: item.pinned }),
        ...(item.validity === undefined ? {} : { validity: item.validity }), content: jsonValue(item.content),
      }));
    }
  });
});

describe('context continuity properties', () => {
  const generated = fc.array(fc.record({ kind: fc.constantFrom<ContextKind>('evidence', ...continuity), priority: fc.integer({ min: -20, max: 20 }), pinned: fc.boolean(), text: fc.string({ maxLength: 80 }) }), { maxLength: 12 });

  it('admits exactly the half-open interval and never silently loses an invalid required item', async () => {
    await fc.assert(fc.asyncProperty(fc.integer({ min: -1_000, max: 1_000 }), fc.integer({ min: 1, max: 1_000 }), fc.boolean(), async (offset, duration, pinned) => {
      const start = Date.parse(asOf) + offset;
      const item = candidate('validity-property', { pinned, validity: { from: new Date(start).toISOString(), until: new Date(start + duration).toISOString() } });
      const current = offset <= 0 && offset + duration > 0;
      if (pinned && !current) await expect(assembleContext(options([item]))).rejects.toMatchObject({ code: 'CONFLICT' });
      else {
        const result = await assembleContext(options([item]));
        expect(result.selected).toHaveLength(current ? 1 : 0);
        if (!current) expect(result.excluded[0]?.reason).toBe(offset > 0 ? 'not_yet_valid' : 'expired');
      }
    }), { numRuns: 60 });
  });

  it('never drops a required current-scope item when required framing fits, otherwise fails explicitly', async () => {
    await fc.assert(fc.asyncProperty(generated, fc.integer({ min: 500, max: 12_000 }), fc.integer({ min: 0, max: 200 }), async (generatedItems, maxBytes, reservedBytes) => {
      const items = generatedItems.map((entry, index) => candidate(`item-${index}`, { kind: entry.kind, pinned: entry.pinned, priority: entry.priority, content: entry.text }));
      const required = items.filter((item) => item.pinned || continuity.includes(item.kind));
      const minimum = await assembleContext(options(required));
      if (minimum.usage.bytes > maxBytes - reservedBytes) {
        await expect(assembleContext(options(items, { maxBytes, reservedBytes }))).rejects.toMatchObject({ code: 'LIMIT_EXCEEDED' });
      } else {
        const result = await assembleContext(options(items, { maxBytes, reservedBytes }));
        expect(result.usage.bytes + reservedBytes).toBeLessThanOrEqual(maxBytes);
        expect(result.selected.filter((item) => item.required).map((item) => item.id).sort()).toEqual(required.map((item) => item.id).sort());
      }
    }), { numRuns: 60 });
  });

  it('is permutation-invariant and never mutates candidate content or ordering', async () => {
    await fc.assert(fc.asyncProperty(generated, async (generatedItems) => {
      const items = generatedItems.map((entry, index) => candidate(`item-${index}`, { kind: entry.kind, pinned: entry.pinned, priority: entry.priority, content: { text: entry.text } }));
      const original = JSON.stringify(items);
      const first = await assembleContext(options(items)); const second = await assembleContext(options([...items].reverse()));
      expect(first.serialized).toBe(second.serialized); expect(first.fingerprint).toBe(second.fingerprint); expect(JSON.stringify(items)).toBe(original);
    }), { numRuns: 60 });
  });
});
