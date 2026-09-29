import { APIConnectionError, APIError, OpenAI } from 'openai';
import { assertPositiveInteger, jsonValue, MayuraError, MEDIA_TYPES, ModelProviderError, type JsonObject, type JsonValue, type Media, type MediaType, type ModelAdapter,
  type ModelDefinitionCheck, type ModelFailureReason, type ModelMediaCapability, type ModelMessage, type ModelProvider, type ModelRequest,
  type ModelResponse, type ModelStreamEvent, type ModelToolCall, type ProviderModelSettings } from 'mayura';
import { checkStrictDefinition, encodedMediaBytes, mediaDataUrl, modelToolNames, providerEndpoint, providerHeaders, providerHttpFailure, streamModelCall, strictJsonSchema, tokenCostMicros } from 'mayura/core/host';
import { catalog } from './catalog.js';

export { catalog };

export interface OpenAIProviderOptions {
  /** Your OpenAI API key. Required: the provider never reads keys, organizations or URLs from the environment. */
  readonly apiKey: string;
  /**
   * Send requests here instead of https://api.openai.com/v1, for example through a gateway. It must be https.
   * Prompts, tool results and outputs go to this host.
   */
  readonly baseURL?: string;
  readonly organization?: string;
  readonly project?: string;
  /** Extra headers, such as a gateway's credential. Treated as credentials. They cannot replace Authorization. */
  readonly headers?: Readonly<Record<string, string>>;
  /** What the models can see. The default is every Mayura media type and URLs; pass `false` for none. */
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
function integer(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) return failed();
  return value;
}
function toolSchema(tool: { readonly id: string; readonly inputJsonSchema?: JsonObject }): JsonObject {
  if (!tool.inputJsonSchema) throw new MayuraError('INVALID_CONFIG', `Tool "${tool.id}" has no inputJsonSchema.`);
  return strictJsonSchema(tool.inputJsonSchema, `Tool "${tool.id}" input schema`);
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
/**
 * The SDK's transport, bounded: no redirects, and a response body larger than `limit` (four times that for an event
 * stream) fails instead of being read into memory.
 */
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

/** Tool-returned media follows the tool results in one user turn, since tool results themselves are text. */
const TOOL_MEDIA_NOTE = 'Media returned by the tool calls above:';

/** Responses input for `messages`; media appears as placeholders that `hydrate` replaces, so continuations never hold bytes. */
function messagesToInput(messages: readonly ModelMessage[], offset: number, hasContinuation: boolean, aliases: Map<string, string>): JsonValue[] {
  const result: JsonValue[] = []; let pending: JsonValue[] = [];
  const marker = (message: number, count: number): JsonValue[] => Array.from({ length: count }, (_, item) => ({ type: 'mayura_media', message, item }));
  const flush = (): void => { if (pending.length > 0) { result.push({ role: 'user', content: [{ type: 'input_text', text: TOOL_MEDIA_NOTE }, ...pending] }); pending = []; } };
  for (const [index, message] of messages.entries()) {
    if (message.role !== 'tool') flush();
    if (message.role === 'user') {
      const count = message.media?.length ?? 0;
      result.push(count === 0 ? { role: 'user', content: JSON.stringify(message.content) }
        : { role: 'user', content: [{ type: 'input_text', text: JSON.stringify(message.content) }, ...marker(offset + index, count)] });
    } else if (message.role === 'tool') {
      result.push({ type: 'function_call_output', call_id: message.callId, output: JSON.stringify(message.result) });
      pending.push(...marker(offset + index, message.media?.length ?? 0));
    } else if (!hasContinuation) for (const call of message.calls) {
      const name = aliases.get(call.toolId); if (!name) return failed();
      result.push({ type: 'function_call', call_id: call.id, name, arguments: JSON.stringify(call.input) });
    }
  }
  flush();
  return result;
}
function mediaPart(item: Media): JsonValue {
  if (item.mediaType === 'application/pdf') {
    return 'data' in item ? { type: 'input_file', filename: item.name ?? 'document.pdf', file_data: mediaDataUrl(item) } : { type: 'input_file', file_url: item.url };
  }
  return { type: 'input_image', image_url: 'data' in item ? mediaDataUrl(item) : item.url, detail: 'auto' };
}
function hydrate(input: readonly JsonValue[], messages: readonly ModelMessage[]): JsonValue[] {
  return input.map(entry => {
    const item = entry as JsonObject;
    if (!item || typeof item !== 'object' || item['role'] !== 'user' || !Array.isArray(item['content'])) return entry;
    return { ...item, content: item['content'].map(part => {
      const placeholder = part as JsonObject;
      if (!placeholder || typeof placeholder !== 'object' || placeholder['type'] !== 'mayura_media') return part;
      const message = messages[placeholder['message'] as number]; const media = message && 'media' in message ? message.media : undefined;
      const found = typeof placeholder['item'] === 'number' ? media?.[placeholder['item']] : undefined;
      return found ? mediaPart(found) : failed();
    }) };
  });
}

/**
 * OpenAI models for a Mayura model registry, through the official OpenAI SDK and the Responses API:
 *
 * ```ts
 * const models = createModels({ providers: [openai({ apiKey })], prices: 'catalog', maxCallCostMicros: 50_000 });
 * const model = models.model('openai/gpt-5.1'); // granted as model:openai/gpt-5.1
 * ```
 *
 * Structured output and tool inputs use strict JSON Schema; streaming reports output text as it arrives. The SDK's own
 * retries are off (the registry's `retry` option retries, and charges every attempt), and nothing is read from the
 * environment.
 */
export function openai(options: OpenAIProviderOptions): ModelProvider {
  if (!options || typeof options.apiKey !== 'string' || !options.apiKey.trim() || /[\r\n]/u.test(options.apiKey) || options.apiKey.length > 4096) {
    throw new MayuraError('INVALID_CONFIG', 'openai() needs an apiKey.');
  }
  const baseURL = options.baseURL === undefined ? 'https://api.openai.com/v1' : providerEndpoint(options.baseURL, '', 'openai()');
  const headers = providerHeaders(options.headers, ['Authorization', 'OpenAI-Organization', 'OpenAI-Project'], 'openai()');
  const maxRequestBytes = options.maxRequestBytes ?? 1_048_576; const maxResponseBytes = options.maxResponseBytes ?? 1_048_576;
  const defaultTimeout = options.timeoutMs ?? 60_000;
  for (const [value, name] of [[maxRequestBytes, 'maxRequestBytes'], [maxResponseBytes, 'maxResponseBytes'], [defaultTimeout, 'timeoutMs']] as const) assertPositiveInteger(value, name);
  const media = mediaOption(options.media);
  const client = new OpenAI({
    apiKey: options.apiKey, baseURL, organization: options.organization ?? null, project: options.project ?? null, defaultHeaders: headers,
    // Mayura owns retries and time limits: one SDK attempt per call, and its own timer never fires before Mayura's.
    maxRetries: 0, timeout: 2_147_483_647,
    fetch: boundedFetch(() => options.fetch ?? globalThis.fetch, maxResponseBytes),
  });

  return Object.freeze({
    id: 'openai',
    catalog,
    model(name: string, settings: ProviderModelSettings): ModelAdapter {
      if (typeof name !== 'string' || !name.trim() || name.length > 128) throw new MayuraError('INVALID_CONFIG', 'An OpenAI model name is required.');
      const timeoutMs = settings.timeoutMs ?? defaultTimeout;

      const call = async (request: ModelRequest, onDelta?: (text: string) => void, consumer?: AbortSignal): Promise<ModelResponse> => {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        let knownCost: number | undefined;
        try {
          const signal = AbortSignal.any([request.signal, controller.signal, ...(consumer ? [consumer] : [])]);
          if (signal.aborted) throw new MayuraError('CANCELLED', 'Provider request was cancelled.');
          assertPositiveInteger(request.maxOutputTokens, 'maxOutputTokens');
          const aliases = new Map(modelToolNames(request.tools.map(tool => tool.id)));
          const ids = new Map([...aliases].map(([id, alias]) => [alias, id]));
          if (aliases.size !== request.tools.length || request.tools.length > 128) return failed();
          let history: JsonValue[] = []; let consumed = 0;
          if (request.continuation !== undefined) {
            const previous = object(jsonValue(request.continuation, { maxBytes: maxRequestBytes }));
            if (previous['provider'] !== 'openai.responses.v1' || previous['model'] !== name || !Array.isArray(previous['history'])) return failed();
            consumed = integer(previous['consumed']);
            if (consumed > request.messages.length) return failed();
            history = previous['history'];
          }
          const input = [...history, ...messagesToInput(request.messages.slice(consumed), consumed, request.continuation !== undefined, aliases)];
          const outputSchema = request.outputJsonSchema === undefined ? failed('configuration') : strictJsonSchema(request.outputJsonSchema, 'The output schema');
          const body = jsonValue({
            model: name, instructions: request.instructions, input: hydrate(input, request.messages),
            tools: request.tools.map(tool => ({ type: 'function', name: aliases.get(tool.id)!, description: tool.description, parameters: toolSchema(tool), strict: true })),
            store: false, include: ['reasoning.encrypted_content'], parallel_tool_calls: true, max_output_tokens: request.maxOutputTokens,
            text: { format: { type: 'json_schema', name: 'mayura_output', schema: outputSchema, strict: true } },
          }, { maxBytes: maxRequestBytes + encodedMediaBytes(request.messages) }) as JsonObject;

          let payload: JsonObject;
          if (onDelta) {
            const stream = await client.responses.create({ ...body, stream: true } as never, { signal }) as unknown as AsyncIterable<JsonObject>;
            let completed: JsonObject | undefined;
            for await (const event of stream) {
              if (completed) continue;
              const type = event['type'];
              if (type === 'response.output_text.delta') { if (typeof event['delta'] !== 'string') return failed(); onDelta(event['delta']); }
              else if (type === 'response.completed') completed = object(event['response']);
              else if (type === 'response.incomplete') return failed('refused');
              else if (type === 'response.failed' || type === 'error') return failed('unavailable');
            }
            payload = completed ?? failed();
          } else {
            // The SDK adds non-enumerable metadata (`_request_id`); only the JSON the provider sent is used.
            const result = await client.responses.create(body as never, { signal });
            payload = object(jsonValue(JSON.parse(JSON.stringify(result)) as JsonValue, { maxBytes: maxResponseBytes * 2 }));
          }

          const usage = object(payload['usage']);
          const inputTokens = integer(usage['input_tokens']); const outputTokens = integer(usage['output_tokens']);
          // Long prompts are charged at the long-context rates when the pricing has them.
          knownCost = tokenCostMicros(settings.pricing, inputTokens, outputTokens) ?? failed();
          if (payload['status'] === 'incomplete') return failed('refused');
          if (payload['status'] !== 'completed' || !Array.isArray(payload['output']) || payload['output'].length > 256) return failed();
          const calls: ModelToolCall[] = []; const callIds = new Set<string>(); const text: string[] = [];
          for (const raw of payload['output']) {
            const item = object(raw);
            if (item['status'] !== undefined && item['status'] !== 'completed') return failed();
            if (item['type'] === 'reasoning') continue;
            if (item['type'] === 'function_call') {
              const callId = item['call_id']; const alias = item['name']; const args = item['arguments'];
              if (typeof callId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/u.test(callId) || callIds.has(callId) || typeof alias !== 'string' || !ids.has(alias) || typeof args !== 'string') return failed();
              callIds.add(callId); calls.push({ id: callId, toolId: ids.get(alias)!, input: jsonValue(JSON.parse(args)) });
            } else if (item['type'] === 'message') {
              if (item['role'] !== 'assistant' || !Array.isArray(item['content'])) return failed();
              for (const rawContent of item['content']) {
                const content = object(rawContent);
                if (content['type'] === 'refusal') return failed('refused');
                if (content['type'] !== 'output_text' || typeof content['text'] !== 'string') return failed();
                text.push(content['text']);
              }
            } else return failed();
          }
          const accounting = { costMicros: knownCost };
          if (calls.length > 0) {
            const continuation = jsonValue({ provider: 'openai.responses.v1', model: name, consumed: request.messages.length, history: [...input, ...payload['output']] }, { maxBytes: maxRequestBytes });
            return { type: 'tool_calls', calls, usage: accounting, continuation };
          }
          if (text.length === 0) return failed();
          return { type: 'final', output: jsonValue(JSON.parse(text.join('')), { maxBytes: maxResponseBytes }), usage: accounting };
        } catch (error) {
          // Status texts, bodies, credentials and SDK messages are private; only Mayura's reasons leave the adapter.
          if (knownCost !== undefined) throw new ModelProviderError(reasonOf(error), { costMicros: knownCost });
          if (request.signal.aborted || controller.signal.aborted || consumer?.aborted) throw new MayuraError('CANCELLED', 'Provider request was cancelled or timed out.');
          if (error instanceof ModelProviderError) throw error;
          if (error instanceof MayuraError && error.code === 'INVALID_CONFIG') return failed('configuration');
          if (error instanceof APIConnectionError) return failed(error.cause instanceof ResponseTooLarge ? 'invalid_response' : 'unavailable');
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

