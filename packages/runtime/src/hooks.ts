import { MayuraError, type JsonValue, type ModelRequest, type Scope } from '@mayura/core';
import { assertTool, type AnyTool } from '@mayura/tools';
import { isAgentTool } from './composition.js';

/** Required process-local control boundaries, not the complete planned lifecycle catalog. */
export type HookStage = 'beforeExecution' | 'beforeModelCall' | 'beforeToolCall' | 'beforeOutputRelease';

/** Immutable stage-specific content. Tool proposals are not final schema-transformed arguments. */
export type HookEvent<S extends HookStage = HookStage> =
  S extends 'beforeExecution' ? { readonly stage: S; readonly input: JsonValue } :
    S extends 'beforeModelCall' ? {
      readonly stage: S; readonly purpose: 'primary'; readonly modelId: string;
      /** Content projection only; private instructions, continuation and execution authority are absent. */
      readonly request: Readonly<Pick<ModelRequest, 'messages' | 'tools' | 'maxOutputTokens'>>;
    } : S extends 'beforeToolCall' ? {
      readonly stage: S; readonly phase: 'proposal';
      readonly proposal: { readonly callId: string; readonly toolId: string; readonly input: JsonValue };
    } : {
      readonly stage: S; readonly source: 'agent' | 'tool'; readonly callId: string;
      readonly toolId?: string; readonly candidate: JsonValue;
    };

/** Correlation only: no account, dispatch ticket, grants, descriptor or executable gateway. */
export interface HookContext {
  readonly runId: string;
  readonly rootId: string;
  readonly parentId?: string;
  readonly agentId: string;
  readonly scope: Scope;
  readonly invocationId: string;
  readonly hookId: string;
  readonly hookVersion: string;
  readonly step: number | null;
  readonly attempt: 1;
  readonly signal: AbortSignal;
}

/** A declarative request, never authority to dispatch or replace the protected candidate. */
export interface HookAction { readonly toolId: string; readonly input: JsonValue }
export type HookDecision =
  | { readonly decision: 'block' }
  | { readonly decision: 'continue'; readonly actions?: readonly HookAction[] };

/** In-process callbacks are trusted application code; this API does not sandbox their closures. */
export interface HookOptions<S extends HookStage = HookStage> {
  readonly id: string;
  readonly version: string;
  readonly stage: S;
  readonly tools: readonly AnyTool[];
  readonly handler: (event: HookEvent<S>, context: HookContext) => HookDecision | Promise<HookDecision>;
  readonly timeoutMs?: number;
  readonly maxActions?: number;
  readonly maxResultBytes?: number;
}

/** Only this module's private registration, not a matching shape, establishes hook identity. */
export interface HookDefinition<S extends HookStage = HookStage> {
  readonly kind: 'mayura.control-hook';
  readonly id: string;
  readonly version: string;
  readonly stage: S;
}

/** Internal runtime integration contract; deliberately absent from package-root exports. */
export interface HookDescriptor<S extends HookStage = HookStage> {
  readonly id: string;
  readonly version: string;
  readonly stage: S;
  readonly tools: readonly AnyTool[];
  readonly handler: (event: HookEvent<S>, context: HookContext) => HookDecision | Promise<HookDecision>;
  readonly timeoutMs: number;
  readonly maxActions: number;
  readonly maxResultBytes: number;
}

const definitions = new WeakMap<object, Readonly<HookDescriptor>>();
const stableIdentifier = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/;
const stages: readonly HookStage[] = ['beforeExecution', 'beforeModelCall', 'beforeToolCall', 'beforeOutputRelease'];
const required = ['id', 'version', 'stage', 'tools', 'handler'];
const optional = ['timeoutMs', 'maxActions', 'maxResultBytes'];

function identifier(value: unknown): string {
  if (typeof value !== 'string' || !stableIdentifier.test(value)) throw new Error();
  return value;
}

/** Snapshot once before validation; caller iterators, accessors and array methods never execute. */
function denseArray(value: unknown, maximum: number): readonly unknown[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) throw new Error();
  const fields = Object.getOwnPropertyDescriptors(value as object); const length = fields['length'];
  if (!length || !('value' in length) || !Number.isSafeInteger(length.value) || length.value < 0 || length.value > maximum
    || Reflect.ownKeys(fields).length !== length.value + 1) throw new Error();
  const result: unknown[] = [];
  for (let index = 0; index < length.value; index++) {
    const field = fields[String(index)];
    if (!field || !field.enumerable || !('value' in field)) throw new Error();
    result.push(field.value);
  }
  return result;
}

function configuration(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw new Error();
  const fields = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(fields).some(key => typeof key !== 'string' || ![...required, ...optional].includes(key))
    || required.some(key => !Object.hasOwn(fields, key))) throw new Error();
  const result = Object.create(null) as Record<string, unknown>;
  for (const [key, field] of Object.entries(fields)) {
    if (!field.enumerable || !('value' in field)) throw new Error();
    result[key] = field.value;
  }
  return result;
}

function limit(fields: Record<string, unknown>, key: string, fallback: number, maximum: number): number {
  const value = Object.hasOwn(fields, key) ? fields[key] : fallback;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1 || value > maximum) throw new Error();
  return value;
}

/**
 * Define a reusable control hook without invoking its handler or any tool. The private registry
 * pins only configuration and function references; each execution still requires runtime admission.
 */
export function defineHook<S extends HookStage>(options: HookOptions<S>): HookDefinition<S> {
  try {
    const fields = configuration(options);
    const id = identifier(fields['id']); const version = identifier(fields['version']);
    const stage = fields['stage']; const handler = fields['handler'];
    if (typeof stage !== 'string' || !stages.includes(stage as HookStage) || typeof handler !== 'function') throw new Error();
    const tools: AnyTool[] = []; const seen = new Set<string>();
    for (const candidate of denseArray(fields['tools'], 32)) {
      assertTool(candidate as AnyTool);
      const tool = candidate as AnyTool;
      if ((tool.effects !== 'none' && tool.effects !== 'read') || isAgentTool(tool) || seen.has(tool.id)) throw new Error();
      seen.add(tool.id); tools.push(tool);
    }
    const descriptor: Readonly<HookDescriptor> = Object.freeze({ id, version, stage: stage as HookStage, tools: Object.freeze(tools),
      // Preserve the ordinary receiver without consulting a callback-owned .bind property.
      handler: (event: HookEvent, context: HookContext): HookDecision | Promise<HookDecision> =>
        Reflect.apply(handler, options, [event, context]) as HookDecision | Promise<HookDecision>,
      timeoutMs: limit(fields, 'timeoutMs', 5_000, 30_000), maxActions: limit(fields, 'maxActions', 4, 8),
      maxResultBytes: limit(fields, 'maxResultBytes', 65_536, 1_048_576),
    });
    const handle: HookDefinition<S> = Object.freeze({ kind: 'mayura.control-hook', id, version, stage: stage as S });
    definitions.set(handle, descriptor); return handle;
  } catch { throw new MayuraError('INVALID_CONFIG', 'Control hooks require explicit valid metadata, a bounded local tool registry, callable handler and finite limits.'); }
}

/** Identity lookup does not inspect unknown values or expose a package-root execution gateway. */
export function readHookDefinition<S extends HookStage>(value: HookDefinition<S>): Readonly<HookDescriptor<S>> | undefined;
export function readHookDefinition(value: unknown): Readonly<HookDescriptor> | undefined;
export function readHookDefinition(value: unknown): Readonly<HookDescriptor> | undefined {
  return value !== null && typeof value === 'object' ? definitions.get(value) : undefined;
}

/** Internal agent capture preserves the exact registrations and rejects ambiguous ordering/IDs. */
export function snapshotHooks(value: unknown): readonly HookDefinition[] {
  try {
    const seen = new Set<string>(); const result: HookDefinition[] = [];
    for (const candidate of denseArray(value, 16)) {
      const descriptor = readHookDefinition(candidate);
      if (!descriptor || seen.has(descriptor.id)) throw new Error();
      seen.add(descriptor.id); result.push(candidate as HookDefinition);
    }
    return Object.freeze(result);
  } catch { throw new MayuraError('INVALID_CONFIG', 'Agent hooks require a dense ordered list of at most 16 genuine definitions with unique identifiers.'); }
}
