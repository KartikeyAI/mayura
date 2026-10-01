import { APIConnectionError, APIError, Groq } from 'groq-sdk';
import { assertPositiveInteger, jsonValue, MayuraError, ModelProviderError, type JsonObject, type JsonValue, type Media, type MediaType, type ModelAdapter,
  type ModelDefinitionCheck, type ModelFailureReason, type ModelMediaCapability, type ModelMessage, type ModelProvider, type ModelRequest, type ModelResponse,
  type ModelStreamEvent, type ModelToolCall, type ProviderModelSettings } from 'mayura';
import { bytesToBase64, checkStrictDefinition, encodedMediaBytes, modelToolNames, providerEndpoint, providerHeaders, providerHttpFailure, streamModelCall, strictJsonSchema, tokenCostMicros } from 'mayura/core/host';
import { catalog } from './catalog.js';

export { catalog };

export interface GroqProviderOptions {
  /** Your Groq API key. Required: the provider never reads keys, URLs or headers from the environment. */
  readonly apiKey: string;
  /** Send requests here instead of https://api.groq.com, for example through a gateway. It must be https. */
  readonly baseURL?: string;
  /** Extra headers, such as a gateway's credential. Treated as credentials. They cannot replace Authorization. */
  readonly headers?: Readonly<Record<string, string>>;
  /**
   * What the models can see. The default is nothing, as most Groq models read only text; give PNG, JPEG, WebP or GIF
   * images (as bytes, or also URLs) for a vision model.
   */
  readonly media?: ModelMediaCapability | false;
  readonly maxRequestBytes?: number;
  readonly maxResponseBytes?: number;
  /** How long one call may take unless the registry sets `timeoutMs` (default 60 s). */
  readonly timeoutMs?: number;
  /** A trusted transport for tests or proxies. Never selected from model output. */
  readonly fetch?: typeof globalThis.fetch;
}

const GROQ_MEDIA: readonly MediaType[] = Object.freeze(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);

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
  if (value === undefined || value === false) return undefined;
  if (!Array.isArray(value.types) || value.types.length === 0 || value.types.some(type => !GROQ_MEDIA.includes(type)) || typeof value.urls !== 'boolean') {
    throw new MayuraError('INVALID_CONFIG', 'media must list PNG, JPEG, WebP or GIF images and say whether URLs are taken.');
  }
  return Object.freeze({ types: Object.freeze([...new Set(value.types)] as MediaType[]), urls: value.urls });
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
/**
 * The SDK always merges GROQ_CUSTOM_HEADERS from the environment into every request's headers. This puts back exactly
 * the headers the provider was given; if the SDK changes so that this cannot be done, the provider refuses to start.
 */
function withoutEnvironmentHeaders(client: Groq, headers: Readonly<Record<string, string>>): Groq {
  const holder = client as unknown as { _options?: unknown };
  if (!holder._options || typeof holder._options !== 'object' || !('defaultHeaders' in holder._options || 'apiKey' in holder._options)) {
    throw new MayuraError('INVALID_CONFIG', 'groq(): this version of groq-sdk cannot be run without its environment headers.');
  }
  holder._options = { ...holder._options, defaultHeaders: { ...headers } };
  return client;
}
const silent = Object.freeze({ error: () => undefined, warn: () => undefined, info: () => undefined, debug: () => undefined });

/** Image parts: inline as a data URL, or a URL Groq fetches. A named image is introduced by a text part. */
function mediaParts(item: Media): JsonObject[] {
  if (!GROQ_MEDIA.includes(item.mediaType)) return failed('configuration');
  const part = { type: 'image_url', image_url: { url: 'data' in item ? `data:${item.mediaType};base64,${bytesToBase64(item.data)}` : item.url } };
  return item.name === undefined ? [part] : [{ type: 'text', text: `Image: ${item.name}` }, part];
}

/** One of the model's own tool-call turns in this run: its reasoning and the ids of its calls. */
type OwnTurn = { reasoning: string | null; calls: string[] };
/**
 * The conversation as chat messages; `assistants` are the model's own earlier tool-call turns. Tool results carry only
 * text, so images from a run of tool results follow it in one user message.
 */
function messagesFor(request: ModelRequest, aliases: ReadonlyMap<string, string>, assistants: readonly OwnTurn[]): JsonValue[] {
  const messages: JsonValue[] = [{ role: 'system', content: request.instructions }];
  let pending: JsonObject[] = []; let turn = 0;
  const flush = () => { if (pending.length) messages.push({ role: 'user', content: [{ type: 'text', text: 'Images from the tool results above:' }, ...pending] }); pending = []; };
  for (const message of request.messages as readonly ModelMessage[]) {
    if (message.role === 'tool') {
      messages.push({ role: 'tool', tool_call_id: message.callId, content: JSON.stringify(message.result) });
      pending.push(...(message.media ?? []).flatMap(mediaParts));
      continue;
    }
    flush();
    if (message.role === 'user') {
      const text = JSON.stringify(message.content);
      messages.push({ role: 'user', content: message.media?.length ? [{ type: 'text', text }, ...message.media.flatMap(mediaParts)] : text });
      continue;
    }
    const toolCalls = message.calls.map(call => {
      const name = aliases.get(call.toolId); if (!name) return failed();
      return { id: call.id, type: 'function', function: { name, arguments: JSON.stringify(call.input) } };
    });
    const own = assistants[turn++];
    if (own && (own.calls.length !== message.calls.length || own.calls.some((id, index) => id !== message.calls[index]!.id))) return failed();
    messages.push({ role: 'assistant', ...(own?.reasoning ? { reasoning: own.reasoning } : {}), tool_calls: toolCalls });
  }
  flush();
  return messages;
}

/** Rebuilds the response a non-streamed call returns from a chat completion stream, reporting text as it arrives. */
async function assemble(chunks: AsyncIterable<unknown>, maxResponseBytes: number, onDelta: (text: string) => void): Promise<JsonObject> {
  let usage: JsonValue | undefined; let finish: JsonValue = null; let content = ''; let reasoning = ''; let refusal = '';
  const calls: { id: JsonValue; name: string; json: string }[] = [];
  for await (const raw of chunks) {
    const data = object(jsonValue(JSON.parse(JSON.stringify(raw)) as JsonValue, { maxBytes: maxResponseBytes }));
    const groq = data['x_groq'] === undefined || data['x_groq'] === null ? {} : object(data['x_groq']);
    if (groq['error'] !== undefined && groq['error'] !== null) return failed('unavailable');
    for (const found of [groq['usage'], data['usage']]) if (found !== undefined && found !== null) usage = found;
    if (!Array.isArray(data['choices'])) return failed();
    for (const rawChoice of data['choices']) {
      const choice = object(rawChoice); const delta = object(choice['delta']);
      if (choice['index'] !== 0) return failed();
      if (typeof delta['content'] === 'string' && delta['content']) { content += delta['content']; onDelta(delta['content']); }
      if (typeof delta['reasoning'] === 'string') reasoning += delta['reasoning'];
      if (typeof delta['refusal'] === 'string') refusal += delta['refusal'];
      const toolCalls = delta['tool_calls'];
      for (const rawCall of Array.isArray(toolCalls) ? toolCalls : toolCalls == null ? [] : failed()) {
        const call = object(rawCall); const fn = call['function'] == null ? {} : object(call['function']);
        const index = call['index'];
        if (typeof index !== 'number' || !Number.isSafeInteger(index) || index < 0 || index > calls.length || calls.length >= 128) return failed();
        const entry = calls[index] ?? (calls[index] = { id: null, name: '', json: '' });
        if (typeof call['id'] === 'string') entry.id = call['id'];
        if (typeof fn['name'] === 'string' && fn['name']) entry.name = fn['name'];
        if (typeof fn['arguments'] === 'string') entry.json += fn['arguments'];
      }
      if (choice['finish_reason'] !== undefined && choice['finish_reason'] !== null) finish = choice['finish_reason'];
    }
  }
  if (usage === undefined || finish === null) return failed();
  return { usage, choices: [{ index: 0, finish_reason: finish, message: { role: 'assistant', content, ...(reasoning ? { reasoning } : {}), ...(refusal ? { refusal } : {}),
    ...(calls.length ? { tool_calls: calls.map(call => ({ id: call.id, type: 'function', function: { name: call.name, arguments: call.json } })) } : {}) } }] };
}

/**
 * Groq models for a Mayura model registry, through the official Groq SDK and its Chat Completions API:
 *
 * ```ts
 * const models = createModels({ providers: [groq({ apiKey })], prices: 'catalog', maxCallCostMicros: 20_000 });
 * const model = models.model('groq/openai/gpt-oss-120b'); // granted as model:groq/openai/gpt-oss-120b
 * ```
 *
 * Structured output and tool inputs use strict JSON Schema, so use a model that supports strict structured outputs;
 * streaming reports output text as it arrives; the model's reasoning is kept for the next call of the run and never
 * released. The SDK's retries and logging are off, and nothing is read from the environment.
 */
export function groq(options: GroqProviderOptions): ModelProvider {
  if (!options || typeof options.apiKey !== 'string' || !options.apiKey.trim() || /[\r\n]/u.test(options.apiKey) || options.apiKey.length > 4096) {
    throw new MayuraError('INVALID_CONFIG', 'groq() needs an apiKey.');
  }
  const baseURL = options.baseURL === undefined ? 'https://api.groq.com' : providerEndpoint(options.baseURL, '', 'groq()').replace(/\/+$/u, '');
  const headers = providerHeaders(options.headers, ['Authorization'], 'groq()');
  const maxRequestBytes = options.maxRequestBytes ?? 1_048_576; const maxResponseBytes = options.maxResponseBytes ?? 1_048_576;
  const defaultTimeout = options.timeoutMs ?? 60_000;
  for (const [value, name] of [[maxRequestBytes, 'maxRequestBytes'], [maxResponseBytes, 'maxResponseBytes'], [defaultTimeout, 'timeoutMs']] as const) assertPositiveInteger(value, name);
  const media = mediaOption(options.media);
  const client = withoutEnvironmentHeaders(new Groq({
    apiKey: options.apiKey, baseURL, defaultHeaders: headers, logLevel: 'off', logger: silent,
    // Mayura owns retries and time limits: one SDK attempt per call, and the SDK's own timer never fires first.
    maxRetries: 0, timeout: 2_147_483_647,
    fetch: boundedFetch(() => options.fetch ?? globalThis.fetch, maxResponseBytes),
  }), headers);

  return Object.freeze({
    id: 'groq',
    catalog,
    model(name: string, settings: ProviderModelSettings): ModelAdapter {
      if (typeof name !== 'string' || !name.trim() || name.length > 128) throw new MayuraError('INVALID_CONFIG', 'A Groq model name is required.');
      const timeoutMs = settings.timeoutMs ?? defaultTimeout;

      const call = async (request: ModelRequest, onDelta?: (text: string) => void, consumer?: AbortSignal): Promise<ModelResponse> => {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        let knownCost: number | undefined; let inputTokens = 0; let outputTokens = 0;
        try {
          const signal = AbortSignal.any([request.signal, controller.signal, ...(consumer ? [consumer] : [])]);
          if (signal.aborted) throw new MayuraError('CANCELLED', 'Provider request was cancelled.');
          let assistants: OwnTurn[] = [];
          if (request.continuation !== undefined) {
            const previous = object(request.continuation);
            if (previous['provider'] !== 'groq.chat.v1' || previous['model'] !== name || !Array.isArray(previous['assistants'])) return failed();
            assistants = previous['assistants'].map(raw => {
              const turn = object(raw);
              if ((turn['reasoning'] !== null && typeof turn['reasoning'] !== 'string') || !Array.isArray(turn['calls']) || turn['calls'].some(id => typeof id !== 'string')) return failed();
              return { reasoning: turn['reasoning'], calls: turn['calls'] as string[] };
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
          // Groq refuses a response format beside tools. So with tools, the model first answers freely; once it calls no
          // more tools, one more call without tools asks for the answer in the strict format.
          const messages = messagesFor(request, aliases, assistants);
          const format = { response_format: { type: 'json_schema', json_schema: { name: 'output', schema: outputSchema, strict: true } } };
          const body: JsonObject = { model: name, max_completion_tokens: request.maxOutputTokens, messages,
            ...(tools.length > 0 ? { tools, tool_choice: 'auto', parallel_tool_calls: true } : format) };
          jsonValue(body, { maxBytes: maxRequestBytes + encodedMediaBytes(request.messages) });

          const chat = async (request: JsonObject, stream: ((text: string) => void) | undefined): Promise<{ message: JsonObject; finish: JsonValue | undefined }> => {
            const payload = stream
              ? await assemble(await client.chat.completions.create({ ...request, stream: true } as never, { signal }) as unknown as AsyncIterable<unknown>, maxResponseBytes, stream)
              : object(jsonValue(JSON.parse(JSON.stringify(await client.chat.completions.create(request as never, { signal }))) as JsonValue, { maxBytes: maxResponseBytes * 2 }));
            // Reasoning tokens are part of the completion tokens; cached prompt tokens are charged at the full rate.
            const usage = object(payload['usage']);
            const prompt = integer(usage['prompt_tokens']); const completion = integer(usage['completion_tokens']);
            knownCost = (knownCost ?? 0) + (tokenCostMicros(settings.pricing, prompt, completion) ?? failed());
            inputTokens += prompt; outputTokens += completion;
            if (!Array.isArray(payload['choices']) || payload['choices'].length !== 1) return failed();
            const choice = object(payload['choices'][0]); const message = object(choice['message']);
            if (typeof message['refusal'] === 'string' && message['refusal']) return failed('refused');
            return { message, finish: choice['finish_reason'] };
          };
          const finalFrom = ({ message, finish }: { message: JsonObject; finish: JsonValue | undefined }): ModelResponse => {
            // Output cut off by the token limit is not an answer.
            if (finish === 'length') return failed('refused');
            if (finish !== 'stop' || typeof message['content'] !== 'string' || (Array.isArray(message['tool_calls']) && message['tool_calls'].length > 0)) return failed();
            return { type: 'final', output: jsonValue(JSON.parse(message['content']) as JsonValue, { maxBytes: maxResponseBytes }), usage: { costMicros: knownCost!, inputTokens, outputTokens } };
          };
          if (tools.length === 0) return finalFrom(await chat(body, onDelta));

          // The free reply is never streamed: it may be prose, which is not the answer.
          const { message, finish } = await chat(body, onDelta ? () => undefined : undefined);
          const toolCalls = message['tool_calls'] ?? [];
          if (!Array.isArray(toolCalls)) return failed();
          if (finish === 'tool_calls' || (finish === 'stop' && toolCalls.length > 0)) {
            // Text before a tool call is narration, not an answer: it is dropped. Reasoning is kept for the next call.
            const calls: ModelToolCall[] = []; const seen = new Set<string>();
            for (const raw of toolCalls) {
              const entry = object(raw); const fn = object(entry['function']);
              const callId = entry['id']; const alias = fn['name']; const args = fn['arguments'];
              if (entry['type'] !== undefined && entry['type'] !== 'function') return failed();
              if (typeof callId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/u.test(callId) || seen.has(callId) || typeof alias !== 'string' || !ids.has(alias) || typeof args !== 'string') return failed();
              seen.add(callId); calls.push({ id: callId, toolId: ids.get(alias)!, input: jsonValue(JSON.parse(args || '{}') as JsonValue, { maxBytes: maxResponseBytes }) });
            }
            if (calls.length === 0 || calls.length > 128) return failed();
            const reasoning = typeof message['reasoning'] === 'string' && message['reasoning'] ? message['reasoning'] : null;
            const continuation = jsonValue({ provider: 'groq.chat.v1', model: name, assistants: [...assistants, { reasoning, calls: calls.map(entry => entry.id) }] }, { maxBytes: maxRequestBytes });
            return { type: 'tool_calls', calls, usage: { costMicros: knownCost!, inputTokens, outputTokens }, continuation };
          }
          if (finish === 'length') return failed('refused');
          if (finish !== 'stop') return failed();
          const { tools: _tools, tool_choice: _choice, parallel_tool_calls: _parallel, ...plain } = body;
          return finalFrom(await chat({ ...plain, ...format }, onDelta));
        } catch (error) {
          if (knownCost !== undefined) throw new ModelProviderError(reasonOf(error), { costMicros: knownCost });
          if (request.signal.aborted || controller.signal.aborted || consumer?.aborted) throw new MayuraError('CANCELLED', 'Provider request was cancelled or timed out.');
          if (error instanceof ModelProviderError) throw error;
          if (error instanceof MayuraError && error.code === 'INVALID_CONFIG') return failed('configuration');
          if (error instanceof APIConnectionError) return failed(error.cause instanceof ResponseTooLarge ? 'invalid_response' : 'unavailable');
          if (error instanceof APIError) {
            // Groq answers 498 when a flex-tier model is over capacity: the provider is unavailable, as for a 5xx.
            if (error.status === 498) throw new ModelProviderError('unavailable', { httpStatus: 498 });
            // An error event inside a stream has no status: the provider failed mid-answer.
            if (typeof error.status !== 'number') return failed('unavailable');
            // Groq answers 400 when the model itself wrote a tool call or answer it cannot parse: an unusable response.
            const body = error.error && typeof error.error === 'object' ? error.error as { code?: unknown; error?: { code?: unknown } } : undefined;
            const code = body?.error?.code ?? body?.code;
            if (error.status === 400 && (code === 'tool_use_failed' || code === 'output_parse_failed')) return failed('invalid_response');
            throw providerHttpFailure(error.status);
          }
          if (error instanceof ResponseTooLarge) return failed();
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
