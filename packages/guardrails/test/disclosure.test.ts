import { describe, expect, it, vi } from 'vitest';
import { type GuardContext } from '@mayura/core';
import { createPipeline, prepareOutputDisclosure, protectLiterals, type Pipeline } from '../src/index.js';

const context = (boundary: 'input' | 'output' = 'output'): GuardContext => ({ runId: 'run', callId: 'call',
  scope: { principalId: 'alice', projectId: 'project' }, boundary, signal: new AbortController().signal });

describe('structured output disclosure', () => {
  it('withholds tool previews, raw events and error messages before the configured pipeline', async () => {
    const result = await prepareOutputDisclosure([
      { kind: 'text', text: 'safe' },
      { kind: 'tool_preview', toolId: 'payments.capture', preview: { secret: 'PRIVATE_TOOL' } },
      { kind: 'event', event: { raw: 'PRIVATE_EVENT' } },
      { kind: 'error', code: 'TOOL_FAILED', message: 'PRIVATE_ERROR' },
    ], createPipeline(), context());
    expect(result.status).toBe('succeeded');
    expect(JSON.stringify(result)).not.toMatch(/PRIVATE_|payments\.capture/u);
    if (result.status === 'succeeded') expect(result.output.value).toBe('safe\n[tool preview withheld]\n[event withheld]\n[error:TOOL_FAILED]');
  });

  it('permits only configured HTTPS citation origins without credentials, query or fragment', async () => {
    const pipeline = createPipeline(); const options = { allowedCitationOrigins: ['https://docs.example.com'] };
    const allowed = await prepareOutputDisclosure([{ kind: 'citation', label: 'Guide', url: 'https://docs.example.com/path' }], pipeline, context(), options);
    expect(allowed.status).toBe('succeeded'); if (allowed.status === 'succeeded') expect(allowed.output.value).toBe('Guide [https://docs.example.com/path]');
    for (const url of ['http://docs.example.com/path', 'https://evil.example/path', 'https://docs.example.com/path?token=SECRET',
      'https://user:pass@docs.example.com/path', 'https://docs.example.com/path#SECRET']) {
      const denied = await prepareOutputDisclosure([{ kind: 'citation', label: 'Guide', url }], pipeline, context(), options);
      expect(denied.status).toBe('succeeded'); if (denied.status === 'succeeded') expect(denied.output.value).toBe('[citation withheld]');
    }
  });

  it('runs the complete rendered candidate through required release checks', async () => {
    const pipeline = createPipeline({ guards: [protectLiterals({ literals: ['SECRET'] })] });
    await expect(prepareOutputDisclosure([{ kind: 'text', text: 'prefix SECRET suffix' }], pipeline, context()))
      .resolves.toMatchObject({ status: 'blocked', error: { code: 'GUARD_BLOCKED' } });
  });

  it('rejects malformed, accessor-bearing and oversized parts without invoking getters', async () => {
    await expect(prepareOutputDisclosure([{ kind: 'text', text: 'safe', extra: true } as never], createPipeline(), context()))
      .rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await expect(prepareOutputDisclosure([{ kind: 'text', text: 'a' }, { kind: 'text', text: 'b' }], createPipeline(), context(), { maxParts: 1 }))
      .rejects.toMatchObject({ code: 'INVALID_INPUT' });
    const getter = vi.fn(); const hostile = Object.defineProperty({ kind: 'text' }, 'text', { enumerable: true, get: getter });
    await expect(prepareOutputDisclosure([hostile as never], createPipeline(), context())).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    expect(getter).not.toHaveBeenCalled();
  });

  it('rejects forged pipelines, non-output contexts and invalid origin policy', async () => {
    const fake: Pipeline = { process: async () => ({ status: 'succeeded', output: { version: 1, digest: 'fake', value: 'raw', checks: [] } }) };
    await expect(prepareOutputDisclosure([], fake, context())).rejects.toMatchObject({ code: 'INVALID_CONFIG' });
    await expect(prepareOutputDisclosure([], createPipeline(), context('input'))).rejects.toMatchObject({ code: 'INVALID_CONFIG' });
    await expect(prepareOutputDisclosure([], createPipeline(), context(), { allowedCitationOrigins: ['http://docs.example.com'] }))
      .rejects.toMatchObject({ code: 'INVALID_CONFIG' });
  });
});
