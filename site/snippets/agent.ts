import { createModels, defineAgent, defineTool, z } from 'mayura';
import { openai } from '@mayurajs/provider-openai';

// Models as provider/model, priced from a dated catalog.
const models = createModels({
  providers: [openai({ apiKey })],
  prices: 'catalog', maxCallCostMicros: 20_000,
});

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
  model: models.model('openai/gpt-5-mini'),
});
