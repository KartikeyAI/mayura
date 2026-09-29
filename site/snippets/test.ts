import { createRuntime } from 'mayura';
import { scriptedModel } from 'mayura/testing';

// A scripted model replays fixed responses: no network and no API key.
const model = scriptedModel([
  { type: 'tool_calls', calls: [{ id: 'call-1', toolId: 'weather.get', input: { city: 'Paris' } }], usage: { costMicros: 0 } },
  { type: 'final', output: { reply: 'Clear skies, no umbrella needed.' }, usage: { costMicros: 0 } },
]);

const runtime = createRuntime({
  profile: 'ephemeral',
  permissions: { allow: ['model:scripted', 'tool:weather.get', 'effect:read'] },
});

const result = await runtime.submit(weatherAgent(model), { input: { question: 'Umbrella in Paris?' } }).result();
assert.equal(result.status, 'succeeded');
