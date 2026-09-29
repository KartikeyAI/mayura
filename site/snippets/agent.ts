import { createRuntime, defineAgent, defineTool } from 'mayura';
import { openAIResponses } from 'mayura/provider-openai';
import { z } from 'zod';

const getWeather = defineTool({
  id: 'weather.get', version: '1', description: 'Current weather for a city.',
  input: z.object({ city: z.string() }),
  output: z.object({ celsius: z.number(), sky: z.string() }),
  effects: 'read', capabilities: [],
  execute: async ({ city }) => ({ celsius: 21, sky: 'clear' }), // call your weather API here
});

const agent = defineAgent({
  id: 'weather-assistant', version: '1',
  instructions: 'Answer questions about the weather. Use the weather tool.',
  input: z.object({ question: z.string() }), output: z.object({ reply: z.string() }), tools: [getWeather],
  model: openAIResponses({
    apiKey: process.env.OPENAI_API_KEY!, model: 'gpt-5-mini',
    pricing: { inputMicrosPerMillionTokens: 250_000, outputMicrosPerMillionTokens: 2_000_000 },
    maxCostMicros: 20_000,
  }),
});

// Nothing is allowed unless you allow it, and every run has limits (here, at most 10 cents).
const runtime = createRuntime({
  profile: 'ephemeral',
  permissions: { allow: ['model:openai.responses', 'tool:weather.get', 'effect:read'] },
  limits: { maxCostMicros: 100_000 },
});

const result = await runtime.submit(agent, { input: { question: 'Do I need an umbrella in Paris?' } }).result();
if (result.status === 'succeeded') console.log(result.output.reply);
else console.error(result.status, result.error.message);
