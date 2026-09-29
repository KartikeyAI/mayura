import { createRuntime } from 'mayura';
import { agent } from './agent.js';

// Nothing is allowed unless you allow it,
// and every run has limits: here, 10 cents.
const runtime = createRuntime({
  profile: 'ephemeral',
  permissions: {
    allow: ['model:openai.responses',
      'tool:weather.get', 'effect:read'],
  },
  limits: { maxCostMicros: 100_000 },
});

const result = await runtime.submit(agent, {
  input: { question: 'Do I need an umbrella?' },
}).result();

if (result.status === 'succeeded') {
  console.log(result.output.reply); // typed from the schema
} else console.error(result.status, result.error.message);
