import { describe, expect, it, vi } from 'vitest';
import type { RunEvent } from 'mayura';
import { agentRunTraceSpans } from 'mayura/exporter-otlp';
import { phoenixTraceExporter } from '../src/index.js';

const apiKey = 'phx-SECRET-0123456789';
const at = (second: number) => `2026-10-01T00:00:0${second}.000Z`;
const event = (sequence: number, type: RunEvent['type'], metadata: RunEvent['metadata']): RunEvent => ({ runId: 'run-1', sequence, timestamp: at(sequence), type, metadata });
const spans = agentRunTraceSpans([
  event(1, 'run.started', { profile: 'ephemeral', agentId: 'support' }), event(2, 'model.started', { step: 0, modelCall: 1, modelId: 'openai/gpt-test' }),
  event(3, 'model.completed', { step: 0, response: 'final', costMicros: 9, inputTokens: 120, outputTokens: 30 }),
  event(4, 'run.completed', { status: 'succeeded', spentMicros: 9, reservedMicros: 0, calls: 1 }),
]);
const signal = () => new AbortController().signal;
// Phoenix answers an accepted export with an empty protobuf body.
const accepted = () => new Response(new Uint8Array(0), { status: 200, headers: { 'Content-Type': 'application/x-protobuf' } });
const contains = (body: unknown, text: string) => new TextDecoder('latin1').decode(body as Uint8Array).includes(text);

describe('@mayurajs/observability-arize: Phoenix', () => {
  it('sends protobuf to a Phoenix Cloud space with its key, the project and OpenInference attributes', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(accepted());
    const exporter = phoenixTraceExporter({ baseUrl: 'https://app.phoenix.arize.com/s/acme/', apiKey, projectName: 'support-agent', serviceName: 'support', fetch });
    await exporter.sink(spans, { signal: signal() });
    const [url, init] = fetch.mock.calls[0]!;
    expect(url).toBe('https://app.phoenix.arize.com/s/acme/v1/traces');
    expect(init?.headers).toEqual({ 'Content-Type': 'application/x-protobuf', Authorization: `Bearer ${apiKey}` });
    expect(init?.body).toBeInstanceOf(Uint8Array);
    for (const text of ['openinference.project.name', 'support-agent', 'openinference.span.kind', 'LLM', 'AGENT', 'llm.token_count.prompt']) expect(contains(init?.body, text)).toBe(true);
    expect(exporter.inspect().metrics).toMatchObject({ recordsAccepted: 2 }); expect(JSON.stringify(exporter.inspect())).not.toContain('SECRET');
  });

  it('sends to a local Phoenix without authentication', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(accepted());
    await phoenixTraceExporter({ baseUrl: 'http://127.0.0.1:6006', allowInsecureLoopback: true, projectName: 'p', serviceName: 's', fetch }).sink(spans, { signal: signal() });
    const [url, init] = fetch.mock.calls[0]!;
    expect(url).toBe('http://127.0.0.1:6006/v1/traces'); expect(init?.headers).toEqual({ 'Content-Type': 'application/x-protobuf' });
  });

  it('refuses unsafe addresses, a malformed key and a free-text project, without repeating the key', () => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    const refused: [object, RegExp][] = [
      [{ projectName: 'p' }, /baseUrl/u], [{ baseUrl: 'https://user:SECRET@phoenix.example.com', projectName: 'p' }, /baseUrl/u],
      [{ baseUrl: 'https://phoenix.example.com?project=p', projectName: 'p' }, /baseUrl/u], [{ baseUrl: 'https://phoenix.example.com', apiKey: 'SECRET key with spaces', projectName: 'p' }, /API key/u],
      [{ baseUrl: 'https://phoenix.example.com' }, /project name/u], [{ baseUrl: 'https://phoenix.example.com', projectName: 'Support agent' }, /project name/u],
      [{ baseUrl: 'http://phoenix.example.com', projectName: 'p' }, /./u],
    ];
    for (const [options, message] of refused) {
      let caught: unknown; try { phoenixTraceExporter({ serviceName: 's', fetch, ...options } as never); } catch (error) { caught = error; }
      expect(caught).toMatchObject({ code: 'INVALID_CONFIG', message: expect.stringMatching(message) }); expect(`${String(caught)} ${JSON.stringify(caught)}`).not.toContain('SECRET');
    }
    expect(fetch).not.toHaveBeenCalled();
  });

  it('reports Phoenix refusing the content type or a full queue without its text', async () => {
    for (const status of [415, 503]) {
      const exporter = phoenixTraceExporter({ baseUrl: 'https://phoenix.example.com', projectName: 'p', serviceName: 's',
        fetch: vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response('SECRET Unsupported content type', { status })) });
      const caught = await exporter.sink(spans, { signal: signal() }).catch((error: unknown) => error);
      expect(caught).toMatchObject({ code: 'TOOL_FAILED' }); expect(`${String(caught)} ${JSON.stringify(caught)}`).not.toContain('SECRET');
    }
  });
});
