import { describe, expect, it, vi } from 'vitest';
import { StorageError } from '../src/contracts.js';
import { workflowGraphDiscoveryCommand, workflowGraphDiscoveryCursor, workflowGraphDiscoveryPage,
  type WorkflowGraphDiscoveryScan } from '../src/workflow-graph-discovery.js';

const scope = 'a'.repeat(64); const policyHash = 'b'.repeat(64);
const id = (n: number) => n.toString(16).padStart(64, '0');
const cursor = (n = 1) => ({ format: 1 as const, scope, policyHash, afterId: id(n) });
const scan = (limit = 2): WorkflowGraphDiscoveryScan => ({ scope, policyHash, cursor: null, limit });
const candidate = (n = 1) => ({ reference: { kind: 'scheduled-workflow' as const, runId: id(n), definitionHash: 'c'.repeat(64), policyHash }, version: 1, status: 'waiting' as const });

describe('bounded graph discovery contracts', () => {
  it('owns commands and versioned context-bound cursors', () => {
    expect(workflowGraphDiscoveryCommand('initialize', {})).toEqual({});
    const raw = { ...scan(), cursor: cursor() }; const owned = workflowGraphDiscoveryCommand('scan', raw);
    raw.cursor.afterId = id(9);
    expect(owned['cursor']).toEqual(cursor()); expect(Object.isFrozen(owned['cursor'])).toBe(true);
    expect(workflowGraphDiscoveryCursor(cursor())).toEqual(cursor());
  });
  it.each([
    { ...scan(), extra: true }, { ...scan(), limit: 0 }, { ...scan(), limit: 33 },
    { ...scan(), limit: 1.5 }, { ...scan(), cursor: { ...cursor(), scope: 'd'.repeat(64) } },
    { ...scan(), cursor: { ...cursor(), policyHash: 'd'.repeat(64) } },
    { ...scan(), cursor: { ...cursor(), format: 2 } }, { ...scan(), cursor: { ...cursor(), afterId: 'bad' } },
  ])('rejects invalid/context-switched commands (%#)', raw => {
    expect(() => workflowGraphDiscoveryCommand('scan', raw)).toThrow(StorageError);
  });
  it('rejects missing fields, initialization payloads and accessor commands without invoking them', () => {
    expect(() => workflowGraphDiscoveryCommand('scan', { scope, policyHash, limit: 2 })).toThrow(StorageError);
    expect(() => workflowGraphDiscoveryCommand('initialize', { scope })).toThrow(StorageError);
    const getter = vi.fn(() => 2); const raw = Object.defineProperty({ ...scan() }, 'limit', { enumerable: true, get: getter });
    expect(() => workflowGraphDiscoveryCommand('scan', raw)).toThrow(StorageError); expect(getter).not.toHaveBeenCalled();
  });
  it('counts terminal examined owners even when the returned candidate list is empty', () => {
    const page = workflowGraphDiscoveryPage({ candidates: [], examined: 2, nextCursor: cursor(3) }, scan());
    expect(page.candidates).toEqual([]); expect(page.nextCursor?.afterId).toBe(id(3)); expect(Object.isFrozen(page.nextCursor)).toBe(true);
    expect(workflowGraphDiscoveryPage({ candidates: [], examined: 0, nextCursor: null }, { ...scan(), cursor: cursor(3) })).toEqual({ candidates: [], examined: 0, nextCursor: null });
  });
  it('owns bounded ordered metadata and permits a final short page', () => {
    const raw = { candidates: [candidate(2)], examined: 1, nextCursor: null };
    const page = workflowGraphDiscoveryPage(raw, { ...scan(), cursor: cursor(1) });
    raw.candidates[0]!.reference.runId = id(7);
    expect(page.candidates[0]?.reference.runId).toBe(id(2)); expect(Object.isFrozen(page.candidates[0]?.reference)).toBe(true);
  });
  it.each([
    { candidates: [], examined: 3, nextCursor: cursor(4) },
    { candidates: [candidate()], examined: 0, nextCursor: null },
    { candidates: [], examined: 1, nextCursor: cursor(2) },
    { candidates: [], examined: 2, nextCursor: null },
    { candidates: [candidate(2), candidate(1)], examined: 2, nextCursor: cursor(2) },
    { candidates: [candidate(1), candidate(1)], examined: 2, nextCursor: cursor(2) },
    { candidates: [{ ...candidate(), status: 'succeeded' }], examined: 1, nextCursor: null },
    { candidates: [{ ...candidate(), version: 0 }], examined: 1, nextCursor: null },
    { candidates: [{ ...candidate(), input: 'PRIVATE' }], examined: 1, nextCursor: null },
    { candidates: [{ ...candidate(), reference: { ...candidate().reference, policyHash: 'd'.repeat(64) } }], examined: 1, nextCursor: null },
    { candidates: [candidate(3)], examined: 2, nextCursor: cursor(2) },
    { candidates: [candidate(1), candidate(2)], examined: 2, nextCursor: cursor(3) },
    { candidates: [], examined: 2, nextCursor: { ...cursor(), policyHash: 'd'.repeat(64) } },
  ])('rejects malformed, excessive or contradictory pages (%#)', raw => {
    expect(() => workflowGraphDiscoveryPage(raw, scan())).toThrow(StorageError);
  });
  it('rejects candidate/cursor rewinds relative to the examined input cursor', () => {
    const command = { ...scan(), cursor: cursor(3) };
    expect(() => workflowGraphDiscoveryPage({ candidates: [candidate(3)], examined: 1, nextCursor: null }, command)).toThrow(StorageError);
    expect(() => workflowGraphDiscoveryPage({ candidates: [], examined: 2, nextCursor: cursor(3) }, command)).toThrow(StorageError);
  });
  it('rejects metadata getters, unsafe counters and oversized reply extensions', () => {
    const getter = vi.fn(() => [candidate()]); const raw = Object.defineProperty({ examined: 1, nextCursor: null }, 'candidates', { enumerable: true, get: getter });
    expect(() => workflowGraphDiscoveryPage(raw, scan())).toThrow(StorageError); expect(getter).not.toHaveBeenCalled();
    expect(() => workflowGraphDiscoveryPage({ candidates: [{ ...candidate(), version: Number.MAX_SAFE_INTEGER + 1 }], examined: 1, nextCursor: null }, scan())).toThrow(StorageError);
    expect(() => workflowGraphDiscoveryPage({ candidates: [], examined: 0, nextCursor: null, secret: 'x'.repeat(65_536) }, scan())).toThrow(StorageError);
  });
});
