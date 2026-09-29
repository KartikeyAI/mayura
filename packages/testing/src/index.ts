import { Budget, MayuraError, MEDIA_TYPES, jsonValue, mediaFromBase64, type ExecutionReceipt, type Media, type ModelAdapter, type ModelMediaCapability, type ModelRequest, type ModelResponse, type ModelStreamEvent, type Outcome, type Scope } from '@mayura/core';
import { invokeTool, type AnyTool, type ToolOutput } from '@mayura/tools';

/**
 * Deterministic test-only model. It never performs inference or network requests.
 * Each call consumes a scripted response; exhaustion is an error, not a fabricated answer.
 *
 * It also streams, for agents with a stream policy: a final answer arrives as `output.delta` pieces of its JSON text
 * (`streamChunk` characters each, 16 by default), then the complete response, exactly as a provider adapter streams.
 *
 * It can "see" every media type and URLs, so agents that accept images or PDFs can be tested; a scripted step receives
 * the request with its `media`. Pass `media: false` to test a model that cannot see.
 */
export function scriptedModel(
  responses: readonly (ModelResponse | ((request: ModelRequest) => ModelResponse | Promise<ModelResponse>))[],
  options: { readonly id?: string; readonly maxCostMicros?: number; readonly streamChunk?: number; readonly media?: ModelMediaCapability | false } = {},
): ModelAdapter {
  const steps = [...responses];
  let position = 0;
  const chunk = options.streamChunk ?? 16;
  if (!Number.isSafeInteger(chunk) || chunk < 1) throw new MayuraError('INVALID_CONFIG', 'streamChunk must be a positive integer.');
  const next = async (request: ModelRequest): Promise<ModelResponse> => {
    request.signal.throwIfAborted();
    const response = steps[position++];
    if (!response) throw new MayuraError('MODEL_FAILED', 'The test model script is exhausted.');
    const result = typeof response === 'function' ? await response(request) : response;
    // Copy snapshots so a runtime cannot mutate a later test's scripted response.
    return jsonValue(result) as unknown as ModelResponse;
  };
  return Object.freeze({
    id: options.id ?? 'scripted',
    capabilities: Object.freeze({ tools: true, structuredOutput: true,
      ...(options.media === false ? {} : { media: options.media ?? Object.freeze({ types: MEDIA_TYPES, urls: true }) }) }),
    maxCostMicros: options.maxCostMicros ?? 0,
    generate: next,
    async *stream(request: ModelRequest): AsyncIterable<ModelStreamEvent> {
      const response = await next(request);
      if (response.type === 'final') {
        const text = JSON.stringify(response.output);
        for (let index = 0; index < text.length; index += chunk) { request.signal.throwIfAborted(); yield { type: 'output.delta', text: text.slice(index, index + chunk) }; }
      }
      yield { type: 'response', response };
    },
  });
}

/** A real 1×1 PNG, for tests of agents and tools that take or return images. */
export function testImage(options: { readonly name?: string } = {}): Media {
  return mediaFromBase64('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'image/png', options);
}
/** A minimal one-page PDF, for tests of agents and tools that take or return documents. */
export function testPdf(options: { readonly name?: string } = {}): Media {
  const text = ['%PDF-1.4', '1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj', '2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj',
    '3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 72 72]>>endobj', 'trailer<</Root 1 0 R>>', '%%EOF', ''].join('\n');
  return mediaFromBase64(btoa(text), 'application/pdf', options);
}

/** The grants a tool needs to run: `tool:<id>`, each of its capabilities, and its effect (unless it has none). */
export function toolGrants(tool: AnyTool): readonly string[] {
  return [`tool:${tool.id}`, ...tool.capabilities, ...(tool.effects === 'none' ? [] : [`effect:${tool.effects}`])];
}

export interface TestToolOptions {
  /** What the call is allowed; the default is exactly what the tool needs (`toolGrants`). */
  readonly permissions?: readonly string[];
  readonly scope?: Scope;
  /** The budget for the call, in micros; the default is the tool's own `costMicros`. */
  readonly budgetMicros?: number;
  readonly signal?: AbortSignal;
  readonly runId?: string;
  readonly callId?: string;
}

export interface TestToolResult<T extends AnyTool> {
  /** The outcome, exactly as a run would see it: checked input, the tool's effect and cost rules, checked output. */
  readonly outcome: Outcome<ToolOutput<T>>;
  /** What the call was charged: known cost, and cost still unresolved (an uncertain call keeps its reservation). */
  readonly spentMicros: number;
  readonly reservedMicros: number;
  /** The execution record Mayura keeps for the call, when it started. */
  readonly receipt: ExecutionReceipt | undefined;
}

/**
 * Run one tool through Mayura's broker, as an agent's call would, without an agent, model or runtime: permissions,
 * input and output validation, guards, timeout, cost and the `outcome_unknown` rules all apply. For unit tests.
 */
export async function testTool<T extends AnyTool>(tool: T, input: unknown, options: TestToolOptions = {}): Promise<TestToolResult<T>> {
  const budget = new Budget(options.budgetMicros ?? tool.costMicros, 1);
  let receipt: ExecutionReceipt | undefined;
  const outcome = await invokeTool(tool, input, {
    runId: options.runId ?? 'test-run', callId: options.callId ?? 'test-call',
    scope: options.scope ?? { principalId: 'test', projectId: 'test' }, signal: options.signal ?? new AbortController().signal,
    permissions: { allow: [...(options.permissions ?? toolGrants(tool))] }, budget,
    onExecutionReceipt: async evidence => { receipt = evidence; },
  });
  const snapshot = budget.snapshot();
  return { outcome, spentMicros: Number(snapshot.spentMicros), reservedMicros: snapshot.reservedMicros, receipt: outcome.receipt ?? receipt };
}
export { conformanceTools, expectedCostMicros, modelAdapterConformance, type ConformanceModelSettings, type ModelAdapterHarness, type ModelConformanceCase, type ModelScenario, type ModelScenarioKind } from './model-conformance.js';
