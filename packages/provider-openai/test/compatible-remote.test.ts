import { describe, expect, it, vi } from 'vitest';
import { MayuraError, type JsonObject, type JsonValue, type ModelRequest, type ModelStreamEvent } from '@mayura/core';
import { openAICompatibleChat, type OpenAICompatibleChatOptions } from '../src/index.js';

const outputSchema: JsonObject = { type: 'object', properties: { answer: { type: 'string' } }, required: ['answer'], additionalProperties: false };
const base = { model: 'fixture-model', outputJsonSchema: outputSchema, maxCostMicros: 100, pricing: { inputMicrosPerMillionTokens: 1_000, outputMicrosPerMillionTokens: 2_000 } };
const request = (overrides: Partial<ModelRequest> = {}): ModelRequest => ({ instructions: 'x', messages: [{ role: 'user', content: 'hi' }], tools: [],
  signal: new AbortController().signal, maxOutputTokens: 64, ...overrides });
const completion = (content = '{"answer":"ok"}'): Response => new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 10, completion_tokens: 3 } }), { headers: { 'Content-Type': 'application/json' } });
const sse = (chunks: (JsonValue | '[DONE]')[]): Response => new Response(chunks.map(chunk => `data: ${chunk === '[DONE]' ? chunk : JSON.stringify(chunk)}\n\n`).join(''),
  { headers: { 'Content-Type': 'text/event-stream' } });
async function collect(source: AsyncIterable<ModelStreamEvent>): Promise<ModelStreamEvent[]> { const events: ModelStreamEvent[] = []; for await (const event of source) events.push(event); return events; }
// Options are loosely typed here so tests can clear a field (for example `apiKey: undefined`) to exercise validation.
const make = (options: Record<string, unknown>, fetch: typeof globalThis.fetch) =>
  openAICompatibleChat({ endpoint: 'https://api.provider.example/openai/v1/chat/completions', remote: { id: 'provider' }, apiKey: 'fixture-key', ...base, fetch, ...options } as OpenAICompatibleChatOptions);

describe('remote OpenAI-compatible providers', () => {
  it('sends to the exact HTTPS endpoint with a bearer credential, under a provider-named adapter id', async () => {
    const transport = vi.fn<typeof globalThis.fetch>(async () => completion());
    const adapter = make({ remote: { id: 'groq' } }, transport);
    expect(adapter.id).toBe('openai-compatible.groq');
    expect(await adapter.generate(request())).toEqual({ type: 'final', output: { answer: 'ok' }, usage: { costMicros: 1, inputTokens: 10, outputTokens: 3 } });
    const [url, init] = transport.mock.calls[0]!;
    expect(url).toBe('https://api.provider.example/openai/v1/chat/completions');
    expect(init).toMatchObject({ redirect: 'error', headers: { Authorization: 'Bearer fixture-key' } });
  });

  it('supports Azure OpenAI: the api-key header and an api-version query', async () => {
    const transport = vi.fn<typeof globalThis.fetch>(async () => completion());
    const adapter = make({ endpoint: 'https://example.openai.azure.com/openai/deployments/chat/chat/completions?api-version=2024-10-21', remote: { id: 'azure', auth: 'api-key' } }, transport);
    await adapter.generate(request());
    const headers = transport.mock.calls[0]![1]!.headers as Record<string, string>;
    expect(headers['api-key']).toBe('fixture-key'); expect(headers['Authorization']).toBeUndefined();
    expect(String(transport.mock.calls[0]![0])).toContain('api-version=2024-10-21');
  });

  it('asks a token source for a fresh credential on each request and refuses an unsafe one', async () => {
    let issued = 0; const transport = vi.fn<typeof globalThis.fetch>(async () => completion());
    const adapter = make({ apiKey: undefined, token: async () => `token-${++issued}` }, transport);
    await adapter.generate(request()); await adapter.generate(request());
    expect(transport.mock.calls.map(call => (call[1]!.headers as Record<string, string>)['Authorization'])).toEqual(['Bearer token-1', 'Bearer token-2']);
    await expect(make({ apiKey: undefined, token: () => 'bad\r\nInjected: header' }, transport).generate(request())).rejects.toBeInstanceOf(MayuraError);
  });

  it('refuses destinations that are not an explicit, exact HTTPS provider endpoint', () => {
    const refused: Record<string, unknown>[] = [
      { endpoint: 'http://api.provider.example/v1/chat/completions' },
      { endpoint: 'https://127.0.0.1/v1/chat/completions' },
      { endpoint: 'https://user:pass@api.provider.example/v1/chat/completions' },
      { endpoint: 'https://api.provider.example/v1/embeddings' },
      { endpoint: 'https://api.provider.example/v1/chat/completions?target=elsewhere' },
      { remote: { id: 'Bad Id' } },
      { apiKey: undefined },
      { token: () => 'x' },
    ];
    for (const options of refused) expect(() => make(options, async () => completion())).toThrow(MayuraError);
    // Without `remote`, only loopback is accepted, as before.
    expect(() => openAICompatibleChat({ endpoint: 'https://api.provider.example/v1/chat/completions', ...base })).toThrow(MayuraError);
  });

  it('streams content deltas and assembles tool calls from their fragments, requiring usage', async () => {
    const chunk = (delta: JsonObject, finish: string | null = null): JsonValue => ({ choices: [{ delta, finish_reason: finish }] });
    const streaming = make({}, async () => sse([chunk({ role: 'assistant', content: '{"answer":' }), chunk({ content: '"streamed"}' }), chunk({}, 'stop'),
      { choices: [], usage: { prompt_tokens: 10, completion_tokens: 3 } }, '[DONE]']));
    expect(await collect(streaming.stream!(request()))).toEqual([{ type: 'output.delta', text: '{"answer":' }, { type: 'output.delta', text: '"streamed"}' },
      { type: 'response', response: { type: 'final', output: { answer: 'streamed' }, usage: { costMicros: 1, inputTokens: 10, outputTokens: 3 } } }]);

    const tools = make({}, async () => sse([chunk({ tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'lookup', arguments: '{"q":' } }] }),
      chunk({ tool_calls: [{ index: 0, function: { arguments: '4}' } }] }), chunk({}, 'tool_calls'), { choices: [], usage: { prompt_tokens: 1, completion_tokens: 1 } }, '[DONE]']));
    const toolEvents = await collect(tools.stream!(request({ tools: [{ id: 'lookup', description: 'x', inputJsonSchema: { type: 'object', properties: { q: { type: 'number' } }, required: ['q'], additionalProperties: false } }] })));
    expect(toolEvents).toMatchObject([{ type: 'response', response: { type: 'tool_calls', calls: [{ id: 'call_1', toolId: 'lookup', input: { q: 4 } }], usage: { costMicros: 1 } } }]);

    for (const chunks of [[chunk({ content: '{"answer":"x"}' }, 'stop'), '[DONE]'], [chunk({ content: '{"answer":"x"}' }, 'stop'), { choices: [], usage: { prompt_tokens: 1, completion_tokens: 1 } }]] as (JsonValue | '[DONE]')[][]) {
      await expect(collect(make({}, async () => sse(chunks)).stream!(request()))).rejects.toBeInstanceOf(MayuraError);
    }
  });
});
