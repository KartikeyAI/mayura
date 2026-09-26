import { describe, expect, it, vi } from 'vitest';
import { createWorkflowDrainGate } from '../src/drain.js';

describe('workflow drain gate', () => {
  it('closes immediately when idle and returns one shared report', async () => {
    const gate = createWorkflowDrainGate(); const close = vi.fn();
    const first = gate.drain(undefined, close); expect(gate.drain(undefined, close)).toBe(first);
    expect(await first).toEqual({ drained: true, interrupted: 0 }); expect(close).toHaveBeenCalledOnce();
    expect(gate.enter()).toBeUndefined();
  });

  it('waits for admitted work, refuses new admission and releases idempotently', async () => {
    const gate = createWorkflowDrainGate(); const close = vi.fn(); const release = gate.enter()!;
    const report = gate.drain({ timeoutMs: 5_000 }, close);
    expect(gate.draining).toBe(true); expect(gate.enter()).toBeUndefined();
    await Promise.resolve(); expect(close).not.toHaveBeenCalled();
    release(); release(); expect(await report).toEqual({ drained: true, interrupted: 0 }); expect(close).toHaveBeenCalledOnce();
  });

  it('reports interrupted work at the deadline and validates its bound', async () => {
    const gate = createWorkflowDrainGate(); gate.enter(); gate.enter(); const close = vi.fn(async () => undefined);
    expect(await gate.drain({ timeoutMs: 20 }, close)).toEqual({ drained: false, interrupted: 2 }); expect(close).toHaveBeenCalledOnce();
    expect(() => createWorkflowDrainGate().drain({ timeoutMs: 0 }, close)).toThrow(expect.objectContaining({ code: 'INVALID_INPUT' }));
    expect(() => createWorkflowDrainGate().drain({ timeoutMs: 300_001 }, close)).toThrow(expect.objectContaining({ code: 'INVALID_INPUT' }));
  });
});
