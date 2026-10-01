import type { PublicError } from './errors.js';
import { MayuraError } from './errors.js';
import type { JsonValue, JsonObject } from './json.js';
import type { Media, MediaType } from './media.js';

export interface Scope { readonly principalId: string; readonly projectId: string }
export type Effect = 'none' | 'read' | 'write' | 'host';
export interface Permissions { readonly allow: readonly string[] }
export interface ExecutionContext {
  readonly runId: string;
  readonly callId: string;
  readonly scope: Scope;
  readonly signal: AbortSignal;
}
export interface ExecutionReceipt {
  readonly callId: string;
  readonly toolId: string;
  readonly execution: 'not_started' | 'succeeded' | 'failed' | 'unknown';
  readonly disclosure: 'released' | 'withheld';
}
/** Confirmed and unresolved cost within one pre-admitted execution bound. */
export interface ExecutionSettlement {
  readonly knownCostMicros: number;
  readonly unknownCostMicros: number;
}
/** Run-qualified evidence: call identifiers alone are not unique across descendants. */
export interface ExecutionEvidence {
  readonly runId: string;
  readonly receipt: ExecutionReceipt;
}
export type Outcome<T> =
  | { readonly status: 'succeeded'; readonly output: T; readonly receipt?: ExecutionReceipt; readonly evidence?: readonly ExecutionEvidence[] }
  | { readonly status: 'failed' | 'blocked' | 'cancelled' | 'outcome_unknown'; readonly error: PublicError; readonly receipt?: ExecutionReceipt; readonly evidence?: readonly ExecutionEvidence[] };
export interface RunEvent {
  readonly runId: string;
  readonly sequence: number;
  readonly timestamp: string;
  readonly type: 'run.started' | 'model.started' | 'model.completed' | 'tool.started' | 'tool.completed'
    | 'hook.started' | 'hook.completed' | 'step.started' | 'step.completed' | 'delegate.started' | 'delegate.completed'
    | 'run.completed' | 'events.gap' | 'output.delta' | 'output.withheld';
  readonly metadata: Readonly<Record<string, string | number | boolean>>;
}
export interface RunHandle<T> {
  readonly id: string;
  readonly profile: 'ephemeral';
  result(): Promise<Outcome<T>>;
  observe(options?: { readonly after?: number; readonly signal?: AbortSignal }): AsyncIterable<RunEvent>;
  cancel(): void;
}
export interface GuardContext extends ExecutionContext { readonly boundary: 'input' | 'output' }
/**
 * A guard allows content, blocks it, or rewrites it (for example to redact personal data). A rewritten value replaces
 * the content for the guards after it and is validated again against the boundary's schema before anything uses it.
 */
export type GuardVerdict = { readonly decision: 'allow' } | { readonly decision: 'block'; readonly reason?: string }
  | { readonly decision: 'rewrite'; readonly value: JsonValue };
export interface Guard {
  readonly id: string;
  check(value: JsonValue, context: GuardContext): Promise<GuardVerdict> | GuardVerdict;
}
export interface ModelTool {
  readonly id: string;
  readonly description: string;
  readonly inputJsonSchema?: JsonObject;
}
/**
 * One message of a model conversation. `media` holds images or PDFs the model should see: with the user's input, or
 * returned by a tool. It is present only when there is some, and only for adapters that declare `capabilities.media`.
 */
export type ModelMessage =
  | { readonly role: 'user'; readonly content: JsonValue; readonly media?: readonly Media[] }
  | { readonly role: 'assistant'; readonly calls: readonly ModelToolCall[] }
  | { readonly role: 'tool'; readonly callId: string; readonly toolId: string; readonly result: JsonValue; readonly media?: readonly Media[] };
export interface ModelToolCall { readonly id: string; readonly toolId: string; readonly input: JsonValue }
export interface ModelRequest {
  readonly instructions: string;
  readonly messages: readonly ModelMessage[];
  readonly tools: readonly ModelTool[];
  readonly signal: AbortSignal;
  readonly maxOutputTokens: number;
  /** Opaque bounded provider protocol state; private to this run and never a public output. */
  readonly continuation?: JsonValue;
  /**
   * The agent's output as JSON Schema: what the final answer must look like. The runtime sends it when the agent has
   * one (given, or generated from its output validator); an adapter configured with its own output schema uses that.
   */
  readonly outputJsonSchema?: JsonObject;
}
/**
 * What `defineAgent` asks an adapter to check once, before any run: the tools and output schema it would be sent, and
 * the media the agent accepts with its input or its tools may return.
 */
export interface ModelDefinitionCheck {
  readonly tools: readonly ModelTool[];
  readonly outputJsonSchema?: JsonObject;
  readonly media?: { readonly types: readonly MediaType[]; readonly urls: boolean };
}
/** The media a model can see: which types, and whether it can take a URL (which its provider then fetches). */
export interface ModelMediaCapability { readonly types: readonly MediaType[]; readonly urls: boolean }
export interface ModelUsage {
  readonly costMicros: number;
  /** The input (prompt) tokens the provider billed, cached ones included, when it reports them. */
  readonly inputTokens?: number;
  /** The output tokens the provider billed, reasoning included, when it reports them. */
  readonly outputTokens?: number;
}
/** A failed provider invocation may still have confirmed billable usage. No raw failure text is accepted. */
export class ModelInvocationError extends MayuraError {
  constructor(readonly costMicros: number) {
    super('MODEL_FAILED', 'The model invocation failed after reporting known usage.');
    if (!Number.isSafeInteger(costMicros) || costMicros < 0) throw new MayuraError('INVALID_CONFIG', 'Known model usage must be a nonnegative safe integer.');
    Object.freeze(this);
  }
}
/**
 * Why a model call failed, in words Mayura can show safely. An adapter picks the reason; the message is Mayura's own,
 * so no provider text or credential can reach an outcome through it.
 */
export type ModelFailureReason = 'authentication' | 'rate_limited' | 'unavailable' | 'timeout' | 'rejected' | 'invalid_response' | 'refused' | 'configuration';
const modelFailureReasons: readonly ModelFailureReason[] = ['authentication', 'rate_limited', 'unavailable', 'timeout', 'rejected', 'invalid_response', 'refused', 'configuration'];
export function isModelFailureReason(value: unknown): value is ModelFailureReason { return modelFailureReasons.includes(value as ModelFailureReason); }
/** The fixed public message for a failure reason, with the provider's HTTP status when there is one. */
export function modelFailureMessage(reason: ModelFailureReason, httpStatus?: number): string {
  const status = httpStatus === undefined ? '' : ` (HTTP ${httpStatus})`;
  switch (reason) {
    case 'authentication': return `The model provider refused the credentials or access to this model${status}. Check the API key and that it may use this model.`;
    case 'rate_limited': return `The model provider's rate limit or quota was reached${status}. Try again later, or raise the limit with the provider.`;
    case 'unavailable': return `The model provider was unavailable${status}. Try again later.`;
    case 'timeout': return `The model provider did not answer in time. Try again, or raise the adapter's timeoutMs.`;
    case 'rejected': return `The model provider rejected the request${status}. Check the model name and the adapter's settings.`;
    case 'invalid_response': return 'The model provider returned a response Mayura could not use, for example an answer that is not the required JSON or no token usage.';
    case 'refused': return 'The model refused to answer, or stopped before finishing (for example at its token limit).';
    case 'configuration': return `The model adapter could not send this request: a tool's input schema or the output schema breaks the provider's rules, no output schema was given, or the request holds media this provider cannot take.`;
  }
}
/** A model call that failed for a known reason. `costMicros`, when given, is usage the provider confirmed before failing. */
export class ModelProviderError extends MayuraError {
  readonly reason: ModelFailureReason;
  /** Present only when the provider answered with an HTTP error status. */
  declare readonly httpStatus?: number;
  /** Present only when the provider confirmed usage before the failure. */
  declare readonly costMicros?: number;
  constructor(reason: ModelFailureReason, options: { readonly httpStatus?: number; readonly costMicros?: number } = {}) {
    if (!isModelFailureReason(reason)) throw new MayuraError('INVALID_CONFIG', 'Unknown model failure reason.');
    const { httpStatus, costMicros } = options;
    if (httpStatus !== undefined && (!Number.isSafeInteger(httpStatus) || httpStatus < 100 || httpStatus > 599)) throw new MayuraError('INVALID_CONFIG', 'An HTTP status must be between 100 and 599.');
    if (costMicros !== undefined && (!Number.isSafeInteger(costMicros) || costMicros < 0)) throw new MayuraError('INVALID_CONFIG', 'Known model usage must be a nonnegative safe integer.');
    super(reason === 'configuration' ? 'INVALID_CONFIG' : 'MODEL_FAILED', modelFailureMessage(reason, httpStatus));
    this.reason = reason;
    if (httpStatus !== undefined) Object.defineProperty(this, 'httpStatus', { value: httpStatus, enumerable: true });
    if (costMicros !== undefined) Object.defineProperty(this, 'costMicros', { value: costMicros, enumerable: true });
    Object.freeze(this);
  }
}
export type ModelResponse =
  | { readonly type: 'final'; readonly output: JsonValue; readonly usage: ModelUsage; readonly continuation?: JsonValue }
  | { readonly type: 'tool_calls'; readonly calls: readonly ModelToolCall[]; readonly usage: ModelUsage; readonly continuation?: JsonValue };
/** Model adapters are trusted code; declared bounds are enforced/accounted, not a provider billing guarantee. */
/**
 * One event of a streamed model call: fragments of the final output's raw text as the provider produces them, then
 * exactly one complete response. The complete response is validated and accounted exactly as `generate` would return
 * it; fragments are provisional and never authoritative. Tool-call argument fragments and reasoning are never emitted.
 */
export type ModelStreamEvent =
  | { readonly type: 'output.delta'; readonly text: string }
  | { readonly type: 'response'; readonly response: ModelResponse };
export interface ModelAdapter {
  readonly id: string;
  /** What the model can do. Without `media`, it cannot see images or PDFs, and agents that accept media refuse it. */
  readonly capabilities: { readonly tools: boolean; readonly structuredOutput: boolean; readonly media?: ModelMediaCapability };
  readonly maxCostMicros: number;
  generate(request: ModelRequest): Promise<ModelResponse>;
  /** Optional streamed form of `generate`, used only for agents that opt into streaming. */
  stream?(request: ModelRequest): AsyncIterable<ModelStreamEvent>;
  /**
   * Optional: called by `defineAgent` with the agent's tools and output schema. Throw INVALID_CONFIG, with a message
   * that says what to fix, when this adapter could never send them (for example a schema its provider refuses), so the
   * mistake shows when the agent is defined instead of on its first call.
   */
  checkDefinition?(definition: ModelDefinitionCheck): void;
}
