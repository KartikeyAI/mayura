import { z } from 'zod';
import type { ModelAdapter } from '@mayura/core';
import { createRuntime, defineAgent, type AgentOutput } from '../src/index.js';

declare const model: ModelAdapter;
const definition = defineAgent({
  id: 'typed', version: '1', instructions: 'test', model, tools: [],
  input: z.object({ request: z.string() }),
  output: z.object({ answer: z.number() }),
});
const runtime = createRuntime({ profile: 'ephemeral', permissions: { allow: ['model:fixture'] } });
const run = runtime.submit(definition, { input: { request: 'hello' } });
// @ts-expect-error Submitted data must satisfy the input schema's inferred input type.
runtime.submit(definition, { input: { request: 123 } });
// @ts-expect-error Missing required input property is rejected for consumers.
runtime.submit(definition, { input: {} });
// Snapshot definitions expose portable Standard Schema, not the original Zod method surface.
// @ts-expect-error The snapshot is not a Zod object.
definition.input.parse({ request: 'hello' });

const result = await run.result();
if (result.status === 'succeeded') {
  const answer: number = result.output.answer;
  // @ts-expect-error Output field retains its inferred number type.
  const incorrect: string = result.output.answer;
  void answer; void incorrect;
} else {
  // @ts-expect-error Non-success outcomes never disclose an output property.
  result.output;
}
const typedOutput: AgentOutput<typeof definition> = { answer: 1 };
// @ts-expect-error AgentOutput is inferred from the output schema.
const incorrectOutput: AgentOutput<typeof definition> = { answer: 'wrong' };
void typedOutput; void incorrectOutput;
