import { cloudflareGateway } from '../src/index.js';
import { gatewaySuite } from '../../provider-openai/test/gateway-suite.js';
gatewaySuite('cloudflare', (fetch, settings = {}) => cloudflareGateway({ ...{ apiKey: 'fixture-key', accountId: 'a'.repeat(32), gatewayId: 'fixture' }, ...settings, fetch }), { 'cf-aig-authorization': 'Bearer fixture-key' });

import { expect, it } from 'vitest';
it('keeps the optional upstream key distinct from the gateway credential', async () => {
  const provider = cloudflareGateway({ apiKey: 'gateway-fixture', providerApiKey: 'upstream-fixture', accountId: 'a'.repeat(32), gatewayId: 'fixture', fetch: async (_url, init) => {
    const headers = new Headers(init?.headers); expect(headers.get('Authorization')).toBe('Bearer upstream-fixture'); expect(headers.get('cf-aig-authorization')).toBe('Bearer gateway-fixture');
    return new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content: '{}' }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1 } }));
  } });
  await provider.model('model-1', { id: 'cloudflare/model-1', maxCostMicros: 10, pricing: { inputMicrosPerMillionTokens: 1, outputMicrosPerMillionTokens: 1 } }).generate({ instructions: 'JSON.', messages: [], tools: [], signal: new AbortController().signal, maxOutputTokens: 32, outputJsonSchema: { type: 'object', properties: {}, additionalProperties: false } });
});
