import { createHash, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { z } from 'zod';
import { assignee, label, TicketNotFound, ticketId, type TicketTracker } from './tickets.js';

/**
 * A deliberately small MCP server for the local tracker: the Streamable HTTP transport (one JSON-RPC message per
 * POST, answered with `application/json`), `initialize`, `ping`, `tools/list` and `tools/call`. No sessions, no
 * server-initiated streams, no resources or prompts. It exists so the starter runs offline; point TRACKER_MCP_URL
 * at your tracker's real MCP server instead (see README).
 */

export const SUPPORTED_PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26'] as const;
const maxBodyBytes = 65_536;

interface RemoteTool {
  readonly name: string;
  readonly description: string;
  readonly input: z.ZodType;
  readonly output: z.ZodType;
  call(args: never): Promise<unknown>;
}

/** The tracker's MCP tools. Names follow the remote server's conventions; Mayura maps them to its own tool ids. */
function remoteTools(tracker: TicketTracker): readonly RemoteTool[] {
  const labelInput = z.strictObject({ ticketId, labels: z.array(label).min(1).max(8) });
  const commentInput = z.strictObject({ ticketId, body: z.string().min(1).max(2_000) });
  const assignInput = z.strictObject({ ticketId, assignee });
  return [
    { name: 'label_ticket', description: 'Add labels to a ticket. Existing labels are kept.', input: labelInput,
      output: z.strictObject({ ticketId, labels: z.array(label).max(64) }),
      call: async (args: z.infer<typeof labelInput>) => ({ ticketId: args.ticketId, labels: await tracker.addLabels(args.ticketId, args.labels) }) },
    { name: 'comment_on_ticket', description: 'Post a comment on a ticket, visible to the reporter.', input: commentInput,
      output: z.strictObject({ ticketId, commentId: z.string() }),
      call: async (args: z.infer<typeof commentInput>) => ({ ticketId: args.ticketId, commentId: await tracker.addComment(args.ticketId, args.body) }) },
    { name: 'assign_ticket', description: 'Assign a ticket to a person or rotation.', input: assignInput,
      output: z.strictObject({ ticketId, assignee }),
      call: async (args: z.infer<typeof assignInput>) => { await tracker.assign(args.ticketId, args.assignee); return { ticketId: args.ticketId, assignee: args.assignee }; } },
  ];
}

const message = z.object({
  jsonrpc: z.literal('2.0'),
  id: z.union([z.string().min(1).max(128), z.number().int().min(0).max(Number.MAX_SAFE_INTEGER)]).optional(),
  method: z.string().min(1).max(128),
  params: z.record(z.string(), z.unknown()).optional(),
});
type Id = string | number | null;

function schemaOf(schema: z.ZodType): Record<string, unknown> {
  const { $schema: _dialect, ...plain } = z.toJSONSchema(schema) as Record<string, unknown>;
  return plain;
}
const digest = (value: string): Buffer => createHash('sha256').update(value).digest();

export interface TrackerMcpServer { readonly url: string; close(): Promise<void> }

export async function startTrackerMcpServer(options: {
  readonly tracker: TicketTracker; readonly port: number; readonly host?: string;
  /** When set, every request must carry `Authorization: Bearer <token>`. */
  readonly token?: string;
}): Promise<TrackerMcpServer> {
  const tools = remoteTools(options.tracker);
  const expected = options.token === undefined ? undefined : digest(options.token);

  const send = (response: ServerResponse, status: number, body?: unknown, headers: Record<string, string> = {}): void => {
    const text = body === undefined ? '' : JSON.stringify(body);
    response.writeHead(status, { ...(body === undefined ? {} : { 'content-type': 'application/json' }), 'cache-control': 'no-store', ...headers });
    response.end(text);
  };
  const result = (id: Id, value: unknown) => ({ jsonrpc: '2.0', id, result: value });
  const failure = (id: Id, code: number, text: string) => ({ jsonrpc: '2.0', id, error: { code, message: text } });
  const toolResult = (structured: unknown) => ({ content: [{ type: 'text', text: JSON.stringify(structured) }], structuredContent: structured, isError: false });
  const toolError = (text: string) => ({ content: [{ type: 'text', text }], isError: true });

  async function readBody(request: IncomingMessage): Promise<Buffer | undefined> {
    const chunks: Buffer[] = []; let size = 0;
    for await (const chunk of request as AsyncIterable<Buffer>) {
      size += chunk.length; if (size > maxBodyBytes) return undefined;
      chunks.push(chunk);
    }
    return Buffer.concat(chunks);
  }

  async function call(params: Record<string, unknown> | undefined): Promise<{ readonly error?: [number, string]; readonly value?: unknown }> {
    const name = params?.['name'];
    const tool = tools.find(candidate => candidate.name === name);
    if (!tool) return { error: [-32602, 'Unknown tool.'] };
    const args = tool.input.safeParse(params?.['arguments'] ?? {});
    // Tool-level problems are results with isError, so the calling model or client can see them (MCP convention).
    if (!args.success) return { value: toolError('Invalid arguments.') };
    try { return { value: toolResult(tool.output.parse(await tool.call(args.data as never))) }; }
    catch (error) { return { value: toolError(error instanceof TicketNotFound ? 'Ticket not found.' : 'The tracker could not complete the operation.') }; }
  }

  const server = createServer({ requestTimeout: 15_000, headersTimeout: 10_000, maxHeaderSize: 16_384 }, (request, response) => {
    void (async () => {
      const path = (request.url ?? '').split('?')[0];
      if (path !== '/mcp') return send(response, 404, { error: 'not_found' });
      // DNS-rebinding defence from the MCP transport spec: MCP clients here are servers, never browsers.
      if (request.headers.origin !== undefined) return send(response, 403, { error: 'forbidden' });
      if (expected) {
        const header = request.headers.authorization ?? '';
        const supplied = header.startsWith('Bearer ') ? digest(header.slice(7)) : undefined;
        if (!supplied || !timingSafeEqual(supplied, expected)) return send(response, 401, { error: 'unauthorized' }, { 'www-authenticate': 'Bearer' });
      }
      if (request.method !== 'POST') return send(response, 405, { error: 'method_not_allowed' }, { allow: 'POST' });
      const version = request.headers['mcp-protocol-version'];
      if (typeof version === 'string' && !(SUPPORTED_PROTOCOL_VERSIONS as readonly string[]).includes(version)) return send(response, 400, { error: 'unsupported_protocol_version' });
      const body = await readBody(request);
      if (!body) return send(response, 413, { error: 'too_large' }, { connection: 'close' });
      let parsed: unknown;
      try { parsed = JSON.parse(body.toString('utf8')); } catch { return send(response, 400, failure(null, -32700, 'Parse error.')); }
      const rpc = message.safeParse(parsed);
      if (!rpc.success) return send(response, 400, failure(null, -32600, 'Invalid request.'));
      const { id, method, params } = rpc.data;
      // Notifications (no id), such as notifications/initialized, are acknowledged without a body.
      if (id === undefined) return send(response, 202);
      switch (method) {
        case 'initialize': {
          const requested = params?.['protocolVersion'];
          const protocolVersion = (SUPPORTED_PROTOCOL_VERSIONS as readonly unknown[]).includes(requested) ? requested : SUPPORTED_PROTOCOL_VERSIONS[0];
          return send(response, 200, result(id, { protocolVersion, capabilities: { tools: { listChanged: false } },
            serverInfo: { name: 'local-ticket-tracker', version: '1.0.0' } }));
        }
        case 'ping': return send(response, 200, result(id, {}));
        case 'tools/list': return send(response, 200, result(id, { tools: tools.map(tool => ({ name: tool.name, description: tool.description,
          inputSchema: schemaOf(tool.input), outputSchema: schemaOf(tool.output) })) }));
        case 'tools/call': {
          const outcome = await call(params);
          return send(response, 200, outcome.error ? failure(id, ...outcome.error) : result(id, outcome.value));
        }
        default: return send(response, 200, failure(id, -32601, 'Method not found.'));
      }
    })().catch(() => { if (!response.headersSent) send(response, 500, { error: 'internal' }); else response.destroy(); });
  });
  const host = options.host ?? '127.0.0.1';
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(options.port, host, () => { server.off('error', reject); resolve(); }); });
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://${host}:${port}/mcp`,
    close: () => new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); }),
  };
}
