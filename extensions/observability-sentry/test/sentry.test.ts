import { describe, expect, it, vi } from 'vitest';
import type { RunEvent } from 'mayura';
import { agentRunTraceSpans } from 'mayura/exporter-otlp';
import { sentryAttributes, sentryTraceExporter } from '../src/index.js';

const key = '0123456789abcdef0123456789abcdef';
const dsn = `https://${key}@o12345.ingest.us.sentry.io/678`;
const response = (body = '{}', status = 200): Response => new Response(body, { status, headers: { 'Content-Type': 'application/json' } });
const at = (second: number) => `2026-10-01T00:00:0${second}.000Z`;
const event = (sequence: number, type: RunEvent['type'], metadata: RunEvent['metadata']): RunEvent => ({ runId: 'run-1', sequence, timestamp: at(sequence), type, metadata });
const spans = agentRunTraceSpans([
  event(1, 'run.started', { profile: 'ephemeral', agentId: 'support' }), event(2, 'model.started', { step: 0, modelCall: 1, modelId: 'openai/gpt-test' }),
  event(3, 'model.completed', { step: 0, response: 'tool_calls', costMicros: 9, inputTokens: 120, outputTokens: 30 }), event(4, 'tool.started', { callId: 'c-1', toolId: 'orders.lookup' }),
  event(5, 'tool.completed', { callId: 'c-1', toolId: 'orders.lookup', status: 'succeeded', execution: 'succeeded', disclosure: 'released' }),
  event(6, 'run.completed', { status: 'succeeded', spentMicros: 9, reservedMicros: 0, calls: 1 }),
]);
const signal = () => new AbortController().signal;
type Encoded = { key: string; value: { stringValue?: string } };

describe('@mayurajs/observability-sentry', () => {
  it('gives agent, model and tool spans Sentry\'s gen_ai span ops, and other spans none', () => {
    expect(spans.map(sentryAttributes)).toEqual([{ 'sentry.op': 'gen_ai.invoke_agent' }, { 'sentry.op': 'gen_ai.chat' }, { 'sentry.op': 'gen_ai.execute_tool' }]);
    expect(sentryAttributes({ ...spans[0]!, attributes: { 'mayura.workflow.node.id': 'plan' } })).toBeUndefined();
  });

  it('sends OTLP JSON to the project\'s OTLP endpoint, built from the DSN, with the public key', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(response());
    await sentryTraceExporter({ dsn, serviceName: 'support-agent', fetch }).sink(spans, { signal: signal() });
    const [url, init] = fetch.mock.calls[0]!;
    expect(url).toBe('https://o12345.ingest.us.sentry.io/api/678/integration/otlp/v1/traces');
    expect(init?.headers).toEqual({ 'Content-Type': 'application/json', 'x-sentry-auth': `sentry sentry_key=${key}` });
    const sent = JSON.parse(String(init?.body)).resourceSpans[0].scopeSpans[0].spans as { attributes: Encoded[] }[];
    expect(sent.map(span => span.attributes.find(attribute => attribute.key === 'sentry.op')?.value.stringValue)).toEqual(['gen_ai.invoke_agent', 'gen_ai.chat', 'gen_ai.execute_tool']);
  });

  it('reaches a self-hosted Sentry under a path, and never sends a legacy DSN\'s secret key', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(response());
    await sentryTraceExporter({ dsn: `https://${key}:SECRET0legacy0key@sentry.example.com/errors/42`, serviceName: 's', fetch }).sink(spans, { signal: signal() });
    await sentryTraceExporter({ dsn: `http://${key}@127.0.0.1:9000/7`, allowInsecureLoopback: true, serviceName: 's', fetch }).sink(spans, { signal: signal() });
    expect(fetch.mock.calls.map(([url]) => url)).toEqual(['https://sentry.example.com/errors/api/42/integration/otlp/v1/traces', 'http://127.0.0.1:9000/api/7/integration/otlp/v1/traces']);
    expect(JSON.stringify(fetch.mock.calls)).not.toContain('SECRET');
  });

  it('refuses a missing or malformed DSN without repeating it', () => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    for (const bad of [undefined, 'not a url', 'https://o1.ingest.sentry.io/2', `https://${key}@o1.ingest.sentry.io/`, `https://${key}@o1.ingest.sentry.io/project`,
      `https://${key}@o1.ingest.sentry.io/2?SECRET=1`, 'https://SECRET-not-a-key@o1.ingest.sentry.io/2', `http://${key}@sentry.example.com/2`]) {
      let caught: unknown; try { sentryTraceExporter({ dsn: bad as never, serviceName: 's', fetch }); } catch (error) { caught = error; }
      expect(caught).toMatchObject({ code: 'INVALID_CONFIG' }); expect(`${String(caught)} ${JSON.stringify(caught)}`).not.toContain('SECRET');
    }
    expect(fetch).not.toHaveBeenCalled();
  });

  it('reports a rejected request without Sentry\'s text', async () => {
    const exporter = sentryTraceExporter({ dsn, serviceName: 's', fetch: vi.fn<typeof globalThis.fetch>().mockResolvedValue(response('{"detail":"SECRET rate limited"}', 429)) });
    const caught = await exporter.sink(spans, { signal: signal() }).catch((error: unknown) => error);
    expect(caught).toMatchObject({ code: 'TOOL_FAILED' }); expect(`${String(caught)} ${JSON.stringify(caught)}`).not.toContain('SECRET');
  });
});
