import { assertPositiveInteger, freezeJson, jsonValue, MayuraError, ModelInvocationError, type JsonObject, type JsonValue, type ModelAdapter, type ModelMessage, type ModelRequest, type ModelResponse, type ModelToolCall } from '@mayura/core';

export interface OpenAIResponsesOptions {
  readonly apiKey: string;
  readonly model: string;
  readonly outputJsonSchema: JsonObject;
  readonly maxCostMicros: number;
  readonly pricing: { readonly inputMicrosPerMillionTokens: number; readonly outputMicrosPerMillionTokens: number };
  readonly maxRequestBytes?: number;
  readonly maxResponseBytes?: number;
  readonly timeoutMs?: number;
  /** Trusted test/proxy transport; never selected from model output. Default destination is fixed. */
  readonly fetch?: typeof globalThis.fetch;
}
export interface OpenAICompatibleChatOptions {
  /** Exact loopback Chat Completions URL, for example http://127.0.0.1:11434/v1/chat/completions. */
  readonly endpoint: string;
  readonly apiKey?: string;
  readonly model: string;
  readonly outputJsonSchema: JsonObject;
  readonly maxCostMicros: number;
  readonly pricing: { readonly inputMicrosPerMillionTokens: number; readonly outputMicrosPerMillionTokens: number };
  readonly maxRequestBytes?: number;
  readonly maxResponseBytes?: number;
  readonly timeoutMs?: number;
  readonly fetch?: typeof globalThis.fetch;
}
class ProviderFailure extends MayuraError {
  constructor(message = 'The model provider returned an unavailable, refused or invalid response.') { super('MODEL_FAILED', message); }
}
const failed = (message?: string): never => { throw new ProviderFailure(message); };
function object(value: JsonValue | undefined): JsonObject {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return failed();
  return value;
}
function integer(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) return failed();
  return value;
}
function strictSchema(schema: JsonObject): JsonObject {
  const copy = jsonValue(schema) as JsonObject;
  if (copy['type'] !== 'object') throw new MayuraError('INVALID_CONFIG', 'Provider schemas require a root JSON object.');
  const visit = (item: JsonObject): void => {
    if (item['type'] === 'object' || (Array.isArray(item['type']) && item['type'].includes('object'))) {
      const properties = object(item['properties']); const required = item['required'];
      if (item['additionalProperties'] !== false || !Array.isArray(required) || required.some(key => typeof key !== 'string') || new Set(required).size !== required.length || Object.keys(properties).length !== required.length || Object.keys(properties).some(key => !required.includes(key))) {
        throw new MayuraError('INVALID_CONFIG', 'Strict object schemas must require every property and prohibit additional properties.');
      }
      for (const child of Object.values(properties)) visit(object(child));
    }
    if (item['items'] !== undefined) visit(object(item['items']));
    for (const key of ['anyOf', 'allOf', 'oneOf']) if (Array.isArray(item[key])) for (const child of item[key]) visit(object(child));
    for (const key of ['$defs', 'definitions']) if (item[key] !== undefined) for (const child of Object.values(object(item[key]))) visit(object(child));
  };
  visit(copy); return freezeJson(copy);
}

async function abortable<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) { void operation.catch(() => undefined); throw new MayuraError('CANCELLED', 'Provider request was cancelled.'); }
  let abort: (() => void) | undefined;
  try {
    return await Promise.race([operation, new Promise<never>((_, reject) => {
      abort = () => reject(new MayuraError('CANCELLED', 'Provider request was cancelled.'));
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) abort();
    })]);
  } finally { if (abort) signal.removeEventListener('abort', abort); }
}

async function responseBody(response: Response, limit: number, signal: AbortSignal): Promise<JsonObject> {
  if (!response.ok || response.redirected || !response.body) {
    // Rejected responses still own a stream; release it without reading or exposing its contents.
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
  const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let size = 0;
  try {
    while (true) {
      const item = await abortable(reader.read(), signal);
      if (item.done) break;
      size += item.value.byteLength;
      if (size > limit) return failed();
      chunks.push(item.value);
    }
    const buffer = new Uint8Array(size); let offset = 0;
    for (const chunk of chunks) { buffer.set(chunk, offset); offset += chunk.byteLength; }
    return object(jsonValue(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(buffer)), { maxBytes: limit }));
  } finally { void reader.cancel().catch(() => undefined); reader.releaseLock(); }
}

function messagesToInput(messages: readonly ModelMessage[], hasContinuation: boolean, aliases: Map<string, string>): JsonValue[] {
  const result: JsonValue[] = [];
  for (const message of messages) {
    if (message.role === 'user') result.push({ role: 'user', content: JSON.stringify(message.content) });
    else if (message.role === 'tool') result.push({ type: 'function_call_output', call_id: message.callId, output: JSON.stringify(message.result) });
    else if (!hasContinuation) for (const call of message.calls) {
      const name = aliases.get(call.toolId); if (!name) return failed();
      result.push({ type: 'function_call', call_id: call.id, name, arguments: JSON.stringify(call.input) });
    }
    // Continuation already includes the provider's original function calls and reasoning items.
  }
  return result;
}

/** Explicit, stateless-per-call Responses adapter. No credential discovery, retries or public raw deltas. */
export function openAIResponses(options: OpenAIResponsesOptions): ModelAdapter {
  if (typeof options.apiKey !== 'string' || !options.apiKey.trim() || /[\r\n]/.test(options.apiKey) || options.apiKey.length > 4096 || typeof options.model !== 'string' || !options.model.trim() || options.model.length > 128) throw new MayuraError('INVALID_CONFIG', 'A model ID and bounded API key are required.');
  const apiKey = options.apiKey; const model = options.model;
  const outputSchema = strictSchema(options.outputJsonSchema);
  const priceInput = options.pricing.inputMicrosPerMillionTokens;
  const priceOutput = options.pricing.outputMicrosPerMillionTokens;
  for (const amount of [options.maxCostMicros, priceInput, priceOutput]) if (!Number.isSafeInteger(amount) || amount < 0) throw new MayuraError('INVALID_CONFIG', 'Configured costs must be non-negative safe integers.');
  const maxRequestBytes = options.maxRequestBytes ?? 1_048_576;
  const maxResponseBytes = options.maxResponseBytes ?? 1_048_576;
  const timeoutMs = options.timeoutMs ?? 30_000;
  assertPositiveInteger(maxRequestBytes, 'maxRequestBytes'); assertPositiveInteger(maxResponseBytes, 'maxResponseBytes'); assertPositiveInteger(timeoutMs, 'timeoutMs');
  if (timeoutMs > 2_147_483_647) throw new MayuraError('INVALID_CONFIG', 'Provider timeout exceeds the supported timer range.');
  const transport = options.fetch ?? globalThis.fetch;
  if (typeof transport !== 'function') throw new MayuraError('INVALID_CONFIG', 'A fetch-compatible transport is required.');
  return Object.freeze({
    id: 'openai.responses', capabilities: Object.freeze({ tools: true, structuredOutput: true }), maxCostMicros: options.maxCostMicros,
    async generate(request: ModelRequest): Promise<ModelResponse> {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      let knownCost: number | undefined;
      try {
        const signal = AbortSignal.any([request.signal, controller.signal]);
        if (signal.aborted) throw new MayuraError('CANCELLED', 'Provider request was cancelled.');
        assertPositiveInteger(request.maxOutputTokens, 'maxOutputTokens');
        const aliases = new Map(request.tools.map((tool, index) => [tool.id, `tool_${index}`]));
        const ids = new Map([...aliases].map(([id, name]) => [name, id]));
        if (aliases.size !== request.tools.length || request.tools.length > 128) return failed();
        let history: JsonValue[] = []; let consumed = 0;
        if (request.continuation !== undefined) {
          const previous = object(jsonValue(request.continuation, { maxBytes: maxRequestBytes }));
          if (previous['provider'] !== 'openai.responses.v1' || previous['model'] !== model || !Array.isArray(previous['history'])) return failed();
          consumed = integer(previous['consumed']);
          if (consumed > request.messages.length) return failed();
          history = previous['history'];
        }
        const additions = messagesToInput(request.messages.slice(consumed), request.continuation !== undefined, aliases);
        const input = [...history, ...additions];
        const tools = request.tools.map(tool => {
          if (!tool.inputJsonSchema) throw new MayuraError('INVALID_CONFIG', 'Every provider-exposed tool requires an explicit portable JSON Schema.');
          return { type: 'function', name: aliases.get(tool.id)!, description: tool.description, parameters: strictSchema(tool.inputJsonSchema), strict: true };
        });
        const body = JSON.stringify(jsonValue({ model, instructions: request.instructions, input, tools,
          store: false, stream: false, include: ['reasoning.encrypted_content'], parallel_tool_calls: true,
          max_output_tokens: request.maxOutputTokens,
          text: { format: { type: 'json_schema', name: 'mayura_output', schema: outputSchema, strict: true } },
        }, { maxBytes: maxRequestBytes }));
        const response = await abortable(transport('https://api.openai.com/v1/responses', {
          method: 'POST', headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
          body, signal, redirect: 'error',
        }), signal);
        const payload = await responseBody(response, maxResponseBytes, signal);
        const usage = object(payload['usage']);
        const inputTokens = integer(usage['input_tokens']); const outputTokens = integer(usage['output_tokens']);
        const numerator = BigInt(inputTokens) * BigInt(priceInput) + BigInt(outputTokens) * BigInt(priceOutput);
        const computedCost = (numerator + 999_999n) / 1_000_000n;
        if (computedCost > BigInt(Number.MAX_SAFE_INTEGER)) return failed();
        knownCost = Number(computedCost);
        if (payload['status'] !== 'completed' || !Array.isArray(payload['output']) || payload['output'].length > 256) return failed();
        const calls: ModelToolCall[] = []; const callIds = new Set<string>(); const text: string[] = [];
        for (const rawItem of payload['output']) {
          const item = object(rawItem);
          // A completed envelope cannot legitimize a partial individual output item.
          if (item['status'] !== undefined && item['status'] !== 'completed') return failed();
          if (item['type'] === 'reasoning') continue;
          if (item['type'] === 'function_call') {
            const callId = item['call_id']; const name = item['name']; const args = item['arguments'];
            if (typeof callId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/.test(callId) || callIds.has(callId) || typeof name !== 'string' || !ids.has(name) || typeof args !== 'string') return failed();
            callIds.add(callId); calls.push({ id: callId, toolId: ids.get(name)!, input: jsonValue(JSON.parse(args)) });
          } else if (item['type'] === 'message') {
            if (item['role'] !== 'assistant' || !Array.isArray(item['content'])) return failed();
            for (const rawContent of item['content']) {
              const content = object(rawContent);
              if (content['type'] !== 'output_text' || typeof content['text'] !== 'string') return failed();
              text.push(content['text']);
            }
          } else return failed();
        }
        const accounting = { costMicros: Number(computedCost) };
        if (calls.length > 0) {
          const continuation = jsonValue({ provider: 'openai.responses.v1', model, consumed: request.messages.length, history: [...input, ...payload['output']] }, { maxBytes: maxRequestBytes });
          return { type: 'tool_calls', calls, usage: accounting, continuation };
        }
        if (text.length === 0) return failed();
        return { type: 'final', output: jsonValue(JSON.parse(text.join('')), { maxBytes: maxResponseBytes }), usage: accounting };
      } catch (error) {
        // HTTP status/body, credentials, model output and arbitrary transport exceptions are private.
        if (knownCost !== undefined) throw new ModelInvocationError(knownCost);
        if (request.signal.aborted || controller.signal.aborted) throw new MayuraError('CANCELLED', 'Provider request was cancelled or timed out.');
        if (error instanceof ProviderFailure) throw error;
        return failed();
      } finally { clearTimeout(timer); }
    },
  });
}

function compatibleMessages(messages: readonly ModelMessage[], aliases: Map<string, string>): JsonValue[] {
  return messages.map(message => {
    if (message.role === 'user') return { role: 'user', content: JSON.stringify(message.content) };
    if (message.role === 'tool') return { role: 'tool', tool_call_id: message.callId, content: JSON.stringify(message.result) };
    return { role: 'assistant', content: null, tool_calls: message.calls.map(call => {
      const name = aliases.get(call.toolId); if (!name) return failed();
      return { id: call.id, type: 'function', function: { name, arguments: JSON.stringify(call.input) } };
    }) };
  });
}

/** Loopback-only Chat Completions adapter for explicitly selected compatible local model servers. */
export function openAICompatibleChat(options: OpenAICompatibleChatOptions): ModelAdapter {
  let endpoint: URL;
  try { endpoint = new URL(options.endpoint); }
  catch { throw new MayuraError('INVALID_CONFIG', 'A valid loopback Chat Completions endpoint is required.'); }
  if (endpoint.protocol !== 'http:' || !['localhost', '127.0.0.1', '[::1]'].includes(endpoint.hostname)
    || endpoint.username || endpoint.password || endpoint.pathname !== '/v1/chat/completions' || endpoint.search || endpoint.hash) {
    throw new MayuraError('INVALID_CONFIG', 'Compatible local models require an exact loopback HTTP endpoint.');
  }
  if (options.apiKey !== undefined && (typeof options.apiKey !== 'string' || !options.apiKey || /[\r\n]/u.test(options.apiKey) || options.apiKey.length > 4_096)) {
    throw new MayuraError('INVALID_CONFIG', 'Compatible provider credentials must be bounded header values.');
  }
  if (typeof options.model !== 'string' || !options.model.trim() || options.model.length > 128) throw new MayuraError('INVALID_CONFIG', 'A bounded local model ID is required.');
  const url = endpoint.href; const apiKey = options.apiKey; const model = options.model; const outputSchema = strictSchema(options.outputJsonSchema);
  const inputPrice = options.pricing.inputMicrosPerMillionTokens; const outputPrice = options.pricing.outputMicrosPerMillionTokens;
  for (const amount of [options.maxCostMicros, inputPrice, outputPrice]) if (!Number.isSafeInteger(amount) || amount < 0) throw new MayuraError('INVALID_CONFIG', 'Configured costs must be non-negative safe integers.');
  const maxRequestBytes = options.maxRequestBytes ?? 1_048_576; const maxResponseBytes = options.maxResponseBytes ?? 1_048_576;
  const timeoutMs = options.timeoutMs ?? 30_000;
  assertPositiveInteger(maxRequestBytes, 'maxRequestBytes'); assertPositiveInteger(maxResponseBytes, 'maxResponseBytes'); assertPositiveInteger(timeoutMs, 'timeoutMs');
  if (timeoutMs > 2_147_483_647) throw new MayuraError('INVALID_CONFIG', 'Provider timeout exceeds the supported timer range.');
  const transport = options.fetch ?? globalThis.fetch;
  if (typeof transport !== 'function') throw new MayuraError('INVALID_CONFIG', 'A fetch-compatible transport is required.');
  return Object.freeze({ id: 'openai-compatible.chat', capabilities: Object.freeze({ tools: true, structuredOutput: true }), maxCostMicros: options.maxCostMicros,
    async generate(request: ModelRequest): Promise<ModelResponse> {
      const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), timeoutMs); let knownCost: number | undefined;
      try {
        const signal = AbortSignal.any([request.signal, controller.signal]);
        if (signal.aborted) throw new MayuraError('CANCELLED', 'Provider request was cancelled.');
        if (request.continuation !== undefined) return failed();
        assertPositiveInteger(request.maxOutputTokens, 'maxOutputTokens');
        const aliases = new Map(request.tools.map((tool, index) => [tool.id, `tool_${index}`]));
        const ids = new Map([...aliases].map(([toolId, alias]) => [alias, toolId]));
        if (aliases.size !== request.tools.length || aliases.size > 128) return failed();
        const tools = request.tools.map(tool => {
          if (!tool.inputJsonSchema) throw new MayuraError('INVALID_CONFIG', 'Every provider-exposed tool requires an explicit portable JSON Schema.');
          return { type: 'function', function: { name: aliases.get(tool.id)!, description: tool.description, parameters: strictSchema(tool.inputJsonSchema) } };
        });
        const body = JSON.stringify(jsonValue({ model, stream: false, messages: [{ role: 'system', content: request.instructions }, ...compatibleMessages(request.messages, aliases)],
          tools, parallel_tool_calls: true, max_tokens: request.maxOutputTokens,
          response_format: { type: 'json_schema', json_schema: { name: 'mayura_output', strict: true, schema: outputSchema } },
        }, { maxBytes: maxRequestBytes }));
        const headers: Record<string, string> = { 'Content-Type': 'application/json' }; if (apiKey !== undefined) headers['Authorization'] = `Bearer ${apiKey}`;
        const response = await abortable(transport(url, { method: 'POST', headers, body, signal, redirect: 'error' }), signal);
        const payload = await responseBody(response, maxResponseBytes, signal); const usage = object(payload['usage']);
        const inputTokens = integer(usage['prompt_tokens']); const outputTokens = integer(usage['completion_tokens']);
        const cost = (BigInt(inputTokens) * BigInt(inputPrice) + BigInt(outputTokens) * BigInt(outputPrice) + 999_999n) / 1_000_000n;
        if (cost > BigInt(Number.MAX_SAFE_INTEGER)) return failed(); knownCost = Number(cost);
        if (!Array.isArray(payload['choices']) || payload['choices'].length !== 1) return failed();
        const choice = object(payload['choices'][0]); const message = object(choice['message']);
        if (message['role'] !== 'assistant') return failed();
        if (choice['finish_reason'] === 'tool_calls') {
          if (!Array.isArray(message['tool_calls']) || message['tool_calls'].length < 1 || message['tool_calls'].length > 128) return failed();
          const seen = new Set<string>(); const calls = message['tool_calls'].map(raw => {
            const call = object(raw); const fn = object(call['function']); const callId = call['id']; const alias = fn['name'];
            if (call['type'] !== 'function' || typeof callId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/u.test(callId)
              || seen.has(callId) || typeof alias !== 'string' || !ids.has(alias) || typeof fn['arguments'] !== 'string') return failed();
            seen.add(callId); return { id: callId, toolId: ids.get(alias)!, input: jsonValue(JSON.parse(fn['arguments'])) };
          });
          return { type: 'tool_calls', calls, usage: { costMicros: knownCost } };
        }
        if (choice['finish_reason'] !== 'stop' || typeof message['content'] !== 'string') return failed();
        return { type: 'final', output: jsonValue(JSON.parse(message['content']), { maxBytes: maxResponseBytes }), usage: { costMicros: knownCost } };
      } catch (error) {
        if (knownCost !== undefined) throw new ModelInvocationError(knownCost);
        if (request.signal.aborted || controller.signal.aborted) throw new MayuraError('CANCELLED', 'Provider request was cancelled or timed out.');
        if (error instanceof ProviderFailure) throw error;
        return failed();
      } finally { clearTimeout(timer); }
    },
  });
}

export interface OpenAIEmbeddingsOptions {
  readonly apiKey: string;
  /** For example `text-embedding-3-small`. The adapter id includes model and dimensions, so changing either re-indexes. */
  readonly model: string;
  readonly dimensions: number;
  readonly maxBatch?: number;
  readonly maxResponseBytes?: number;
  readonly timeoutMs?: number;
  /** Receives provider-reported token usage per request for application accounting. */
  readonly onUsage?: (usage: { readonly inputTokens: number }) => void;
  /** Trusted test/proxy transport; the destination is fixed. */
  readonly fetch?: typeof globalThis.fetch;
}
/**
 * Hosted embedding adapter for native memory (`createNativeMemory({ embedder })`). It declares `location: 'hosted'`,
 * so native memory sends it only the configured `embedSensitivities` and requires the `memory:index` grant.
 */
export function openAIEmbeddings(options: OpenAIEmbeddingsOptions): {
  readonly id: string; readonly dimensions: number; readonly maxBatch: number; readonly location: 'hosted';
  embed(texts: readonly string[], signal: AbortSignal): Promise<readonly (readonly number[])[]>;
} {
  if (typeof options.apiKey !== 'string' || !options.apiKey.trim() || /[\r\n]/.test(options.apiKey) || options.apiKey.length > 4096
    || typeof options.model !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(options.model)) throw new MayuraError('INVALID_CONFIG', 'A model ID and bounded API key are required.');
  const dimensions = options.dimensions; const maxBatch = options.maxBatch ?? 128;
  const maxResponseBytes = options.maxResponseBytes ?? 16_777_216; const timeoutMs = options.timeoutMs ?? 30_000;
  if (!Number.isSafeInteger(dimensions) || dimensions < 1 || dimensions > 4_096 || !Number.isSafeInteger(maxBatch) || maxBatch < 1 || maxBatch > 2_048) {
    throw new MayuraError('INVALID_CONFIG', 'Embedding dimensions must be 1–4096 and batches 1–2048.');
  }
  assertPositiveInteger(maxResponseBytes, 'maxResponseBytes'); assertPositiveInteger(timeoutMs, 'timeoutMs');
  const transport = options.fetch ?? globalThis.fetch;
  if (typeof transport !== 'function') throw new MayuraError('INVALID_CONFIG', 'A fetch-compatible transport is required.');
  const apiKey = options.apiKey; const model = options.model;
  return Object.freeze({
    id: `openai.${model}.${dimensions}`, dimensions, maxBatch, location: 'hosted' as const,
    async embed(texts: readonly string[], requestSignal: AbortSignal): Promise<readonly (readonly number[])[]> {
      if (!Array.isArray(texts) || texts.length === 0 || texts.length > maxBatch || texts.some(text => typeof text !== 'string' || text.length === 0 || text.length > 32_768)) {
        throw new MayuraError('INVALID_INPUT', 'Embedding input must be 1–maxBatch nonempty bounded strings.');
      }
      const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const signal = AbortSignal.any([requestSignal, controller.signal]);
        if (signal.aborted) throw new MayuraError('CANCELLED', 'Provider request was cancelled.');
        const response = await abortable(transport('https://api.openai.com/v1/embeddings', {
          method: 'POST', headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ model, input: texts, dimensions, encoding_format: 'float' }), signal, redirect: 'error',
        }), signal);
        const payload = await responseBody(response, maxResponseBytes, signal);
        const data = payload['data'];
        if (!Array.isArray(data) || data.length !== texts.length) return failed();
        const vectors: number[][] = new Array(texts.length);
        for (const entry of data) {
          const item = object(entry); const index = integer(item['index']); const embedding = item['embedding'];
          if (index >= texts.length || vectors[index] !== undefined || !Array.isArray(embedding) || embedding.length !== dimensions
            || embedding.some(value => typeof value !== 'number' || !Number.isFinite(value))) return failed();
          vectors[index] = embedding as number[];
        }
        const usage = object(payload['usage']);
        try { options.onUsage?.({ inputTokens: integer(usage['prompt_tokens']) }); } catch { /* Accounting callbacks cannot change the result. */ }
        return vectors;
      } catch (error) {
        if (error instanceof MayuraError) throw error;
        throw new ProviderFailure();
      } finally { clearTimeout(timer); }
    },
  });
}
