import type { PublicError } from './errors.js';
import { MayuraError } from './errors.js';
import type { JsonValue, JsonObject } from './json.js';

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
export type GuardVerdict = { readonly decision: 'allow' } | { readonly decision: 'block'; readonly reason?: string };
export interface Guard {
  readonly id: string;
  check(value: JsonValue, context: GuardContext): Promise<GuardVerdict> | GuardVerdict;
}
export interface ModelTool {
  readonly id: string;
  readonly description: string;
  readonly inputJsonSchema?: JsonObject;
}
export type ModelMessage =
  | { readonly role: 'user'; readonly content: JsonValue }
  | { readonly role: 'assistant'; readonly calls: readonly ModelToolCall[] }
  | { readonly role: 'tool'; readonly callId: string; readonly toolId: string; readonly result: JsonValue };
export interface ModelToolCall { readonly id: string; readonly toolId: string; readonly input: JsonValue }
export interface ModelRequest {
  readonly instructions: string;
  readonly messages: readonly ModelMessage[];
  readonly tools: readonly ModelTool[];
  readonly signal: AbortSignal;
  readonly maxOutputTokens: number;
  /** Opaque bounded provider protocol state; private to this run and never a public output. */
  readonly continuation?: JsonValue;
}
export interface ModelUsage { readonly costMicros: number }
/** A failed provider invocation may still have confirmed billable usage. No raw failure text is accepted. */
export class ModelInvocationError extends MayuraError {
  constructor(readonly costMicros: number) {
    super('MODEL_FAILED', 'The model invocation failed after reporting known usage.');
    if (!Number.isSafeInteger(costMicros) || costMicros < 0) throw new MayuraError('INVALID_CONFIG', 'Known model usage must be a nonnegative safe integer.');
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
  readonly capabilities: { readonly tools: boolean; readonly structuredOutput: boolean };
  readonly maxCostMicros: number;
  generate(request: ModelRequest): Promise<ModelResponse>;
  /** Optional streamed form of `generate`, used only for agents that opt into streaming. */
  stream?(request: ModelRequest): AsyncIterable<ModelStreamEvent>;
}
