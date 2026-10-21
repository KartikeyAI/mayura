import { ApiError, GoogleGenAI } from '@google/genai';
import { assertPositiveInteger, jsonValue, MayuraError, ModelProviderError, type JsonObject, type JsonValue, type Media, type MediaType, type ModelAdapter,
  type ModelDefinitionCheck, type ModelFailureReason, type ModelHistoryMessage, type ModelMediaCapability, type ModelMessage, type ModelProvider, type ModelRequest, type ModelResponse,
  type ModelStreamEvent, type ModelToolCall, type ProviderModelSettings } from 'mayura';
import { bytesToBase64, checkStrictDefinition, encodedMediaBytes, modelToolNames, providerEndpoint, providerHeaders, providerHttpFailure, streamModelCall, strictJsonSchema, tokenCostMicros } from 'mayura/core/host';
import { catalog } from './catalog.js';

export { catalog };

export interface GoogleProviderOptions {
  /** Your Gemini API key. Required: the provider never reads keys, projects or URLs from the environment. */
  readonly apiKey: string;
  /** Send requests here instead of https://generativelanguage.googleapis.com, for example through a gateway. It must be https. */
  readonly baseURL?: string;
  /** Extra headers, such as a gateway's credential. Treated as credentials. They cannot replace x-goog-api-key. */
  readonly headers?: Readonly<Record<string, string>>;
  /** What the models can see, as inline bytes. The default is PNG, JPEG, WebP and PDF; `false` for none. */
  readonly media?: ModelMediaCapability | false;
  readonly maxRequestBytes?: number;
  readonly maxResponseBytes?: number;
  /** How long one call may take unless the registry sets `timeoutMs` (default 60 s). */
  readonly timeoutMs?: number;
  /** A trusted transport for tests or proxies. Never selected from model output. */
  readonly fetch?: typeof globalThis.fetch;
}

const GEMINI_MEDIA: readonly MediaType[] = Object.freeze(['image/png', 'image/jpeg', 'image/webp', 'application/pdf']);
/** Finish reasons meaning the model declined, was stopped by a filter, or ran out of output tokens. */
const REFUSED = new Set(['MAX_TOKENS', 'SAFETY', 'RECITATION', 'BLOCKLIST', 'PROHIBITED_CONTENT', 'SPII', 'IMAGE_SAFETY', 'LANGUAGE']);

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
  const capability = value ?? { types: GEMINI_MEDIA, urls: false };
  if (!Array.isArray(capability.types) || capability.types.some(type => !GEMINI_MEDIA.includes(type)) || capability.urls !== false) {
    throw new MayuraError('INVALID_CONFIG', 'media must list PNG, JPEG, WebP or PDF, sent as bytes (urls: false).');
  }
  return Object.freeze({ types: Object.freeze([...new Set(capability.types)] as MediaType[]), urls: false });
}

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

const mediaPart = (item: Media): JsonValue => 'data' in item ? { inlineData: { mimeType: item.mediaType, data: bytesToBase64(item.data) } } : failed('configuration');
/**
 * The conversation as Gemini contents. `turns` are the model's own earlier tool-call turns in this run (their parts,
 * thought signatures included), which Gemini needs back unchanged. Consecutive tool results share one user turn.
 */
function contentsFor(messages: readonly ModelMessage[], aliases: ReadonlyMap<string, string>, turns: readonly JsonObject[][]): JsonValue[] {
  const contents: JsonObject[] = []; let turn = 0; let own: readonly JsonObject[] | undefined;
  for (const message of messages) {
    if (message.role === 'user') {
      contents.push({ role: 'user', parts: [{ text: JSON.stringify(message.content) }, ...(message.media ?? []).map(mediaPart)] });
    } else if (message.role === 'assistant') {
      own = turns[turn++];
      const calls = message.calls.map(call => {
        const name = aliases.get(call.toolId); if (!name) return failed();
        return { functionCall: { id: call.id, name, args: call.input } };
      });
      if (own) {
        const ownCalls = own.filter(part => part['functionCall'] !== undefined);
        if (ownCalls.length !== calls.length) return failed();
        contents.push({ role: 'model', parts: [...own] });
      } else contents.push({ role: 'model', parts: calls });
    } else {
      const name = aliases.get(message.toolId); if (!name) return failed();
      // Echo the call's id only when Gemini gave it one.
      const hadId = own?.some(part => (part['functionCall'] as JsonObject | undefined)?.['id'] === message.callId) ?? true;
      const response = { functionResponse: { ...(hadId ? { id: message.callId } : {}), name, response: { output: message.result } } };
      const previous = contents.at(-1);
      const parts = [response, ...(message.media ?? []).map(mediaPart)];
      if (previous && previous['role'] === 'user' && Array.isArray(previous['parts']) && (previous['parts'] as JsonObject[]).some(part => part['functionResponse'] !== undefined)) {
        (previous['parts'] as JsonValue[]).push(...parts);
      } else contents.push({ role: 'user', parts });
    }
  }
  return contents;
}

/**
 * The history as Gemini contents, in the encoding this run's own turns use. It has no thoughts or signatures: Gemini
 * validates signatures only in the current turn, which starts at the run's own user message, after the history.
 */
function historyContents(history: readonly ModelHistoryMessage[], names: ReadonlyMap<string, string>): JsonObject[] {
  return history.map((message): JsonObject => {
    if ('media' in message && message.media?.length) return failed('configuration');
    if (message.role === 'user') return { role: 'user', parts: [{ text: JSON.stringify(message.content) }] };
    if (message.role === 'tool') return { role: 'user', parts: [{ functionResponse: { id: message.callId, name: names.get(message.toolId)!, response: { output: message.result } } }] };
    if ('output' in message) return { role: 'model', parts: [{ text: JSON.stringify(message.output) }] };
    return { role: 'model', parts: message.calls.map(call => ({ functionCall: { id: call.id, name: names.get(call.toolId)!, args: call.input } })) };
  });
}
/**
 * Contents in the order Gemini accepts: consecutive turns of one role share a turn (a function call turn must follow a
 * user or function response turn), and a conversation that would start with the model starts with a user turn holding
 * `null`, the JSON for no input, since the history may begin with an earlier answer.
 */
function alternating(contents: readonly JsonObject[]): JsonObject[] {
  const result: JsonObject[] = [];
  for (const content of contents) {
    const previous = result.at(-1);
    if (previous && previous['role'] === content['role']) result[result.length - 1] = { ...previous, parts: [...previous['parts'] as JsonValue[], ...content['parts'] as JsonValue[]] };
    else result.push(content);
  }
  if (result[0]?.['role'] === 'model') result.unshift({ role: 'user', parts: [{ text: 'null' }] });
  return result;
}
/** The call ids already in the conversation, the history's and this run's, which a new call's id must not repeat. */
function takenCallIds(request: ModelRequest): Set<string> {
  return new Set([...request.history ?? [], ...request.messages].flatMap(message => message.role === 'assistant' && 'calls' in message ? message.calls.map(call => call.id) : []));
}
/** Tool names for the history: this run's tools keep their names, and a tool only the history used gets its own. */
function historyToolNames(request: ModelRequest): ReadonlyMap<string, string> {
  const used = (request.history ?? []).flatMap(message => message.role === 'assistant' && 'calls' in message ? message.calls.map(call => call.toolId) : message.role === 'tool' ? [message.toolId] : []);
  return modelToolNames([...new Set([...request.tools.map(tool => tool.id), ...used])]);
}

/** Joins streamed chunks into one response: text parts are concatenated, other parts kept whole, usage from the last. */
function joined(chunks: readonly JsonObject[]): JsonObject {
  const parts: JsonObject[] = []; let finishReason: JsonValue = null; let usage: JsonValue | undefined; let feedback: JsonValue | undefined;
  for (const chunk of chunks) {
    if (chunk['usageMetadata'] !== undefined) usage = chunk['usageMetadata'];
    if (chunk['promptFeedback'] !== undefined) feedback = chunk['promptFeedback'];
    const candidate = Array.isArray(chunk['candidates']) ? chunk['candidates'][0] as JsonObject | undefined : undefined;
    if (!candidate) continue;
    if (candidate['finishReason'] !== undefined) finishReason = candidate['finishReason'];
    const content = candidate['content'] as JsonObject | undefined;
    for (const part of Array.isArray(content?.['parts']) ? content['parts'] as JsonObject[] : []) {
      const last = parts.at(-1);
      if (typeof part['text'] === 'string' && last && typeof last['text'] === 'string' && Boolean(last['thought']) === Boolean(part['thought']) && part['thoughtSignature'] === undefined) {
        last['text'] = (last['text'] as string) + part['text'];
      } else parts.push({ ...part });
    }
  }
  return { candidates: [{ content: { role: 'model', parts }, finishReason }], ...(usage === undefined ? {} : { usageMetadata: usage }), ...(feedback === undefined ? {} : { promptFeedback: feedback }) };
}

/**
 * Google Gemini models for a Mayura model registry, through the official Google Gen AI SDK and the Gemini API:
 *
 * ```ts
 * const models = createModels({ providers: [google({ apiKey })], prices: 'catalog', maxCallCostMicros: 50_000 });
 * const model = models.model('google/gemini-3.5-flash'); // granted as model:google/gemini-3.5-flash
 * ```
 *
 * Structured output and tool parameters use strict JSON Schema; streaming reports output text as it arrives; the
 * model's thoughts and thought signatures are kept for the next call of the run and never released. The SDK's retries
 * are off, and nothing is read from the environment. Thinking tokens are charged as output, and cached input at the
 * full input rate.
 */
export function google(options: GoogleProviderOptions): ModelProvider {
  if (!options || typeof options.apiKey !== 'string' || !options.apiKey.trim() || /[\r\n]/u.test(options.apiKey) || options.apiKey.length > 4096) {
    throw new MayuraError('INVALID_CONFIG', 'google() needs an apiKey.');
  }
  const baseUrl = options.baseURL === undefined ? 'https://generativelanguage.googleapis.com' : providerEndpoint(options.baseURL, '', 'google()');
  const headers = providerHeaders(options.headers, ['x-goog-api-key', 'Authorization'], 'google()');
  const maxRequestBytes = options.maxRequestBytes ?? 1_048_576; const maxResponseBytes = options.maxResponseBytes ?? 1_048_576;
  const defaultTimeout = options.timeoutMs ?? 60_000;
  for (const [value, name] of [[maxRequestBytes, 'maxRequestBytes'], [maxResponseBytes, 'maxResponseBytes'], [defaultTimeout, 'timeoutMs']] as const) assertPositiveInteger(value, name);
  const media = mediaOption(options.media);
  const client = new GoogleGenAI({
    // Explicit values win over the SDK's environment variables: the Gemini API, this key, this URL.
    vertexai: false, apiKey: options.apiKey, apiVersion: 'v1beta',
    httpOptions: { baseUrl, headers: { ...headers }, retryOptions: { attempts: 1 }, fetch: boundedFetch(() => options.fetch ?? globalThis.fetch, maxResponseBytes) },
  });

  return Object.freeze({
    id: 'google',
    catalog,
    model(name: string, settings: ProviderModelSettings): ModelAdapter {
      if (typeof name !== 'string' || !name.trim() || name.length > 128) throw new MayuraError('INVALID_CONFIG', 'A Gemini model name is required.');
      const timeoutMs = settings.timeoutMs ?? defaultTimeout;

      const call = async (request: ModelRequest, onDelta?: (text: string) => void, consumer?: AbortSignal): Promise<ModelResponse> => {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        let knownCost: number | undefined;
        try {
          const signal = AbortSignal.any([request.signal, controller.signal, ...(consumer ? [consumer] : [])]);
          if (signal.aborted) throw new MayuraError('CANCELLED', 'Provider request was cancelled.');
          let turns: JsonObject[][] = [];
          if (request.continuation !== undefined) {
            const previous = object(request.continuation);
            if (previous['provider'] !== 'google.gemini.v1' || previous['model'] !== name || !Array.isArray(previous['turns'])) return failed();
            turns = previous['turns'].map(turn => Array.isArray(turn) ? turn.map(part => object(part)) : failed());
          }
          if (turns.length > request.messages.filter(message => message.role === 'assistant').length) return failed();
          assertPositiveInteger(request.maxOutputTokens, 'maxOutputTokens');
          const aliases = new Map(modelToolNames(request.tools.map(tool => tool.id)));
          const ids = new Map([...aliases].map(([toolId, alias]) => [alias, toolId]));
          if (aliases.size !== request.tools.length || aliases.size > 128) return failed();
          const declarations = request.tools.map(tool => {
            if (!tool.inputJsonSchema) throw new MayuraError('INVALID_CONFIG', `Tool "${tool.id}" has no inputJsonSchema.`);
            return { name: aliases.get(tool.id)!, description: tool.description, parametersJsonSchema: strictJsonSchema(tool.inputJsonSchema, `Tool "${tool.id}" input schema`) };
          });
          const outputSchema = request.outputJsonSchema === undefined ? failed('configuration') : strictJsonSchema(request.outputJsonSchema, 'The output schema');
          // The history goes first. This run's own turns (and the continuation's count of them) are this run's messages alone.
          const own = contentsFor(request.messages, aliases, turns);
          const contents = request.history ? alternating([...historyContents(request.history, historyToolNames(request)), ...own as JsonObject[]]) : own;
          jsonValue({ contents, declarations }, { maxBytes: maxRequestBytes + encodedMediaBytes(request.messages) });
          const params = {
            model: name, contents,
            config: {
              systemInstruction: request.instructions, maxOutputTokens: request.maxOutputTokens,
              responseMimeType: 'application/json', responseJsonSchema: outputSchema, abortSignal: signal,
              ...(declarations.length > 0 ? { tools: [{ functionDeclarations: declarations }] } : {}),
            },
          };

          let payload: JsonObject;
          if (onDelta) {
            const chunks: JsonObject[] = [];
            for await (const chunk of await client.models.generateContentStream(params as never)) {
              const data = object(jsonValue(JSON.parse(JSON.stringify(chunk)) as JsonValue, { maxBytes: maxResponseBytes }));
              chunks.push(data);
              const candidate = Array.isArray(data['candidates']) ? data['candidates'][0] as JsonObject | undefined : undefined;
              const parts = candidate?.['content'] && Array.isArray((candidate['content'] as JsonObject)['parts']) ? (candidate['content'] as JsonObject)['parts'] as JsonObject[] : [];
              for (const part of parts) if (typeof part['text'] === 'string' && part['thought'] !== true) onDelta(part['text']);
            }
            payload = joined(chunks);
          } else {
            payload = object(jsonValue(JSON.parse(JSON.stringify(await client.models.generateContent(params as never))) as JsonValue, { maxBytes: maxResponseBytes * 2 }));
          }

          const usage = object(payload['usageMetadata']);
          const input = integer(usage['promptTokenCount']) + integer(usage['toolUsePromptTokenCount'], 0);
          // Thinking is billed as output; cached input is charged at the full input rate.
          const output = integer(usage['candidatesTokenCount'], 0) + integer(usage['thoughtsTokenCount'], 0);
          knownCost = tokenCostMicros(settings.pricing, input, output) ?? failed();
          if (payload['promptFeedback'] && (payload['promptFeedback'] as JsonObject)['blockReason'] !== undefined) return failed('refused');
          const candidate = Array.isArray(payload['candidates']) ? payload['candidates'][0] as JsonObject | undefined : undefined;
          if (!candidate) return failed();
          const finish = candidate['finishReason'];
          if (typeof finish === 'string' && REFUSED.has(finish)) return failed('refused');
          const parts = Array.isArray((candidate['content'] as JsonObject | undefined)?.['parts']) ? ((candidate['content'] as JsonObject)['parts'] as JsonValue[]).map(object) : [];
          if (parts.length > 256) return failed();
          const accounting = { costMicros: knownCost, inputTokens: input, outputTokens: output };
          const calls: ModelToolCall[] = []; const seen = new Set<string>(); const taken = takenCallIds(request);
          for (const [index, part] of parts.entries()) {
            const call = part['functionCall'] as JsonObject | undefined;
            if (!call) continue;
            const alias = call['name']; const given = call['id'];
            // Gemini's own id when it gives a usable one; otherwise one that no earlier call of the conversation has.
            const usable = typeof given === 'string' && /^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/u.test(given) && !taken.has(given);
            let id = usable ? given : `call-${index}`;
            for (let suffix = 2; !usable && (taken.has(id) || seen.has(id)); suffix++) id = `call-${index}-${suffix}`;
            if (typeof alias !== 'string' || !ids.has(alias) || seen.has(id)) return failed();
            seen.add(id); calls.push({ id, toolId: ids.get(alias)!, input: jsonValue(call['args'] ?? {}) });
          }
          if (calls.length > 0) {
            if (finish !== undefined && finish !== null && finish !== 'STOP') return failed();
            // The model's own parts, thoughts and signatures included, go back unchanged on the next call.
            const own = parts.map(part => part['functionCall'] ? { ...part, functionCall: { ...(part['functionCall'] as JsonObject) } } : part);
            const continuation = jsonValue({ provider: 'google.gemini.v1', model: name, turns: [...turns, own] }, { maxBytes: maxRequestBytes });
            return { type: 'tool_calls', calls, usage: accounting, continuation };
          }
          if (finish !== 'STOP') return failed();
          const text = parts.filter(part => typeof part['text'] === 'string' && part['thought'] !== true).map(part => part['text'] as string);
          if (text.length === 0) return failed();
          return { type: 'final', output: jsonValue(JSON.parse(text.join('')), { maxBytes: maxResponseBytes }), usage: accounting };
        } catch (error) {
          if (knownCost !== undefined) throw new ModelProviderError(reasonOf(error), { costMicros: knownCost });
          if (request.signal.aborted || controller.signal.aborted || consumer?.aborted) throw new MayuraError('CANCELLED', 'Provider request was cancelled or timed out.');
          if (error instanceof ModelProviderError) throw error;
          if (error instanceof MayuraError && error.code === 'INVALID_CONFIG') return failed('configuration');
          if (error instanceof ApiError && typeof error.status === 'number' && error.status >= 100) throw providerHttpFailure(error.status);
          if (error instanceof ResponseTooLarge || (error instanceof Error && error.cause instanceof ResponseTooLarge)) return failed('invalid_response');
          // A transport failure before any response (the SDK passes fetch's own error through).
          if (error instanceof TypeError) return failed('unavailable');
          return failed();
        } finally { clearTimeout(timer); }
      };

      return Object.freeze({
        id: settings.id, maxCostMicros: settings.maxCostMicros,
        capabilities: Object.freeze({ tools: true, structuredOutput: true, history: true, ...(media ? { media } : {}) }),
        checkDefinition: (definition: ModelDefinitionCheck): void => checkStrictDefinition(definition),
        generate: (request: ModelRequest): Promise<ModelResponse> => call(request),
        stream: (request: ModelRequest): AsyncIterable<ModelStreamEvent> => streamModelCall((onDelta, consumer) => call(request, onDelta, consumer)),
      });
    },
  });
}

export { googleEmbeddings, type EmbeddingsOptions } from './embeddings.js';
