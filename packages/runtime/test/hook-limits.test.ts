import { describe, expect, it } from 'vitest';
import { createRuntime, type RuntimeLimits } from '../src/index.js';

describe('bounded lifecycle-hook admissions', () => {
  it('accepts an explicit hook-call ceiling independently of financial calls', async () => {
    const runtime = createRuntime({ profile: 'ephemeral', limits: { maxHookCalls: 1 } as RuntimeLimits });
    await runtime.close();
  });

  it.each([0, -1, 1.5, 4097, Number.MAX_SAFE_INTEGER, Infinity, NaN])('rejects unsupported hook ceiling %s', (maxHookCalls) => {
    expect(() => createRuntime({ profile: 'ephemeral', limits: { maxHookCalls } as RuntimeLimits }))
      .toThrow(expect.objectContaining({ code: 'INVALID_CONFIG' }));
  });
});
