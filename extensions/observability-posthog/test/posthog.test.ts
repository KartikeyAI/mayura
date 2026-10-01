import { describe, expect, it, vi } from 'vitest';
import type { RunEvent } from 'mayura';
import { agentRunTraceSpans } from 'mayura/exporter-otlp';
import { posthogTraceExporter } from '../src/index.js';

const projectToken = 'phc_SECRET0123456789';
const response = (body = '{}', status = 200): Response => new Response(body, { status, headers: { 'Content-Type': 'application/json' } });
const at = (second: number) => `2026-10-01T00:00:0${second}.000Z`;
const event = (sequence: number, type: RunEvent['type'], metadata: RunEvent['metadata']): RunEvent => ({ runId: 'run-1', sequence, timestamp: at(sequence), type, metadata });
const spans = agentRunTraceSpans([
  event(1, 'run.started', { profile: 'ephemeral', agentId: 'support' }), event(2, 'model.started', { step: 0, modelCall: 1, modelId: 'openai/gpt-test' }),
  event(3, 'model.completed', { step: 0, response: 'final', costMicros: 9, inputTokens: 120, outputTokens: 30 }),
  event(4, 'run.completed', { status: 'succeeded', spentMicros: 9, reservedMicros: 0, calls: 1 }),
]);
const signal = () => new AbortController().signal;
type Encoded = { key: string; value: { stringValue?: string } };

describe('@mayurajs/observability-posthog', () => {
  it('sends OTLP JSON to PostHog\'s AI endpoint with the project token, anonymously by default', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(response());
    const exporter = posthogTraceExporter({ projectToken, serviceName: 'support-agent', fetch });
    await exporter.sink(spans, { signal: signal() });
    const [url, init] = fetch.mock.calls[0]!;
    expect(url).toBe('https://us.i.posthog.com/i/v0/ai/otel');
    expect(init?.headers).toEqual({ 'Content-Type': 'application/json', Authorization: `Bearer ${projectToken}` });
    const body = JSON.parse(String(init?.body));
    expect(body.resourceSpans[0].resource.attributes.map((attribute: Encoded) => attribute.key)).toEqual(['service.name']);
    expect(String(init?.body)).toContain('gen_ai.request.model');
    expect(JSON.stringify(exporter.inspect())).not.toContain('SECRET');
  });

  it('reaches the EU region, and names the person with posthog.distinct_id', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(response());
    await posthogTraceExporter({ projectToken, region: 'eu', distinctId: 'user-42', resourceAttributes: { 'deployment.environment': 'prod' }, serviceName: 's', fetch }).sink(spans, { signal: signal() });
    const [url, init] = fetch.mock.calls[0]!;
    expect(url).toBe('https://eu.i.posthog.com/i/v0/ai/otel');
    expect(JSON.parse(String(init?.body)).resourceSpans[0].resource.attributes).toEqual([{ key: 'service.name', value: { stringValue: 's' } },
      { key: 'deployment.environment', value: { stringValue: 'prod' } }, { key: 'posthog.distinct_id', value: { stringValue: 'user-42' } }]);
  });

  it('refuses a missing or malformed token, unknown regions and a free-text distinct id, without repeating the token', () => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    const refused: [object, RegExp][] = [
      [{}, /API token/u], [{ projectToken: 'phx_SECRET0123456789' }, /API token/u], [{ projectToken: 'phc_SECRET with space' }, /API token/u],
      [{ projectToken, region: 'apac' }, /region/u], [{ projectToken, region: 'constructor' }, /region/u], [{ projectToken, distinctId: 'jane doe' }, /distinctId/u],
    ];
    for (const [options, message] of refused) {
      let caught: unknown; try { posthogTraceExporter({ serviceName: 's', fetch, ...options } as never); } catch (error) { caught = error; }
      expect(caught).toMatchObject({ code: 'INVALID_CONFIG', message: expect.stringMatching(message) }); expect(`${String(caught)} ${JSON.stringify(caught)}`).not.toContain('SECRET');
    }
    expect(fetch).not.toHaveBeenCalled();
  });

  it('reports a rejected request without PostHog\'s text or the token', async () => {
    const exporter = posthogTraceExporter({ projectToken, serviceName: 's', fetch: vi.fn<typeof globalThis.fetch>().mockResolvedValue(response('{"detail":"SECRET invalid token"}', 401)) });
    const caught = await exporter.sink(spans, { signal: signal() }).catch((error: unknown) => error);
    expect(caught).toMatchObject({ code: 'TOOL_FAILED' }); expect(`${String(caught)} ${JSON.stringify(caught)}`).not.toContain('SECRET');
  });
});
