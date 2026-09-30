import { Anthropic, APIConnectionError, APIError } from '@anthropic-ai/sdk';
import { assertPositiveInteger, jsonValue, MayuraError, MEDIA_TYPES, ModelProviderError, type JsonObject, type JsonValue, type Media, type MediaType, type ModelAdapter,
  type ModelDefinitionCheck, type ModelFailureReason, type ModelMediaCapability, type ModelMessage, type ModelProvider, type ModelRequest, type ModelResponse,
  type ModelStreamEvent, type ModelToolCall, type ProviderModelSettings } from 'mayura';
import { bytesToBase64, checkStrictDefinition, encodedMediaBytes, modelToolNames, providerEndpoint, providerHeaders, providerHttpFailure, streamModelCall, strictJsonSchema, tokenCostMicros } from 'mayura/core/host';
import { catalog } from './catalog.js';

export { catalog };

export interface AnthropicProviderOptions {
  /** Your Anthropic API key. Required: the provider never reads keys, tokens or URLs from the environment. */
  readonly apiKey: string;
  /** Send requests here instead of https://api.anthropic.com, for example through a gateway. It must be https. */
  readonly baseURL?: string;
  /** Extra headers, such as a gateway's credential. Treated as credentials. They cannot replace x-api-key or the API version. */
  readonly headers?: Readonly<Record<string, string>>;
  /** What the models can see. The default is every Mayura media type and URLs, as Claude models take them; `false` for none. */
  readonly media?: ModelMediaCapability | false;
  readonly maxRequestBytes?: number;
  readonly maxResponseBytes?: number;
  /** How long one call may take unless the registry sets `timeoutMs` (default 60 s). */
  readonly timeoutMs?: number;
  /** A trusted transport for tests or proxies. Never selected from model output. */
  readonly fetch?: typeof globalThis.fetch;
}

const failed = (reason: ModelFailureReason = 'invalid_response'): never => { throw new ModelProviderError(reason); };
const reasonOf = (error: unknown): ModelFailureReason => error instanceof ModelProviderError ? error.reason : 'invalid_response';
function object(value: JsonValue | undefined): JsonObject {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return failed();
  return value;
}
function integer(value: unknown, fallback?: number): number {
  if ((value === undefined || value === null) && fallback !== undefined) return fallback;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) return failed();
  return value;
}
function mediaOption(value: ModelMediaCapability | false | undefined): ModelMediaCapability | undefined {
  if (value === false) return undefined;
  const capability = value ?? { types: MEDIA_TYPES, urls: true };
  if (!Array.isArray(capability.types) || capability.types.some(type => !MEDIA_TYPES.includes(type)) || typeof capability.urls !== 'boolean') {
    throw new MayuraError('INVALID_CONFIG', 'media must list media types and say whether URLs are taken.');
  }
  return Object.freeze({ types: Object.freeze([...new Set(capability.types)] as MediaType[]), urls: capability.urls });
}

/** A response larger than the configured limit; reported as an unusable response. */
class ResponseTooLarge extends Error {}
/** The SDK's transport, bounded: no redirects, and a body larger than `limit` (four times that for a stream) fails. */
function boundedFetch(transport: () => typeof globalThis.fetch, limit: number): typeof globalThis.fetch {
  return async (input, init) => {
    const response = await transport()(input, { ...init, redirect: 'error' });
    const max = (response.headers.get('content-type') ?? '').includes('text/event-stream') ? limit * 4 : limit;
    const length = response.headers.get('content-length');
    if (length !== null && (!/^\d+$/u.test(length) || Number(length) > max)) { void response.body?.cancel().catch(() => undefined); throw new ResponseTooLarge(); }
    if (!response.body) return response;
    let size = 0;
    const counted = response.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) { size += chunk.byteLength; if (size > max) controller.error(new ResponseTooLarge()); else controller.enqueue(chunk); },
    }));
    return new Response(counted, { status: response.status, statusText: response.statusText, headers: response.headers });
  };
}

/** An image or document block: inline base64, or a URL Anthropic fetches. A named image is introduced by a text block. */
function mediaBlocks(item: Media): JsonValue[] {
  const source = 'data' in item ? { type: 'base64', media_type: item.mediaType, data: bytesToBase64(item.data) } : { type: 'url', url: item.url };
  const block = item.mediaType === 'application/pdf'
    ? { type: 'document', source, ...(item.name === undefined ? {} : { title: item.name }) }
    : { type: 'image', source };
  return item.name === undefined || item.mediaType === 'application/pdf' ? [block] : [{ type: 'text', text: `Image: ${item.name}` }, block];
}
/** The blocks of a tool-call turn Anthropic needs back unchanged: thinking (with its signature) and tool calls. */
function ownTurn(content: readonly JsonValue[]): JsonObject[] {
  const kept: JsonObject[] = [];
  for (const raw of content) {
    const block = object(raw);
    if (block['type'] === 'thinking' && typeof block['thinking'] === 'string' && typeof block['signature'] === 'string') kept.push({ type: 'thinking', thinking: block['thinking'], signature: block['signature'] });
    else if (block['type'] === 'redacted_thinking' && typeof block['data'] === 'string') kept.push({ type: 'redacted_thinking', data: block['data'] });
    else if (block['type'] === 'tool_use') kept.push({ type: 'tool_use', id: block['id'] as JsonValue, name: block['name'] as JsonValue, input: block['input'] as JsonValue });
  }
  return kept;
}
const isThinking = (block: JsonObject): boolean => (block['type'] === 'thinking' && typeof block['thinking'] === 'string')
  || (block['type'] === 'redacted_thinking' && typeof block['data'] === 'string');
/** The conversation as Anthropic messages; `assistants` are the model's own earlier tool-call turns in this run. */
function messagesFor(messages: readonly ModelMessage[], aliases: ReadonlyMap<string, string>, assistants: readonly JsonObject[][]): JsonValue[] {
  let turn = 0;
  return messages.map(message => {
    if (message.role === 'user') return { role: 'user', content: [{ type: 'text', text: JSON.stringify(message.content) }, ...(message.media ?? []).flatMap(mediaBlocks)] };
    if (message.role === 'tool') {
      // Images go inside the tool result; documents follow it in the same turn.
      const media = message.media ?? [];
      const images = media.filter(item => item.mediaType !== 'application/pdf'); const documents = media.filter(item => item.mediaType === 'application/pdf');
      const result = images.length === 0 ? JSON.stringify(message.result) : [{ type: 'text', text: JSON.stringify(message.result) }, ...images.flatMap(mediaBlocks)];
      return { role: 'user', content: [{ type: 'tool_result', tool_use_id: message.callId, content: result }, ...documents.flatMap(mediaBlocks)] };
    }
    const calls = message.calls.map(call => {
      const name = aliases.get(call.toolId); if (!name) return failed();
      return { type: 'tool_use', id: call.id, name, input: call.input };
    });
    const own = assistants[turn++];
    if (!own) return { role: 'assistant', content: calls };
    const ownCalls = own.filter(block => block['type'] === 'tool_use');
    if (ownCalls.length !== calls.length || ownCalls.some((block, index) => block['id'] !== calls[index]!.id)) return failed();
    return { role: 'assistant', content: own };
  });
}

/** Rebuilds the message a non-streamed call returns from a Messages event stream, reporting text deltas as they arrive. */
async function assemble(events: AsyncIterable<JsonObject>, maxResponseBytes: number, onDelta: (text: string) => void): Promise<JsonObject> {
  let message: JsonObject | undefined; let stopped = false; let stopReason: JsonValue = null; let usage: JsonObject = {};
  const list: ({ type: 'text'; text: string } | { type: 'tool_use'; id: JsonValue; name: JsonValue; json: string }
    | { type: 'thinking'; thinking: string; signature: string } | { type: 'redacted_thinking'; data: string })[] = [];
  for await (const raw of events) {
    if (stopped) return failed();
    const data = object(jsonValue(JSON.parse(JSON.stringify(raw)) as JsonValue, { maxBytes: maxResponseBytes }));
    const type = data['type'];
    if (type === 'ping') continue;
    if (type === 'error') return failed('unavailable');
    if (type === 'message_start') { if (message) return failed(); message = object(data['message']); usage = { ...object(message['usage']) }; continue; }
    if (!message) return failed();
    if (type === 'content_block_start') {
      const index = integer(data['index']); const block = object(data['content_block']);
      if (index !== list.length || list.length >= 256) return failed();
      if (block['type'] === 'text') list.push({ type: 'text', text: typeof block['text'] === 'string' ? block['text'] : '' });
      else if (block['type'] === 'tool_use') list.push({ type: 'tool_use', id: block['id'] ?? null, name: block['name'] ?? null, json: '' });
      else if (block['type'] === 'thinking') list.push({ type: 'thinking', thinking: typeof block['thinking'] === 'string' ? block['thinking'] : '', signature: typeof block['signature'] === 'string' ? block['signature'] : '' });
      else if (block['type'] === 'redacted_thinking' && typeof block['data'] === 'string') list.push({ type: 'redacted_thinking', data: block['data'] });
      else return failed();
    } else if (type === 'content_block_delta') {
      const block = list[integer(data['index'])]; const delta = object(data['delta']);
      if (!block) return failed();
      if (delta['type'] === 'text_delta' && block.type === 'text' && typeof delta['text'] === 'string') { block.text += delta['text']; onDelta(delta['text']); }
      else if (delta['type'] === 'input_json_delta' && block.type === 'tool_use' && typeof delta['partial_json'] === 'string') block.json += delta['partial_json'];
      else if (delta['type'] === 'thinking_delta' && block.type === 'thinking' && typeof delta['thinking'] === 'string') block.thinking += delta['thinking'];
      else if (delta['type'] === 'signature_delta' && block.type === 'thinking' && typeof delta['signature'] === 'string') block.signature += delta['signature'];
      else return failed();
    } else if (type === 'message_delta') {
      const delta = object(data['delta']); stopReason = delta['stop_reason'] ?? null;
      if (data['usage'] !== undefined) usage = { ...usage, ...object(data['usage']) };
    } else if (type === 'message_stop') stopped = true;
  }
  if (!message || !stopped) return failed();
  const content = list.map(block => block.type === 'text' ? { type: 'text', text: block.text }
    : block.type === 'thinking' ? { type: 'thinking', thinking: block.thinking, signature: block.signature }
      : block.type === 'redacted_thinking' ? { type: 'redacted_thinking', data: block.data }
        : { type: 'tool_use', id: block.id, name: block.name, input: jsonValue(JSON.parse(block.json || '{}'), { maxBytes: maxResponseBytes }) });
  return { ...message, content, stop_reason: stopReason, usage } as JsonObject;
}

/**
 * Anthropic Claude models for a Mayura model registry, through the official Anthropic SDK and the Messages API:
 *
 * ```ts
 * const models = createModels({ providers: [anthropic({ apiKey })], prices: 'catalog', maxCallCostMicros: 50_000 });
 * const model = models.model('anthropic/claude-sonnet-5-5'); // granted as model:anthropic/claude-sonnet-5-5
 * ```
 *
 * Structured output and tool inputs use strict JSON Schema; streaming reports output text as it arrives; the model's
 * thinking is kept for the next call of the run and never released. The SDK's retries are off, and nothing is read
 * from the environment. Prompt-cache writes are charged at twice the input rate and cache reads at the full rate, so a
 * budget never undercounts.
 */
export function anthropic(options: AnthropicProviderOptions): ModelProvider {
  if (!options || typeof options.apiKey !== 'string' || !options.apiKey.trim() || /[\r\n]/u.test(options.apiKey) || options.apiKey.length > 4096) {
    throw new MayuraError('INVALID_CONFIG', 'anthropic() needs an apiKey.');
  }
  const baseURL = options.baseURL === undefined ? 'https://api.anthropic.com' : providerEndpoint(options.baseURL, '', 'anthropic()');
  const headers = providerHeaders(options.headers, ['x-api-key', 'anthropic-version', 'Authorization'], 'anthropic()');
  const maxRequestBytes = options.maxRequestBytes ?? 1_048_576; const maxResponseBytes = options.maxResponseBytes ?? 1_048_576;
  const defaultTimeout = options.timeoutMs ?? 60_000;
  for (const [value, name] of [[maxRequestBytes, 'maxRequestBytes'], [maxResponseBytes, 'maxResponseBytes'], [defaultTimeout, 'timeoutMs']] as const) assertPositiveInteger(value, name);
  const media = mediaOption(options.media);
  const client = new Anthropic({
    apiKey: options.apiKey, authToken: null, baseURL, defaultHeaders: headers,
    // Mayura owns retries and time limits: one SDK attempt per call, and the SDK's own timer never fires first. The
    // SDK's logging, which ANTHROPIC_LOG would switch on (logging each request, prompts included), stays off.
    maxRetries: 0, timeout: 2_147_483_647, logLevel: 'off',
    fetch: boundedFetch(() => options.fetch ?? globalThis.fetch, maxResponseBytes),
  });

  return Object.freeze({
    id: 'anthropic',
    catalog,
    model(name: string, settings: ProviderModelSettings): ModelAdapter {
      if (typeof name !== 'string' || !name.trim() || name.length > 128) throw new MayuraError('INVALID_CONFIG', 'An Anthropic model name is required.');
      const timeoutMs = settings.timeoutMs ?? defaultTimeout;

      const call = async (request: ModelRequest, onDelta?: (text: string) => void, consumer?: AbortSignal): Promise<ModelResponse> => {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        let knownCost: number | undefined;
        try {
          const signal = AbortSignal.any([request.signal, controller.signal, ...(consumer ? [consumer] : [])]);
          if (signal.aborted) throw new MayuraError('CANCELLED', 'Provider request was cancelled.');
          let assistants: JsonObject[][] = [];
          if (request.continuation !== undefined) {
            const previous = object(request.continuation);
            if (previous['provider'] !== 'anthropic.messages.v1' || previous['model'] !== name || !Array.isArray(previous['assistants'])) return failed();
            assistants = previous['assistants'].map(turn => Array.isArray(turn) ? turn.map(block => object(block)) : failed());
          }
          if (assistants.length > request.messages.filter(message => message.role === 'assistant').length) return failed();
          assertPositiveInteger(request.maxOutputTokens, 'maxOutputTokens');
          const aliases = new Map(modelToolNames(request.tools.map(tool => tool.id)));
          const ids = new Map([...aliases].map(([toolId, alias]) => [alias, toolId]));
          if (aliases.size !== request.tools.length || aliases.size > 128) return failed();
          const tools = request.tools.map(tool => {
            if (!tool.inputJsonSchema) throw new MayuraError('INVALID_CONFIG', `Tool "${tool.id}" has no inputJsonSchema.`);
            return { name: aliases.get(tool.id)!, description: tool.description, input_schema: strictJsonSchema(tool.inputJsonSchema, `Tool "${tool.id}" input schema`), strict: true };
          });
          const outputSchema = request.outputJsonSchema === undefined ? failed('configuration') : strictJsonSchema(request.outputJsonSchema, 'The output schema');
          const body: JsonObject = {
            model: name, max_tokens: request.maxOutputTokens, system: request.instructions,
            messages: messagesFor(request.messages, aliases, assistants),
            output_config: { format: { type: 'json_schema', schema: outputSchema } },
            ...(tools.length > 0 ? { tools, tool_choice: { type: 'auto', disable_parallel_tool_use: false } } : {}),
          };
          jsonValue(body, { maxBytes: maxRequestBytes + encodedMediaBytes(request.messages) });

          const payload = onDelta
            ? await assemble(await client.messages.create({ ...body, stream: true } as never, { signal }) as unknown as AsyncIterable<JsonObject>, maxResponseBytes, onDelta)
            : object(jsonValue(JSON.parse(JSON.stringify(await client.messages.create(body as never, { signal }))) as JsonValue, { maxBytes: maxResponseBytes * 2 }));

          const usage = object(payload['usage']);
          const input = integer(usage['input_tokens']); const output = integer(usage['output_tokens']);
          const cacheWrites = integer(usage['cache_creation_input_tokens'], 0); const cacheReads = integer(usage['cache_read_input_tokens'], 0);
          // Cache writes cost up to twice the input rate (one-hour cache) and reads less than it: both are charged high.
          knownCost = tokenCostMicros(settings.pricing, input + 2 * cacheWrites + cacheReads, output) ?? failed();
          if (payload['type'] !== 'message' || payload['role'] !== 'assistant' || !Array.isArray(payload['content']) || payload['content'].length < 1 || payload['content'].length > 256) return failed();
          const accounting = { costMicros: knownCost };
          if (payload['stop_reason'] === 'tool_use') {
            const calls: ModelToolCall[] = []; const seen = new Set<string>();
            for (const raw of payload['content']) {
              const block = object(raw);
              // Text before a tool call is narration, not an answer: it is dropped. Thinking is kept for the next call.
              if ((block['type'] === 'text' && typeof block['text'] === 'string') || isThinking(block)) continue;
              const callId = block['id']; const alias = block['name'];
              if (block['type'] !== 'tool_use' || typeof callId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/u.test(callId) || seen.has(callId)
                || typeof alias !== 'string' || !ids.has(alias) || block['input'] === undefined) return failed();
              seen.add(callId); calls.push({ id: callId, toolId: ids.get(alias)!, input: jsonValue(block['input']) });
            }
            if (calls.length === 0) return failed();
            const continuation = jsonValue({ provider: 'anthropic.messages.v1', model: name, assistants: [...assistants, ownTurn(payload['content'])] }, { maxBytes: maxRequestBytes });
            return { type: 'tool_calls', calls, usage: accounting, continuation };
          }
          if (payload['stop_reason'] === 'refusal' || payload['stop_reason'] === 'max_tokens') return failed('refused');
          if (payload['stop_reason'] !== 'end_turn') return failed();
          const text: string[] = [];
          for (const raw of payload['content']) {
            const block = object(raw);
            if (isThinking(block)) continue;
            if (block['type'] !== 'text' || typeof block['text'] !== 'string') return failed();
            text.push(block['text']);
          }
          return { type: 'final', output: jsonValue(JSON.parse(text.join('')), { maxBytes: maxResponseBytes }), usage: accounting };
        } catch (error) {
          if (knownCost !== undefined) throw new ModelProviderError(reasonOf(error), { costMicros: knownCost });
          if (request.signal.aborted || controller.signal.aborted || consumer?.aborted) throw new MayuraError('CANCELLED', 'Provider request was cancelled or timed out.');
          if (error instanceof ModelProviderError) throw error;
          if (error instanceof MayuraError && error.code === 'INVALID_CONFIG') return failed('configuration');
          if (error instanceof APIConnectionError) return failed(error.cause instanceof ResponseTooLarge ? 'invalid_response' : 'unavailable');
          // Anthropic answers 529 when it is overloaded; like any 5xx, the provider is unavailable.
          if (error instanceof APIError && typeof error.status === 'number') throw providerHttpFailure(error.status);
          return failed();
        } finally { clearTimeout(timer); }
      };

      return Object.freeze({
        id: settings.id, maxCostMicros: settings.maxCostMicros,
        capabilities: Object.freeze({ tools: true, structuredOutput: true, ...(media ? { media } : {}) }),
        checkDefinition: (definition: ModelDefinitionCheck): void => checkStrictDefinition(definition),
        generate: (request: ModelRequest): Promise<ModelResponse> => call(request),
        stream: (request: ModelRequest): AsyncIterable<ModelStreamEvent> => streamModelCall((onDelta, consumer) => call(request, onDelta, consumer)),
      });
    },
  });
}
