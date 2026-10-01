import { describe, expect, it, vi } from 'vitest';
import type { RunEvent } from 'mayura';
import { agentRunTraceSpans } from 'mayura/exporter-otlp';
import { langfuseTraceExporter } from '../src/index.js';

const publicKey = 'pk-lf-1234'; const secretKey = 'sk-lf-SECRET5678';
const response = (body = '{}', status = 200): Response => new Response(body, { status, headers: { 'Content-Type': 'application/json' } });
const at = (second: number) => `2026-10-01T00:00:0${second}.000Z`;
const event = (sequence: number, type: RunEvent['type'], metadata: RunEvent['metadata']): RunEvent => ({ runId: 'run-1', sequence, timestamp: at(sequence), type, metadata });
const spans = agentRunTraceSpans([
  event(1, 'run.started', { profile: 'ephemeral', agentId: 'support' }), event(2, 'model.started', { step: 0, modelCall: 1, modelId: 'openai/gpt-test' }),
  event(3, 'model.completed', { step: 0, response: 'final', costMicros: 9, inputTokens: 120, outputTokens: 30 }),
  event(4, 'run.completed', { status: 'succeeded', spentMicros: 9, reservedMicros: 0, calls: 1 }),
]);
const signal = () => new AbortController().signal;

describe('@mayurajs/observability-langfuse', () => {
  it('sends OTLP JSON to Langfuse Cloud with Basic authentication and the current ingestion version', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(response());
    const exporter = langfuseTraceExporter({ publicKey, secretKey, serviceName: 'support-agent', fetch });
    await exporter.sink(spans, { signal: signal() });
    const [url, init] = fetch.mock.calls[0]!;
    expect(url).toBe('https://cloud.langfuse.com/api/public/otel/v1/traces');
    expect(init?.headers).toMatchObject({ Authorization: `Basic ${btoa(`${publicKey}:${secretKey}`)}`, 'x-langfuse-ingestion-version': '4', 'Content-Type': 'application/json' });
    const sent = JSON.stringify(JSON.parse(String(init?.body)));
    for (const attribute of ['gen_ai.operation.name', 'gen_ai.agent.id', 'gen_ai.provider.name', 'gen_ai.usage.input_tokens']) expect(sent).toContain(attribute);
    expect(exporter.inspect().metrics).toMatchObject({ recordsAccepted: 2 });
    expect(JSON.stringify(exporter.inspect())).not.toContain('SECRET');
  });

  it('reaches each Cloud region and a self-hosted Langfuse', async () => {
    const urls: string[] = [];
    const fetch = vi.fn<typeof globalThis.fetch>(async url => { urls.push(String(url)); return response(); });
    for (const region of ['us', 'jp', 'hipaa'] as const) await langfuseTraceExporter({ publicKey, secretKey, region, serviceName: 's', fetch }).sink(spans, { signal: signal() });
    await langfuseTraceExporter({ publicKey, secretKey, baseUrl: 'https://langfuse.example.com/', serviceName: 's', fetch }).sink(spans, { signal: signal() });
    await langfuseTraceExporter({ publicKey, secretKey, baseUrl: 'http://127.0.0.1:3000', allowInsecureLoopback: true, serviceName: 's', fetch }).sink(spans, { signal: signal() });
    expect(urls).toEqual(['https://us.cloud.langfuse.com/api/public/otel/v1/traces', 'https://jp.cloud.langfuse.com/api/public/otel/v1/traces',
      'https://hipaa.cloud.langfuse.com/api/public/otel/v1/traces', 'https://langfuse.example.com/api/public/otel/v1/traces', 'http://127.0.0.1:3000/api/public/otel/v1/traces']);
  });

  it('refuses missing or malformed keys, unknown regions and unsafe URLs without repeating the secret', () => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    const refused = [
      { publicKey, secretKey: undefined }, { publicKey: secretKey, secretKey }, { publicKey, secretKey: 'sk-lf-SECRET with space' }, { publicKey, secretKey, region: 'mars' },
      { publicKey, secretKey, region: 'us', baseUrl: 'https://langfuse.example.com' }, { publicKey, secretKey, baseUrl: 'https://user:SECRET@langfuse.example.com' },
      { publicKey, secretKey, baseUrl: 'https://langfuse.example.com?x=1' }, { publicKey, secretKey, baseUrl: 'http://langfuse.example.com' },
      { publicKey, secretKey, baseUrl: 'http://127.0.0.1:3000' },
    ];
    for (const options of refused) {
      let caught: unknown; try { langfuseTraceExporter({ serviceName: 's', fetch, ...options } as never); } catch (error) { caught = error; }
      expect(caught).toMatchObject({ code: 'INVALID_CONFIG' }); expect(`${String(caught)} ${JSON.stringify(caught)}`).not.toContain('SECRET');
    }
    // An unknown region is named as such, not reported as a bad URL.
    expect(() => langfuseTraceExporter({ publicKey, secretKey, region: 'constructor' as never, serviceName: 's', fetch })).toThrow(/region must be/u);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('reports a rejected request and a cancelled export without Langfuse\'s text or the credentials', async () => {
    const rejecting = langfuseTraceExporter({ publicKey, secretKey, serviceName: 's', fetch: vi.fn<typeof globalThis.fetch>().mockResolvedValue(response('{"message":"SECRET invalid credentials"}', 401)) });
    const caught = await rejecting.sink(spans, { signal: signal() }).catch((error: unknown) => error);
    expect(caught).toMatchObject({ code: 'TOOL_FAILED' }); expect(`${String(caught)} ${JSON.stringify(caught)}`).not.toContain('SECRET');
    expect(rejecting.inspect().metrics).toMatchObject({ failedRequests: 1, recordsDropped: 2 });
    const controller = new AbortController();
    const hanging = langfuseTraceExporter({ publicKey, secretKey, serviceName: 's', fetch: (_url, init) => new Promise((_resolve, reject) => init?.signal?.addEventListener('abort', () => reject(new Error('aborted')))) });
    const pending = hanging.sink(spans, { signal: controller.signal }); controller.abort();
    await expect(pending).rejects.toMatchObject({ code: 'CANCELLED' });
  });
});
