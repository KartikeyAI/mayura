import { litellm } from '../src/index.js';
import { gatewaySuite } from '../../provider-openai/test/gateway-suite.js';
gatewaySuite('litellm', (fetch, settings = {}) => litellm({ ...{ apiKey: 'fixture-key', baseURL: 'https://proxy.example/v1' }, ...settings, fetch }), { Authorization: 'Bearer fixture-key' });

import { expect, it } from 'vitest';
import type { ModelRequest } from 'mayura';
const request: ModelRequest = { instructions: 'JSON', tools: [], messages: [], signal: new AbortController().signal, maxOutputTokens: 32, outputJsonSchema: { type: 'object', properties: {}, additionalProperties: false } };
const model = (fetch: typeof globalThis.fetch) => litellm({ apiKey: 'fixture-key', baseURL: 'https://proxy.example/v1', fetch }).model('model-1', { id: 'litellm/model-1', maxCostMicros: 100, pricing: { inputMicrosPerMillionTokens: 0, outputMicrosPerMillionTokens: 0 } });
it('takes the maximum of native header, usage.cost and configured token prices without double billing', async () => {
  const result = await model(async () => new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content: '{}' }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1, cost: 0.00001 } }), { headers: { 'content-type': 'application/json', 'x-litellm-response-cost': '2.000001e-5' } })).generate(request);
  expect(result.usage.costMicros).toBe(21);
});
it('retains header-confirmed cost and HTTP status on a provider error', async () => {
  await expect(model(async () => new Response('PRIVATE', { status: 429, headers: { 'x-litellm-response-cost': '0.00001' } })).generate(request)).rejects.toMatchObject({ reason: 'rate_limited', httpStatus: 429, costMicros: 10 });
});
