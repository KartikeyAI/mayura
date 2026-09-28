import {
  assertPositiveInteger,
  jsonValue,
  MayuraError,
  ModelProviderError,
  type JsonObject,
  type JsonValue,
  type ModelAdapter,
  type ModelDefinitionCheck,
  type ModelFailureReason,
  type ModelMessage,
  type ModelRequest,
  type ModelResponse,
  type ModelStreamEvent,
  type ModelToolCall,
} from '@mayura/core';
import { checkStrictDefinition, modelToolNames, providerHttpFailure, readServerSentEvents, streamModelCall, strictJsonSchema } from '@mayura/core/host';

const ENDPOINT = 'https://api.anthropic.com/v1/messages';
const API_VERSION = '2023-06-01';

export interface AnthropicMessagesOptions {
  readonly apiKey: string;
  readonly model: string;
  /**
   * The output as strict JSON Schema. Optional: without it, the adapter uses the schema the runtime sends with each
   * request, which `defineAgent` generates from the agent's output validator (or takes from its `outputJsonSchema`).
   */
  readonly outputJsonSchema?: JsonObject;
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

/** A failed call, for a reason Mayura reports in its own words. The default is a response the adapter cannot use. */
const failed = (reason: ModelFailureReason = 'invalid_response'): never => { throw new ModelProviderError(reason); };
/** The reason a caught failure carries, for charging known usage without losing why the call failed. */
const reasonOf = (error: unknown): ModelFailureReason => error instanceof ModelProviderError ? error.reason : 'invalid_response';

function object(value: JsonValue | undefined): JsonObject {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return failed();
  return value;
}

function integer(value: unknown, fallback?: number): number {
  if (value === undefined && fallback !== undefined) return fallback;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) return failed();
  return value;
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
    if (response.redirected) return failed('rejected');
    // Anthropic answers 529 when it is overloaded; like any 5xx, the provider is unavailable.
    if (!response.ok) throw providerHttpFailure(response.status);
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
  const fixedOutput = options.outputJsonSchema === undefined ? undefined : strictJsonSchema(options.outputJsonSchema, `The adapter's outputJsonSchema`);
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
        const aliases = new Map(modelToolNames(request.tools.map(tool => tool.id)));
        const ids = new Map([...aliases].map(([toolId, alias]) => [alias, toolId]));
        if (aliases.size !== request.tools.length || aliases.size > 128) return failed();
        const tools = request.tools.map(tool => {
          if (!tool.inputJsonSchema) throw new MayuraError('INVALID_CONFIG', `Tool "${tool.id}" has no inputJsonSchema.`);
          return { name: aliases.get(tool.id)!, description: tool.description, input_schema: strictJsonSchema(tool.inputJsonSchema, `Tool "${tool.id}" input schema`), strict: true };
        });
        const outputSchema = fixedOutput ?? (request.outputJsonSchema === undefined ? failed('configuration') : strictJsonSchema(request.outputJsonSchema, 'The output schema'));
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
        }).catch((): never => failed('unavailable')), signal);
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
        if (payload['stop_reason'] === 'refusal' || payload['stop_reason'] === 'max_tokens') return failed('refused');
        if (payload['stop_reason'] !== 'end_turn') return failed();
        const text: string[] = [];
        for (const raw of payload['content']) {
          const block = object(raw);
          if (block['type'] !== 'text' || typeof block['text'] !== 'string') return failed();
          text.push(block['text']);
        }
        return { type: 'final', output: jsonValue(JSON.parse(text.join('')), { maxBytes: maxResponseBytes }), usage: accounting };
      } catch (error) {
        if (knownCost !== undefined) throw new ModelProviderError(reasonOf(error), { costMicros: knownCost });
        if (request.signal.aborted || controller.signal.aborted || consumer?.aborted) throw new MayuraError('CANCELLED', 'Provider request was cancelled or timed out.');
        if (error instanceof ModelProviderError) throw error;
        // A schema the provider would refuse, or no output schema at all, is the agent's configuration.
        if (error instanceof MayuraError && error.code === 'INVALID_CONFIG') return failed('configuration');
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
      if (type === 'error') return failed('unavailable');
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
    checkDefinition: (definition: ModelDefinitionCheck): void => checkStrictDefinition(definition, fixedOutput),
    generate: (request: ModelRequest): Promise<ModelResponse> => call(request),
    stream: (request: ModelRequest): AsyncIterable<ModelStreamEvent> => streamModelCall((onDelta, consumer) => call(request, onDelta, consumer)),
  });
}
