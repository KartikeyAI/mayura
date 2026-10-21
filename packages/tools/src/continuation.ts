import type { Guard, JsonValue, Scope, Schema } from '@mayura/core';
import { MayuraError, freezeJson, jsonValue, validate } from '@mayura/core';
import type { AnyTool } from './index.js';

/** Trusted host port for an external result wait; callbacks must never execute external effects. */
export interface ToolContinuationContext {
  readonly runId: string; readonly callId: string; readonly scope: Scope; readonly signal: AbortSignal;
}
export interface ToolContinuation {
  /** Pin an inactive external call; it must remain undispatchable until publish. */
  prepare(input: JsonValue, context: ToolContinuationContext): Promise<{ readonly digest: string; readonly expiresAtMs: number }>;
  /** Publish only after the runtime checkpoint is committed. Safe to repeat after a process restart. */
  publish(input: JsonValue, context: ToolContinuationContext, digest: string): Promise<void>;
  /** Check authoritative result availability without consuming or reserving delivery. */
  ready(input: JsonValue, context: ToolContinuationContext, digest: string): Promise<boolean>;
}
const continuations = new WeakMap<object, ToolContinuation>();
/** Attach once during trusted registration, before sharing the tool with a runtime. No capability is granted. */
export function registerToolContinuation(tool: AnyTool, port: ToolContinuation): void {
  if (continuations.has(tool) || ['prepare', 'publish', 'ready'].some(key => typeof (port as any)?.[key] !== 'function')) {
    throw new MayuraError('INVALID_CONFIG', 'Invalid external tool continuation registration.');
  }
  continuations.set(tool, Object.freeze({ prepare: port.prepare.bind(port), publish: port.publish.bind(port), ready: port.ready.bind(port) }));
}
/** Runtime-only lookup; result consumption still goes through ordinary tool admission and output barriers. */
export function toolContinuation(tool: AnyTool): ToolContinuation | undefined { return continuations.get(tool); }

interface InputAdmission { readonly schema: Schema; readonly guards: readonly Guard[] }
const admissions = new WeakMap<object, InputAdmission>();
/** Internal registration; only defineTool installs schema and guard callbacks. */
export function registerContinuationInput(tool: AnyTool, schema: Schema, guards: readonly Guard[]): void { admissions.set(tool, { schema, guards }); }
/** Complete normal input validation/guards once before publication, under the runtime's callback limiter. */
export async function prepareToolInput(tool: AnyTool, input: JsonValue, context: ToolContinuationContext,
  callback: <T>(work: () => Promise<T>) => Promise<T>): Promise<JsonValue> {
  const admission = admissions.get(tool);
  if (!admission || !continuations.has(tool)) throw new MayuraError('INVALID_CONFIG', 'An external tool input admission is required.');
  context.signal.throwIfAborted();
  const parsed = freezeJson(jsonValue(await callback(async () => validate(admission.schema, input, 'input'))));
  const verdicts = await Promise.all(admission.guards.map(guard => callback(async () => {
    try { const verdict = await guard.check(parsed, Object.freeze({ ...context, boundary: 'input' as const }));
      if (!verdict || !['allow', 'block'].includes(verdict.decision)) throw new Error(); return verdict.decision;
    } catch { throw new MayuraError('GUARD_UNAVAILABLE', 'An external input guard could not establish a verdict.'); }
  })));
  context.signal.throwIfAborted();
  if (verdicts.includes('block')) throw new MayuraError('GUARD_BLOCKED', 'An input guard withheld external publication.');
  return parsed;
}
/** Opaque one-use host proof for admitted input restored from a consumed continuation checkpoint. */
export interface PreparedToolInputBinding { readonly kind: 'prepared-tool-input' }
const inputs = new WeakMap<object, { tool: AnyTool; raw: string; parsed: JsonValue; prepaid: boolean; context: ToolContinuationContext }>();
export function bindPreparedToolInput(tool: AnyTool, raw: JsonValue, parsed: JsonValue, context: ToolContinuationContext, prepaid = false): PreparedToolInputBinding {
  if (!continuations.has(tool)) throw new MayuraError('PERMISSION_DENIED', 'Only checkpointed external tools accept admitted input.');
  const binding = Object.freeze({ kind: 'prepared-tool-input' as const });
  inputs.set(binding, { tool, raw: JSON.stringify(raw), parsed: freezeJson(jsonValue(parsed)), prepaid, context: { ...context } }); return binding;
}
/** Internal consumption bound to the exact tool, raw proposal, run, call, scope and cancellation authority. */
export function claimPreparedToolInput(binding: PreparedToolInputBinding, tool: AnyTool, raw: JsonValue, context: ToolContinuationContext): { readonly input: JsonValue; readonly prepaid: boolean } {
  const item = inputs.get(binding); inputs.delete(binding);
  if (!item || item.tool !== tool || item.raw !== JSON.stringify(raw) || item.context.runId !== context.runId || item.context.callId !== context.callId
    || item.context.scope.principalId !== context.scope.principalId || item.context.scope.projectId !== context.scope.projectId || item.context.signal !== context.signal) {
    throw new MayuraError('PERMISSION_DENIED', 'The admitted external input proof does not match this invocation.');
  }
  return { input: item.parsed, prepaid: item.prepaid };
}
