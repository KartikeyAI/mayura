import { describe, expect, it, vi } from 'vitest';
import { createModels, createRuntime, defineAgent, z, type JsonObject, type ModelRequest } from 'mayura';
import type { GatewayProvider } from '../src/gateway.js';

const pricing = { inputMicrosPerMillionTokens: 1_000_000, outputMicrosPerMillionTokens: 2_000_000 };
const schema: JsonObject = { type: 'object', properties: { answer: { type: 'string' } }, required: ['answer'], additionalProperties: false };
const request = (signal = new AbortController().signal): ModelRequest => ({ instructions: 'Return JSON.', messages: [{ role: 'user', content: 'hi' }], tools: [], maxOutputTokens: 64, signal, outputJsonSchema: schema });
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });
const final = (cost: number | string = 0.0000201) => ({ choices: [{ message: { role: 'assistant', content: '{"answer":"ok"}' }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1, cost } });
const sse = (events: unknown[], done = true) => new Response(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join('') + (done ? 'data: [DONE]\n\n' : ''), { headers: { 'Content-Type': 'text/event-stream' } });

/** Offline wire regression cases shared by all six gateway packages; no real transport or key is used. */
export function gatewaySuite(id: string, factory: (fetch: typeof globalThis.fetch, settings?: { timeoutMs?: number; maxResponseBytes?: number; headers?: Readonly<Record<string, string>> }) => GatewayProvider, auth: Readonly<Record<string, string>>) {
  const model = (provider: GatewayProvider) => provider.model('model-1', { id: `${id}/model-1`, pricing, maxCostMicros: 1000 });
  describe(`${id} gateway`, () => {
    it('preserves registry identity, credentials and a rounded-up reported cost floor', async () => {
      const fetch = vi.fn<typeof globalThis.fetch>(async (_url, init) => {
        const paths: Record<string, string> = { vercel: 'https://ai-gateway.vercel.sh/v1/chat/completions', cloudflare: `https://gateway.ai.cloudflare.com/v1/${'a'.repeat(32)}/fixture/compat/chat/completions`, openrouter: 'https://openrouter.ai/api/v1/chat/completions', portkey: 'https://api.portkey.ai/v1/chat/completions', helicone: 'https://ai-gateway.helicone.ai/chat/completions', litellm: 'https://proxy.example/v1/chat/completions' };
        expect(String(_url)).toBe(paths[id]);
        const headers = new Headers(init?.headers);
        for (const [key, value] of Object.entries(auth)) expect(headers.get(key)).toBe(value);
        expect(init?.redirect).toBe('error');
        const body = JSON.parse(String(init?.body)); if (id === 'openrouter') expect(body.provider).toEqual({ require_parameters: true, allow_fallbacks: false }); expect(body.model).toBe('model-1'); expect(body.response_format.type).toBe('json_schema');
        return json(final());
      });
      const adapter = model(factory(fetch)); expect(adapter.id).toBe(`${id}/model-1`);
      expect(await adapter.generate(request())).toMatchObject({ type: 'final', output: { answer: 'ok' }, usage: { costMicros: 21 } }); expect(fetch).toHaveBeenCalledTimes(1);
    });
    it('does not let lower gateway cost reduce configured token prices', async () => {
      expect(await model(factory(async () => json(final(0)))).generate(request())).toMatchObject({ usage: { costMicros: 3 } });
    });
    it('applies host long-context prices to the whole call', async () => {
      const provider = factory(async () => json({ ...final(0), usage: { prompt_tokens: 20, completion_tokens: 1 } }));
      const adapter = provider.model('model-1', { id: `${id}/model-1`, maxCostMicros: 1000, pricing: { ...pricing, longContext: { aboveInputTokens: 10, inputMicrosPerMillionTokens: 3_000_000, outputMicrosPerMillionTokens: 4_000_000 } } });
      expect(await adapter.generate(request())).toMatchObject({ usage: { costMicros: 64 } });
    });
    it('requires a model price before use and a runtime model grant before paid work', async () => {
      const fetch = vi.fn<typeof globalThis.fetch>(async () => json(final())); const provider = factory(fetch);
      const models = createModels({ providers: [provider], maxCallCostMicros: 1000 });
      expect(() => models.model(`${id}/model-1`)).toThrow();
      const agent = defineAgent({ id: 'gateway-fixture', version: '1', instructions: 'JSON.', input: z.object({}), output: z.object({ answer: z.string() }), tools: [], model: model(provider) });
      const runtime = createRuntime({ profile: 'ephemeral', permissions: { allow: [] }, limits: { maxCostMicros: 1000 } });
      try { expect((await runtime.submit(agent, { input: {} }).result()).status).toBe('blocked'); expect(fetch).not.toHaveBeenCalled(); } finally { await runtime.close(); }
    });
    it('does not retry HTTP failures and does not leak provider details', async () => {
      const fetch = vi.fn<typeof globalThis.fetch>(async () => json({ error: { message: 'PRIVATE-CREDENTIAL' } }, 401));
      const error = await model(factory(fetch)).generate(request()).catch(error => error);
      expect(error).toMatchObject({ reason: 'authentication', httpStatus: 401 }); expect(String(error)).not.toContain('PRIVATE'); expect(fetch).toHaveBeenCalledTimes(1);
    });
    it('rejects credential-header overrides', () => {
      for (const name of ['Authorization', ...Object.keys(auth).filter(name => name.toLowerCase() !== 'authorization')]) {
        expect(() => model(factory(async () => json(final()), { headers: { [name.toUpperCase()]: 'replace' } }))).toThrow();
      }
    });
    it('cancels before any request and times out an uncooperative transport', async () => {
      const fetch = vi.fn<typeof globalThis.fetch>(async () => new Promise<Response>(() => undefined));
      const controller = new AbortController(); controller.abort();
      await expect(model(factory(fetch)).generate(request(controller.signal))).rejects.toMatchObject({ code: 'CANCELLED' }); expect(fetch).not.toHaveBeenCalled();
      await expect(model(factory(fetch, { timeoutMs: 5 })).generate(request())).rejects.toMatchObject({ code: 'CANCELLED' }); expect(fetch).toHaveBeenCalledTimes(1);
    });
    it('keeps known billable usage when output is malformed or refused', async () => {
      await expect(model(factory(async () => json({ ...final(), choices: [{ message: { role: 'assistant', content: 'PRIVATE invalid' }, finish_reason: 'stop' }] }))).generate(request())).rejects.toMatchObject({ costMicros: 21, reason: 'invalid_response' });
      await expect(model(factory(async () => json({ ...final(), choices: [{ message: { role: 'assistant', content: '' }, finish_reason: 'length' }] }))).generate(request())).rejects.toMatchObject({ costMicros: 21, reason: 'refused' });
    });
    it('rejects malformed, negative and unsafe gateway costs', async () => {
      for (const cost of ['PRIVATE', '-1', '1e100']) await expect(model(factory(async () => json(final(cost)))).generate(request())).rejects.toMatchObject({ reason: 'invalid_response' });
    });
    it('streams only content and accounts final usage, also on a truncated stream', async () => {
      const events = [{ choices: [{ delta: { content: '{"answer":', reasoning_content: 'PRIVATE' }, finish_reason: null }] }, { choices: [{ delta: { content: '"ok"}' }, finish_reason: 'stop' }] }, { choices: [], usage: final().usage }];
      const seen = []; for await (const event of model(factory(async () => sse(events))).stream!(request())) seen.push(event);
      expect(seen.at(-1)).toMatchObject({ type: 'response', response: { usage: { costMicros: 21 } } }); expect(JSON.stringify(seen)).not.toContain('PRIVATE');
      await expect((async () => { for await (const _event of model(factory(async () => sse(events, false))).stream!(request())) { /* Consume without replay. */ } })()).rejects.toMatchObject({ costMicros: 21 });
    });
    it('bounds complete responses', async () => {
      await expect(model(factory(async () => json({ ...final(), padding: 'x'.repeat(5000) }), { maxResponseBytes: 1000 })).generate(request())).rejects.toMatchObject({ reason: 'invalid_response' });
    });
    it('binds tool names and forwards shared thread history on the next call', async () => {
      const fetch = vi.fn<typeof globalThis.fetch>(async (_url, init) => {
        const body = JSON.parse(String(init?.body)); expect(body.messages[1]).toEqual({ role: 'assistant', content: '{"answer":"earlier"}' });
        return json({ ...final(), choices: [{ message: { role: 'assistant', content: null, tool_calls: [{ id: 'call-1', type: 'function', function: { name: body.tools[0].function.name, arguments: '{"id":"a"}' } }] }, finish_reason: 'tool_calls' }] });
      });
      const response = await model(factory(fetch)).generate({ ...request(), history: [{ role: 'assistant', output: { answer: 'earlier' } }], tools: [{ id: 'orders.lookup', description: 'Lookup', inputJsonSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'], additionalProperties: false } }] });
      expect(response).toMatchObject({ type: 'tool_calls', calls: [{ id: 'call-1', toolId: 'orders.lookup', input: { id: 'a' } }] });
    });
    it('requires a separate discovery grant and never trusts listing as pricing', async () => {
      const fetch = vi.fn<typeof globalThis.fetch>(async () => json({ data: [{ id: 'vendor/model-1' }] })); const provider = factory(fetch);
      await expect(provider.listModels({ permissions: { allow: [] }, signal: new AbortController().signal })).rejects.toMatchObject({ code: 'PERMISSION_DENIED' }); expect(fetch).not.toHaveBeenCalled();
      const list = () => provider.listModels({ permissions: { allow: [`gateway:${id}:models`] }, signal: new AbortController().signal });
      if (!provider.discovery) { await expect(list()).rejects.toMatchObject({ code: 'INVALID_CONFIG' }); expect(fetch).not.toHaveBeenCalled(); return; }
      expect(await list()).toEqual(['vendor/model-1']); expect(fetch).toHaveBeenCalledTimes(1);
      expect(provider.catalog).toBeUndefined(); expect(fetch.mock.calls[0]?.[1]?.method).toBe('GET'); expect(String(fetch.mock.calls[0]?.[0])).toMatch(id === 'helicone' ? /\/v1\/models$/u : /\/models$/u);
    });
    it('bounds discovery and keeps its slot when a transport ignores abort', async () => {
      const provider = factory(async () => new Promise<Response>(() => undefined), { timeoutMs: 5 }); if (!provider.discovery) return;
      const request = { permissions: { allow: [`gateway:${id}:models`] }, signal: new AbortController().signal };
      await expect(provider.listModels(request)).rejects.toMatchObject({ code: 'CANCELLED' });
      await expect(provider.listModels(request)).rejects.toMatchObject({ code: 'INVALID_CONFIG' });
      const malformed = factory(async () => json({ data: [{ id: 'duplicate' }, { id: 'duplicate' }] }));
      await expect(malformed.listModels(request)).rejects.toMatchObject({ reason: 'invalid_response' });
    });
  });
}
