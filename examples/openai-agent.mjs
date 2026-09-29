import { defineAgent, createRuntime, z } from 'mayura';
import { openAIResponses } from 'mayura/provider-openai';

const required = name => {
  const value = process.env[name];
  if (!value) throw new Error(`Set ${name} explicitly; this opt-in example never discovers or stores credentials.`);
  return value;
};
const integer = name => {
  const value = Number(required(name));
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${name} must be a non-negative integer.`);
  return value;
};

const outputJsonSchema = {
  type: 'object', properties: { answer: { type: 'string' } }, required: ['answer'], additionalProperties: false,
};
const agent = defineAgent({
  id: 'openai.quickstart', version: '1', instructions: 'Answer the user concisely.', tools: [],
  input: z.object({ question: z.string().min(1).max(2_000) }), output: z.object({ answer: z.string().min(1).max(8_000) }),
  model: openAIResponses({
    apiKey: required('OPENAI_API_KEY'), model: required('MAYURA_OPENAI_MODEL'), outputJsonSchema,
    maxCostMicros: integer('MAYURA_OPENAI_MAX_CALL_COST_MICROS'),
    pricing: {
      inputMicrosPerMillionTokens: integer('MAYURA_OPENAI_INPUT_MICROS_PER_MILLION_TOKENS'),
      outputMicrosPerMillionTokens: integer('MAYURA_OPENAI_OUTPUT_MICROS_PER_MILLION_TOKENS'),
    }, timeoutMs: 30_000,
  }),
});
const runtime = createRuntime({ profile: 'ephemeral', permissions: { allow: ['model:openai.responses'] },
  limits: { maxDurationMs: 35_000, maxModelCalls: 1, maxToolCalls: 1, maxSteps: 2,
    maxOutputTokens: 1_024, maxOutputBytes: 16_384, maxCostMicros: integer('MAYURA_OPENAI_MAX_RUN_COST_MICROS') } });
try {
  const outcome = await runtime.submit(agent, { input: { question: required('MAYURA_QUESTION') } }).result();
  if (outcome.status !== 'succeeded') throw new Error(`${outcome.error.code}: ${outcome.error.message}`);
  console.log(outcome.output.answer);
} finally { await runtime.close(); }
