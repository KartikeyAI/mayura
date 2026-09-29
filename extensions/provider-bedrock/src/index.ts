import { BedrockRuntimeClient, ConverseCommand, ConverseStreamCommand } from '@aws-sdk/client-bedrock-runtime';
import { assertPositiveInteger, jsonValue, MayuraError, ModelProviderError, type JsonObject, type Media, type MediaType, type ModelAdapter,
  type ModelDefinitionCheck, type ModelFailureReason, type ModelMediaCapability, type ModelMessage, type ModelProvider, type ModelRequest, type ModelResponse,
  type ModelStreamEvent, type ModelToolCall, type ProviderModelSettings } from 'mayura';
import { base64ToBytes, bytesToBase64, checkStrictDefinition, modelToolNames, providerEndpoint, providerHttpFailure, streamModelCall, strictJsonSchema, tokenCostMicros } from 'mayura/core/host';
import { catalog } from './catalog.js';

export { catalog };

/** AWS credentials, or a function that returns fresh ones (for example from your own STS call). */
export type BedrockAwsCredentials =
  | { readonly accessKeyId: string; readonly secretAccessKey: string; readonly sessionToken?: string }
  | (() => Promise<{ readonly accessKeyId: string; readonly secretAccessKey: string; readonly sessionToken?: string; readonly expiration?: Date }>);

export interface BedrockProviderOptions {
  /** The AWS region, such as `us-east-1`. Required: nothing is read from the environment or AWS config files. */
  readonly region: string;
  /** Signs requests with AWS credentials (SigV4). Give either this or `apiKey`. */
  readonly credentials?: BedrockAwsCredentials;
  /** A Bedrock API key, sent as a bearer token. Give either this or `credentials`. */
  readonly apiKey?: string;
  /** Send requests here instead of https://bedrock-runtime.<region>.amazonaws.com, for example a VPC endpoint. https only. */
  readonly baseURL?: string;
  /** What the models can see, as bytes. The default is PNG, JPEG, WebP, GIF and PDF; `false` for none. */
  readonly media?: ModelMediaCapability | false;
  readonly maxRequestBytes?: number;
  readonly maxResponseBytes?: number;
  /** How long one call may take unless the registry sets `timeoutMs` (default 60 s). */
  readonly timeoutMs?: number;
  /** A trusted transport for tests or proxies. Never selected from model output. */
  readonly fetch?: typeof globalThis.fetch;
}

const BEDROCK_MEDIA: readonly MediaType[] = Object.freeze(['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'application/pdf']);
const IMAGE_FORMATS: Readonly<Record<string, string>> = { 'image/png': 'png', 'image/jpeg': 'jpeg', 'image/webp': 'webp', 'image/gif': 'gif' };
/** Stop reasons meaning the model declined, a filter or guardrail stopped it, or it ran out of output tokens. */
const REFUSED = new Set(['max_tokens', 'guardrail_intervened', 'content_filtered']);
/** Errors a stream reports as events, by event name. */
const STREAM_ERRORS: Readonly<Record<string, ModelFailureReason>> = {
  throttlingException: 'rate_limited', serviceUnavailableException: 'unavailable', internalServerException: 'unavailable',
  modelStreamErrorException: 'unavailable', modelTimeoutException: 'unavailable', validationException: 'rejected',
};

const failed = (reason: ModelFailureReason = 'invalid_response'): never => { throw new ModelProviderError(reason); };
const reasonOf = (error: unknown): ModelFailureReason => error instanceof ModelProviderError ? error.reason : 'invalid_response';
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return failed();
  return value as Record<string, unknown>;
}
function integer(value: unknown, fallback?: number): number {
  if ((value === undefined || value === null) && fallback !== undefined) return fallback;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) return failed();
  return value;
}
function mediaOption(value: ModelMediaCapability | false | undefined): ModelMediaCapability | undefined {
  if (value === false) return undefined;
  const capability = value ?? { types: BEDROCK_MEDIA, urls: false };
  if (!Array.isArray(capability.types) || capability.types.some(type => !BEDROCK_MEDIA.includes(type)) || capability.urls !== false) {
    throw new MayuraError('INVALID_CONFIG', 'media must list PNG, JPEG, WebP, GIF or PDF, sent as bytes (urls: false).');
  }
  return Object.freeze({ types: Object.freeze([...new Set(capability.types)] as MediaType[]), urls: false });
}

class ResponseTooLarge extends Error {}
/**
 * A fetch-based HTTP handler for the AWS SDK: web-standard, so it runs wherever fetch does. No redirects, and a response
 * body larger than `limit` (four times that for an event stream) fails instead of being read into memory.
 */
function fetchHandler(transport: () => typeof globalThis.fetch, limit: number) {
  return {
    metadata: { handlerProtocol: 'http/1.1' },
    async handle(request: { method: string; protocol: string; hostname: string; port?: number; path: string; query?: Record<string, string | string[] | null>; headers: Record<string, string>; body?: unknown },
      options: { abortSignal?: AbortSignal } = {}) {
      const query = new URLSearchParams();
      for (const [key, value] of Object.entries(request.query ?? {})) for (const item of Array.isArray(value) ? value : [value]) query.append(key, item ?? '');
      const url = `${request.protocol}//${request.hostname}${request.port ? `:${request.port}` : ''}${request.path}${query.size ? `?${query}` : ''}`;
      const headers = Object.fromEntries(Object.entries(request.headers).filter(([name]) => !['host', 'content-length'].includes(name.toLowerCase())));
      const response = await transport()(url, { method: request.method, headers, redirect: 'error',
        ...(request.body === undefined || request.body === null ? {} : { body: request.body as BodyInit }), ...(options.abortSignal ? { signal: options.abortSignal } : {}) });
      const max = (response.headers.get('content-type') ?? '').includes('eventstream') ? limit * 4 : limit;
      const length = response.headers.get('content-length');
      if (length !== null && (!/^\d+$/u.test(length) || Number(length) > max)) { void response.body?.cancel().catch(() => undefined); throw new ResponseTooLarge(); }
      let size = 0;
      const body = response.body ? response.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
        transform(chunk, controller) { size += chunk.byteLength; if (size > max) controller.error(new ResponseTooLarge()); else controller.enqueue(chunk); },
      })) : new ReadableStream<Uint8Array>({ start(controller) { controller.close(); } });
      const responseHeaders: Record<string, string> = {}; response.headers.forEach((value, name) => { responseHeaders[name] = value; });
      return { response: { statusCode: response.status, reason: response.statusText, headers: responseHeaders, body } };
    },
    updateHttpClientConfig() { /* nothing to configure */ },
    httpHandlerConfigs() { return {}; },
    destroy() { /* nothing to release */ },
  };
}

/** A document name Bedrock accepts: letters, digits, spaces, hyphens, parentheses and square brackets. */
const documentName = (name: string | undefined) => (name ?? 'document').replace(/\.[A-Za-z0-9]+$/u, '').replace(/[^A-Za-z0-9 ()[\]-]/gu, '-').replace(/\s+/gu, ' ').slice(0, 64) || 'document';
function mediaBlock(item: Media): unknown {
  if (!('data' in item)) return failed('configuration');
  return item.mediaType === 'application/pdf'
    ? { document: { format: 'pdf', name: documentName(item.name), source: { bytes: item.data } } }
    : { image: { format: IMAGE_FORMATS[item.mediaType] ?? failed('configuration'), source: { bytes: item.data } } };
}
/** The model's own content blocks as JSON, for a continuation: reasoning signatures kept, redacted bytes as base64. */
function ownBlocks(content: readonly unknown[]): JsonObject[] {
  const kept: JsonObject[] = [];
  for (const raw of content) {
    const block = record(raw);
    if (block['toolUse']) {
      const use = record(block['toolUse']);
      kept.push({ toolUse: { toolUseId: String(use['toolUseId']), name: String(use['name']), input: jsonValue(use['input'] ?? {}) } });
    } else if (block['reasoningContent']) {
      const reasoning = record(block['reasoningContent']);
      if (reasoning['reasoningText']) {
        const text = record(reasoning['reasoningText']);
        kept.push({ reasoningContent: { reasoningText: { text: String(text['text'] ?? ''), ...(typeof text['signature'] === 'string' ? { signature: text['signature'] } : {}) } } });
      } else if (reasoning['redactedContent'] instanceof Uint8Array) kept.push({ reasoningContent: { redactedContentBase64: bytesToBase64(reasoning['redactedContent']) } });
    }
  }
  return kept;
}
/** A continuation block back in the SDK's shape. */
function sdkBlock(block: JsonObject): unknown {
  const reasoning = block['reasoningContent'] as JsonObject | undefined;
  if (reasoning && typeof reasoning['redactedContentBase64'] === 'string') return { reasoningContent: { redactedContent: base64ToBytes(reasoning['redactedContentBase64']) } };
  return block;
}
/** The conversation as Converse messages; `turns` are the model's own earlier tool-call turns in this run. */
function messagesFor(messages: readonly ModelMessage[], aliases: ReadonlyMap<string, string>, turns: readonly JsonObject[][]): unknown[] {
  const result: { role: string; content: unknown[] }[] = []; let turn = 0;
  for (const message of messages) {
    if (message.role === 'user') {
      result.push({ role: 'user', content: [{ text: JSON.stringify(message.content) }, ...(message.media ?? []).map(mediaBlock)] });
    } else if (message.role === 'assistant') {
      const calls = message.calls.map(call => {
        const name = aliases.get(call.toolId); if (!name) return failed();
        return { toolUse: { toolUseId: call.id, name, input: call.input } };
      });
      const own = turns[turn++];
      if (own) {
        const ownCalls = own.filter(block => block['toolUse'] !== undefined);
        if (ownCalls.length !== calls.length || ownCalls.some((block, index) => (block['toolUse'] as JsonObject)['toolUseId'] !== message.calls[index]!.id)) return failed();
        result.push({ role: 'assistant', content: own.map(sdkBlock) });
      } else result.push({ role: 'assistant', content: calls });
    } else {
      // Consecutive tool results share one user turn; images go inside the result, documents after it.
      const media = message.media ?? [];
      const images = media.filter(item => item.mediaType !== 'application/pdf'); const documents = media.filter(item => item.mediaType === 'application/pdf');
      const blocks = [{ toolResult: { toolUseId: message.callId, content: [{ text: JSON.stringify(message.result) }, ...images.map(mediaBlock)] } }, ...documents.map(mediaBlock)];
      const previous = result.at(-1);
      if (previous?.role === 'user' && previous.content.some(block => (block as Record<string, unknown>)['toolResult'] !== undefined)) previous.content.push(...blocks);
      else result.push({ role: 'user', content: blocks });
    }
  }
  return result;
}

/** Rebuilds the response a Converse call returns from a ConverseStream's events, reporting text deltas as they arrive. */
async function assemble(events: AsyncIterable<unknown>, onDelta: (text: string) => void): Promise<Record<string, unknown>> {
  const blocks: ({ type: 'text'; text: string } | { type: 'toolUse'; toolUseId: string; name: string; input: string } | { type: 'reasoning'; text: string; signature: string; redacted?: Uint8Array })[] = [];
  let stopReason: unknown; let usage: unknown;
  for await (const raw of events) {
    const event = record(raw);
    for (const [name, reason] of Object.entries(STREAM_ERRORS)) if (event[name] !== undefined) return failed(reason);
    if (event['contentBlockStart']) {
      const start = record(record(event['contentBlockStart'])['start'] ?? {});
      const use = start['toolUse'] ? record(start['toolUse']) : undefined;
      const index = integer(record(event['contentBlockStart'])['contentBlockIndex']);
      if (index > 255) return failed();
      if (use) blocks[index] = { type: 'toolUse', toolUseId: String(use['toolUseId'] ?? ''), name: String(use['name'] ?? ''), input: '' };
    } else if (event['contentBlockDelta']) {
      const delta = record(event['contentBlockDelta']); const index = integer(delta['contentBlockIndex']); const change = record(delta['delta'] ?? {});
      if (index > 255) return failed();
      if (typeof change['text'] === 'string') {
        const block = blocks[index] ??= { type: 'text', text: '' };
        if (block.type !== 'text') return failed();
        block.text += change['text']; onDelta(change['text']);
      } else if (change['toolUse']) {
        const block = blocks[index];
        if (block?.type !== 'toolUse') return failed();
        block.input += String(record(change['toolUse'])['input'] ?? '');
      } else if (change['reasoningContent']) {
        const reasoning = record(change['reasoningContent']);
        const block = blocks[index] ??= { type: 'reasoning', text: '', signature: '' };
        if (block.type !== 'reasoning') return failed();
        if (typeof reasoning['text'] === 'string') block.text += reasoning['text'];
        if (typeof reasoning['signature'] === 'string') block.signature += reasoning['signature'];
        if (reasoning['redactedContent'] instanceof Uint8Array) block.redacted = reasoning['redactedContent'];
      }
    } else if (event['messageStop']) stopReason = record(event['messageStop'])['stopReason'];
    else if (event['metadata']) usage = record(event['metadata'])['usage'];
  }
  const content = blocks.filter(Boolean).map(block => block.type === 'text' ? { text: block.text }
    : block.type === 'toolUse' ? { toolUse: { toolUseId: block.toolUseId, name: block.name, input: JSON.parse(block.input || '{}') as unknown } }
      : { reasoningContent: block.redacted ? { redactedContent: block.redacted } : { reasoningText: { text: block.text, ...(block.signature ? { signature: block.signature } : {}) } } });
  return { output: { message: { role: 'assistant', content } }, stopReason, usage };
}

/**
 * Amazon Bedrock models for a Mayura model registry, through the official AWS SDK and the Converse API:
 *
 * ```ts
 * const models = createModels({ providers: [bedrock({ region: 'us-east-1', credentials })], prices: 'catalog', maxCallCostMicros: 50_000 });
 * const model = models.model('bedrock/global.anthropic.claude-sonnet-5-5'); // granted as model:bedrock/global.anthropic.claude-sonnet-5-5
 * ```
 *
 * Model names are Bedrock model ids or inference profile ids. Structured output and tool inputs use strict JSON Schema;
 * streaming reports output text as it arrives; reasoning is kept for the next call of the run and never released. The
 * region and credentials are options: nothing is read from the environment, AWS config files or instance metadata, and
 * the SDK makes one attempt per call. Requests go through fetch.
 */
export function bedrock(options: BedrockProviderOptions): ModelProvider {
  if (!options || typeof options.region !== 'string' || !/^[a-z]{2}(?:-[a-z]+)+-\d{1,2}$/u.test(options.region)) {
    throw new MayuraError('INVALID_CONFIG', 'bedrock() needs a region, such as us-east-1.');
  }
  const hasKey = options.apiKey !== undefined; const hasCredentials = options.credentials !== undefined;
  if (hasKey === hasCredentials) throw new MayuraError('INVALID_CONFIG', 'bedrock() needs either credentials or an apiKey.');
  if (hasKey && (typeof options.apiKey !== 'string' || !options.apiKey.trim() || /[\r\n]/u.test(options.apiKey) || options.apiKey.length > 4096)) {
    throw new MayuraError('INVALID_CONFIG', 'The Bedrock apiKey must be a single-line string.');
  }
  const credentials = options.credentials;
  if (hasCredentials && typeof credentials !== 'function' && (!credentials || typeof credentials.accessKeyId !== 'string' || !credentials.accessKeyId || typeof credentials.secretAccessKey !== 'string' || !credentials.secretAccessKey)) {
    throw new MayuraError('INVALID_CONFIG', 'Bedrock credentials need an accessKeyId and a secretAccessKey.');
  }
  const endpoint = options.baseURL === undefined ? `https://bedrock-runtime.${options.region}.amazonaws.com` : providerEndpoint(options.baseURL, '', 'bedrock()');
  const maxRequestBytes = options.maxRequestBytes ?? 1_048_576; const maxResponseBytes = options.maxResponseBytes ?? 1_048_576;
  const defaultTimeout = options.timeoutMs ?? 60_000;
  for (const [value, name] of [[maxRequestBytes, 'maxRequestBytes'], [maxResponseBytes, 'maxResponseBytes'], [defaultTimeout, 'timeoutMs']] as const) assertPositiveInteger(value, name);
  const media = mediaOption(options.media);
  const client = new BedrockRuntimeClient({
    // Every setting the SDK would otherwise look up in the environment, AWS config files or instance metadata.
    region: options.region, endpoint, useFipsEndpoint: false, useDualstackEndpoint: false, defaultsMode: 'standard',
    maxAttempts: 1, retryMode: 'standard', userAgentAppId: 'mayura',
    ...(hasKey ? { token: { token: options.apiKey! }, authSchemePreference: ['httpBearerAuth'] } : { credentials: credentials!, authSchemePreference: ['sigv4'] }),
    requestHandler: fetchHandler(() => options.fetch ?? globalThis.fetch, maxResponseBytes) as never,
    streamCollector: async (stream: unknown) => new Uint8Array(await new Response(stream as BodyInit).arrayBuffer()),
  } as never);

  return Object.freeze({
    id: 'bedrock',
    // List prices are for us-east-1; elsewhere they can be higher, so the catalog is only offered there.
    ...(options.region === 'us-east-1' ? { catalog } : {}),
    model(name: string, settings: ProviderModelSettings): ModelAdapter {
      if (typeof name !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,119}$/u.test(name)) throw new MayuraError('INVALID_CONFIG', 'A Bedrock model or inference profile id is required.');
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
            const previous = record(request.continuation) as JsonObject;
            if (previous['provider'] !== 'bedrock.converse.v1' || previous['model'] !== name || !Array.isArray(previous['turns'])) return failed();
            turns = previous['turns'].map(turn => Array.isArray(turn) ? turn.map(block => record(block) as JsonObject) : failed());
          }
          if (turns.length > request.messages.filter(message => message.role === 'assistant').length) return failed();
          assertPositiveInteger(request.maxOutputTokens, 'maxOutputTokens');
          const aliases = new Map(modelToolNames(request.tools.map(tool => tool.id)));
          const ids = new Map([...aliases].map(([toolId, alias]) => [alias, toolId]));
          if (aliases.size !== request.tools.length || aliases.size > 128) return failed();
          const tools = request.tools.map(tool => {
            if (!tool.inputJsonSchema) throw new MayuraError('INVALID_CONFIG', `Tool "${tool.id}" has no inputJsonSchema.`);
            return { toolSpec: { name: aliases.get(tool.id)!, description: tool.description, inputSchema: { json: strictJsonSchema(tool.inputJsonSchema, `Tool "${tool.id}" input schema`) }, strict: true } };
          });
          const outputSchema = request.outputJsonSchema === undefined ? failed('configuration') : strictJsonSchema(request.outputJsonSchema, 'The output schema');
          // The request's JSON is bounded; media bytes are bounded by the runtime (maxMediaBytes) and sent as bytes.
          jsonValue({ instructions: request.instructions, tools, turns, messages: request.messages.map(message => message.role === 'user' ? message.content : message.role === 'tool' ? message.result : message.calls) },
            { maxBytes: maxRequestBytes });
          const input = {
            modelId: name, system: [{ text: request.instructions }], messages: messagesFor(request.messages, aliases, turns),
            inferenceConfig: { maxTokens: request.maxOutputTokens },
            outputConfig: { textFormat: { type: 'json_schema', structure: { jsonSchema: { schema: JSON.stringify(outputSchema), name: 'mayura_output' } } } },
            ...(tools.length > 0 ? { toolConfig: { tools, toolChoice: { auto: {} } } } : {}),
          };

          let payload: Record<string, unknown>;
          if (onDelta) {
            const response = await client.send(new ConverseStreamCommand(input as never), { abortSignal: signal });
            payload = await assemble(record(response)['stream'] as AsyncIterable<unknown> ?? failed(), onDelta);
          } else payload = record(await client.send(new ConverseCommand(input as never), { abortSignal: signal }));

          const usage = record(payload['usage']);
          const inputTokens = integer(usage['inputTokens']); const outputTokens = integer(usage['outputTokens']);
          // Cache writes cost up to twice the input rate, and reads less than it: both are charged high.
          const cacheWrites = integer(usage['cacheWriteInputTokens'], 0); const cacheReads = integer(usage['cacheReadInputTokens'], 0);
          knownCost = tokenCostMicros(settings.pricing, inputTokens + 2 * cacheWrites + cacheReads, outputTokens) ?? failed();
          const stop = payload['stopReason'];
          if (typeof stop === 'string' && REFUSED.has(stop)) return failed('refused');
          if (stop === 'model_context_window_exceeded') return failed('rejected');
          const message = record(record(payload['output'])['message']);
          const content = Array.isArray(message['content']) ? message['content'] : failed();
          if (content.length > 256) return failed();
          const accounting = { costMicros: knownCost };
          if (stop === 'tool_use') {
            const calls: ModelToolCall[] = []; const seen = new Set<string>();
            for (const raw of content) {
              const block = record(raw);
              if (!block['toolUse']) continue; // narration and reasoning are not calls
              const use = record(block['toolUse']); const id = use['toolUseId']; const alias = use['name'];
              if (typeof id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/u.test(id) || seen.has(id) || typeof alias !== 'string' || !ids.has(alias)) return failed();
              seen.add(id); calls.push({ id, toolId: ids.get(alias)!, input: jsonValue(use['input'] ?? {}) });
            }
            if (calls.length === 0) return failed();
            const continuation = jsonValue({ provider: 'bedrock.converse.v1', model: name, turns: [...turns, ownBlocks(content)] }, { maxBytes: maxRequestBytes });
            return { type: 'tool_calls', calls, usage: accounting, continuation };
          }
          if (stop !== 'end_turn' && stop !== 'stop_sequence') return failed();
          const text: string[] = [];
          for (const raw of content) {
            const block = record(raw);
            if (block['reasoningContent'] !== undefined) continue; // reasoning is never output
            if (typeof block['text'] !== 'string') return failed();
            text.push(block['text']);
          }
          if (text.length === 0) return failed();
          return { type: 'final', output: jsonValue(JSON.parse(text.join('')), { maxBytes: maxResponseBytes }), usage: accounting };
        } catch (error) {
          if (knownCost !== undefined) throw new ModelProviderError(reasonOf(error), { costMicros: knownCost });
          if (request.signal.aborted || controller.signal.aborted || consumer?.aborted) throw new MayuraError('CANCELLED', 'Provider request was cancelled or timed out.');
          if (error instanceof ModelProviderError) throw error;
          if (error instanceof MayuraError && error.code === 'INVALID_CONFIG') return failed('configuration');
          const status = (error as { $metadata?: { httpStatusCode?: unknown } } | null)?.$metadata?.httpStatusCode;
          if (typeof status === 'number' && status >= 400) throw providerHttpFailure(status);
          if (error instanceof ResponseTooLarge || (error instanceof Error && error.cause instanceof ResponseTooLarge)) return failed('invalid_response');
          if (error instanceof TypeError || (error instanceof Error && error.cause instanceof TypeError)) return failed('unavailable');
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

