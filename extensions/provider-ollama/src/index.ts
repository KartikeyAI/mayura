import { Ollama } from 'ollama/browser';
import { assertPositiveInteger, jsonValue, MayuraError, ModelProviderError, type JsonObject, type JsonValue, type Media, type MediaType, type ModelAdapter,
  type ModelDefinitionCheck, type ModelFailureReason, type ModelMediaCapability, type ModelMessage, type ModelProvider, type ModelRequest, type ModelResponse,
  type ModelStreamEvent, type ModelToolCall, type ProviderModelSettings } from 'mayura';
import { bytesToBase64, checkStrictDefinition, encodedMediaBytes, modelToolNames, providerHeaders, providerHttpFailure, streamModelCall, strictJsonSchema, tokenCostMicros } from 'mayura/core/host';

export interface OllamaProviderOptions {
  /**
   * The Ollama server: a loopback address over http (the default is http://127.0.0.1:11434), or any https URL, such as
   * https://ollama.com for Ollama's cloud models or a gateway.
   */
  readonly host?: string;
  /** An API key, sent as a bearer token. Required for https://ollama.com: the provider never reads OLLAMA_API_KEY. */
  readonly apiKey?: string;
  /** Extra headers, such as a gateway's credential. Treated as credentials. They cannot replace Authorization. */
  readonly headers?: Readonly<Record<string, string>>;
  /** Whether and how hard thinking models think. Leave it unset for a model that does not think. */
  readonly think?: boolean | 'low' | 'medium' | 'high';
  /** What the models can see. The default is nothing; give PNG or JPEG images (as bytes) for a vision model. */
  readonly media?: ModelMediaCapability | false;
  readonly maxRequestBytes?: number;
  readonly maxResponseBytes?: number;
  /** How long one call may take unless the registry sets `timeoutMs` (default 120 s, as a local model may need loading first). */
  readonly timeoutMs?: number;
  /** A trusted transport for tests or proxies. Never selected from model output. */
  readonly fetch?: typeof globalThis.fetch;
}

const OLLAMA_MEDIA: readonly MediaType[] = Object.freeze(['image/png', 'image/jpeg']);
const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);

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
  if (!Array.isArray(value.types) || value.types.length === 0 || value.types.some(type => !OLLAMA_MEDIA.includes(type)) || value.urls !== false) {
    throw new MayuraError('INVALID_CONFIG', 'media must list PNG or JPEG images, sent as bytes (urls: false).');
  }
  return Object.freeze({ types: Object.freeze([...new Set(value.types)] as MediaType[]), urls: false });
}
/** The server's base URL: http only on a loopback address, https anywhere; no credentials, query or fragment. */
function hostOf(value: unknown): string {
  if (value === undefined) return 'http://127.0.0.1:11434';
  let url: URL;
  try { url = new URL(typeof value === 'string' ? value : ''); } catch { throw new MayuraError('INVALID_CONFIG', 'ollama(): host must be an absolute URL.'); }
  if (!(url.protocol === 'https:' || (url.protocol === 'http:' && LOOPBACK.has(url.hostname))) || url.username || url.password || url.search || url.hash || url.href.length > 2_048) {
    throw new MayuraError('INVALID_CONFIG', 'ollama(): host must be http on a loopback address or https, without credentials, query or fragment.');
  }
  return url.href.replace(/\/+$/u, '');
}

/** A response larger than the configured limit; reported as an unusable response. */
class ResponseTooLarge extends Error {}
/** The server could not be reached, for example because Ollama is not running. */
class ConnectionFailure extends Error {}
/** An error status; its body, which may echo the request, is never read. */
class HttpFailure extends Error { constructor(readonly status: number) { super('HTTP failure'); } }
/**
 * One call's transport: cancelled by the call's signal (the SDK passes none for a non-streamed call), no redirects, an
 * error status reported without reading its body, and a body larger than `limit` (four times that for a stream) fails.
 */
function callFetch(transport: typeof globalThis.fetch, limit: number, signal: AbortSignal): typeof globalThis.fetch {
  return async (input, init) => {
    let response: Response;
    try {
      response = await transport(input, { ...init, signal: init?.signal ? AbortSignal.any([signal, init.signal]) : signal, redirect: 'error' });
    } catch (error) {
      if (signal.aborted) throw error;
      throw new ConnectionFailure('Ollama could not be reached.', { cause: error });
    }
    if (!response.ok) { void response.body?.cancel().catch(() => undefined); throw new HttpFailure(response.status); }
    const max = (response.headers.get('content-type') ?? '').includes('ndjson') ? limit * 4 : limit;
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

/** Images as base64, as Ollama takes them. */
function images(media: readonly Media[] | undefined): { images?: string[] } {
  if (!media?.length) return {};
  return { images: media.map(item => 'data' in item && OLLAMA_MEDIA.includes(item.mediaType) ? bytesToBase64(item.data) : failed('configuration')) };
}
/** Image names, which Ollama's image list cannot carry, follow the text. */
const withNames = (text: string, media: readonly Media[] | undefined): string => {
  const names = (media ?? []).flatMap(item => item.name === undefined ? [] : [item.name]);
  return names.length ? `${text}\n\nImages, in order: ${names.join(', ')}` : text;
};

/** One of the model's own tool-call turns in this run: its thinking and the ids given to its calls. */
type OwnTurn = { thinking: string | null; calls: string[] };
/** The conversation as Ollama chat messages; `assistants` are the model's own earlier tool-call turns. */
function messagesFor(request: ModelRequest, aliases: ReadonlyMap<string, string>, assistants: readonly OwnTurn[]): JsonValue[] {
  let turn = 0;
  return [{ role: 'system', content: request.instructions }, ...(request.messages as readonly ModelMessage[]).map((message): JsonValue => {
    if (message.role === 'user') return { role: 'user', content: withNames(JSON.stringify(message.content), message.media), ...images(message.media) };
    if (message.role === 'tool') {
      const name = aliases.get(message.toolId); if (!name) return failed();
      return { role: 'tool', tool_name: name, content: withNames(JSON.stringify(message.result), message.media), ...images(message.media) };
    }
    const toolCalls = message.calls.map(call => {
      const name = aliases.get(call.toolId); if (!name) return failed();
      return { function: { name, arguments: call.input } };
    });
    const own = assistants[turn++];
    if (own && (own.calls.length !== message.calls.length || own.calls.some((id, index) => id !== message.calls[index]!.id))) return failed();
    return { role: 'assistant', content: '', ...(own?.thinking ? { thinking: own.thinking } : {}), tool_calls: toolCalls };
  })];
}
/** Ids for a response's tool calls, which Ollama does not give: unique within the run. */
function callIds(request: ModelRequest, count: number): string[] {
  const used = new Set(request.messages.flatMap(message => message.role === 'assistant' ? message.calls.map(call => call.id) : message.role === 'tool' ? [message.callId] : []));
  const ids: string[] = [];
  for (let next = used.size + 1; ids.length < count; next++) if (!used.has(`call_${next}`)) ids.push(`call_${next}`);
  return ids;
}

/** Rebuilds the response a non-streamed call returns from Ollama's stream, reporting text as it arrives. */
async function assemble(chunks: AsyncIterable<unknown>, maxResponseBytes: number, onDelta: (text: string) => void): Promise<JsonObject> {
  let content = ''; let thinking = ''; const toolCalls: JsonValue[] = []; let last: JsonObject | undefined;
  try {
    for await (const raw of chunks) {
      const data = object(jsonValue(JSON.parse(JSON.stringify(raw)) as JsonValue, { maxBytes: maxResponseBytes }));
      const message = data['message'] === undefined ? {} : object(data['message']);
      if (typeof message['content'] === 'string' && message['content']) { content += message['content']; onDelta(message['content']); }
      if (typeof message['thinking'] === 'string') thinking += message['thinking'];
      if (Array.isArray(message['tool_calls'])) { toolCalls.push(...message['tool_calls']); if (toolCalls.length > 128) return failed(); }
      if (data['done'] === true) last = data;
    }
  } catch (error) {
    // The server reported an error mid-answer, or ended the stream without finishing it.
    if (error instanceof ModelProviderError || error instanceof ResponseTooLarge || error instanceof SyntaxError) throw error;
    return failed('unavailable');
  }
  if (!last) return failed();
  return { ...last, message: { role: 'assistant', content, ...(thinking ? { thinking } : {}), ...(toolCalls.length ? { tool_calls: toolCalls } : {}) } };
}

/**
 * Ollama models for a Mayura model registry, local or in Ollama's cloud, through the official Ollama SDK:
 *
 * ```ts
 * const models = createModels({
 *   providers: [ollama()],
 *   prices: { 'ollama/gpt-oss:20b': { inputMicrosPerMillionTokens: 0, outputMicrosPerMillionTokens: 0 } },
 *   maxCallCostMicros: 1,
 * });
 * const model = models.model('ollama/gpt-oss:20b'); // granted as model:ollama/gpt-oss:20b
 * ```
 *
 * Local models cost nothing, so there is no catalog: give each model's price, zero or your own. Structured output
 * and tool inputs use JSON Schema; streaming reports output text as it arrives; the model's thinking is kept for the
 * next call of the run and never released. Nothing is read from the environment or the file system.
 */
export function ollama(options: OllamaProviderOptions = {}): ModelProvider {
  if (!options || typeof options !== 'object') throw new MayuraError('INVALID_CONFIG', 'ollama() options must be an object.');
  const host = hostOf(options.host);
  if (options.apiKey !== undefined && (typeof options.apiKey !== 'string' || !options.apiKey.trim() || /[\r\n]/u.test(options.apiKey) || options.apiKey.length > 4096)) {
    throw new MayuraError('INVALID_CONFIG', 'ollama(): apiKey must be a non-empty string.');
  }
  // The SDK falls back to OLLAMA_API_KEY for ollama.com; the key must be given instead.
  if (new URL(host).hostname === 'ollama.com' && options.apiKey === undefined) throw new MayuraError('INVALID_CONFIG', 'ollama(): https://ollama.com needs an apiKey.');
  const headers = { ...providerHeaders(options.headers, ['Authorization', 'Accept', 'User-Agent'], 'ollama()'), ...(options.apiKey === undefined ? {} : { Authorization: `Bearer ${options.apiKey}` }) };
  if (options.think !== undefined && ![true, false, 'low', 'medium', 'high'].includes(options.think)) throw new MayuraError('INVALID_CONFIG', 'ollama(): think must be true, false, low, medium or high.');
  const maxRequestBytes = options.maxRequestBytes ?? 1_048_576; const maxResponseBytes = options.maxResponseBytes ?? 1_048_576;
  const defaultTimeout = options.timeoutMs ?? 120_000;
  for (const [value, name] of [[maxRequestBytes, 'maxRequestBytes'], [maxResponseBytes, 'maxResponseBytes'], [defaultTimeout, 'timeoutMs']] as const) assertPositiveInteger(value, name);
  const media = mediaOption(options.media);

  return Object.freeze({
    id: 'ollama',
    model(name: string, settings: ProviderModelSettings): ModelAdapter {
      if (typeof name !== 'string' || !name.trim() || name.length > 128) throw new MayuraError('INVALID_CONFIG', 'An Ollama model name is required.');
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
            if (previous['provider'] !== 'ollama.chat.v1' || previous['model'] !== name || !Array.isArray(previous['assistants'])) return failed();
            assistants = previous['assistants'].map(raw => {
              const turn = object(raw);
              if ((turn['thinking'] !== null && typeof turn['thinking'] !== 'string') || !Array.isArray(turn['calls']) || turn['calls'].some(id => typeof id !== 'string')) return failed();
              return { thinking: turn['thinking'], calls: turn['calls'] as string[] };
            });
          }
          if (assistants.length > request.messages.filter(message => message.role === 'assistant').length) return failed();
          assertPositiveInteger(request.maxOutputTokens, 'maxOutputTokens');
          const aliases = new Map(modelToolNames(request.tools.map(tool => tool.id)));
          const ids = new Map([...aliases].map(([toolId, alias]) => [alias, toolId]));
          if (aliases.size !== request.tools.length || aliases.size > 128) return failed();
          const tools = request.tools.map(tool => {
            if (!tool.inputJsonSchema) throw new MayuraError('INVALID_CONFIG', `Tool "${tool.id}" has no inputJsonSchema.`);
            return { type: 'function', function: { name: aliases.get(tool.id)!, description: tool.description, parameters: strictJsonSchema(tool.inputJsonSchema, `Tool "${tool.id}" input schema`) } };
          });
          const outputSchema = request.outputJsonSchema === undefined ? failed('configuration') : strictJsonSchema(request.outputJsonSchema, 'The output schema');
          // A format constrains a reply to the answer, which leaves no way to call a tool. So with tools, the model first
          // answers freely; once it calls no more tools, one more call without tools asks for the answer in the format.
          const messages = messagesFor(request, aliases, assistants);
          const common = { model: name, messages, options: { num_predict: request.maxOutputTokens }, ...(options.think === undefined ? {} : { think: options.think }) };
          const body: JsonObject = tools.length > 0 ? { ...common, tools } : { ...common, format: outputSchema };
          jsonValue(body, { maxBytes: maxRequestBytes + encodedMediaBytes(request.messages) });

          // A client per call, so the call's signal reaches every request it makes.
          const client = new Ollama({ host, headers, fetch: callFetch(options.fetch ?? globalThis.fetch, maxResponseBytes, signal) });
          const chat = async (request: JsonObject, stream: ((text: string) => void) | undefined): Promise<JsonObject> => {
            const payload = stream
              ? await assemble(await client.chat({ ...request, stream: true } as never) as unknown as AsyncIterable<unknown>, maxResponseBytes, stream)
              : object(jsonValue(JSON.parse(JSON.stringify(await client.chat({ ...request, stream: false } as never))) as JsonValue, { maxBytes: maxResponseBytes * 2 }));
            // Ollama leaves out the prompt count when the whole prompt was cached.
            const cost = tokenCostMicros(settings.pricing, payload['prompt_eval_count'] === undefined ? 0 : integer(payload['prompt_eval_count']), integer(payload['eval_count'])) ?? failed();
            knownCost = (knownCost ?? 0) + cost;
            if (payload['done'] !== true) return failed();
            return payload;
          };
          const finalFrom = (payload: JsonObject): ModelResponse => {
            const message = object(payload['message']); const finish = payload['done_reason'];
            // Output cut off by the token limit is not an answer.
            if (finish === 'length') return failed('refused');
            if (finish !== 'stop' || typeof message['content'] !== 'string' || (Array.isArray(message['tool_calls']) && message['tool_calls'].length > 0)) return failed();
            return { type: 'final', output: jsonValue(JSON.parse(message['content']) as JsonValue, { maxBytes: maxResponseBytes }), usage: { costMicros: knownCost! } };
          };
          if (tools.length === 0) return finalFrom(await chat(body, onDelta));

          // The free reply is never streamed: it may be prose, which is not the answer.
          const payload = await chat(body, onDelta ? () => undefined : undefined);
          const message = object(payload['message']); const finish = payload['done_reason'];
          const toolCalls = message['tool_calls'] ?? [];
          if (!Array.isArray(toolCalls) || toolCalls.length > 128) return failed();
          if (toolCalls.length > 0 && finish === 'stop') {
            const given = callIds(request, toolCalls.length);
            const calls: ModelToolCall[] = toolCalls.map((raw, index) => {
              const fn = object(object(raw)['function']); const alias = fn['name']; const args = fn['arguments'];
              if (typeof alias !== 'string' || !ids.has(alias)) return failed();
              const input = typeof args === 'string' ? JSON.parse(args || '{}') as JsonValue : args === undefined ? {} : object(args);
              return { id: given[index]!, toolId: ids.get(alias)!, input: jsonValue(input, { maxBytes: maxResponseBytes }) };
            });
            const thinking = typeof message['thinking'] === 'string' && message['thinking'] ? message['thinking'] : null;
            const continuation = jsonValue({ provider: 'ollama.chat.v1', model: name, assistants: [...assistants, { thinking, calls: calls.map(entry => entry.id) }] }, { maxBytes: maxRequestBytes });
            return { type: 'tool_calls', calls, usage: { costMicros: knownCost! }, continuation };
          }
          if (finish === 'length') return failed('refused');
          if (finish !== 'stop') return failed();
          return finalFrom(await chat({ ...common, format: outputSchema }, onDelta));
        } catch (error) {
          if (knownCost !== undefined) throw new ModelProviderError(reasonOf(error), { costMicros: knownCost });
          if (request.signal.aborted || controller.signal.aborted || consumer?.aborted) throw new MayuraError('CANCELLED', 'Provider request was cancelled or timed out.');
          if (error instanceof ModelProviderError) throw error;
          if (error instanceof MayuraError && error.code === 'INVALID_CONFIG') return failed('configuration');
          if (error instanceof HttpFailure) throw providerHttpFailure(error.status);
          if (error instanceof ConnectionFailure) return failed('unavailable');
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
