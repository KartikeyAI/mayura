import { describe, expect, it, vi } from 'vitest';
import { openAIEmbeddings } from '../src/index.js';

const reply = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });

describe('OpenAI embeddings adapter', () => {
  it('posts a bounded batch to the fixed endpoint and returns vectors in input order', async () => {
    const fetch = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => reply({ data: [{ index: 1, embedding: [0, 1] }, { index: 0, embedding: [1, 0] }], usage: { prompt_tokens: 7 } }));
    const onUsage = vi.fn();
    const adapter = openAIEmbeddings({ apiKey: 'test-only', model: 'text-embedding-3-small', dimensions: 2, fetch: fetch as never, onUsage });
    expect(adapter).toMatchObject({ id: 'openai.text-embedding-3-small.2', dimensions: 2, location: 'hosted' });
    expect(await adapter.embed(['a', 'b'], new AbortController().signal)).toEqual([[1, 0], [0, 1]]);
    expect(fetch.mock.calls[0]![0]).toBe('https://api.openai.com/v1/embeddings');
    expect(JSON.parse(fetch.mock.calls[0]![1]!.body as string)).toEqual({ model: 'text-embedding-3-small', input: ['a', 'b'], dimensions: 2, encoding_format: 'float' });
    expect(fetch.mock.calls[0]![1]!.redirect).toBe('error'); expect(onUsage).toHaveBeenCalledWith({ inputTokens: 7 });
  });

  it('rejects malformed responses, provider errors and oversized batches without echoing provider text', async () => {
    const make = (value: unknown, status = 200) => openAIEmbeddings({ apiKey: 'k', model: 'm', dimensions: 2, maxBatch: 2, fetch: (async () => reply(value, status)) as never });
    for (const payload of [{ data: [{ index: 0, embedding: [1] }], usage: { prompt_tokens: 1 } }, { data: [], usage: {} },
      { data: [{ index: 0, embedding: [1, 'x'] }], usage: { prompt_tokens: 1 } }, { data: [{ index: 0, embedding: [1, 0] }, { index: 0, embedding: [1, 0] }], usage: { prompt_tokens: 1 } }]) {
      await expect(make(payload).embed(['a'], new AbortController().signal)).rejects.toMatchObject({ code: 'MODEL_FAILED' });
    }
    const failure = make({ error: { message: 'SECRET provider text' } }, 500).embed(['a'], new AbortController().signal);
    await expect(failure).rejects.toMatchObject({ code: 'MODEL_FAILED' }); await expect(failure).rejects.not.toThrow(/SECRET/);
    await expect(make({}).embed(['a', 'b', 'c'], new AbortController().signal)).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    expect(() => openAIEmbeddings({ apiKey: 'k', model: 'bad model', dimensions: 2 })).toThrow();
  });
});
