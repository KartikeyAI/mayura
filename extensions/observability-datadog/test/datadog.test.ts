import { describe, expect, it, vi } from 'vitest';
import type { RunEvent } from 'mayura';
import { agentRunTraceSpans } from 'mayura/exporter-otlp';
import { datadogTraceExporter } from '../src/index.js';

const apiKey = 'abcdef0123456789SECRET0123456789';
const response = (body = '{}', status = 200): Response => new Response(body, { status, headers: { 'Content-Type': 'application/json' } });
const at = (second: number) => `2026-10-01T00:00:0${second}.000Z`;
const event = (sequence: number, type: RunEvent['type'], metadata: RunEvent['metadata']): RunEvent => ({ runId: 'run-1', sequence, timestamp: at(sequence), type, metadata });
const spans = agentRunTraceSpans([
  event(1, 'run.started', { profile: 'ephemeral', agentId: 'support' }), event(2, 'model.started', { step: 0, modelCall: 1, modelId: 'anthropic/claude-test' }),
  event(3, 'model.completed', { step: 0, response: 'final', costMicros: 9, inputTokens: 120, outputTokens: 30 }),
  event(4, 'run.completed', { status: 'succeeded', spentMicros: 9, reservedMicros: 0, calls: 1 }),
]);
const signal = () => new AbortController().signal;
const sent = (fetch: ReturnType<typeof vi.fn<typeof globalThis.fetch>>) => fetch.mock.calls.map(([url, init]) => ({ url: String(url), headers: init?.headers as Record<string, string> }));

describe('@mayurajs/observability-datadog', () => {
  it('sends OTLP JSON traces to the site\'s OTLP intake for APM, with the API key header', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(response());
    const exporter = datadogTraceExporter({ apiKey, serviceName: 'support-agent', fetch });
    await exporter.sink(spans, { signal: signal() });
    const [request] = sent(fetch);
    expect(request!.url).toBe('https://otlp.datadoghq.com/v1/traces');
    expect(request!.headers).toEqual({ 'Content-Type': 'application/json', 'dd-api-key': apiKey });
    expect(String(fetch.mock.calls[0]![1]?.body)).toContain('gen_ai.provider.name');
    expect(JSON.stringify(exporter.inspect())).not.toContain('SECRET');
  });

  it('sends to LLM Observability, with or without an ML app, on any non-government site', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(response());
    await datadogTraceExporter({ apiKey, site: 'datadoghq.eu', llmObservability: true, serviceName: 's', fetch }).sink(spans, { signal: signal() });
    await datadogTraceExporter({ apiKey, site: 'us5.datadoghq.com', llmObservability: { mlApp: 'support-bot' }, serviceName: 's', fetch }).sink(spans, { signal: signal() });
    expect(sent(fetch)).toEqual([
      { url: 'https://otlp.datadoghq.eu/v1/traces', headers: { 'Content-Type': 'application/json', 'dd-api-key': apiKey, 'dd-otlp-source': 'llmobs' } },
      { url: 'https://otlp.us5.datadoghq.com/v1/traces', headers: { 'Content-Type': 'application/json', 'dd-api-key': apiKey, 'dd-otlp-source': 'llmobs', 'dd-ml-app': 'support-bot' } },
    ]);
  });

  it('refuses a missing key, unknown sites, a bad ML app and LLM Observability on ddog-gov.com, without repeating the key', () => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    const refused = [
      { apiKey: undefined }, { apiKey: 'SECRET key with spaces' }, { apiKey, site: 'evil.example' }, { apiKey, site: 'constructor' },
      { apiKey, llmObservability: 'yes' }, { apiKey, llmObservability: { mlApp: 'has spaces' } }, { apiKey, site: 'ddog-gov.com', llmObservability: true },
    ];
    for (const options of refused) {
      let caught: unknown; try { datadogTraceExporter({ serviceName: 's', fetch, ...options } as never); } catch (error) { caught = error; }
      expect(caught).toMatchObject({ code: 'INVALID_CONFIG' }); expect(`${String(caught)} ${JSON.stringify(caught)}`).not.toContain('SECRET');
    }
    expect(() => datadogTraceExporter({ apiKey, site: 'ddog-gov.com', serviceName: 's', fetch })).not.toThrow();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('reports a rejected request without Datadog\'s text or the key', async () => {
    const exporter = datadogTraceExporter({ apiKey, serviceName: 's', fetch: vi.fn<typeof globalThis.fetch>().mockResolvedValue(response('{"errors":["SECRET Forbidden"]}', 403)) });
    const caught = await exporter.sink(spans, { signal: signal() }).catch((error: unknown) => error);
    expect(caught).toMatchObject({ code: 'TOOL_FAILED' }); expect(`${String(caught)} ${JSON.stringify(caught)}`).not.toContain('SECRET');
    expect(exporter.inspect().metrics).toMatchObject({ failedRequests: 1, recordsDropped: 2 });
  });
});
