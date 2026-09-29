import { describe, expect, it } from 'vitest';
import type { JsonObject } from '@mayura/core';
import { conformanceTools, modelAdapterConformance, type ModelAdapterHarness, type ModelScenario } from '@mayura/testing';
import { openAIResponses } from '../src/index.js';

// The OpenAI Responses API on the wire, answering each conformance scenario. The same transport serves any adapter that
// speaks this API, including ones built on the vendor SDK.
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
const message = (text: string) => ({ type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text }] });
const usage = (input: number, output: number) => ({ input_tokens: input, output_tokens: output });
const sse = (events: unknown[]) => new Response(new ReadableStream({ start(controller) {
  for (const event of events) controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\n`));
  controller.close();
} }), { headers: { 'content-type': 'text/event-stream' } });

export function responsesTransport(scenario: ModelScenario): typeof globalThis.fetch {
  return async (_input, init) => {
    const body = JSON.parse(String(init?.body ?? '{}')) as JsonObject;
    switch (scenario.kind) {
      case 'network': throw new TypeError('fetch failed');
      case 'hang': return new Promise<Response>((_resolve, reject) => init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError'))));
      case 'http': return json({ error: { message: scenario.detail } }, scenario.status);
      case 'invalid': return json({ status: 'completed', output: [message(`not json: ${scenario.detail}`)], usage: usage(1, 1) });
      case 'refusal': return json({ status: 'completed', output: [{ type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'refusal', refusal: 'I cannot help with that.' }] }], usage: usage(5, 1) });
      case 'final': return json({ status: 'completed', output: [message(JSON.stringify(scenario.output))], usage: usage(scenario.inputTokens, scenario.outputTokens) });
      case 'tool_calls': {
        const offered = (body['tools'] as { name: string; description: string }[]) ?? [];
        const nameOf = (toolId: string) => offered.find(tool => tool.description === conformanceTools.find(entry => entry.id === toolId)?.description)?.name;
        return json({ status: 'completed', usage: usage(scenario.inputTokens, scenario.outputTokens), output: scenario.calls.map((call, index) => ({
          type: 'function_call', id: `fc_${index}`, status: 'completed', call_id: `call_${index}`, name: nameOf(call.toolId), arguments: JSON.stringify(call.input) })) });
      }
      case 'stream_final': return sse([
        { type: 'response.created' },
        ...scenario.chunks.map(delta => ({ type: 'response.output_text.delta', delta })),
        { type: 'response.completed', response: { status: 'completed', output: [message(scenario.chunks.join(''))], usage: usage(scenario.inputTokens, scenario.outputTokens) } },
      ]);
    }
  };
}

const harness: ModelAdapterHarness = {
  // The 1.0 adapter takes flat prices only; use a registry provider package for long-context rates.
  skip: { long_context: 'The 1.0 adapter charges flat prices.' },
  adapter: (scenario, settings) => {
    const adapter = openAIResponses({ apiKey: 'fixture-not-a-real-key', model: 'fixture-model', pricing: settings.pricing, maxCostMicros: settings.maxCostMicros,
      ...(settings.timeoutMs === undefined ? {} : { timeoutMs: settings.timeoutMs }), fetch: responsesTransport(scenario) });
    // The 1.0 adapter's id is protocol-level; the id check applies to adapters built for a model registry.
    return { ...adapter, id: settings.id, generate: adapter.generate.bind(adapter), ...(adapter.stream ? { stream: adapter.stream.bind(adapter) } : {}),
      ...(adapter.checkDefinition ? { checkDefinition: adapter.checkDefinition.bind(adapter) } : {}) };
  },
};

describe('openAIResponses keeps the model adapter contract', () => {
  for (const test of modelAdapterConformance) it(test.name, async () => { expect(await test.run(harness)).toMatch(/^(?:passed|skipped)$/u); });
});
