import { describe, expect, it, vi } from 'vitest';
import type { RunEvent } from 'mayura';
import { agentRunTraceSpans } from 'mayura/exporter-otlp';
import { arizeTraceExporter, openInferenceAttributes } from '../src/index.js';

const spaceId = 'U3BhY2U6MTIzNDU='; const apiKey = 'ak-SECRET-0123456789';
const response = (body = '{}', status = 200): Response => new Response(body, { status, headers: { 'Content-Type': 'application/json' } });
const at = (second: number) => `2026-10-01T00:00:0${second}.000Z`;
const event = (sequence: number, type: RunEvent['type'], metadata: RunEvent['metadata']): RunEvent => ({ runId: 'run-1', sequence, timestamp: at(sequence), type, metadata });
const spans = agentRunTraceSpans([
  event(1, 'run.started', { profile: 'ephemeral', agentId: 'support' }), event(2, 'model.started', { step: 0, modelCall: 1, modelId: 'bedrock/claude-test' }),
  event(3, 'model.completed', { step: 0, response: 'tool_calls', costMicros: 9, inputTokens: 120, outputTokens: 30 }), event(4, 'tool.started', { callId: 'c-1', toolId: 'orders.lookup' }),
  event(5, 'tool.completed', { callId: 'c-1', toolId: 'orders.lookup', status: 'succeeded', execution: 'succeeded', disclosure: 'released' }),
  event(6, 'run.completed', { status: 'succeeded', spentMicros: 9, reservedMicros: 0, calls: 1 }),
]);
const signal = () => new AbortController().signal;
type Encoded = { key: string; value: { stringValue?: string; intValue?: string } };
const flat = (attributes: Encoded[]) => Object.fromEntries(attributes.map(({ key, value }) => [key, value.stringValue ?? Number(value.intValue)]));

describe('@mayurajs/observability-arize', () => {
  it('maps GenAI attributes to OpenInference: span kinds, model, provider, token counts, tool and agent', () => {
    const [run, model, tool] = spans.map(openInferenceAttributes);
    expect(run).toEqual({ 'openinference.span.kind': 'AGENT', 'agent.name': 'support' });
    expect(model).toEqual({ 'openinference.span.kind': 'LLM', 'llm.model_name': 'claude-test', 'llm.provider': 'aws', 'llm.token_count.prompt': 120, 'llm.token_count.completion': 30, 'llm.token_count.total': 150 });
    expect(tool).toEqual({ 'openinference.span.kind': 'TOOL', 'tool.name': 'orders.lookup' });
    expect(openInferenceAttributes({ ...spans[0]!, attributes: { 'mayura.workflow.node.id': 'plan' } })).toEqual({ 'openinference.span.kind': 'CHAIN' });
  });

  it('sends OTLP JSON to Arize AX with the space and key headers, the project and OpenInference attributes', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(response());
    const exporter = arizeTraceExporter({ spaceId, apiKey, projectName: 'support-agent', serviceName: 'support', fetch });
    await exporter.sink(spans, { signal: signal() });
    const [url, init] = fetch.mock.calls[0]!;
    expect(url).toBe('https://otlp.arize.com/v1/traces');
    expect(init?.headers).toEqual({ 'Content-Type': 'application/json', space_id: spaceId, api_key: apiKey });
    const body = JSON.parse(String(init?.body));
    expect(flat(body.resourceSpans[0].resource.attributes)).toEqual({ 'service.name': 'support', 'openinference.project.name': 'support-agent' });
    const kinds = body.resourceSpans[0].scopeSpans[0].spans.map((span: { attributes: Encoded[] }) => flat(span.attributes)['openinference.span.kind']);
    expect(kinds).toEqual(['AGENT', 'LLM', 'TOOL']);
    expect(JSON.stringify(exporter.inspect())).not.toContain('SECRET');
  });

  it('reaches the EU and Canada regions', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(response());
    for (const region of ['eu', 'ca'] as const) await arizeTraceExporter({ spaceId, apiKey, projectName: 'p', region, serviceName: 's', fetch }).sink(spans, { signal: signal() });
    expect(fetch.mock.calls.map(([url]) => url)).toEqual(['https://otlp.eu-west-1a.arize.com/v1/traces', 'https://otlp.ca-central-1a.arize.com/v1/traces']);
  });

  it('refuses missing credentials, a free-text project and unknown regions, without repeating the key', () => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    // Each is named for what is wrong, not reported as a generic exporter configuration error.
    const refused: [object, RegExp][] = [
      [{ apiKey, projectName: 'p' }, /space id/u], [{ spaceId, projectName: 'p' }, /API key/u], [{ spaceId, apiKey: 'SECRET key\nwith newline', projectName: 'p' }, /API key/u],
      [{ spaceId, apiKey }, /project name/u], [{ spaceId, apiKey, projectName: 'Support agent' }, /project name/u],
      [{ spaceId, apiKey, projectName: 'p', region: 'mars' }, /region/u], [{ spaceId, apiKey, projectName: 'p', region: 'constructor' }, /region/u],
    ];
    for (const [options, message] of refused) {
      let caught: unknown; try { arizeTraceExporter({ serviceName: 's', fetch, ...options } as never); } catch (error) { caught = error; }
      expect(caught).toMatchObject({ code: 'INVALID_CONFIG', message: expect.stringMatching(message) }); expect(`${String(caught)} ${JSON.stringify(caught)}`).not.toContain('SECRET');
    }
    expect(fetch).not.toHaveBeenCalled();
  });

  it('reports a rejected request without Arize\'s text or the key', async () => {
    const exporter = arizeTraceExporter({ spaceId, apiKey, projectName: 'p', serviceName: 's', fetch: vi.fn<typeof globalThis.fetch>().mockResolvedValue(response('SECRET unauthorized', 401)) });
    const caught = await exporter.sink(spans, { signal: signal() }).catch((error: unknown) => error);
    expect(caught).toMatchObject({ code: 'TOOL_FAILED' }); expect(`${String(caught)} ${JSON.stringify(caught)}`).not.toContain('SECRET');
  });
});
