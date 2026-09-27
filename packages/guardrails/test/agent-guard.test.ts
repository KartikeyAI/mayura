import { describe, expect, it } from 'vitest';
import { createPipeline, pipelineGuard, redactPII } from '../src/index.js';

const context = { runId: 'run-1', callId: 'call-1', scope: { principalId: 'p', projectId: 'x' }, signal: new AbortController().signal, boundary: 'output' as const };

describe('pipelineGuard', () => {
  it('rewrites content the pipeline changed, allows unchanged content, and blocks what the pipeline blocks', async () => {
    const guard = pipelineGuard('pii', createPipeline({ processors: [redactPII({ email: true, phone: true })] }));
    expect(await guard.check({ reply: 'mail ada@example.com' }, context)).toEqual({ decision: 'rewrite', value: { reply: 'mail [EMAIL]' } });
    expect(await guard.check({ reply: 'nothing personal' }, context)).toEqual({ decision: 'allow' });
    const blocking = pipelineGuard('never', createPipeline({ guards: [{ id: 'no', check: () => ({ decision: 'block' }) }] }));
    expect(await blocking.check('anything', context)).toEqual({ decision: 'block' });
    expect(() => pipelineGuard('bad id', createPipeline())).toThrow();
  });
});
