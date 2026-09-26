import { MayuraError, type JsonValue, type ModelRequest, type Outcome, type Scope } from '@mayura/core';
import { assertTool, type AnyTool } from '@mayura/tools';
import { isAgentTool } from './composition.js';

/** Awaited, fail-closed decision points. Each may block and request registered read-only actions. */
export type ControlHookStage = 'beforeExecution' | 'beforeStep' | 'beforeModelCall' | 'beforeToolCall' | 'beforeDelegate' | 'beforeOutputRelease';
/** Awaited metadata-only observation points. A mandatory observer fails closed; an optional one fails visibly. */
export type ObserverHookStage = 'afterStep' | 'afterModelCall' | 'afterToolCall' | 'afterDelegate' | 'onViolation'
  | 'afterExecution' | 'onError' | 'onCancel' | 'onBlocked' | 'onFinally';
/** Every lifecycle point served by an agent run. Context, memory and retry points live in their own packages. */
export type HookStage = ControlHookStage | ObserverHookStage;
export type TerminalHookStage = 'afterExecution' | 'onError' | 'onCancel' | 'onBlocked' | 'onFinally';

/** Immutable stage-specific views. Control views may carry content; observer views never do. */
export interface HookEvents {
  readonly beforeExecution: { readonly stage: 'beforeExecution'; readonly input: JsonValue };
  readonly beforeStep: { readonly stage: 'beforeStep'; readonly step: number };
  readonly beforeModelCall: {
    readonly stage: 'beforeModelCall'; readonly purpose: 'primary'; readonly modelId: string;
    /** Content projection only; private instructions, continuation and execution authority are absent. */
    readonly request: Readonly<Pick<ModelRequest, 'messages' | 'tools' | 'maxOutputTokens'>>;
  };
  /** Tool proposals are not final schema-transformed arguments. */
  readonly beforeToolCall: {
    readonly stage: 'beforeToolCall'; readonly phase: 'proposal';
    readonly proposal: { readonly callId: string; readonly toolId: string; readonly input: JsonValue };
  };
  readonly beforeDelegate: { readonly stage: 'beforeDelegate'; readonly childRunId: string; readonly childAgentId: string; readonly input: JsonValue };
  readonly beforeOutputRelease: {
    readonly stage: 'beforeOutputRelease'; readonly source: 'agent' | 'tool'; readonly callId: string;
    readonly toolId?: string; readonly candidate: JsonValue;
  };
  readonly afterStep: { readonly stage: 'afterStep'; readonly step: number; readonly result: 'tool_calls' | 'final' | 'stopped' };
  readonly afterModelCall: { readonly stage: 'afterModelCall'; readonly step: number; readonly modelId: string; readonly response: 'final' | 'tool_calls'; readonly toolCalls: number };
  /** The real tool outcome; an observer cannot change it. */
  readonly afterToolCall: {
    readonly stage: 'afterToolCall'; readonly step: number; readonly callId: string; readonly toolId: string;
    readonly status: Outcome<unknown>['status']; readonly execution?: string; readonly disclosure?: 'released' | 'withheld';
  };
  readonly afterDelegate: { readonly stage: 'afterDelegate'; readonly childRunId: string; readonly childAgentId: string; readonly status: Outcome<unknown>['status'] };
  readonly onViolation: {
    readonly stage: 'onViolation'; readonly source: 'guard' | 'hook' | 'permission';
    readonly boundary: 'input' | 'output' | 'tool' | 'model' | 'execution' | 'delegate'; readonly code: string; readonly callId?: string;
  };
  readonly afterExecution: TerminalView<'afterExecution'>;
  readonly onError: TerminalView<'onError'>;
  readonly onCancel: TerminalView<'onCancel'>;
  readonly onBlocked: TerminalView<'onBlocked'>;
  readonly onFinally: TerminalView<'onFinally'>;
}
export interface TerminalView<S extends TerminalHookStage> {
  readonly stage: S; readonly status: Outcome<unknown>['status']; readonly error?: { readonly code: string };
}
export type HookEvent<S extends HookStage = HookStage> = HookEvents[S];

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
export interface ControlHookOptions<S extends ControlHookStage = ControlHookStage> {
  readonly id: string;
  readonly version: string;
  readonly stage: S;
  readonly tools: readonly AnyTool[];
  readonly handler: (event: HookEvent<S>, context: HookContext) => HookDecision | Promise<HookDecision>;
  readonly timeoutMs?: number;
  readonly maxActions?: number;
  readonly maxResultBytes?: number;
}
/** Observers receive a metadata-only view, request no actions and return nothing. */
export interface ObserverHookOptions<S extends ObserverHookStage = ObserverHookStage> {
  readonly id: string;
  readonly version: string;
  readonly stage: S;
  readonly tools?: readonly [];
  readonly handler: (event: HookEvent<S>, context: HookContext) => void | Promise<void>;
  /** A mandatory observer's failure stops the run (or withholds a successful output); default false. */
  readonly mandatory?: boolean;
  readonly timeoutMs?: number;
}
export type HookOptions<S extends HookStage = HookStage> =
  S extends ControlHookStage ? ControlHookOptions<S> : S extends ObserverHookStage ? ObserverHookOptions<S> : never;

/** Only this module's private registration, not a matching shape, establishes hook identity. */
export interface HookDefinition<S extends HookStage = HookStage> {
  readonly kind: S extends ObserverHookStage ? 'mayura.observer-hook' : 'mayura.control-hook';
  readonly id: string;
  readonly version: string;
  readonly stage: S;
}

/** Internal runtime integration contract; deliberately absent from package-root exports. */
export interface HookDescriptor<S extends HookStage = HookStage> {
  readonly id: string;
  readonly version: string;
  readonly stage: S;
  readonly observer: boolean;
  readonly mandatory: boolean;
  readonly tools: readonly AnyTool[];
  readonly handler: (event: HookEvent<S>, context: HookContext) => unknown;
  readonly timeoutMs: number;
  readonly maxActions: number;
  readonly maxResultBytes: number;
}

const definitions = new WeakMap<object, Readonly<HookDescriptor>>();
const stableIdentifier = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/;
const controlStages: readonly ControlHookStage[] = ['beforeExecution', 'beforeStep', 'beforeModelCall', 'beforeToolCall', 'beforeDelegate', 'beforeOutputRelease'];
const observerStages: readonly ObserverHookStage[] = ['afterStep', 'afterModelCall', 'afterToolCall', 'afterDelegate', 'onViolation',
  'afterExecution', 'onError', 'onCancel', 'onBlocked', 'onFinally'];
const controlFields = { required: ['id', 'version', 'stage', 'tools', 'handler'], optional: ['timeoutMs', 'maxActions', 'maxResultBytes'] };
const observerFields = { required: ['id', 'version', 'stage', 'handler'], optional: ['tools', 'mandatory', 'timeoutMs'] };

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
  const stageField = fields['stage'];
  const stage = stageField && 'value' in stageField ? stageField.value : undefined;
  const allowed = observerStages.includes(stage) ? observerFields : controlFields;
  if (Reflect.ownKeys(fields).some(key => typeof key !== 'string' || ![...allowed.required, ...allowed.optional].includes(key))
    || allowed.required.some(key => !Object.hasOwn(fields, key))) throw new Error();
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
 * Define a reusable lifecycle hook without invoking its handler or any tool. The private registry
 * pins only configuration and function references; each execution still requires runtime admission.
 */
export function defineHook<S extends ControlHookStage>(options: ControlHookOptions<S>): HookDefinition<S>;
export function defineHook<S extends ObserverHookStage>(options: ObserverHookOptions<S>): HookDefinition<S>;
export function defineHook(options: ControlHookOptions | ObserverHookOptions): HookDefinition {
  try {
    const fields = configuration(options);
    const id = identifier(fields['id']); const version = identifier(fields['version']);
    const stage = fields['stage']; const handler = fields['handler'];
    const observer = observerStages.includes(stage as ObserverHookStage);
    if (typeof stage !== 'string' || (!observer && !controlStages.includes(stage as ControlHookStage)) || typeof handler !== 'function') throw new Error();
    const tools: AnyTool[] = []; const seen = new Set<string>();
    if (observer) {
      if (Object.hasOwn(fields, 'tools') && denseArray(fields['tools'], 0).length !== 0) throw new Error();
      if (Object.hasOwn(fields, 'mandatory') && typeof fields['mandatory'] !== 'boolean') throw new Error();
    } else for (const candidate of denseArray(fields['tools'], 32)) {
      assertTool(candidate as AnyTool);
      const tool = candidate as AnyTool;
      if ((tool.effects !== 'none' && tool.effects !== 'read') || isAgentTool(tool) || seen.has(tool.id)) throw new Error();
      seen.add(tool.id); tools.push(tool);
    }
    const descriptor: Readonly<HookDescriptor> = Object.freeze({ id, version, stage: stage as HookStage, observer,
      mandatory: observer && fields['mandatory'] === true, tools: Object.freeze(tools),
      // Preserve the ordinary receiver without consulting a callback-owned .bind property.
      handler: (event: HookEvent, context: HookContext): unknown => Reflect.apply(handler, options, [event, context]),
      timeoutMs: limit(fields, 'timeoutMs', 5_000, 30_000), maxActions: observer ? 0 : limit(fields, 'maxActions', 4, 8),
      maxResultBytes: observer ? 0 : limit(fields, 'maxResultBytes', 65_536, 1_048_576),
    });
    const handle = Object.freeze({ kind: observer ? 'mayura.observer-hook' : 'mayura.control-hook', id, version, stage }) as HookDefinition;
    definitions.set(handle, descriptor); return handle;
  } catch { throw new MayuraError('INVALID_CONFIG', 'Lifecycle hooks require explicit valid metadata and a supported stage; control hooks need a bounded local tool registry and finite limits, observers take no tools.'); }
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
