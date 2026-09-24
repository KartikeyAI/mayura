import { jsonValue, MayuraError, type Effect, type InferInput, type InferOutput, type JsonObject, type JsonValue, type Schema } from '@mayura/core';
import { defineTool, type ToolDefinition } from '@mayura/tools';

export interface McpCallToolRequest {
  readonly name: string;
  readonly arguments: JsonObject;
  readonly signal: AbortSignal;
}

/** Minimal transport seam implemented by an application-selected, authenticated MCP client. */
export interface McpClient { callTool(request: McpCallToolRequest): Promise<unknown>; }

export interface McpToolOptions<I extends Schema, O extends Schema> {
  readonly id: string;
  readonly version: string;
  readonly description: string;
  readonly remoteName: string;
  readonly input: I;
  readonly output: O;
  readonly effects: Effect;
  readonly capabilities: readonly string[];
  readonly client: McpClient;
  readonly timeoutMs?: number;
  readonly costMicros?: number;
  readonly inputJsonSchema?: JsonObject;
}

function remoteName(value: unknown): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/u.test(value)) {
    throw new MayuraError('INVALID_CONFIG', 'An MCP tool requires an explicit bounded remote name.');
  }
  return value;
}

function call(client: unknown): McpClient['callTool'] {
  if (!client || (typeof client !== 'object' && typeof client !== 'function')) {
    throw new MayuraError('INVALID_CONFIG', 'An MCP tool requires an explicit client transport.');
  }
  const descriptor = Object.getOwnPropertyDescriptor(client, 'callTool');
  const candidate = descriptor && 'value' in descriptor ? descriptor.value : Reflect.get(client, 'callTool');
  if (typeof candidate !== 'function') throw new MayuraError('INVALID_CONFIG', 'The MCP client transport must implement callTool.');
  return (request) => Reflect.apply(candidate, client, [request]) as Promise<unknown>;
}

function structuredResult(value: unknown): JsonValue {
  const envelope = jsonValue(value, { maxBytes: 1_048_576 });
  if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope)) {
    throw new MayuraError('TOOL_FAILED', 'The MCP server returned an invalid tool result.');
  }
  const keys = Object.keys(envelope);
  if (keys.some(key => !['content', 'structuredContent', 'isError'].includes(key))
    || (envelope['isError'] !== undefined && typeof envelope['isError'] !== 'boolean')
    || envelope['isError'] === true || !Object.hasOwn(envelope, 'structuredContent')) {
    throw new MayuraError('TOOL_FAILED', 'The MCP server did not return an accepted structured result.');
  }
  return jsonValue(envelope['structuredContent'], { maxBytes: 1_048_576 });
}

/** Wrap an explicitly selected MCP operation as a genuine Mayura tool. */
export function defineMcpTool<I extends Schema, O extends Schema>(options: McpToolOptions<I, O>): ToolDefinition<I, O> {
  const name = remoteName(options?.remoteName);
  const invoke = call(options?.client);
  return defineTool({
    id: options.id, version: options.version, description: options.description, input: options.input, output: options.output,
    effects: options.effects, capabilities: options.capabilities,
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    ...(options.costMicros === undefined ? {} : { costMicros: options.costMicros }),
    ...(options.inputJsonSchema === undefined ? {} : { inputJsonSchema: options.inputJsonSchema }),
    execute: async (input, context): Promise<InferInput<O>> => {
      const args = jsonValue(input);
      if (!args || typeof args !== 'object' || Array.isArray(args)) {
        throw new MayuraError('INVALID_INPUT', 'MCP tool arguments must be a JSON object.');
      }
      const result = await invoke(Object.freeze({ name, arguments: args, signal: context.signal }));
      return structuredResult(result) as InferInput<O>;
    },
  }) as ToolDefinition<I, O>;
}

export type McpToolInput<T extends Schema> = InferOutput<T>;
