import { crc32 } from 'node:zlib';

const encoder = new TextEncoder();
/** One AWS event-stream message: prelude, string headers, payload and CRCs. */
export function eventMessage(headers: Readonly<Record<string, string>>, payload: Uint8Array): Uint8Array {
  const headerBytes: number[] = [];
  for (const [name, value] of Object.entries(headers)) {
    const nameBytes = encoder.encode(name); const valueBytes = encoder.encode(value);
    headerBytes.push(nameBytes.byteLength, ...nameBytes, 7, valueBytes.byteLength >> 8, valueBytes.byteLength & 0xff, ...valueBytes);
  }
  const total = 12 + headerBytes.length + payload.byteLength + 4;
  const message = new Uint8Array(total); const view = new DataView(message.buffer);
  view.setUint32(0, total); view.setUint32(4, headerBytes.length); view.setUint32(8, crc32(message.subarray(0, 8)));
  message.set(headerBytes, 12); message.set(payload, 12 + headerBytes.length);
  view.setUint32(total - 4, crc32(message.subarray(0, total - 4)));
  return message;
}
/** A `result` event of the Code Interpreter stream. */
export function resultEvent(result: unknown): Uint8Array {
  return eventMessage({ ':message-type': 'event', ':event-type': 'result', ':content-type': 'application/json' }, encoder.encode(JSON.stringify(result)));
}
/** An exception sent within the stream. */
export function exceptionEvent(type: string): Uint8Array {
  return eventMessage({ ':message-type': 'exception', ':exception-type': type, ':content-type': 'application/json' }, encoder.encode(JSON.stringify({ message: 'secret detail from aws' })));
}

export interface Seen { readonly method: string; readonly url: URL; readonly headers: Headers; readonly json?: Record<string, unknown> }
export interface FakeAgentCore {
  readonly fetch: typeof globalThis.fetch;
  readonly seen: Seen[];
  readonly commands: string[];
}
/**
 * AgentCore's data plane, answering in its wire formats. `execute` runs an executeCommand line: what it prints and its
 * exit code, or the raw messages to stream.
 */
export function fakeAgentCore(execute: (command: string) => Promise<{ stdout?: string; exitCode: number } | Uint8Array[]> | { stdout?: string; exitCode: number } | Uint8Array[],
  options: { readonly start?: () => Response; readonly stop?: () => Response } = {}): FakeAgentCore {
  const seen: Seen[] = []; const commands: string[] = [];
  const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init); const url = new URL(request.url);
    const text = await request.text();
    const json = text ? JSON.parse(text) as Record<string, unknown> : undefined;
    seen.push({ method: request.method, url, headers: request.headers, ...(json ? { json } : {}) });
    if (url.pathname.endsWith('/sessions/start')) return options.start?.() ?? Response.json({ codeInterpreterIdentifier: 'aws.codeinterpreter.v1', sessionId: 'sess-1', createdAt: '2026-10-01T00:00:00Z' });
    if (url.pathname.endsWith('/sessions/stop')) return options.stop?.() ?? Response.json({ codeInterpreterIdentifier: 'aws.codeinterpreter.v1', sessionId: 'sess-1', lastUpdatedAt: '2026-10-01T00:00:00Z' });
    if (url.pathname.endsWith('/tools/invoke')) {
      const command = (json!['arguments'] as { command: string }).command; commands.push(command);
      const answer = await execute(command);
      const messages = Array.isArray(answer) ? answer
        : [resultEvent({ content: [{ type: 'text', text: answer.stdout ?? '' }], structuredContent: { stdout: answer.stdout ?? '', stderr: '', exitCode: answer.exitCode }, isError: answer.exitCode !== 0 })];
      return new Response(new Blob(messages as BlobPart[]).stream(), { status: 200, headers: { 'content-type': 'application/vnd.amazon.eventstream' } });
    }
    return Response.json({ message: 'not found' }, { status: 404 });
  }) as typeof globalThis.fetch;
  return { fetch, seen, commands };
}
