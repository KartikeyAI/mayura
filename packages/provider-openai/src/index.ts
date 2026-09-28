import { assertPositiveInteger, jsonValue, MayuraError, ModelProviderError, type JsonObject, type ModelDefinitionCheck, type ModelFailureReason, type JsonValue, type ModelAdapter, type ModelMessage, type ModelRequest, type ModelResponse, type ModelStreamEvent, type ModelToolCall } from '@mayura/core';
import { checkStrictDefinition, modelToolNames, providerHttpFailure, readServerSentEvents, streamModelCall, strictJsonSchema } from '@mayura/core/host';

export interface OpenAIResponsesOptions {
  readonly apiKey: string;
  readonly model: string;
  /**
   * The output as strict JSON Schema. Optional: without it, the adapter uses the schema the runtime sends with each
   * request, which `defineAgent` generates from the agent's output validator (or takes from its `outputJsonSchema`).
   */
  readonly outputJsonSchema?: JsonObject;
  readonly maxCostMicros: number;
  readonly pricing: { readonly inputMicrosPerMillionTokens: number; readonly outputMicrosPerMillionTokens: number };
  readonly maxRequestBytes?: number;
  readonly maxResponseBytes?: number;
  readonly timeoutMs?: number;
  /** Trusted test/proxy transport; never selected from model output. Default destination is fixed. */
  readonly fetch?: typeof globalThis.fetch;
}
export interface OpenAICompatibleChatOptions {
  /**
   * The exact Chat Completions URL. Without `remote`, only a loopback HTTP server (for example
   * http://127.0.0.1:11434/v1/chat/completions). With `remote`, an HTTPS URL ending in `/chat/completions`.
   */
  readonly endpoint: string;
  /**
   * Opt in to a remote provider. Prompts, tool results and outputs are sent to `endpoint`'s host. `id` names the
   * provider in the adapter id (`openai-compatible.<id>`), which is what a runtime grants as `model:<adapter id>`.
   * `auth` is `bearer` (Authorization header, the default) or `api-key` (Azure OpenAI's header).
   */
  readonly remote?: { readonly id: string; readonly auth?: 'bearer' | 'api-key' };
  readonly apiKey?: string;
  /** Short-lived credential source (for example a Google OAuth access token), called for each request; not with `apiKey`. */
  readonly token?: () => string | Promise<string>;
  readonly model: string;
  /**
   * The output as strict JSON Schema. Optional: without it, the adapter uses the schema the runtime sends with each
   * request, which `defineAgent` generates from the agent's output validator (or takes from its `outputJsonSchema`).
   */
  readonly outputJsonSchema?: JsonObject;
  readonly maxCostMicros: number;
  readonly pricing: { readonly inputMicrosPerMillionTokens: number; readonly outputMicrosPerMillionTokens: number };
  readonly maxRequestBytes?: number;
  readonly maxResponseBytes?: number;
  readonly timeoutMs?: number;
  readonly fetch?: typeof globalThis.fetch;
  /**
   * How the provider is asked for structured output. `json_schema` (the default) sends the strict JSON Schema as
   * `response_format`. `json_object` is for providers that only offer JSON mode (DeepSeek, for example): it asks for a
   * JSON object and puts the schema in the instructions. Either way Mayura validates the answer against the agent's
   * output schema before using it.
   */
  readonly output?: 'json_schema' | 'json_object';
  /** Send `strict: true` on every function, for providers with strict tool calls (DeepSeek's beta endpoint, for example). */
  readonly strictTools?: boolean;
  /**
   * The request field that carries the output-token limit. `max_tokens` (the default) is what most compatible providers
   * take; OpenAI's newer models, directly or through a gateway, accept only `max_completion_tokens`.
   */
  readonly tokenLimitField?: 'max_tokens' | 'max_completion_tokens';
  /**
   * Extra request headers, such as Cloudflare AI Gateway's `cf-aig-authorization`. Treated as credentials: never logged
   * or reported. They cannot replace the credential header, `Content-Type`, `Host` or cookies.
   */
  readonly headers?: Readonly<Record<string, string>>;
  /**
   * Extra request fields a provider defines, such as DeepSeek's `thinking`. They cannot replace the fields Mayura sets
   * (model, messages, tools, output format, streaming and the output-token limit).
   */
  readonly body?: JsonObject;
}
/** Request fields the compatible adapter owns; `body` cannot set them. */
const ownedFields = new Set(['model', 'messages', 'tools', 'tool_choice', 'parallel_tool_calls', 'stream', 'stream_options', 'response_format', 'max_tokens', 'max_completion_tokens', 'n']);
/** Headers the compatible adapter owns; `headers` cannot set them. */
const ownedHeaders = new Set(['authorization', 'api-key', 'content-type', 'content-length', 'host', 'cookie', 'transfer-encoding', 'connection']);
/** A failed call, for a reason Mayura reports in its own words. The default is a response the adapter cannot use. */
const failed = (reason: ModelFailureReason = 'invalid_response'): never => { throw new ModelProviderError(reason); };
/** The reason a caught failure carries, for charging known usage without losing why the call failed. */
const reasonOf = (error: unknown): ModelFailureReason => error instanceof ModelProviderError ? error.reason : 'invalid_response';
/** The adapter's own output schema, or the one sent with the request. */
function outputSchemaFor(fixed: JsonObject | undefined, requested: JsonObject | undefined): JsonObject {
  if (fixed !== undefined) return fixed;
  return requested === undefined ? failed('configuration') : strictJsonSchema(requested, 'The output schema');
}
function toolSchema(tool: { readonly id: string; readonly inputJsonSchema?: JsonObject }): JsonObject {
  if (!tool.inputJsonSchema) throw new MayuraError('INVALID_CONFIG', `Tool "${tool.id}" has no inputJsonSchema.`);
  return strictJsonSchema(tool.inputJsonSchema, `Tool "${tool.id}" input schema`);
}
function object(value: JsonValue | undefined): JsonObject {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return failed();
  return value;
}
function integer(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) return failed();
  return value;
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
    if (response.redirected) return failed('rejected');
    if (!response.ok) throw providerHttpFailure(response.status);
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
  const fixedOutput = options.outputJsonSchema === undefined ? undefined : strictJsonSchema(options.outputJsonSchema, `The adapter's outputJsonSchema`);
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
  /** One Responses call. With `onDelta` it streams, reporting final-output text as it arrives; the parsing is shared. */
  const call = async (request: ModelRequest, onDelta?: (text: string) => void, consumer?: AbortSignal): Promise<ModelResponse> => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      let knownCost: number | undefined;
      try {
        const signal = AbortSignal.any([request.signal, controller.signal, ...(consumer ? [consumer] : [])]);
        if (signal.aborted) throw new MayuraError('CANCELLED', 'Provider request was cancelled.');
        assertPositiveInteger(request.maxOutputTokens, 'maxOutputTokens');
        const aliases = new Map(modelToolNames(request.tools.map(tool => tool.id)));
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
        const tools = request.tools.map(tool => ({ type: 'function', name: aliases.get(tool.id)!, description: tool.description, parameters: toolSchema(tool), strict: true }));
        const outputSchema = outputSchemaFor(fixedOutput, request.outputJsonSchema);
        const body = JSON.stringify(jsonValue({ model, instructions: request.instructions, input, tools,
          store: false, stream: onDelta !== undefined, include: ['reasoning.encrypted_content'], parallel_tool_calls: true,
          max_output_tokens: request.maxOutputTokens,
          text: { format: { type: 'json_schema', name: 'mayura_output', schema: outputSchema, strict: true } },
        }, { maxBytes: maxRequestBytes }));
        const response = await abortable(transport('https://api.openai.com/v1/responses', {
          method: 'POST', headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
          body, signal, redirect: 'error',
        }).catch((): never => failed('unavailable')), signal);
        const payload = onDelta ? await completedStream(response, signal, onDelta) : await responseBody(response, maxResponseBytes, signal);
        const usage = object(payload['usage']);
        const inputTokens = integer(usage['input_tokens']); const outputTokens = integer(usage['output_tokens']);
        const numerator = BigInt(inputTokens) * BigInt(priceInput) + BigInt(outputTokens) * BigInt(priceOutput);
        const computedCost = (numerator + 999_999n) / 1_000_000n;
        if (computedCost > BigInt(Number.MAX_SAFE_INTEGER)) return failed();
        knownCost = Number(computedCost);
        if (payload['status'] === 'incomplete') return failed('refused');
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
              if (content['type'] === 'refusal') return failed('refused');
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
        if (knownCost !== undefined) throw new ModelProviderError(reasonOf(error), { costMicros: knownCost });
        if (request.signal.aborted || controller.signal.aborted || consumer?.aborted) throw new MayuraError('CANCELLED', 'Provider request was cancelled or timed out.');
        if (error instanceof ModelProviderError) throw error;
        // A schema the provider would refuse, or no output schema at all, is the agent's configuration.
        if (error instanceof MayuraError && error.code === 'INVALID_CONFIG') return failed('configuration');
        return failed();
      } finally { clearTimeout(timer); }
  };
  /**
   * Read a Responses event stream: output text deltas are reported as they arrive (function-call argument deltas and
   * reasoning are not), and the `response.completed` event carries the same complete response a non-streamed call
   * returns, which the shared code then parses and accounts.
   */
  const completedStream = async (response: Response, signal: AbortSignal, onDelta: (text: string) => void): Promise<JsonObject> => {
    let completed: JsonObject | undefined;
    for await (const event of readServerSentEvents(response, { maxBytes: maxResponseBytes * 4, maxEventBytes: maxResponseBytes, signal })) {
      if (completed) continue; // nothing after completion is reported
      const data = object(jsonValue(JSON.parse(event.data), { maxBytes: maxResponseBytes }));
      const type = data['type'];
      if (type === 'response.output_text.delta') { if (typeof data['delta'] !== 'string') return failed(); onDelta(data['delta']); }
      else if (type === 'response.completed') completed = object(data['response']);
      else if (type === 'response.incomplete') return failed('refused');
      else if (type === 'response.failed' || type === 'error') return failed('unavailable');
    }
    return completed ?? failed();
  };
  return Object.freeze({
    id: 'openai.responses', capabilities: Object.freeze({ tools: true, structuredOutput: true }), maxCostMicros: options.maxCostMicros,
    checkDefinition: (definition: ModelDefinitionCheck): void => checkStrictDefinition(definition, fixedOutput),
    generate: (request: ModelRequest): Promise<ModelResponse> => call(request),
    stream: (request: ModelRequest): AsyncIterable<ModelStreamEvent> => streamModelCall((onDelta, consumer) => call(request, onDelta, consumer)),
  });
}

/**
 * The conversation in Chat Completions form. `assistants` are the provider's own earlier assistant turns in this run (from
 * the continuation), in order: they carry fields such as DeepSeek's `reasoning_content` that a thinking model requires
 * back, and each must match the calls Mayura recorded for that turn.
 */
function compatibleMessages(messages: readonly ModelMessage[], aliases: Map<string, string>, assistants: readonly JsonObject[]): JsonValue[] {
  let turn = 0;
  return messages.map(message => {
    if (message.role === 'user') return { role: 'user', content: JSON.stringify(message.content) };
    if (message.role === 'tool') return { role: 'tool', tool_call_id: message.callId, content: JSON.stringify(message.result) };
    const calls = message.calls.map(call => {
      const name = aliases.get(call.toolId); if (!name) return failed();
      return { id: call.id, type: 'function', function: { name, arguments: JSON.stringify(call.input) } };
    });
    const own = assistants[turn++];
    if (!own) return { role: 'assistant', content: null, tool_calls: calls };
    const ownCalls = own['tool_calls'];
    if (!Array.isArray(ownCalls) || ownCalls.length !== calls.length || ownCalls.some((call, index) => (call as JsonObject)['id'] !== calls[index]!.id)) return failed();
    return own;
  });
}
/** The fields of a provider assistant turn worth sending back: its text, reasoning and tool calls, nothing else. */
function assistantTurn(message: JsonObject): JsonObject {
  return { role: 'assistant', content: typeof message['content'] === 'string' ? message['content'] : null,
    ...(typeof message['reasoning_content'] === 'string' ? { reasoning_content: message['reasoning_content'] } : {}),
    tool_calls: message['tool_calls'] as JsonValue };
}

/** Loopback-only Chat Completions adapter for explicitly selected compatible local model servers. */
export function openAICompatibleChat(options: OpenAICompatibleChatOptions): ModelAdapter {
  let endpoint: URL;
  try { endpoint = new URL(options.endpoint); }
  catch { throw new MayuraError('INVALID_CONFIG', 'A valid loopback Chat Completions endpoint is required.'); }
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(endpoint.hostname);
  const remote = options.remote;
  if (remote === undefined) {
    if (endpoint.protocol !== 'http:' || !loopback || endpoint.username || endpoint.password || endpoint.pathname !== '/v1/chat/completions' || endpoint.search || endpoint.hash) {
      throw new MayuraError('INVALID_CONFIG', 'Compatible local models require an exact loopback HTTP endpoint; set `remote` to use a remote provider.');
    }
  } else {
    // A remote destination is an explicit data-egress decision: HTTPS only, the exact API path, and no other query
    // than Azure's `api-version`, so configuration cannot smuggle a different target or credentials into the URL.
    const query = [...endpoint.searchParams.keys()];
    if (!remote || typeof remote.id !== 'string' || !/^[a-z0-9][a-z0-9-]{0,39}$/u.test(remote.id) || (remote.auth !== undefined && remote.auth !== 'bearer' && remote.auth !== 'api-key')
      || endpoint.protocol !== 'https:' || loopback || endpoint.username || endpoint.password || endpoint.hash || !endpoint.pathname.endsWith('/chat/completions')
      || query.some(key => key !== 'api-version') || query.length > 1 || (query.length === 1 && !/^[0-9A-Za-z.-]{1,32}$/u.test(endpoint.searchParams.get('api-version')!))) {
      throw new MayuraError('INVALID_CONFIG', 'Remote compatible providers need an id, an HTTPS `/chat/completions` endpoint and at most an api-version query.');
    }
  }
  if (options.apiKey !== undefined && (typeof options.apiKey !== 'string' || !options.apiKey || /[\r\n]/u.test(options.apiKey) || options.apiKey.length > 4_096)) {
    throw new MayuraError('INVALID_CONFIG', 'Compatible provider credentials must be bounded header values.');
  }
  if (options.token !== undefined && (typeof options.token !== 'function' || options.apiKey !== undefined)) {
    throw new MayuraError('INVALID_CONFIG', 'Give either an apiKey or a token source, not both.');
  }
  const extraHeaders: Record<string, string> = {};
  if (options.headers !== undefined) {
    const entries = options.headers && typeof options.headers === 'object' ? Object.entries(options.headers) : undefined;
    if (!entries || entries.length > 8 || entries.some(([name, value]) => !/^[A-Za-z0-9-]{1,64}$/u.test(name) || ownedHeaders.has(name.toLowerCase())
      || typeof value !== 'string' || !value || /[\r\n]/u.test(value) || value.length > 8_192)) {
      throw new MayuraError('INVALID_CONFIG', 'headers must be at most 8 extra header values; they cannot replace Authorization, api-key, Content-Type, Host or cookies.');
    }
    for (const [name, value] of entries) extraHeaders[name] = value;
  }
  if (remote !== undefined && options.apiKey === undefined && options.token === undefined && Object.keys(extraHeaders).length === 0) {
    throw new MayuraError('INVALID_CONFIG', 'Remote compatible providers require an apiKey, a token source, or a credential header (such as a gateway token in headers).');
  }
  const outputMode = options.output ?? 'json_schema';
  if (outputMode !== 'json_schema' && outputMode !== 'json_object') throw new MayuraError('INVALID_CONFIG', 'output must be "json_schema" or "json_object".');
  if (options.strictTools !== undefined && typeof options.strictTools !== 'boolean') throw new MayuraError('INVALID_CONFIG', 'strictTools must be true or false.');
  const tokenLimitField = options.tokenLimitField ?? 'max_tokens';
  if (tokenLimitField !== 'max_tokens' && tokenLimitField !== 'max_completion_tokens') throw new MayuraError('INVALID_CONFIG', 'tokenLimitField must be "max_tokens" or "max_completion_tokens".');
  let extraBody: JsonObject = {};
  if (options.body !== undefined) {
    let copy: JsonValue;
    try { copy = jsonValue(options.body, { maxBytes: 16_384 }); } catch { throw new MayuraError('INVALID_CONFIG', 'body must be plain JSON of at most 16 KiB.'); }
    if (!copy || typeof copy !== 'object' || Array.isArray(copy)) throw new MayuraError('INVALID_CONFIG', 'body must be a JSON object of extra request fields.');
    const owned = Object.keys(copy).find(key => ownedFields.has(key));
    if (owned !== undefined) throw new MayuraError('INVALID_CONFIG', `body cannot set "${owned}"; the adapter sets it.`);
    extraBody = copy;
  }
  if (typeof options.model !== 'string' || !options.model.trim() || options.model.length > 128) throw new MayuraError('INVALID_CONFIG', 'A bounded local model ID is required.');
  const url = endpoint.href; const apiKey = options.apiKey; const tokenSource = options.token; const model = options.model;
  const fixedOutput = options.outputJsonSchema === undefined ? undefined : strictJsonSchema(options.outputJsonSchema, `The adapter's outputJsonSchema`);
  const authHeader = remote?.auth === 'api-key' ? 'api-key' : 'Authorization';
  const credential = async (): Promise<string | undefined> => {
    const value = tokenSource ? await tokenSource() : apiKey;
    if (value !== undefined && (typeof value !== 'string' || !value || /[\r\n]/u.test(value) || value.length > 8_192)) return failed();
    return value === undefined ? undefined : authHeader === 'api-key' ? value : `Bearer ${value}`;
  };
  const inputPrice = options.pricing.inputMicrosPerMillionTokens; const outputPrice = options.pricing.outputMicrosPerMillionTokens;
  for (const amount of [options.maxCostMicros, inputPrice, outputPrice]) if (!Number.isSafeInteger(amount) || amount < 0) throw new MayuraError('INVALID_CONFIG', 'Configured costs must be non-negative safe integers.');
  const maxRequestBytes = options.maxRequestBytes ?? 1_048_576; const maxResponseBytes = options.maxResponseBytes ?? 1_048_576;
  const timeoutMs = options.timeoutMs ?? 30_000;
  assertPositiveInteger(maxRequestBytes, 'maxRequestBytes'); assertPositiveInteger(maxResponseBytes, 'maxResponseBytes'); assertPositiveInteger(timeoutMs, 'timeoutMs');
  if (timeoutMs > 2_147_483_647) throw new MayuraError('INVALID_CONFIG', 'Provider timeout exceeds the supported timer range.');
  const transport = options.fetch ?? globalThis.fetch;
  if (typeof transport !== 'function') throw new MayuraError('INVALID_CONFIG', 'A fetch-compatible transport is required.');
  /** One Chat Completions call. With `onDelta` it streams, reporting content as it arrives; parsing is shared. */
  const call = async (request: ModelRequest, onDelta?: (text: string) => void, consumer?: AbortSignal): Promise<ModelResponse> => {
      const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), timeoutMs); let knownCost: number | undefined;
      try {
        const signal = AbortSignal.any([request.signal, controller.signal, ...(consumer ? [consumer] : [])]);
        if (signal.aborted) throw new MayuraError('CANCELLED', 'Provider request was cancelled.');
        // The run's private state: the provider's own earlier assistant turns, for the model and endpoint that made them.
        let assistants: JsonObject[] = [];
        if (request.continuation !== undefined) {
          const previous = object(jsonValue(request.continuation, { maxBytes: maxRequestBytes }));
          if (previous['provider'] !== 'openai-compatible.chat.v1' || previous['model'] !== model || previous['endpoint'] !== url || !Array.isArray(previous['assistants'])) return failed();
          assistants = previous['assistants'].map(item => object(item));
        }
        if (assistants.length > request.messages.filter(message => message.role === 'assistant').length) return failed();
        assertPositiveInteger(request.maxOutputTokens, 'maxOutputTokens');
        const aliases = new Map(modelToolNames(request.tools.map(tool => tool.id)));
        const ids = new Map([...aliases].map(([toolId, alias]) => [alias, toolId]));
        if (aliases.size !== request.tools.length || aliases.size > 128) return failed();
        const tools = request.tools.map(tool => ({ type: 'function', function: { name: aliases.get(tool.id)!, description: tool.description, parameters: toolSchema(tool),
          ...(options.strictTools ? { strict: true } : {}) } }));
        const outputSchema = outputSchemaFor(fixedOutput, request.outputJsonSchema);
        // JSON mode has no schema parameter, so the schema goes into the instructions; the answer is validated anyway.
        const instructions = outputMode === 'json_object'
          ? `${request.instructions}\n\nAnswer with one JSON object, and nothing else, that matches this JSON Schema:\n${JSON.stringify(outputSchema)}`
          : request.instructions;
        const body = JSON.stringify(jsonValue({ ...extraBody, model, stream: onDelta !== undefined, ...(onDelta ? { stream_options: { include_usage: true } } : {}),
          messages: [{ role: 'system', content: instructions }, ...compatibleMessages(request.messages, aliases, assistants)],
          ...(tools.length > 0 ? { tools, parallel_tool_calls: true } : {}), [tokenLimitField]: request.maxOutputTokens,
          response_format: outputMode === 'json_object' ? { type: 'json_object' } : { type: 'json_schema', json_schema: { name: 'mayura_output', strict: true, schema: outputSchema } },
        }, { maxBytes: maxRequestBytes }));
        const headers: Record<string, string> = { ...extraHeaders, 'Content-Type': 'application/json' };
        const authorization = await credential(); if (authorization !== undefined) headers[authHeader] = authorization;
        const response = await abortable(transport(url, { method: 'POST', headers, body, signal, redirect: 'error' }).catch((): never => failed('unavailable')), signal);
        const payload = onDelta ? await assembledCompletion(response, signal, onDelta) : await responseBody(response, maxResponseBytes, signal);
        const usage = object(payload['usage']);
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
          // Keep this turn as the provider sent it (with any reasoning) for the next call of the run.
          const continuation = jsonValue({ provider: 'openai-compatible.chat.v1', model, endpoint: url, assistants: [...assistants, assistantTurn(message)] }, { maxBytes: maxRequestBytes });
          return { type: 'tool_calls', calls, usage: { costMicros: knownCost }, continuation };
        }
        if (choice['finish_reason'] === 'length' || choice['finish_reason'] === 'content_filter' || typeof message['refusal'] === 'string') return failed('refused');
        if (choice['finish_reason'] === 'insufficient_system_resource' || choice['finish_reason'] === 'aborted') return failed('unavailable');
        if (choice['finish_reason'] !== 'stop' || typeof message['content'] !== 'string') return failed();
        return { type: 'final', output: jsonValue(JSON.parse(message['content']), { maxBytes: maxResponseBytes }), usage: { costMicros: knownCost } };
      } catch (error) {
        if (knownCost !== undefined) throw new ModelProviderError(reasonOf(error), { costMicros: knownCost });
        if (request.signal.aborted || controller.signal.aborted || consumer?.aborted) throw new MayuraError('CANCELLED', 'Provider request was cancelled or timed out.');
        if (error instanceof ModelProviderError) throw error;
        // A schema the provider would refuse, or no output schema at all, is the agent's configuration.
        if (error instanceof MayuraError && error.code === 'INVALID_CONFIG') return failed('configuration');
        return failed();
      } finally { clearTimeout(timer); }
  };
  /**
   * Rebuild the non-streamed completion from Chat Completions chunks: content deltas are reported as they arrive,
   * tool-call fragments are only assembled by index, and usage must arrive in a final chunk (`include_usage`).
   */
  const assembledCompletion = async (response: Response, signal: AbortSignal, onDelta: (text: string) => void): Promise<JsonObject> => {
    let content = ''; let reasoning = ''; let finish: JsonValue = null; let usage: JsonValue | undefined; let finished = false;
    const calls: { id?: JsonValue; name: string; arguments: string }[] = [];
    for await (const event of readServerSentEvents(response, { maxBytes: maxResponseBytes * 4, maxEventBytes: maxResponseBytes, signal })) {
      if (finished) return failed();
      if (event.data.trim() === '[DONE]') { finished = true; continue; }
      const chunk = object(jsonValue(JSON.parse(event.data), { maxBytes: maxResponseBytes }));
      if (chunk['usage'] !== undefined && chunk['usage'] !== null) usage = chunk['usage'];
      const choices = chunk['choices'];
      if (!Array.isArray(choices) || choices.length > 1) return failed();
      if (choices.length === 0) continue;
      const choice = object(choices[0]);
      if (choice['finish_reason'] !== undefined && choice['finish_reason'] !== null) finish = choice['finish_reason'];
      if (choice['delta'] === undefined || choice['delta'] === null) continue;
      const delta = object(choice['delta']);
      if (typeof delta['content'] === 'string' && delta['content']) { content += delta['content']; onDelta(delta['content']); }
      // Reasoning is kept only to send back with the turn; it is never released as output.
      if (typeof delta['reasoning_content'] === 'string') reasoning += delta['reasoning_content'];
      if (delta['tool_calls'] !== undefined && delta['tool_calls'] !== null) {
        if (!Array.isArray(delta['tool_calls'])) return failed();
        for (const raw of delta['tool_calls']) {
          const fragment = object(raw); const index = integer(fragment['index']);
          if (index > calls.length || index >= 128) return failed();
          const entry = calls[index] ?? (calls[index] = { name: '', arguments: '' });
          if (fragment['id'] !== undefined && fragment['id'] !== null) entry.id = fragment['id'];
          const fn = fragment['function'] === undefined || fragment['function'] === null ? {} : object(fragment['function']);
          if (typeof fn['name'] === 'string') entry.name += fn['name'];
          if (typeof fn['arguments'] === 'string') entry.arguments += fn['arguments'];
        }
      }
    }
    if (!finished || usage === undefined) return failed();
    const message: JsonObject = { role: 'assistant', content: calls.length > 0 && !content ? null : content, ...(reasoning ? { reasoning_content: reasoning } : {}),
      ...(calls.length > 0 ? { tool_calls: calls.map(entry => ({ type: 'function', id: entry.id ?? null, function: { name: entry.name, arguments: entry.arguments } })) } : {}) };
    return { choices: [{ message, finish_reason: finish }], usage };
  };
  return Object.freeze({ id: remote ? `openai-compatible.${remote.id}` : 'openai-compatible.chat', capabilities: Object.freeze({ tools: true, structuredOutput: true }), maxCostMicros: options.maxCostMicros,
    checkDefinition: (definition: ModelDefinitionCheck): void => checkStrictDefinition(definition, fixedOutput),
    generate: (request: ModelRequest): Promise<ModelResponse> => call(request),
    stream: (request: ModelRequest): AsyncIterable<ModelStreamEvent> => streamModelCall((onDelta, consumer) => call(request, onDelta, consumer)),
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
        return failed(error instanceof TypeError ? 'unavailable' : 'invalid_response');
      } finally { clearTimeout(timer); }
    },
  });
}
