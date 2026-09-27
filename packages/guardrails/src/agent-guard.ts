import { MayuraError, type Guard, type GuardContext, type GuardVerdict, type JsonValue } from '@mayura/core';
import { assertPipeline, type Pipeline } from './pipeline.js';

const same = (left: JsonValue, right: JsonValue): boolean => JSON.stringify(left) === JSON.stringify(right);

/**
 * Use a guardrails pipeline as an agent guard: a pipeline that blocks blocks, one whose processors changed the content
 * (for example `redactPII`) rewrites it, and one that left it unchanged allows it. The agent runtime validates a
 * rewritten value against the boundary's schema again before using it.
 */
export function pipelineGuard(id: string, pipeline: Pipeline): Guard {
  if (typeof id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/u.test(id)) throw new MayuraError('INVALID_CONFIG', 'A pipeline guard needs a bounded identifier.');
  assertPipeline(pipeline);
  return Object.freeze({
    id,
    async check(value: JsonValue, context: GuardContext): Promise<GuardVerdict> {
      const outcome = await pipeline.process(value, context);
      if (outcome.status !== 'succeeded') return { decision: 'block' };
      return same(outcome.output.value, value) ? { decision: 'allow' } : { decision: 'rewrite', value: outcome.output.value };
    },
  });
}
