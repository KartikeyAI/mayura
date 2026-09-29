import { createRuntime } from 'mayura';
import { scriptedModel } from 'mayura/testing';

// Replays fixed responses: no network, no API key.
const model = scriptedModel([
  { type: 'tool_calls', usage: { costMicros: 0 },
    calls: [{ id: '1', toolId: 'weather.get',
      input: { city: 'Paris' } }] },
  { type: 'final', usage: { costMicros: 0 },
    output: { reply: 'Clear skies, no umbrella.' } },
]);

const runtime = createRuntime({
  profile: 'ephemeral',
  permissions: { allow: ['model:scripted',
    'tool:weather.get', 'effect:read'] },
});
const result = await runtime.submit(weatherAgent(model), {
  input: { question: 'Do I need an umbrella?' },
}).result();
assert.equal(result.status, 'succeeded');
