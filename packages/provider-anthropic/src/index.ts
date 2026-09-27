import {
  assertPositiveInteger,
  freezeJson,
  jsonValue,
  MayuraError,
  ModelInvocationError,
  type JsonObject,
  type JsonValue,
  type ModelAdapter,
  type ModelMessage,
  type ModelRequest,
  type ModelResponse,
  type ModelStreamEvent,
  type ModelToolCall,
} from '@mayura/core';
import { readServerSentEvents, streamModelCall } from '@mayura/core/host';

const ENDPOINT = 'https://api.anthropic.com/v1/messages';
const API_VERSION = '2023-06-01';

export interface AnthropicMessagesOptions {
  readonly apiKey: string;
  readonly model: string;
  readonly outputJsonSchema: JsonObject;
  readonly maxCostMicros: number;
  readonly pricing: {
    readonly inputMicrosPerMillionTokens: number;
    readonly outputMicrosPerMillionTokens: number;
  };
  readonly maxRequestBytes?: number;
  readonly maxResponseBytes?: number;
  readonly timeoutMs?: number;
  /** Trusted test/proxy transport. The adapter destination remains fixed. */
  readonly fetch?: typeof globalThis.fetch;
}

class ProviderFailure extends MayuraError {
  constructor(message = 'The model provider returned an unavailable, refused or invalid response.') {
    super('MODEL_FAILED', message);
  }
}

const failed = (message?: string): never => { throw new ProviderFailure(message); };

function object(value: JsonValue | undefined): JsonObject {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return failed();
  return value;
}

function integer(value: unknown, fallback?: number): number {
  if (value === undefined && fallback !== undefined) return fallback;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) return failed();
  return value;
}

function strictSchema(schema: JsonObject): JsonObject {
  const copy = jsonValue(schema) as JsonObject;
  if (copy['type'] !== 'object') throw new MayuraError('INVALID_CONFIG', 'Provider schemas require a root JSON object.');
  const visit = (item: JsonObject): void => {
    if (item['type'] === 'object' || (Array.isArray(item['type']) && item['type'].includes('object'))) {
      const properties = object(item['properties']);
      const required = item['required'];
      if (item['additionalProperties'] !== false || !Array.isArray(required)
        || required.some(key => typeof key !== 'string') || new Set(required).size !== required.length
        || Object.keys(properties).length !== required.length || Object.keys(properties).some(key => !required.includes(key))) {
        throw new MayuraError('INVALID_CONFIG', 'Strict object schemas must require every property and prohibit additional properties.');
      }
      for (const child of Object.values(properties)) visit(object(child));
    }
    if (item['items'] !== undefined) visit(object(item['items']));
    for (const key of ['anyOf', 'allOf', 'oneOf']) {
      if (Array.isArray(item[key])) for (const child of item[key]) visit(object(child));
    }
    for (const key of ['$defs', 'definitions']) {
      if (item[key] !== undefined) for (const child of Object.values(object(item[key]))) visit(object(child));
    }
  };
  visit(copy);
  return freezeJson(copy);
}

async function abortable<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    void operation.catch(() => undefined);
    throw new MayuraError('CANCELLED', 'Provider request was cancelled.');
  }
  let abort: (() => void) | undefined;
  try {
    return await Promise.race([operation, new Promise<never>((_, reject) => {
      abort = () => reject(new MayuraError('CANCELLED', 'Provider request was cancelled.'));
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) abort();
    })]);
  } finally {
    if (abort) signal.removeEventListener('abort', abort);
  }
}

async function responseBody(response: Response, limit: number, signal: AbortSignal): Promise<JsonObject> {
  if (!response.ok || response.redirected || !response.body) {
    void response.body?.cancel().catch(() => undefined);
    if (!response.redirected && [401, 403].includes(response.status)) {
      return failed('Model provider authentication or model authorization failed. Verify the configured credential and model access.');
    }
    if (!response.redirected && response.status === 429) {
      return failed('The model provider rate limit was reached. Retry only under the application retry and budget policy.');
    }
    return failed();
  }
  const length = response.headers.get('content-length');
  if (length !== null && (!/^\d+$/.test(length) || Number(length) > limit)) {
    void response.body.cancel().catch(() => undefined);
    return failed();
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const item = await abortable(reader.read(), signal);
      if (item.done) break;
      size += item.value.byteLength;
      if (size > limit) return failed();
      chunks.push(item.value);
    }
    const buffer = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      buffer.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return object(jsonValue(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(buffer)), { maxBytes: limit }));
  } finally {
    void reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

function messagesForAnthropic(messages: readonly ModelMessage[], aliases: ReadonlyMap<string, string>): JsonValue[] {
  return messages.map(message => {
    if (message.role === 'user') {
      return { role: 'user', content: [{ type: 'text', text: JSON.stringify(message.content) }] };
    }
    if (message.role === 'tool') {
      return { role: 'user', content: [{ type: 'tool_result', tool_use_id: message.callId, content: JSON.stringify(message.result) }] };
    }
    return {
      role: 'assistant',
      content: message.calls.map(call => {
        const name = aliases.get(call.toolId);
        if (!name) return failed();
        return { type: 'tool_use', id: call.id, name, input: call.input };
      }),
    };
  });
}

/** Explicit Anthropic Messages adapter with fixed destination and conservative accounting. */
export function anthropicMessages(options: AnthropicMessagesOptions): ModelAdapter {
  if (typeof options.apiKey !== 'string' || !options.apiKey.trim() || /[\r\n]/u.test(options.apiKey) || options.apiKey.length > 4_096
    || typeof options.model !== 'string' || !options.model.trim() || options.model.length > 128) {
    throw new MayuraError('INVALID_CONFIG', 'A model ID and bounded API key are required.');
  }
  const apiKey = options.apiKey;
  const model = options.model;
  const outputSchema = strictSchema(options.outputJsonSchema);
  const inputPrice = options.pricing.inputMicrosPerMillionTokens;
  const outputPrice = options.pricing.outputMicrosPerMillionTokens;
  const maxCostMicros = options.maxCostMicros;
  for (const amount of [maxCostMicros, inputPrice, outputPrice]) {
    if (!Number.isSafeInteger(amount) || amount < 0) throw new MayuraError('INVALID_CONFIG', 'Configured costs must be non-negative safe integers.');
  }
  const maxRequestBytes = options.maxRequestBytes ?? 1_048_576;
  const maxResponseBytes = options.maxResponseBytes ?? 1_048_576;
  const timeoutMs = options.timeoutMs ?? 30_000;
  assertPositiveInteger(maxRequestBytes, 'maxRequestBytes');
  assertPositiveInteger(maxResponseBytes, 'maxResponseBytes');
  assertPositiveInteger(timeoutMs, 'timeoutMs');
  if (timeoutMs > 2_147_483_647) throw new MayuraError('INVALID_CONFIG', 'Provider timeout exceeds the supported timer range.');
  const transport = options.fetch ?? globalThis.fetch;
  if (typeof transport !== 'function') throw new MayuraError('INVALID_CONFIG', 'A fetch-compatible transport is required.');

  /** One Messages call. With `onDelta` it streams, reporting text as it arrives; the message is then parsed as usual. */
  const call = async (request: ModelRequest, onDelta?: (text: string) => void, consumer?: AbortSignal): Promise<ModelResponse> => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      let knownCost: number | undefined;
      try {
        const signal = AbortSignal.any([request.signal, controller.signal, ...(consumer ? [consumer] : [])]);
        if (signal.aborted) throw new MayuraError('CANCELLED', 'Provider request was cancelled.');
        if (request.continuation !== undefined) return failed();
        assertPositiveInteger(request.maxOutputTokens, 'maxOutputTokens');
        const aliases = new Map(request.tools.map((tool, index) => [tool.id, `tool_${index}`]));
        const ids = new Map([...aliases].map(([toolId, alias]) => [alias, toolId]));
        if (aliases.size !== request.tools.length || aliases.size > 128) return failed();
        const tools = request.tools.map(tool => {
          if (!tool.inputJsonSchema) throw new MayuraError('INVALID_CONFIG', 'Every provider-exposed tool requires an explicit portable JSON Schema.');
          return { name: aliases.get(tool.id)!, description: tool.description, input_schema: strictSchema(tool.inputJsonSchema), strict: true };
        });
        const requestObject: JsonObject = {
          model,
          max_tokens: request.maxOutputTokens,
          system: request.instructions,
          messages: messagesForAnthropic(request.messages, aliases),
          stream: onDelta !== undefined,
          output_config: { format: { type: 'json_schema', schema: outputSchema } },
        };
        if (tools.length > 0) {
          requestObject['tools'] = tools;
          requestObject['tool_choice'] = { type: 'auto', disable_parallel_tool_use: false };
        }
        const body = JSON.stringify(jsonValue(requestObject, { maxBytes: maxRequestBytes }));
        const response = await abortable(transport(ENDPOINT, {
          method: 'POST',
          headers: { 'x-api-key': apiKey, 'anthropic-version': API_VERSION, 'content-type': 'application/json' },
          body,
          signal,
          redirect: 'error',
        }), signal);
        const payload = onDelta ? await assembledMessage(response, signal, onDelta) : await responseBody(response, maxResponseBytes, signal);
        const usage = object(payload['usage']);
        const inputTokens = integer(usage['input_tokens']);
        const cacheCreationTokens = integer(usage['cache_creation_input_tokens'], 0);
        const cacheReadTokens = integer(usage['cache_read_input_tokens'], 0);
        const outputTokens = integer(usage['output_tokens']);
        const totalInputTokens = BigInt(inputTokens) + BigInt(cacheCreationTokens) + BigInt(cacheReadTokens);
        const cost = (totalInputTokens * BigInt(inputPrice) + BigInt(outputTokens) * BigInt(outputPrice) + 999_999n) / 1_000_000n;
        if (cost > BigInt(Number.MAX_SAFE_INTEGER)) return failed();
        knownCost = Number(cost);
        if (payload['type'] !== 'message' || payload['role'] !== 'assistant' || !Array.isArray(payload['content'])
          || payload['content'].length < 1 || payload['content'].length > 256) return failed();
        const accounting = { costMicros: knownCost };
        if (payload['stop_reason'] === 'tool_use') {
          const calls: ModelToolCall[] = [];
          const seen = new Set<string>();
          for (const raw of payload['content']) {
            const block = object(raw);
            // Claude often says what it is about to do before calling a tool. That text is narration, not an answer:
            // it is dropped, never passed on. Any other block type is still refused.
            if (block['type'] === 'text' && typeof block['text'] === 'string') continue;
            const callId = block['id'];
            const alias = block['name'];
            if (block['type'] !== 'tool_use' || typeof callId !== 'string'
              || !/^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/u.test(callId) || seen.has(callId)
              || typeof alias !== 'string' || !ids.has(alias) || block['input'] === undefined) return failed();
            seen.add(callId);
            calls.push({ id: callId, toolId: ids.get(alias)!, input: jsonValue(block['input']) });
          }
          if (calls.length === 0) return failed();
          return { type: 'tool_calls', calls, usage: accounting };
        }
        if (payload['stop_reason'] !== 'end_turn') return failed();
        const text: string[] = [];
        for (const raw of payload['content']) {
          const block = object(raw);
          if (block['type'] !== 'text' || typeof block['text'] !== 'string') return failed();
          text.push(block['text']);
        }
        return { type: 'final', output: jsonValue(JSON.parse(text.join('')), { maxBytes: maxResponseBytes }), usage: accounting };
      } catch (error) {
        if (knownCost !== undefined) throw new ModelInvocationError(knownCost);
        if (request.signal.aborted || controller.signal.aborted || consumer?.aborted) throw new MayuraError('CANCELLED', 'Provider request was cancelled or timed out.');
        if (error instanceof ProviderFailure) throw error;
        return failed();
      } finally {
        clearTimeout(timer);
      }
  };
  /**
   * Rebuild the message a non-streamed call returns from a Messages event stream. Text deltas are reported as they
   * arrive; tool input fragments are only assembled. Usage combines `message_start` with the final `message_delta`.
   */
  const assembledMessage = async (response: Response, signal: AbortSignal, onDelta: (text: string) => void): Promise<JsonObject> => {
    let message: JsonObject | undefined; let stopped = false; let stopReason: JsonValue = null; let usage: JsonObject = {};
    const list: ({ type: 'text'; text: string } | { type: 'tool_use'; id: JsonValue; name: JsonValue; json: string })[] = [];
    for await (const event of readServerSentEvents(response, { maxBytes: maxResponseBytes * 4, maxEventBytes: maxResponseBytes, signal })) {
      if (stopped) return failed();
      const data = object(jsonValue(JSON.parse(event.data), { maxBytes: maxResponseBytes }));
      const type = data['type'];
      if (type === 'ping') continue;
      if (type === 'error') return failed();
      if (type === 'message_start') {
        if (message) return failed();
        message = object(data['message']); usage = { ...object(message['usage']) }; continue;
      }
      if (!message) return failed();
      if (type === 'content_block_start') {
        const index = integer(data['index']); const block = object(data['content_block']);
        if (index !== list.length || list.length >= 256) return failed();
        if (block['type'] === 'text') list.push({ type: 'text', text: typeof block['text'] === 'string' ? block['text'] : '' });
        else if (block['type'] === 'tool_use') list.push({ type: 'tool_use', id: block['id'] ?? null, name: block['name'] ?? null, json: '' });
        else return failed();
      } else if (type === 'content_block_delta') {
        const block = list[integer(data['index'])]; const delta = object(data['delta']);
        if (!block) return failed();
        if (delta['type'] === 'text_delta' && block.type === 'text' && typeof delta['text'] === 'string') { block.text += delta['text']; onDelta(delta['text']); }
        else if (delta['type'] === 'input_json_delta' && block.type === 'tool_use' && typeof delta['partial_json'] === 'string') block.json += delta['partial_json'];
        else return failed();
      } else if (type === 'message_delta') {
        const delta = object(data['delta']); stopReason = delta['stop_reason'] ?? null;
        if (data['usage'] !== undefined) usage = { ...usage, ...object(data['usage']) };
      } else if (type === 'message_stop') stopped = true;
      // content_block_stop and unknown informational events carry nothing we use.
    }
    if (!message || !stopped) return failed();
    const content = list.map(block => block.type === 'text' ? { type: 'text', text: block.text }
      : { type: 'tool_use', id: block.id, name: block.name, input: jsonValue(JSON.parse(block.json || '{}'), { maxBytes: maxResponseBytes }) });
    return { ...message, content, stop_reason: stopReason, usage } as JsonObject;
  };
  return Object.freeze({
    id: 'anthropic.messages',
    capabilities: Object.freeze({ tools: true, structuredOutput: true }),
    maxCostMicros,
    generate: (request: ModelRequest): Promise<ModelResponse> => call(request),
    stream: (request: ModelRequest): AsyncIterable<ModelStreamEvent> => streamModelCall((onDelta, consumer) => call(request, onDelta, consumer)),
  });
}
