import { defineAgent, defineTool } from 'mayura';
import { openAIResponses } from 'mayura/provider-openai';
import { z } from 'zod';

const getWeather = defineTool({
  id: 'weather.get', version: '1', description: 'Current weather for a city.',
  input: z.object({ city: z.string() }),
  output: z.object({ celsius: z.number(), sky: z.string() }),
  effects: 'read', capabilities: [],
  execute: async ({ city }) => weatherApi.current(city),
});

export const agent = defineAgent({
  id: 'weather-assistant', version: '1',
  instructions: 'Answer questions about the weather. Use the weather tool.',
  input: z.object({ question: z.string() }),
  output: z.object({ reply: z.string() }),
  tools: [getWeather],
  model: openAIResponses({ apiKey, model: 'gpt-5-mini', pricing, maxCostMicros: 20_000 }),
});
