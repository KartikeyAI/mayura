import { describe, expect, it, vi } from 'vitest';
import type { RunEvent } from 'mayura';
import { agentRunTraceSpans } from 'mayura/exporter-otlp';
import { betterStackTraceExporter } from '../src/index.js';

const sourceToken = 'SECRETsourceToken1234'; const ingestingHost = 's1234.eu-nbg-2.betterstackdata.com';
const response = (body = '{}', status = 200): Response => new Response(body, { status, headers: { 'Content-Type': 'application/json' } });
const at = (second: number) => `2026-10-01T00:00:0${second}.000Z`;
const event = (sequence: number, type: RunEvent['type'], metadata: RunEvent['metadata']): RunEvent => ({ runId: 'run-1', sequence, timestamp: at(sequence), type, metadata });
const spans = agentRunTraceSpans([
  event(1, 'run.started', { profile: 'ephemeral', agentId: 'support' }), event(2, 'model.started', { step: 0, modelCall: 1, modelId: 'openai/gpt-test' }),
  event(3, 'model.completed', { step: 0, response: 'final', costMicros: 9, inputTokens: 120, outputTokens: 30 }),
  event(4, 'run.completed', { status: 'succeeded', spentMicros: 9, reservedMicros: 0, calls: 1 }),
]);
const signal = () => new AbortController().signal;

describe('@mayurajs/observability-betterstack', () => {
  it('sends OTLP JSON traces to the source\'s ingesting host with its token', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(response());
    const exporter = betterStackTraceExporter({ sourceToken, ingestingHost, serviceName: 'support-agent', fetch });
    await exporter.sink(spans, { signal: signal() });
    const [url, init] = fetch.mock.calls[0]!;
    expect(url).toBe(`https://${ingestingHost}/v1/traces`);
    expect(init?.headers).toEqual({ 'Content-Type': 'application/json', Authorization: `Bearer ${sourceToken}` });
    expect(String(init?.body)).toContain('gen_ai.usage.input_tokens');
    expect(exporter.inspect().metrics).toMatchObject({ recordsAccepted: 2 }); expect(JSON.stringify(exporter.inspect())).not.toContain('SECRET');
  });

  it('refuses a missing token and anything but a host name, without repeating the token', () => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    const refused: [object, RegExp][] = [
      [{ ingestingHost }, /source token/u], [{ sourceToken: 'SECRET token with spaces', ingestingHost }, /source token/u], [{ sourceToken }, /ingesting host/u],
      [{ sourceToken, ingestingHost: `https://${ingestingHost}` }, /ingesting host/u], [{ sourceToken, ingestingHost: `${ingestingHost}/v1/traces` }, /ingesting host/u],
      [{ sourceToken, ingestingHost: `user@${ingestingHost}` }, /ingesting host/u], [{ sourceToken, ingestingHost: '127.0.0.1' }, /ingesting host/u],
    ];
    for (const [options, message] of refused) {
      let caught: unknown; try { betterStackTraceExporter({ serviceName: 's', fetch, ...options } as never); } catch (error) { caught = error; }
      expect(caught).toMatchObject({ code: 'INVALID_CONFIG', message: expect.stringMatching(message) }); expect(`${String(caught)} ${JSON.stringify(caught)}`).not.toContain('SECRET');
    }
    expect(fetch).not.toHaveBeenCalled();
  });

  it('reports a rejected request without Better Stack\'s text or the token', async () => {
    const exporter = betterStackTraceExporter({ sourceToken, ingestingHost, serviceName: 's', fetch: vi.fn<typeof globalThis.fetch>().mockResolvedValue(response('SECRET unauthorized', 401)) });
    const caught = await exporter.sink(spans, { signal: signal() }).catch((error: unknown) => error);
    expect(caught).toMatchObject({ code: 'TOOL_FAILED' }); expect(`${String(caught)} ${JSON.stringify(caught)}`).not.toContain('SECRET');
    expect(exporter.inspect().metrics).toMatchObject({ failedRequests: 1, recordsDropped: 2 });
  });
});
