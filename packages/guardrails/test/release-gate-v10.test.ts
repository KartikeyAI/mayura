import { describe, expect, it, vi } from 'vitest';
import { type GuardContext } from '@mayura/core';
import {
  createPipeline,
  prepareOutputDisclosure,
  protectLiterals,
  redactPII,
  releaseBufferedOutput,
} from '../src/index.js';

const context = (): GuardContext => ({
  runId: 'release-gate-v10',
  callId: 'disclosure',
  scope: { principalId: 'release', projectId: 'mayura' },
  boundary: 'output',
  signal: new AbortController().signal,
});

async function* chunks(...values: readonly string[]): AsyncIterable<string> {
  for (const value of values) yield value;
}

describe('V10 streaming disclosure acceptance', () => {
  it('admits one complete transcript so split secrets and PII cannot cross chunk boundaries', async () => {
    const secret = createPipeline({ guards: [protectLiterals({ literals: ['API_SECRET'] })] });
    await expect(releaseBufferedOutput(chunks('prefix API_', 'SEC', 'RET suffix'), secret, context()))
      .rejects.toMatchObject({ code: 'GUARD_BLOCKED' });

    const pii = createPipeline({ processors: [redactPII()] });
    const admitted = await releaseBufferedOutput(chunks('owner', '@example', '.com'), pii, context());
    expect(admitted.value).toBe('[EMAIL]');
    expect(JSON.stringify(admitted)).not.toContain('owner@example.com');
  });

  it('withholds privileged tool, event and error fields and applies release checks to citations', async () => {
    const privileged = await prepareOutputDisclosure([
      { kind: 'tool_preview', toolId: 'payments.capture', preview: { token: 'PRIVATE_TOOL' } },
      { kind: 'event', event: { payload: 'PRIVATE_EVENT' } },
      { kind: 'error', code: 'TOOL_FAILED', message: 'PRIVATE_ERROR' },
    ], createPipeline({ guards: [protectLiterals({ literals: ['PRIVATE_'] })] }), context());
    expect(privileged).toMatchObject({ status: 'succeeded' });
    expect(JSON.stringify(privileged)).not.toMatch(/PRIVATE_|payments\.capture/u);

    const citations = createPipeline({ guards: [protectLiterals({ literals: ['RESTRICTED'] })] });
    await expect(prepareOutputDisclosure([
      { kind: 'citation', label: 'Guide', url: 'https://docs.example.test/RESTRICTED' },
    ], citations, context(), { allowedCitationOrigins: ['https://docs.example.test'] }))
      .resolves.toMatchObject({ status: 'blocked', error: { code: 'GUARD_BLOCKED' } });

    const unsafe = await prepareOutputDisclosure([
      { kind: 'citation', label: 'Guide', url: 'https://docs.example.test/path?token=PRIVATE_QUERY' },
    ], createPipeline(), context(), { allowedCitationOrigins: ['https://docs.example.test'] });
    expect(unsafe).toMatchObject({ status: 'succeeded' });
    expect(JSON.stringify(unsafe)).not.toContain('PRIVATE_QUERY');
  });

  it('fails closed before invoking release checks when cumulative buffers overflow', async () => {
    const check = vi.fn(() => ({ decision: 'allow' as const }));
    const pipeline = createPipeline({ guards: [{ id: 'release-check', check }] });

    await expect(releaseBufferedOutput(chunks('ab', 'cd'), pipeline, context(), { maxBytes: 3 }))
      .rejects.toMatchObject({ code: 'LIMIT_EXCEEDED' });
    await expect(releaseBufferedOutput(chunks('a', 'b'), pipeline, context(), { maxChunks: 1 }))
      .rejects.toMatchObject({ code: 'LIMIT_EXCEEDED' });
    expect(check).not.toHaveBeenCalled();
  });
});
