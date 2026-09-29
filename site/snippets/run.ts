import { createRuntime } from 'mayura';

// Nothing is allowed unless you allow it, and every run has limits.
const runtime = createRuntime({
  profile: 'ephemeral',
  permissions: { allow: ['model:openai.responses', 'tool:weather.get', 'effect:read'] },
  limits: { maxCostMicros: 100_000 }, // at most 10 cents
});

const result = await runtime.submit(agent, { input: { question: 'Umbrella in Paris?' } }).result();

if (result.status === 'succeeded') console.log(result.output.reply); // typed from your schema
else console.error(result.status, result.error.message);
