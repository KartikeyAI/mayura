import { defineAgent, defineTool, z } from 'mayura';
import { openAIResponses } from 'mayura/provider-openai';

const getWeather = defineTool({
  id: 'weather.get', version: '1',
  description: 'Current weather for a city.',
  input: z.object({ city: z.string() }),
  output: z.object({ celsius: z.number() }),
  effects: 'read', capabilities: [],
  execute: ({ city }) => weather.current(city),
});

export const agent = defineAgent({
  id: 'weather-assistant', version: '1',
  instructions: 'Answer questions about the weather.',
  tools: [getWeather],
  input: z.object({ question: z.string() }),
  output: z.object({ reply: z.string() }),
  model: openAIResponses({ apiKey, model: 'gpt-5-mini',
    pricing, maxCostMicros: 20_000 }),
});
