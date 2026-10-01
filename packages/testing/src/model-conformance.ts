import { tokenCostMicros, type TokenPricing } from '@mayura/core/host';
import { MayuraError, ModelProviderError, type JsonObject, type JsonValue, type ModelAdapter, type ModelRequest, type ModelResponse, type ModelStreamEvent, type ModelTool } from '@mayura/core';

/**
 * What a provider's fake transport must answer with. The harness turns each scenario into the provider's own wire
 * format (through the vendor SDK's `fetch` option or request handler), so the adapter parses a realistic response.
 */
export type ModelScenario =
  | { readonly kind: 'final'; readonly output: JsonObject; readonly inputTokens: number; readonly outputTokens: number }
  | { readonly kind: 'tool_calls'; readonly calls: readonly { readonly toolId: string; readonly input: JsonObject }[]; readonly inputTokens: number; readonly outputTokens: number }
  | { readonly kind: 'stream_final'; readonly chunks: readonly string[]; readonly output: JsonObject; readonly inputTokens: number; readonly outputTokens: number }
  /** The provider declined to answer (a refusal, a content filter, or output cut off by the token limit). */
  | { readonly kind: 'refusal' }
  /**
   * An HTTP error. The body must contain `detail`, text that must never reach Mayura's error messages.
   * For status 200 with `invalid: true`, the body is well-formed HTTP but not a valid provider response.
   */
  | { readonly kind: 'http'; readonly status: number; readonly detail: string }
  | { readonly kind: 'invalid'; readonly detail: string }
  /** The connection fails before any response. */
  | { readonly kind: 'network' }
  /** No response ever arrives; only the signal or the timeout ends the call. */
  | { readonly kind: 'hang' };

export type ModelScenarioKind = ModelScenario['kind'];
/** What a harness can skip: a scenario, or `long_context` (charging long-context rates) for an adapter with flat prices. */
export type ModelConformanceKind = ModelScenarioKind | 'long_context';

/** What a model registry passes a provider: the adapter must use this id and cost bound. */
export interface ConformanceModelSettings {
  readonly id: string;
  readonly pricing: TokenPricing;
  readonly maxCostMicros: number;
  readonly timeoutMs?: number;
}

export interface ModelAdapterHarness {
  /** A fresh adapter whose transport answers `scenario`. */
  adapter(scenario: ModelScenario, settings: ConformanceModelSettings): ModelAdapter;
  /** Scenarios this provider cannot produce, with the reason; they are reported as skipped. */
  readonly skip?: Partial<Record<ModelConformanceKind, string>>;
}

export interface ModelConformanceCase {
  readonly name: string;
  /** Runs the case; throws an `Error` describing the first broken expectation. Resolves `'skipped'` when skipped. */
  run(harness: ModelAdapterHarness): Promise<'passed' | 'skipped'>;
}

const settings: ConformanceModelSettings = {
  id: 'conformance/model-1', maxCostMicros: 50_000,
  pricing: { inputMicrosPerMillionTokens: 1_250_000, outputMicrosPerMillionTokens: 10_000_000 },
};
const outputSchema: JsonObject = { type: 'object', properties: { answer: { type: 'string' } }, required: ['answer'], additionalProperties: false };
/** The tools the tool-call cases offer; a harness can find each one in the provider request by its description. */
export const conformanceTools: readonly ModelTool[] = [
  { id: 'orders.lookup', description: 'Look up an order.', inputJsonSchema: { type: 'object', properties: { orderId: { type: 'string' } }, required: ['orderId'], additionalProperties: false } },
  { id: 'orders.refund', description: 'Refund an order.', inputJsonSchema: { type: 'object', properties: { orderId: { type: 'string' }, amountCents: { type: 'integer' } }, required: ['orderId', 'amountCents'], additionalProperties: false } },
];
const identifier = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/u;
const detail = 'PRIVATE-PROVIDER-DETAIL-7f3a';

/** What the adapter must report for the scenario's token counts: rounded up to a whole micro. */
export function expectedCostMicros(inputTokens: number, outputTokens: number, pricing: TokenPricing = settings.pricing): number {
  return tokenCostMicros(pricing, inputTokens, outputTokens)!;
}

const request = (signal: AbortSignal = new AbortController().signal, withTools = false): ModelRequest => ({
  instructions: 'You answer questions about orders.', signal, maxOutputTokens: 256, outputJsonSchema: outputSchema,
  messages: [{ role: 'user', content: 'Where is order ord-1?' }], tools: withTools ? conformanceTools : [],
});

class ConformanceFailure extends Error {}
function check(condition: unknown, message: string): asserts condition { if (!condition) throw new ConformanceFailure(message); }
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

async function failure(call: () => Promise<unknown>): Promise<unknown> {
  try { await call(); } catch (error) { return error; }
  throw new ConformanceFailure('The call succeeded, but it should have failed.');
}
function checkFailure(error: unknown, reason: string, where: string): void {
  check(error instanceof ModelProviderError, `${where}: expected a ModelProviderError, got ${error instanceof Error ? error.constructor.name : typeof error}.`);
  check(error.reason === reason, `${where}: expected reason ${reason}, got ${error.reason}.`);
  checkQuiet(error, where);
}
function checkQuiet(error: unknown, where: string): void {
  const text = error instanceof Error ? `${error.message} ${String(error.stack ?? '')} ${JSON.stringify(error)}` : String(error);
  check(!text.includes(detail), `${where}: the provider's own error text reached the error.`);
}
/** Token counts are optional, but an adapter that reports them reports what the provider billed. */
function checkTokens(response: ModelResponse, scenario: { readonly inputTokens: number; readonly outputTokens: number }, where: string): void {
  if (response.usage.inputTokens !== undefined) check(response.usage.inputTokens === scenario.inputTokens, `${where}: inputTokens must be ${scenario.inputTokens}, got ${response.usage.inputTokens}.`);
  if (response.usage.outputTokens !== undefined) check(response.usage.outputTokens === scenario.outputTokens, `${where}: outputTokens must be ${scenario.outputTokens}, got ${response.usage.outputTokens}.`);
}
function checkResponseShape(response: ModelResponse, where: string): void {
  check(response && (response.type === 'final' || response.type === 'tool_calls'), `${where}: the response type must be final or tool_calls.`);
  const keys = Object.keys(response).sort().join(',');
  const allowed = response.type === 'final' ? ['output', 'type', 'usage'] : ['calls', 'type', 'usage'];
  check(keys === allowed.join(',') || keys === [...allowed, 'continuation'].sort().join(','), `${where}: unexpected response fields ${keys}.`);
  const usageKeys = Object.keys(response.usage);
  check(usageKeys.includes('costMicros') && usageKeys.every(key => key === 'costMicros' || key === 'inputTokens' || key === 'outputTokens')
    && usageKeys.every(key => { const value = (response.usage as unknown as Record<string, unknown>)[key]; return Number.isSafeInteger(value) && (value as number) >= 0; }),
  `${where}: usage must be { costMicros } and optionally inputTokens and outputTokens, each a non-negative integer.`);
  if (response.continuation !== undefined) check(JSON.stringify(response.continuation).length <= 1_048_576, `${where}: the continuation must be bounded JSON.`);
}

const scenarios = {
  final: { kind: 'final', output: { answer: 'Order ord-1 shipped yesterday.' }, inputTokens: 1_234, outputTokens: 56 },
  toolCalls: { kind: 'tool_calls', calls: [{ toolId: 'orders.lookup', input: { orderId: 'ord-1' } }, { toolId: 'orders.refund', input: { orderId: 'ord-1', amountCents: 499 } }], inputTokens: 800, outputTokens: 40 },
  streamFinal: { kind: 'stream_final', chunks: ['{"answer":"Order ', 'ord-1 shipped ', 'yesterday."}'], output: { answer: 'Order ord-1 shipped yesterday.' }, inputTokens: 900, outputTokens: 12 },
} as const satisfies Record<string, ModelScenario>;

const cases: readonly { name: string; kind: ModelConformanceKind; run: (harness: ModelAdapterHarness) => Promise<void> }[] = [
  { name: 'uses the id and cost bound it was given', kind: 'final', run: async harness => {
    const adapter = harness.adapter(scenarios.final, settings);
    check(adapter.id === settings.id, `The adapter id is ${adapter.id}, not ${settings.id}.`);
    check(adapter.maxCostMicros === settings.maxCostMicros, 'The adapter must use the maxCostMicros it was given.');
    check(typeof adapter.capabilities.tools === 'boolean' && typeof adapter.capabilities.structuredOutput === 'boolean', 'Capabilities must be explicit booleans.');
  } },
  { name: 'returns the structured output, costed from the token counts', kind: 'final', run: async harness => {
    const response = await harness.adapter(scenarios.final, settings).generate(request());
    checkResponseShape(response, 'final');
    check(response.type === 'final' && same(response.output, scenarios.final.output), 'The final output must be the parsed JSON the provider returned.');
    const cost = expectedCostMicros(scenarios.final.inputTokens, scenarios.final.outputTokens);
    check(response.usage.costMicros === cost, `The cost must be ${cost} micros (tokens × prices, rounded up), got ${response.usage.costMicros}.`);
    checkTokens(response, scenarios.final, 'final');
  } },
  { name: 'charges the long-context rates for the whole call above their threshold', kind: 'long_context', run: async harness => {
    const pricing: TokenPricing = { ...settings.pricing, longContext: { aboveInputTokens: 10_000, inputMicrosPerMillionTokens: 2_500_000, outputMicrosPerMillionTokens: 15_000_000 } };
    const scenario = { kind: 'final', output: { answer: 'A long report.' }, inputTokens: 12_000, outputTokens: 300 } as const;
    const long = await harness.adapter(scenario, { ...settings, pricing }).generate(request());
    const expected = expectedCostMicros(12_000, 300, pricing);
    check(long.usage.costMicros === expected, `Above aboveInputTokens the whole call is charged at the long-context rates: ${expected} micros, got ${long.usage.costMicros}.`);
    const short = await harness.adapter({ ...scenario, inputTokens: 9_000 }, { ...settings, pricing }).generate(request());
    check(short.usage.costMicros === expectedCostMicros(9_000, 300), 'At or below the threshold the standard rates apply.');
  } },
  { name: 'returns tool calls with their Mayura tool ids, valid call ids and parsed input', kind: 'tool_calls', run: async harness => {
    const response = await harness.adapter(scenarios.toolCalls, settings).generate(request(undefined, true));
    checkResponseShape(response, 'tool_calls');
    check(response.type === 'tool_calls', 'Expected tool calls.');
    check(same(response.calls.map(call => [call.toolId, call.input]), scenarios.toolCalls.calls.map(call => [call.toolId, call.input])), 'Each call must name the Mayura tool id and carry its parsed input, in order.');
    check(response.calls.every(call => identifier.test(call.id)) && new Set(response.calls.map(call => call.id)).size === response.calls.length, 'Call ids must be unique identifiers.');
    check(response.usage.costMicros === expectedCostMicros(scenarios.toolCalls.inputTokens, scenarios.toolCalls.outputTokens), 'Tool-call responses must be costed like final ones.');
    checkTokens(response, scenarios.toolCalls, 'tool_calls');
  } },
  { name: 'streams output deltas, then exactly one response', kind: 'stream_final', run: async harness => {
    const adapter = harness.adapter(scenarios.streamFinal, settings);
    check(typeof adapter.stream === 'function', 'The adapter must implement stream().');
    const events: ModelStreamEvent[] = []; for await (const event of adapter.stream!(request())) events.push(event);
    const last = events.at(-1);
    check(last?.type === 'response' && events.filter(event => event.type === 'response').length === 1, 'A stream must end with exactly one response event.');
    check(events.slice(0, -1).map(event => event.type === 'output.delta' ? event.text : '').join('') === scenarios.streamFinal.chunks.join(''), 'The deltas must add up to the streamed text.');
    checkResponseShape(last.response, 'stream');
    check(last.response.type === 'final' && same(last.response.output, scenarios.streamFinal.output), 'The streamed response must carry the parsed output.');
    check(last.response.usage.costMicros === expectedCostMicros(scenarios.streamFinal.inputTokens, scenarios.streamFinal.outputTokens), 'A streamed response must be costed from its usage.');
    checkTokens(last.response, scenarios.streamFinal, 'stream');
  } },
  { name: 'reports a refusal as refused', kind: 'refusal', run: async harness => {
    checkFailure(await failure(() => harness.adapter({ kind: 'refusal' }, settings).generate(request())), 'refused', 'refusal');
  } },
  { name: 'maps HTTP errors to reasons without the provider text', kind: 'http', run: async harness => {
    for (const [status, reason] of [[400, 'rejected'], [401, 'authentication'], [403, 'authentication'], [429, 'rate_limited'], [500, 'unavailable'], [503, 'unavailable']] as const) {
      const error = await failure(() => harness.adapter({ kind: 'http', status, detail }, settings).generate(request()));
      checkFailure(error, reason, `HTTP ${status}`);
    }
  } },
  { name: 'reports a failed connection as unavailable', kind: 'network', run: async harness => {
    checkFailure(await failure(() => harness.adapter({ kind: 'network' }, settings).generate(request())), 'unavailable', 'network');
  } },
  { name: 'reports an unusable response as invalid_response', kind: 'invalid', run: async harness => {
    checkFailure(await failure(() => harness.adapter({ kind: 'invalid', detail }, settings).generate(request())), 'invalid_response', 'invalid');
  } },
  { name: 'stops when the caller cancels', kind: 'hang', run: async harness => {
    const controller = new AbortController();
    const pending = harness.adapter({ kind: 'hang' }, settings).generate(request(controller.signal));
    setTimeout(() => controller.abort(), 20);
    const error = await Promise.race([failure(() => pending), new Promise(resolve => setTimeout(() => resolve('still running'), 5_000))]);
    check(error !== 'still running', 'The call must stop when its signal aborts.');
    check(error instanceof MayuraError && (error.code === 'CANCELLED' || (error instanceof ModelProviderError && error.reason === 'timeout')), 'A cancelled call must fail with CANCELLED.');
  } },
  { name: 'stops at its timeout', kind: 'hang', run: async harness => {
    const error = await Promise.race([
      failure(() => harness.adapter({ kind: 'hang' }, { ...settings, timeoutMs: 150 }).generate(request())),
      new Promise(resolve => setTimeout(() => resolve('still running'), 5_000)),
    ]);
    check(error !== 'still running', 'The call must stop at timeoutMs.');
    check(error instanceof MayuraError && (error.code === 'CANCELLED' || (error instanceof ModelProviderError && error.reason === 'timeout')), 'A timed-out call must fail with CANCELLED or reason timeout.');
    checkQuiet(error, 'timeout');
  } },
  { name: 'refuses tool schemas that are not strict, before any call', kind: 'final', run: async harness => {
    const adapter = harness.adapter(scenarios.final, settings);
    if (!adapter.checkDefinition) return;
    const loose: ModelTool = { id: 'loose.tool', description: 'Loose.', inputJsonSchema: { type: 'object', properties: { x: { type: 'string' } } } as JsonValue as JsonObject };
    const error = await failure(async () => adapter.checkDefinition!({ tools: [loose], outputJsonSchema: outputSchema }));
    check(error instanceof MayuraError && error.code === 'INVALID_CONFIG', 'checkDefinition must refuse a tool schema that is not strict with INVALID_CONFIG.');
  } },
];

/**
 * The contract every model adapter must keep, as test cases any test runner can run. A provider package supplies a
 * harness that makes its adapter's transport answer each scenario, then runs every case:
 *
 * ```ts
 * for (const test of modelAdapterConformance) it(test.name, () => test.run(harness));
 * ```
 *
 * The cases check response shapes, costs, tool calls, streaming, error reasons, that provider error text never leaks,
 * cancellation, timeouts and strict schemas.
 */
export const modelAdapterConformance: readonly ModelConformanceCase[] = Object.freeze(cases.map(({ name, kind, run }) => Object.freeze({
  name,
  async run(harness: ModelAdapterHarness): Promise<'passed' | 'skipped'> {
    if (harness.skip?.[kind] !== undefined) return 'skipped';
    await run(harness);
    return 'passed';
  },
})));
