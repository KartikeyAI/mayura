import { describe, expect, it, vi } from 'vitest';
import type { RunEvent } from 'mayura';
import { agentRunTraceSpans } from 'mayura/exporter-otlp';
import { langSmithAttributes, langSmithTraceExporter } from '../src/index.js';

const apiKey = 'lsv2_pt_SECRET0123456789';
const response = (body = '{}', status = 200): Response => new Response(body, { status, headers: { 'Content-Type': 'application/json' } });
const at = (second: number) => `2026-10-01T00:00:0${second}.000Z`;
const event = (sequence: number, type: RunEvent['type'], metadata: RunEvent['metadata']): RunEvent => ({ runId: 'run-1', sequence, timestamp: at(sequence), type, metadata });
const spans = agentRunTraceSpans([
  event(1, 'run.started', { profile: 'ephemeral', agentId: 'support' }), event(2, 'model.started', { step: 0, modelCall: 1, modelId: 'anthropic/claude-test' }),
  event(3, 'model.completed', { step: 0, response: 'tool_calls', costMicros: 9, inputTokens: 120, outputTokens: 30 }), event(4, 'tool.started', { callId: 'c-1', toolId: 'orders.lookup' }),
  event(5, 'tool.completed', { callId: 'c-1', toolId: 'orders.lookup', status: 'succeeded', execution: 'succeeded', disclosure: 'released' }),
  event(6, 'run.completed', { status: 'succeeded', spentMicros: 9, reservedMicros: 0, calls: 1 }),
]);
const signal = () => new AbortController().signal;
type Encoded = { key: string; value: { stringValue?: string } };

describe('@mayurajs/observability-langsmith', () => {
  it('gives runs, model calls and tool calls LangSmith\'s run types, and the provider as gen_ai.system', () => {
    expect(spans.map(langSmithAttributes)).toEqual([{ 'langsmith.span.kind': 'chain' }, { 'langsmith.span.kind': 'llm', 'gen_ai.system': 'anthropic' }, { 'langsmith.span.kind': 'tool' }]);
    expect(langSmithAttributes({ ...spans[0]!, attributes: { 'mayura.workflow.node.id': 'plan' } })).toEqual({ 'langsmith.span.kind': 'chain' });
  });

  it('sends OTLP JSON to LangSmith with the API key and project, and LangSmith\'s attributes on each span', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(response());
    const exporter = langSmithTraceExporter({ apiKey, project: 'Support agent', serviceName: 'support-agent', fetch });
    await exporter.sink(spans, { signal: signal() });
    const [url, init] = fetch.mock.calls[0]!;
    expect(url).toBe('https://api.smith.langchain.com/otel/v1/traces');
    expect(init?.headers).toEqual({ 'Content-Type': 'application/json', 'x-api-key': apiKey, 'Langsmith-Project': 'Support agent' });
    const sent = JSON.parse(String(init?.body)).resourceSpans[0].scopeSpans[0].spans as { attributes: Encoded[] }[];
    expect(sent.map(span => span.attributes.find(attribute => attribute.key === 'langsmith.span.kind')?.value.stringValue)).toEqual(['chain', 'llm', 'tool']);
    expect(JSON.stringify(exporter.inspect())).not.toContain('SECRET');
  });

  it('reaches each region and a self-hosted LangSmith, without a project header by default', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(response());
    for (const region of ['eu', 'apac', 'aws-us'] as const) await langSmithTraceExporter({ apiKey, region, serviceName: 's', fetch }).sink(spans, { signal: signal() });
    await langSmithTraceExporter({ apiKey, baseUrl: 'https://langsmith.example.com/', serviceName: 's', fetch }).sink(spans, { signal: signal() });
    expect(fetch.mock.calls.map(([url]) => url)).toEqual(['https://eu.api.smith.langchain.com/otel/v1/traces', 'https://apac.api.smith.langchain.com/otel/v1/traces',
      'https://aws.api.smith.langchain.com/otel/v1/traces', 'https://langsmith.example.com/api/v1/otel/v1/traces']);
    expect(fetch.mock.calls.every(([, init]) => !Object.hasOwn(init?.headers as object, 'Langsmith-Project'))).toBe(true);
  });

  it('refuses a missing key, unsafe projects, unknown regions and unsafe URLs, without repeating the key', () => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    const refused: [object, RegExp][] = [
      [{}, /API key/u], [{ apiKey: 'SECRET key with spaces' }, /API key/u], [{ apiKey, project: 'two\nlines' }, /project/u], [{ apiKey, project: ' padded ' }, /project/u],
      [{ apiKey, project: 'x'.repeat(129) }, /project/u], [{ apiKey, region: 'mars' }, /region/u], [{ apiKey, region: 'constructor' }, /region/u],
      [{ apiKey, region: 'us', baseUrl: 'https://langsmith.example.com' }, /region or a baseUrl/u], [{ apiKey, baseUrl: 'https://user:SECRET@langsmith.example.com' }, /baseUrl/u],
      [{ apiKey, baseUrl: 'https://langsmith.example.com?x=1' }, /baseUrl/u],
    ];
    for (const [options, message] of refused) {
      let caught: unknown; try { langSmithTraceExporter({ serviceName: 's', fetch, ...options } as never); } catch (error) { caught = error; }
      expect(caught).toMatchObject({ code: 'INVALID_CONFIG', message: expect.stringMatching(message) }); expect(`${String(caught)} ${JSON.stringify(caught)}`).not.toContain('SECRET');
    }
    expect(fetch).not.toHaveBeenCalled();
  });

  it('reports a rejected request without LangSmith\'s text or the key', async () => {
    const exporter = langSmithTraceExporter({ apiKey, serviceName: 's', fetch: vi.fn<typeof globalThis.fetch>().mockResolvedValue(response('{"detail":"SECRET invalid"}', 403)) });
    const caught = await exporter.sink(spans, { signal: signal() }).catch((error: unknown) => error);
    expect(caught).toMatchObject({ code: 'TOOL_FAILED' }); expect(`${String(caught)} ${JSON.stringify(caught)}`).not.toContain('SECRET');
  });
});
