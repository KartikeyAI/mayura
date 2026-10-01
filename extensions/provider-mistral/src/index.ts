import { HTTPClient, Mistral } from '@mistralai/mistralai';
import { HTTPClientError, MistralError } from '@mistralai/mistralai/models/errors';
import { assertPositiveInteger, jsonValue, MayuraError, ModelProviderError, type JsonObject, type JsonValue, type Media, type MediaType, type ModelAdapter,
  type ModelDefinitionCheck, type ModelFailureReason, type ModelMediaCapability, type ModelMessage, type ModelProvider, type ModelRequest, type ModelResponse,
  type ModelStreamEvent, type ModelToolCall, type ProviderModelSettings } from 'mayura';
import { bytesToBase64, checkStrictDefinition, encodedMediaBytes, modelToolNames, providerEndpoint, providerHeaders, providerHttpFailure, streamModelCall, strictJsonSchema, tokenCostMicros } from 'mayura/core/host';
import { catalog } from './catalog.js';

export { catalog };

export interface MistralProviderOptions {
  /** Your Mistral API key. Required: the provider never reads keys, URLs or settings from the environment. */
  readonly apiKey: string;
  /**
   * Send requests here instead of https://api.mistral.ai, for example https://api.eu.mistral.ai to keep data in the
   * EU, or a gateway. It must be https.
   */
  readonly baseURL?: string;
  /** Extra headers, such as a gateway's credential. Treated as credentials. They cannot replace Authorization. */
  readonly headers?: Readonly<Record<string, string>>;
  /** What the models can see: PNG, JPEG, WebP and GIF images, as bytes or URLs (the default); `false` for none. */
  readonly media?: ModelMediaCapability | false;
  readonly maxRequestBytes?: number;
  readonly maxResponseBytes?: number;
  /** How long one call may take unless the registry sets `timeoutMs` (default 60 s). */
  readonly timeoutMs?: number;
  /** A trusted transport for tests or proxies. Never selected from model output. */
  readonly fetch?: typeof globalThis.fetch;
}

const MISTRAL_MEDIA: readonly MediaType[] = Object.freeze(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);
/** Mistral accepts only nine letters and digits as a tool call id; ids from elsewhere are renamed for the request. */
const MISTRAL_CALL_ID = /^[A-Za-z0-9]{9}$/u;

const failed = (reason: ModelFailureReason = 'invalid_response'): never => { throw new ModelProviderError(reason); };
const reasonOf = (error: unknown): ModelFailureReason => error instanceof ModelProviderError ? error.reason : 'invalid_response';
function object(value: JsonValue | undefined): JsonObject {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return failed();
  return value;
}
function integer(value: JsonValue | undefined): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) return failed();
  return value;
}
function mediaOption(value: ModelMediaCapability | false | undefined): ModelMediaCapability | undefined {
  if (value === false) return undefined;
  const capability = value ?? { types: MISTRAL_MEDIA, urls: true };
  if (!Array.isArray(capability.types) || capability.types.some(type => !MISTRAL_MEDIA.includes(type)) || typeof capability.urls !== 'boolean') {
    throw new MayuraError('INVALID_CONFIG', 'media must list PNG, JPEG, WebP or GIF images and say whether URLs are taken.');
  }
  return Object.freeze({ types: Object.freeze([...new Set(capability.types)] as MediaType[]), urls: capability.urls });
}

/** A response larger than the configured limit; reported as an unusable response. */
class ResponseTooLarge extends Error {}
const tooLarge = (error: unknown): boolean => {
  for (let cause = error, depth = 0; cause instanceof Error && depth < 4; cause = cause.cause, depth++) if (cause instanceof ResponseTooLarge) return true;
  return false;
};
/** The SDK's transport, bounded: no redirects, and a body larger than `limit` (four times that for a stream) fails. */
function boundedFetch(transport: () => typeof globalThis.fetch, limit: number): typeof globalThis.fetch {
  return async (input, init) => {
    const response = await transport()(new Request(input, { ...init, redirect: 'error' }));
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
/**
 * Removes the SDK's tracing hook, which reads MISTRAL_SDK_TELEMETRY and MISTRAL_OTLP_TRACES_ENDPOINT from the
 * environment and can export spans of every call. If the SDK changes so that the hook cannot be found, the provider
 * refuses to start rather than run with it.
 */
function withoutTracing(client: Mistral): Mistral {
  const hooks = client._options.hooks;
  const lists = hooks ? [hooks.sdkInitHooks, hooks.beforeCreateRequestHooks, hooks.beforeRequestHooks, hooks.afterSuccessHooks, hooks.afterErrorHooks] as unknown[][] : [];
  const tracing = (hook: unknown) => typeof hook === 'object' && hook !== null && (hook as { _mistralTracingHook?: unknown })._mistralTracingHook === true;
  if (lists.length === 0 || lists.some(list => !Array.isArray(list)) || !lists.some(list => list.some(tracing))) {
    throw new MayuraError('INVALID_CONFIG', 'mistral(): this version of @mistralai/mistralai cannot be run without its telemetry.');
  }
  for (const list of lists) for (let index = list.length - 1; index >= 0; index--) if (tracing(list[index])) list.splice(index, 1);
  return client;
}
/** The SDK logs every request, credentials included, when MISTRAL_DEBUG is set and no logger is given: this one drops them. */
const silent = Object.freeze({ group: () => undefined, groupEnd: () => undefined, log: () => undefined });

/** Image chunks: inline as a data URL, or a URL Mistral fetches. A named image is introduced by a text chunk. */
function mediaChunks(item: Media): JsonObject[] {
  if (!MISTRAL_MEDIA.includes(item.mediaType)) return failed('configuration');
  const chunk = { type: 'image_url', imageUrl: 'data' in item ? `data:${item.mediaType};base64,${bytesToBase64(item.data)}` : item.url };
  return item.name === undefined ? [chunk] : [{ type: 'text', text: `Image: ${item.name}` }, chunk];
}
/** One Mistral call id for every call id in the conversation: its own where it is valid, a fresh one otherwise. */
function callIdsFor(messages: readonly ModelMessage[]): ReadonlyMap<string, string> {
  const all = messages.flatMap(message => message.role === 'assistant' ? message.calls.map(call => call.id) : message.role === 'tool' ? [message.callId] : []);
  const ids = new Map<string, string>(); const used = new Set<string>();
  for (const id of all) if (MISTRAL_CALL_ID.test(id)) { ids.set(id, id); used.add(id); }
  let next = 0;
  for (const id of all) {
    if (ids.has(id)) continue;
    let alias: string;
    do alias = `m${(next++).toString(36).padStart(8, '0')}`; while (used.has(alias));
    ids.set(id, alias); used.add(alias);
  }
  return ids;
}
/** A thinking chunk as it is sent back: its text parts and signature only. */
function thinkingChunk(chunk: JsonObject): JsonObject {
  if (!Array.isArray(chunk['thinking'])) return failed();
  const text = chunk['thinking'].map(raw => { const part = object(raw); return part['type'] === 'text' && typeof part['text'] === 'string' ? part['text'] : ''; }).join('');
  return { type: 'thinking', thinking: [{ type: 'text', text }], ...(typeof chunk['signature'] === 'string' ? { signature: chunk['signature'] } : {}) };
}
/** The text of a message's content and its thinking, which is kept for the next call and never released. */
function contentOf(content: JsonValue | undefined): { text: string; thinking: JsonObject[] } {
  if (content === undefined || content === null) return { text: '', thinking: [] };
  if (typeof content === 'string') return { text: content, thinking: [] };
  if (!Array.isArray(content) || content.length > 256) return failed();
  let text = ''; const thinking: JsonObject[] = [];
  for (const raw of content) {
    const chunk = object(raw);
    if (chunk['type'] === 'text' && typeof chunk['text'] === 'string') text += chunk['text'];
    else if (chunk['type'] === 'thinking') thinking.push(thinkingChunk(chunk));
    else return failed();
  }
  return { text, thinking };
}

/** One of the model's own tool-call turns in this run: its thinking and the ids of its calls. */
type OwnTurn = { thinking: JsonObject[]; calls: string[] };
/** The conversation as Mistral messages (in the SDK's shape); `assistants` are the model's own earlier tool-call turns. */
function messagesFor(request: ModelRequest, aliases: ReadonlyMap<string, string>, assistants: readonly OwnTurn[]): JsonValue[] {
  const callIds = callIdsFor(request.messages);
  let turn = 0;
  return [{ role: 'system', content: request.instructions }, ...request.messages.map((message): JsonValue => {
    if (message.role === 'user') {
      const text = JSON.stringify(message.content);
      return { role: 'user', content: message.media?.length ? [{ type: 'text', text }, ...message.media.flatMap(mediaChunks)] : text };
    }
    if (message.role === 'tool') {
      const name = aliases.get(message.toolId); if (!name) return failed();
      const result = JSON.stringify(message.result);
      return { role: 'tool', toolCallId: callIds.get(message.callId)!, name, content: message.media?.length ? [{ type: 'text', text: result }, ...message.media.flatMap(mediaChunks)] : result };
    }
    const toolCalls = message.calls.map(call => {
      const name = aliases.get(call.toolId); if (!name) return failed();
      return { id: callIds.get(call.id)!, type: 'function', function: { name, arguments: JSON.stringify(call.input) } };
    });
    const own = assistants[turn++];
    if (own && (own.calls.length !== message.calls.length || own.calls.some((id, index) => id !== message.calls[index]!.id))) return failed();
    return { role: 'assistant', ...(own?.thinking.length ? { content: own.thinking } : {}), toolCalls };
  })];
}

/** Rebuilds the response a non-streamed call returns from a chat completion event stream, reporting text as it arrives. */
async function assemble(events: AsyncIterable<unknown>, maxResponseBytes: number, onDelta: (text: string) => void): Promise<JsonObject> {
  let usage: JsonValue | undefined; let finish: JsonValue = null; let text = ''; let thinking = ''; let signature: string | undefined;
  const calls: { id: JsonValue; name: JsonValue; json: string }[] = [];
  for await (const raw of events) {
    const data = object(object(jsonValue(JSON.parse(JSON.stringify(raw)) as JsonValue, { maxBytes: maxResponseBytes }))['data']);
    if (data['usage'] !== undefined && data['usage'] !== null) usage = data['usage'];
    if (!Array.isArray(data['choices'])) return failed();
    for (const rawChoice of data['choices']) {
      const choice = object(rawChoice); const delta = object(choice['delta']);
      if (choice['index'] !== 0) return failed();
      const content = delta['content'];
      for (const raw of typeof content === 'string' ? [{ type: 'text', text: content }] : Array.isArray(content) ? content : content == null ? [] : failed()) {
        const chunk = object(raw);
        if (chunk['type'] === 'text' && typeof chunk['text'] === 'string') { text += chunk['text']; if (chunk['text']) onDelta(chunk['text']); }
        else if (chunk['type'] === 'thinking') {
          const part = thinkingChunk(chunk);
          thinking += ((part['thinking'] as JsonObject[])[0]!['text'] as string);
          if (typeof part['signature'] === 'string') signature = part['signature'];
        } else return failed();
      }
      const toolCalls = delta['toolCalls'];
      for (const rawCall of Array.isArray(toolCalls) ? toolCalls : toolCalls == null ? [] : failed()) {
        const call = object(rawCall); const fn = object(call['function']);
        const index = typeof call['index'] === 'number' ? call['index'] : calls.length;
        if (!Number.isSafeInteger(index) || index < 0 || index > calls.length || calls.length >= 128) return failed();
        const entry = calls[index] ?? (calls[index] = { id: null, name: null, json: '' });
        // The SDK fills in a missing id with the text "null"; later deltas of a call carry none.
        if (typeof call['id'] === 'string' && call['id'] !== 'null') entry.id = call['id'];
        if (typeof fn['name'] === 'string' && fn['name']) entry.name = fn['name'];
        const args = fn['arguments'];
        if (typeof args === 'string') entry.json += args;
        else if (args && typeof args === 'object') entry.json = JSON.stringify(args);
      }
      if (choice['finishReason'] !== undefined && choice['finishReason'] !== null) finish = choice['finishReason'];
    }
  }
  if (usage === undefined || finish === null) return failed();
  const own = thinking ? [{ type: 'thinking', thinking: [{ type: 'text', text: thinking }], ...(signature === undefined ? {} : { signature }) }] : [];
  return { usage, choices: [{ index: 0, finishReason: finish, message: { role: 'assistant', content: [...own, { type: 'text', text }],
    toolCalls: calls.map(call => ({ id: call.id, function: { name: call.name, arguments: call.json } })) } }] };
}

/**
 * Mistral models for a Mayura model registry, through the official Mistral SDK and the Chat Completions API:
 *
 * ```ts
 * const models = createModels({ providers: [mistral({ apiKey })], prices: 'catalog', maxCallCostMicros: 50_000 });
 * const model = models.model('mistral/mistral-medium-3-5'); // granted as model:mistral/mistral-medium-3-5
 * ```
 *
 * Structured output and tool inputs use strict JSON Schema; streaming reports output text as it arrives; the model's
 * thinking is kept for the next call of the run and never released. The SDK's retries, debug logging and telemetry
 * are off, and nothing is read from the environment.
 */
export function mistral(options: MistralProviderOptions): ModelProvider {
  if (!options || typeof options.apiKey !== 'string' || !options.apiKey.trim() || /[\r\n]/u.test(options.apiKey) || options.apiKey.length > 4096) {
    throw new MayuraError('INVALID_CONFIG', 'mistral() needs an apiKey.');
  }
  const baseURL = options.baseURL === undefined ? 'https://api.mistral.ai' : providerEndpoint(options.baseURL, '', 'mistral()');
  const headers = providerHeaders(options.headers, ['Authorization'], 'mistral()');
  const maxRequestBytes = options.maxRequestBytes ?? 1_048_576; const maxResponseBytes = options.maxResponseBytes ?? 1_048_576;
  const defaultTimeout = options.timeoutMs ?? 60_000;
  for (const [value, name] of [[maxRequestBytes, 'maxRequestBytes'], [maxResponseBytes, 'maxResponseBytes'], [defaultTimeout, 'timeoutMs']] as const) assertPositiveInteger(value, name);
  const media = mediaOption(options.media);
  // Mayura owns retries and time limits: one SDK attempt per call, cancelled by Mayura's own signal.
  const noRetries = { strategy: 'none' } as const;
  const client = withoutTracing(new Mistral({
    apiKey: options.apiKey, serverURL: baseURL, retryConfig: noRetries, debugLogger: silent,
    httpClient: new HTTPClient({ fetcher: boundedFetch(() => options.fetch ?? globalThis.fetch, maxResponseBytes) }),
  }));
  const chat = client.chat;

  return Object.freeze({
    id: 'mistral',
    catalog,
    model(name: string, settings: ProviderModelSettings): ModelAdapter {
      if (typeof name !== 'string' || !name.trim() || name.length > 128) throw new MayuraError('INVALID_CONFIG', 'A Mistral model name is required.');
      const timeoutMs = settings.timeoutMs ?? defaultTimeout;

      const call = async (request: ModelRequest, onDelta?: (text: string) => void, consumer?: AbortSignal): Promise<ModelResponse> => {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        let knownCost: number | undefined;
        try {
          const signal = AbortSignal.any([request.signal, controller.signal, ...(consumer ? [consumer] : [])]);
          if (signal.aborted) throw new MayuraError('CANCELLED', 'Provider request was cancelled.');
          let assistants: OwnTurn[] = [];
          if (request.continuation !== undefined) {
            const previous = object(request.continuation);
            if (previous['provider'] !== 'mistral.chat.v1' || previous['model'] !== name || !Array.isArray(previous['assistants'])) return failed();
            assistants = previous['assistants'].map(raw => {
              const turn = object(raw);
              if (!Array.isArray(turn['thinking']) || !Array.isArray(turn['calls']) || turn['calls'].some(id => typeof id !== 'string')) return failed();
              return { thinking: turn['thinking'].map(chunk => thinkingChunk(object(chunk))), calls: turn['calls'] as string[] };
            });
          }
          if (assistants.length > request.messages.filter(message => message.role === 'assistant').length) return failed();
          assertPositiveInteger(request.maxOutputTokens, 'maxOutputTokens');
          const aliases = new Map(modelToolNames(request.tools.map(tool => tool.id)));
          const ids = new Map([...aliases].map(([toolId, alias]) => [alias, toolId]));
          if (aliases.size !== request.tools.length || aliases.size > 128) return failed();
          const tools = request.tools.map(tool => {
            if (!tool.inputJsonSchema) throw new MayuraError('INVALID_CONFIG', `Tool "${tool.id}" has no inputJsonSchema.`);
            return { type: 'function', function: { name: aliases.get(tool.id)!, description: tool.description, parameters: strictJsonSchema(tool.inputJsonSchema, `Tool "${tool.id}" input schema`), strict: true } };
          });
          const outputSchema = request.outputJsonSchema === undefined ? failed('configuration') : strictJsonSchema(request.outputJsonSchema, 'The output schema');
          const body: JsonObject = {
            model: name, maxTokens: request.maxOutputTokens,
            messages: messagesFor(request, aliases, assistants),
            responseFormat: { type: 'json_schema', jsonSchema: { name: 'output', schemaDefinition: outputSchema, strict: true } },
            ...(tools.length > 0 ? { tools, toolChoice: 'auto', parallelToolCalls: true } : {}),
          };
          jsonValue(body, { maxBytes: maxRequestBytes + encodedMediaBytes(request.messages) });

          const callOptions = { signal, headers, retries: noRetries };
          const payload = onDelta
            ? await assemble(await chat.stream({ ...body, stream: true } as never, callOptions), maxResponseBytes, onDelta)
            : object(jsonValue(JSON.parse(JSON.stringify(await chat.complete(body as never, callOptions))) as JsonValue, { maxBytes: maxResponseBytes * 2 }));

          const usage = object(payload['usage']);
          const inputTokens = integer(usage['promptTokens']); const outputTokens = integer(usage['completionTokens']);
          knownCost = tokenCostMicros(settings.pricing, inputTokens, outputTokens) ?? failed();
          const accounting = { costMicros: knownCost, inputTokens, outputTokens };
          if (!Array.isArray(payload['choices']) || payload['choices'].length !== 1) return failed();
          const choice = object(payload['choices'][0]); const message = object(choice['message']);
          const finish = choice['finishReason'];
          const { text, thinking } = contentOf(message['content']);
          const toolCalls = message['toolCalls'] ?? [];
          if (!Array.isArray(toolCalls)) return failed();
          if (finish === 'tool_calls' || (finish === 'stop' && toolCalls.length > 0)) {
            // Text before a tool call is narration, not an answer: it is dropped. Thinking is kept for the next call.
            const calls: ModelToolCall[] = []; const seen = new Set<string>();
            for (const raw of toolCalls) {
              const entry = object(raw); const fn = object(entry['function']);
              const callId = entry['id']; const alias = fn['name']; const args = fn['arguments'];
              if (typeof callId !== 'string' || callId === 'null' || !/^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/u.test(callId) || seen.has(callId) || typeof alias !== 'string' || !ids.has(alias)) return failed();
              const input = typeof args === 'string' ? JSON.parse(args || '{}') as JsonValue : args && typeof args === 'object' ? args : failed();
              seen.add(callId); calls.push({ id: callId, toolId: ids.get(alias)!, input: jsonValue(input, { maxBytes: maxResponseBytes }) });
            }
            if (calls.length === 0 || calls.length > 128) return failed();
            const continuation = jsonValue({ provider: 'mistral.chat.v1', model: name, assistants: [...assistants, { thinking, calls: calls.map(entry => entry.id) }] }, { maxBytes: maxRequestBytes });
            return { type: 'tool_calls', calls, usage: accounting, continuation };
          }
          // Output cut off by the token limit is not an answer.
          if (finish === 'length' || finish === 'model_length') return failed('refused');
          if (finish === 'error') return failed('unavailable');
          if (finish !== 'stop') return failed();
          return { type: 'final', output: jsonValue(JSON.parse(text) as JsonValue, { maxBytes: maxResponseBytes }), usage: accounting };
        } catch (error) {
          if (knownCost !== undefined) throw new ModelProviderError(reasonOf(error), { costMicros: knownCost });
          if (request.signal.aborted || controller.signal.aborted || consumer?.aborted) throw new MayuraError('CANCELLED', 'Provider request was cancelled or timed out.');
          if (error instanceof ModelProviderError) throw error;
          if (error instanceof MayuraError && error.code === 'INVALID_CONFIG') return failed('configuration');
          if (tooLarge(error)) return failed();
          // Every error response is a MistralError with its status; a 2xx one is a response the SDK could not read.
          if (error instanceof MistralError) { if (error.statusCode >= 400) throw providerHttpFailure(error.statusCode); return failed(); }
          if (error instanceof HTTPClientError) return failed('unavailable');
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
