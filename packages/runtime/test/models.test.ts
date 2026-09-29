import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { MayuraError, ModelProviderError, type ModelAdapter, type ModelRequest, type ModelResponse, type ModelStreamEvent } from '@mayura/core';
import { createModels, createRuntime, defineAgent, type ModelProvider, type ProviderModelSettings } from '../src/index.js';

const final = (costMicros = 7): ModelResponse => ({ type: 'final', output: { answer: 42 }, usage: { costMicros } });
const request = (signal = new AbortController().signal): ModelRequest => ({ instructions: 'x', messages: [], tools: [], signal, maxOutputTokens: 64 });

/** A provider whose models answer from a script of results: a response, or an error to throw. */
function fakeProvider(id = 'fake', script: (ModelResponse | Error)[] = [], options: { stream?: boolean; deltaBeforeFailure?: boolean; catalog?: ModelProvider['catalog'] } = {}) {
  const seen: ProviderModelSettings[] = []; let calls = 0;
  const next = () => { const step = script[calls++] ?? final(); if (step instanceof Error) throw step; return step; };
  const provider: ModelProvider = {
    id, ...(options.catalog ? { catalog: options.catalog } : {}),
    model(_name, settings): ModelAdapter {
      seen.push(settings);
      return {
        id: settings.id, capabilities: { tools: true, structuredOutput: true }, maxCostMicros: settings.maxCostMicros,
        generate: async () => next(),
        ...(options.stream ? { async *stream(): AsyncIterable<ModelStreamEvent> {
          const step = script[calls++] ?? final();
          if (step instanceof Error) { if (options.deltaBeforeFailure) yield { type: 'output.delta', text: 'partial' }; throw step; }
          yield { type: 'output.delta', text: 'hi' }; yield { type: 'response', response: step };
        } } : {}),
      };
    },
  };
  return { provider, seen, calls: () => calls };
}

const prices = { 'fake/m1': { inputMicrosPerMillionTokens: 1_000_000, outputMicrosPerMillionTokens: 2_000_000 } };

describe('model registry', () => {
  it('builds each model with its id, its price and the per-call bound, and nothing without a price', () => {
    const { provider, seen } = fakeProvider();
    const models = createModels({ providers: [provider], prices, maxCallCostMicros: 50_000, timeoutMs: 20_000 });
    const model = models.model('fake/m1');
    expect(model.id).toBe('fake/m1');
    expect(seen[0]).toEqual({ id: 'fake/m1', pricing: prices['fake/m1'], maxCostMicros: 50_000, timeoutMs: 20_000 });
    expect(models.model('fake/m1', { maxCostMicros: 9, pricing: { inputMicrosPerMillionTokens: 1, outputMicrosPerMillionTokens: 2 } }).maxCostMicros).toBe(9);
    expect(() => models.model('fake/m2')).toThrow(expect.objectContaining({ code: 'INVALID_CONFIG', message: expect.stringMatching(/No price for fake\/m2/) }));
    for (const bad of ['m1', 'other/m1', '', 'fake/', 'fake/has space']) expect(() => models.model(bad)).toThrow(expect.objectContaining({ code: 'INVALID_CONFIG' }));
  });

  it('uses catalog prices only when asked to, and lists them with their date', () => {
    const catalog = { asOf: '2026-09-01', models: { 'm2': { pricing: { inputMicrosPerMillionTokens: 5, outputMicrosPerMillionTokens: 6 }, contextTokens: 128_000 } } };
    const without = createModels({ providers: [fakeProvider('fake', [], { catalog }).provider], maxCallCostMicros: 10 });
    expect(() => without.model('fake/m2')).toThrow(/prices: 'catalog'/);
    expect(without.list()).toEqual([{ id: 'fake/m2', provider: 'fake', name: 'm2', pricing: null, catalogAsOf: '2026-09-01', contextTokens: 128_000 }]);
    const { provider, seen } = fakeProvider('fake', [], { catalog });
    const models = createModels({ providers: [provider], prices: 'catalog', maxCallCostMicros: 10 });
    models.model('fake/m2');
    expect(seen[0]!.pricing).toEqual(catalog.models.m2.pricing);
    expect(models.list()[0]).toMatchObject({ id: 'fake/m2', pricing: catalog.models.m2.pricing, catalogAsOf: '2026-09-01' });
  });

  it('refuses a registry without a cost bound, duplicate or malformed providers, and adapters that ignore their settings', () => {
    const { provider } = fakeProvider();
    for (const options of [{ providers: [provider] }, { providers: [provider], maxCallCostMicros: -1 }, { providers: [], maxCallCostMicros: 1 },
      { providers: [provider, provider], maxCallCostMicros: 1 }, { providers: [{ ...provider, id: 'Bad_Id' }], maxCallCostMicros: 1 },
      { providers: [{ ...provider, catalog: { asOf: 'yesterday', models: {} } }], maxCallCostMicros: 1 }, { providers: [provider], maxCallCostMicros: 1, prices: 'all' }]) {
      expect(() => createModels(options as never)).toThrow(expect.objectContaining({ code: 'INVALID_CONFIG' }));
    }
    const liar: ModelProvider = { id: 'liar', model: (_name, settings) => ({ ...fakeProvider().provider.model('x', settings), id: 'someone-else' }) };
    expect(() => createModels({ providers: [liar], prices: { 'liar/m': prices['fake/m1'] }, maxCallCostMicros: 1 }).model('liar/m')).toThrow(/does not use the id/);
  });

  it('accepts provider model names with a colon, and runs an agent only with its model granted', async () => {
    const { provider } = fakeProvider('ollama');
    const models = createModels({ providers: [provider], prices: { 'ollama/llama3.1:8b': prices['fake/m1'] }, maxCallCostMicros: 10 });
    const agent = defineAgent({ id: 'a', version: '1', instructions: 'x', input: z.object({}), output: z.object({ answer: z.number() }), tools: [], model: models.model('ollama/llama3.1:8b') });
    const allowed = createRuntime({ profile: 'ephemeral', permissions: { allow: ['model:ollama/llama3.1:8b'] }, limits: { maxCostMicros: 100 } });
    expect(await allowed.submit(agent, { input: {} }).result()).toMatchObject({ status: 'succeeded', output: { answer: 42 } });
    const denied = createRuntime({ profile: 'ephemeral', permissions: { allow: ['model:ollama/other'] }, limits: { maxCostMicros: 100 } });
    expect(await denied.submit(agent, { input: {} }).result()).toMatchObject({ status: 'blocked' });
    await allowed.close(); await denied.close();
  });

  it('builds a chain under its own id, from registry models', async () => {
    const { provider } = fakeProvider('fake', [new ModelProviderError('unavailable', { costMicros: 3 }), final(5)]);
    const models = createModels({ providers: [provider], prices: { ...prices, 'fake/m2': prices['fake/m1'] }, maxCallCostMicros: 10 });
    const chain = models.chain('support', ['fake/m1', 'fake/m2']);
    expect(chain.id).toBe('support');
    expect(chain.maxCostMicros).toBe(20);
    expect(await chain.generate(request())).toMatchObject({ type: 'final', usage: { costMicros: 8 } });
    expect(() => models.chain('dupes', ['fake/m1', 'fake/m1'])).toThrow(expect.objectContaining({ code: 'INVALID_CONFIG' }));
  });
});

describe('retries on the same model', () => {
  const retried = (script: (ModelResponse | Error)[], retry = { attempts: 3, backoffMs: 0 }, stream = false, deltaBeforeFailure = false) => {
    const fake = fakeProvider('fake', script, { stream, deltaBeforeFailure });
    return { ...fake, model: createModels({ providers: [fake.provider], prices, maxCallCostMicros: 10 }).model('fake/m1', { retry }) };
  };

  it('retries rate limits and outages, charging every attempt, and bounds the call by all attempts', async () => {
    const { model, calls } = retried([new ModelProviderError('rate_limited', { httpStatus: 429, costMicros: 0 }), new ModelProviderError('unavailable', { costMicros: 2 }), final(5)]);
    expect(model.maxCostMicros).toBe(30);
    expect(await model.generate(request())).toMatchObject({ type: 'final', usage: { costMicros: 7 } });
    expect(calls()).toBe(3);
  });

  it('charges the full bound for an attempt whose cost is unknown', async () => {
    const { model } = retried([new ModelProviderError('unavailable'), final(5)]);
    expect(await model.generate(request())).toMatchObject({ usage: { costMicros: 15 } });
  });

  it('never retries what would fail again, and reports the last reason with the known cost when attempts run out', async () => {
    const auth = retried([new ModelProviderError('authentication', { httpStatus: 401, costMicros: 0 })]);
    await expect(auth.model.generate(request())).rejects.toMatchObject({ reason: 'authentication' });
    expect(auth.calls()).toBe(1);
    const config = retried([new MayuraError('INVALID_CONFIG', 'bad')]);
    await expect(config.model.generate(request())).rejects.toMatchObject({ code: 'INVALID_CONFIG' });
    const out = retried([new ModelProviderError('unavailable', { costMicros: 1 }), new ModelProviderError('rate_limited', { httpStatus: 429, costMicros: 2 })], { attempts: 2, backoffMs: 0 });
    const error = await out.model.generate(request()).then(() => undefined, (caught: unknown) => caught);
    expect(error).toBeInstanceOf(ModelProviderError);
    expect(error).toMatchObject({ reason: 'rate_limited', httpStatus: 429, costMicros: 3 });
  });

  it('stops when the caller cancels, including while waiting to retry', async () => {
    const controller = new AbortController();
    const { model, calls } = retried([new ModelProviderError('unavailable', { costMicros: 0 }), final()], { attempts: 3, backoffMs: 10_000 });
    const pending = model.generate(request(controller.signal));
    setTimeout(() => controller.abort(), 10);
    await expect(pending).rejects.toMatchObject({ code: 'CANCELLED' });
    expect(calls()).toBe(1);
  });

  it('retries a stream that released nothing, never one that already released text', async () => {
    const clean = retried([new ModelProviderError('unavailable', { costMicros: 0 }), final(4)], { attempts: 2, backoffMs: 0 }, true);
    const events: ModelStreamEvent[] = []; for await (const event of clean.model.stream!(request())) events.push(event);
    expect(events).toEqual([{ type: 'output.delta', text: 'hi' }, { type: 'response', response: expect.objectContaining({ usage: { costMicros: 4 } }) }]);
    // The first attempt releases text, then fails with a retryable outage: the call fails instead of starting over.
    const failing = retried([new ModelProviderError('unavailable', { costMicros: 1 }), final()], { attempts: 2, backoffMs: 0 }, true, true);
    const released: ModelStreamEvent[] = [];
    await expect((async () => { for await (const event of failing.model.stream!(request())) released.push(event); })()).rejects.toMatchObject({ reason: 'unavailable' });
    expect(released).toEqual([{ type: 'output.delta', text: 'partial' }]);
    expect(failing.calls()).toBe(1);
  });

  it('refuses retry settings out of range', () => {
    const models = createModels({ providers: [fakeProvider().provider], prices, maxCallCostMicros: 10 });
    for (const retry of [{ attempts: 0 }, { attempts: 6 }, { attempts: 2, backoffMs: -1 }, { attempts: 2, backoffMs: 60_001 }]) {
      expect(() => models.model('fake/m1', { retry })).toThrow(expect.objectContaining({ code: 'INVALID_CONFIG' }));
    }
  });
});
