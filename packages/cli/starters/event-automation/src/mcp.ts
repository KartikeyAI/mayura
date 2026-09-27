import type { McpCallToolRequest, McpClient } from '@mayura/adapter-mcp';

/**
 * The MCP client transport `@mayura/adapter-mcp` asks the application to supply: the MCP Streamable HTTP transport,
 * reduced to what tool calls need. It performs the `initialize` handshake once (lazily, on the first call), keeps the
 * server's session id if it issues one, and sends JSON-RPC requests as POSTs, accepting either a JSON body or a
 * server-sent-event stream in reply. Everything is bounded: one timeout per request and a maximum response size.
 *
 * It does not implement server-initiated requests (sampling, elicitation), resumable streams or OAuth discovery. Use
 * a bearer token your tracker's MCP server accepts, or replace this module with a full MCP client library.
 */

export const PROTOCOL_VERSION = '2025-06-18';
const acceptedVersions = new Set([PROTOCOL_VERSION, '2025-03-26']);

export interface McpHttpClientOptions {
  /** The server's MCP endpoint, for example https://tracker.example.com/mcp. */
  readonly url: string;
  /** Sent as `Authorization: Bearer <token>`. */
  readonly token?: string;
  readonly timeoutMs?: number;
  readonly maxResponseBytes?: number;
}
export interface McpHttpClient extends McpClient {
  listTools(options?: { readonly signal?: AbortSignal }): Promise<readonly { readonly name: string; readonly description?: string }[]>;
  /** Ends the server-side session, if the server issued one. */
  close(): Promise<void>;
}

/** Raised for transport and protocol failures. Messages never include server-supplied text. */
export class McpTransportError extends Error {}

interface Session { readonly protocolVersion: string; readonly sessionId?: string }
type Reply = { readonly status: number; readonly sessionId: string | null; readonly message: Record<string, unknown> | undefined };

export function mcpHttpClient(options: McpHttpClientOptions): McpHttpClient {
  const endpoint = new URL(options.url);
  if (endpoint.protocol !== 'https:' && endpoint.protocol !== 'http:') throw new McpTransportError('The MCP endpoint must be an http(s) URL.');
  const timeoutMs = options.timeoutMs ?? 15_000; const maxBytes = options.maxResponseBytes ?? 1_048_576;
  let nextId = 1; let session: Promise<Session> | undefined;

  async function readBounded(response: Response): Promise<string> {
    if (!response.body) return '';
    const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let size = 0;
    for (;;) {
      const { done, value } = await reader.read(); if (done) break;
      size += value.byteLength;
      if (size > maxBytes) { await reader.cancel(); throw new McpTransportError('The MCP response exceeded its size limit.'); }
      chunks.push(value);
    }
    return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks));
  }

  /** One JSON-RPC message per POST. A request's reply is the response with the same id, as JSON or inside an SSE stream. */
  async function post(body: Record<string, unknown>, current: Session | undefined, signal: AbortSignal | undefined): Promise<Reply> {
    const headers: Record<string, string> = { 'content-type': 'application/json', accept: 'application/json, text/event-stream' };
    if (options.token) headers['authorization'] = `Bearer ${options.token}`;
    if (current) headers['mcp-protocol-version'] = current.protocolVersion;
    if (current?.sessionId) headers['mcp-session-id'] = current.sessionId;
    const timeout = AbortSignal.timeout(timeoutMs);
    let response: Response;
    try { response = await fetch(endpoint, { method: 'POST', headers, body: JSON.stringify(body), redirect: 'error', signal: signal ? AbortSignal.any([signal, timeout]) : timeout }); }
    catch { throw new McpTransportError('The MCP server could not be reached.'); }
    const sessionId = response.headers.get('mcp-session-id');
    if (body['id'] === undefined || response.status === 202 || !response.ok) { await response.body?.cancel(); return { status: response.status, sessionId, message: undefined }; }
    const text = await readBounded(response);
    const type = (response.headers.get('content-type') ?? '').split(';')[0]!.trim().toLowerCase();
    const candidates: unknown[] = [];
    try {
      if (type === 'application/json') candidates.push(JSON.parse(text));
      else if (type === 'text/event-stream') {
        for (const event of text.split(/\r?\n\r?\n/u)) {
          const data = event.split(/\r?\n/u).filter(line => line.startsWith('data:')).map(line => line.slice(5).replace(/^ /u, '')).join('\n');
          if (data) candidates.push(JSON.parse(data));
        }
      } else throw new McpTransportError('The MCP server replied with an unsupported content type.');
    } catch (error) { if (error instanceof McpTransportError) throw error; throw new McpTransportError('The MCP server replied with malformed JSON.'); }
    const message = candidates.find((candidate): candidate is Record<string, unknown> =>
      typeof candidate === 'object' && candidate !== null && !Array.isArray(candidate) && (candidate as Record<string, unknown>)['id'] === body['id']);
    return { status: response.status, sessionId, message };
  }

  function outcome(reply: Reply): Record<string, unknown> {
    if (reply.status < 200 || reply.status >= 300) throw new McpTransportError(`The MCP server refused the request (HTTP ${reply.status}).`);
    const message = reply.message;
    if (!message || message['jsonrpc'] !== '2.0') throw new McpTransportError('The MCP server sent no valid JSON-RPC response.');
    if (message['error'] !== undefined) throw new McpTransportError('The MCP server returned a JSON-RPC error.');
    const value = message['result'];
    if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new McpTransportError('The MCP server returned an invalid result.');
    return value as Record<string, unknown>;
  }

  async function initialize(signal: AbortSignal | undefined): Promise<Session> {
    const reply = await post({ jsonrpc: '2.0', id: nextId++, method: 'initialize',
      params: { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: 'mayura-event-automation', version: '0.1.0' } } }, undefined, signal);
    const protocolVersion = outcome(reply)['protocolVersion'];
    if (typeof protocolVersion !== 'string' || !acceptedVersions.has(protocolVersion)) throw new McpTransportError('The MCP server speaks an unsupported protocol version.');
    const sessionId = reply.sessionId !== null && /^[\x21-\x7e]{1,256}$/u.test(reply.sessionId) ? reply.sessionId : undefined;
    const established: Session = { protocolVersion, ...(sessionId ? { sessionId } : {}) };
    const acknowledged = await post({ jsonrpc: '2.0', method: 'notifications/initialized' }, established, signal);
    if (acknowledged.status < 200 || acknowledged.status >= 300) throw new McpTransportError('The MCP server refused the initialized notification.');
    return established;
  }

  async function request(method: string, params: Record<string, unknown>, signal: AbortSignal | undefined): Promise<Record<string, unknown>> {
    for (let attempt = 0; ; attempt++) {
      const pending = session ??= initialize(signal);
      let current: Session;
      try { current = await pending; } catch (error) { if (session === pending) session = undefined; throw error; }
      const reply = await post({ jsonrpc: '2.0', id: nextId++, method, params }, current, signal);
      // 404 with a session means the server forgot it (for example after a restart); the request was not processed,
      // so starting a new session and sending it once more cannot apply it twice.
      if (reply.status === 404 && current.sessionId && attempt === 0) { if (session === pending) session = undefined; continue; }
      return outcome(reply);
    }
  }

  return {
    async callTool(call: McpCallToolRequest): Promise<unknown> {
      const value = await request('tools/call', { name: call.name, arguments: call.arguments }, call.signal);
      // Hand the adapter the tool-result fields it accepts; protocol metadata such as `_meta` stays here.
      return Object.fromEntries(['content', 'structuredContent', 'isError'].filter(key => key in value).map(key => [key, value[key]]));
    },
    async listTools(listOptions = {}) {
      const value = await request('tools/list', {}, listOptions.signal);
      const tools = value['tools'];
      if (!Array.isArray(tools) || tools.length > 1_000) throw new McpTransportError('The MCP server returned an invalid tool list.');
      return tools.flatMap(tool => typeof tool?.name === 'string'
        ? [{ name: tool.name as string, ...(typeof tool.description === 'string' ? { description: tool.description as string } : {}) }] : []);
    },
    async close() {
      const current = session ? await session.catch(() => undefined) : undefined; session = undefined;
      if (!current?.sessionId) return;
      const headers: Record<string, string> = { 'mcp-session-id': current.sessionId, 'mcp-protocol-version': current.protocolVersion };
      if (options.token) headers['authorization'] = `Bearer ${options.token}`;
      await fetch(endpoint, { method: 'DELETE', headers, redirect: 'error', signal: AbortSignal.timeout(timeoutMs) }).then(response => response.body?.cancel(), () => undefined);
    },
  };
}
