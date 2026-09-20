import { MayuraError } from './errors.js';
import type { Guard, GuardContext, GuardVerdict, ModelAdapter, ModelRequest, ModelResponse } from './contracts.js';
import type { JsonValue } from './json.js';
import type { Schema } from './schema.js';

/** Opaque correlation metadata. Only the shared core registration establishes managed identity. */
export interface ManagedGuardDefinition {
  readonly kind: 'mayura.managed-guard';
  readonly id: string;
  readonly version: string;
}

/** A model classification, not proof of semantic safety or compliance. */
export interface ManagedModerationVerdict {
  readonly decision: 'allow' | 'block';
  readonly categories: readonly string[];
}

/** Fully resolved finite limits; the owning runtime must additionally enforce its stricter ceilings. */
export interface ManagedGuardLimits {
  readonly timeoutMs: number;
  readonly maxInputBytes: number;
  readonly maxOutputBytes: number;
  readonly maxOutputTokens: number;
}

/**
 * Trusted-host integration data, never public run metadata or a context gateway. Registration
 * conveys no budget, grant, scope, dispatch permission, or semantic guarantee from a custom schema.
 */
export interface ManagedGuardDescriptor {
  readonly kind: 'moderation';
  readonly id: string;
  readonly version: string;
  readonly model: ModelAdapter;
  readonly instructions: string;
  readonly input: Schema<JsonValue>;
  readonly output: Schema<unknown, ManagedModerationVerdict>;
  readonly egressGuards: readonly Guard[];
  readonly limits: ManagedGuardLimits;
}

const registrations = new WeakMap<object, Readonly<ManagedGuardDescriptor>>();
const stableId = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/;
const descriptorFields = ['kind', 'id', 'version', 'model', 'instructions', 'input', 'output', 'egressGuards', 'limits'] as const;
const limitFields = ['timeoutMs', 'maxInputBytes', 'maxOutputBytes', 'maxOutputTokens'] as const;

/** Own data only: schema/model callback containers are handled separately for class compatibility. */
function record(value: unknown, fields: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw new Error();
  const descriptors = Object.getOwnPropertyDescriptors(value); const keys = Reflect.ownKeys(descriptors);
  if (keys.length !== fields.length || keys.some(key => typeof key !== 'string' || !fields.includes(key))) throw new Error();
  const result: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const field of fields) {
    const descriptor = descriptors[field];
    if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) throw new Error();
    result[field] = descriptor.value;
  }
  return result;
}

/** Capture ordinary data fields or class methods without executing getters; bound prototype depth is finite. */
function data(value: unknown, key: string, required = true): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
  let cursor: object | null = value;
  for (let depth = 0; cursor !== null && cursor !== Object.prototype && depth < 32; depth++) {
    const descriptor = Object.getOwnPropertyDescriptor(cursor, key);
    if (descriptor) { if (!('value' in descriptor)) throw new Error(); return descriptor.value; }
    cursor = Object.getPrototypeOf(cursor) as object | null;
  }
  if (required || cursor !== null && cursor !== Object.prototype) throw new Error();
  return undefined;
}

function identifier(value: unknown): string {
  if (typeof value !== 'string' || !stableId.test(value)) throw new Error();
  return value;
}

/** The original adapter remains trusted code; only copied metadata and its selected function are pinned. */
function modelSnapshot(value: unknown): ModelAdapter {
  const id = identifier(data(value, 'id')); const maxCostMicros = data(value, 'maxCostMicros');
  const capabilities = record(data(value, 'capabilities'), ['tools', 'structuredOutput']);
  const generate = data(value, 'generate');
  if (typeof capabilities['tools'] !== 'boolean' || capabilities['structuredOutput'] !== true || typeof generate !== 'function'
    || typeof maxCostMicros !== 'number' || !Number.isSafeInteger(maxCostMicros) || maxCostMicros < 0) throw new Error();
  return Object.freeze({ id, maxCostMicros, capabilities: Object.freeze({ tools: capabilities['tools'], structuredOutput: true }),
    // Avoid reading a callback's potentially overridden .bind property or name/length accessors.
    generate: (request: ModelRequest): Promise<ModelResponse> => Reflect.apply(generate, value, [request]) as Promise<ModelResponse>,
  });
}

function schemaSnapshot<I, O>(value: unknown): Schema<I, O> {
  const standard = data(value, '~standard'); const version = data(standard, 'version'); const vendor = data(standard, 'vendor');
  const validate = data(standard, 'validate');
  if (version !== 1 || typeof vendor !== 'string' || vendor.length === 0 || vendor.length > 128 || typeof validate !== 'function') throw new Error();
  return Object.freeze({ '~standard': Object.freeze({ version: 1 as const, vendor,
    validate: (candidate: unknown): ReturnType<Schema<I, O>['~standard']['validate']> => Reflect.apply(validate, standard, [candidate]) as ReturnType<Schema<I, O>['~standard']['validate']>,
  }) });
}

function guardSnapshots(value: unknown): readonly Guard[] {
  if (!Array.isArray(value)) throw new Error();
  const length = Object.getOwnPropertyDescriptor(value, 'length');
  if (!length || !('value' in length) || !Number.isSafeInteger(length.value) || length.value < 0 || length.value > 32) throw new Error();
  const size = length.value as number; const descriptors = Object.getOwnPropertyDescriptors(value); const keys = Reflect.ownKeys(descriptors);
  if (keys.length !== size + 1 || keys.some(key => key !== 'length' && (typeof key !== 'string' || !/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= size))) throw new Error();
  const result: Guard[] = []; const ids = new Set<string>();
  for (let index = 0; index < size; index++) {
    const descriptor = descriptors[String(index)];
    if (!descriptor || !('value' in descriptor) || !descriptor.value || typeof descriptor.value !== 'object') throw new Error();
    const guard = descriptor.value as object;
    if (registrations.has(guard)) throw new Error();
    // A forged/copied managed marker must not fall back to an application callback.
    if (data(guard, 'kind', false) === 'mayura.managed-guard') throw new Error();
    const id = identifier(data(guard, 'id')); const check = data(guard, 'check');
    if (ids.has(id) || typeof check !== 'function') throw new Error();
    ids.add(id); result.push(Object.freeze({ id,
      check: (candidate: JsonValue, context: GuardContext): Promise<GuardVerdict> | GuardVerdict => Reflect.apply(check, guard, [candidate, context]) as Promise<GuardVerdict> | GuardVerdict,
    }));
  }
  return Object.freeze(result);
}

/**
 * Explicit trusted-host registration. It snapshots configuration only, never invokes callbacks or
 * provisions execution authority. Consumers must still enforce the exact no-transform verdict contract.
 */
export function registerManagedGuardDefinition(value: ManagedGuardDescriptor): ManagedGuardDefinition {
  try {
    const config = record(value, descriptorFields);
    if (config['kind'] !== 'moderation') throw new Error();
    const id = identifier(config['id']); const version = identifier(config['version']); const instructions = config['instructions'];
    if (typeof instructions !== 'string' || instructions.length === 0 || instructions.length > 16_384) throw new Error();
    const model = modelSnapshot(config['model']);
    const input = schemaSnapshot<JsonValue, JsonValue>(config['input']);
    const output = schemaSnapshot<unknown, ManagedModerationVerdict>(config['output']);
    const egressGuards = guardSnapshots(config['egressGuards']); const rawLimits = record(config['limits'], limitFields);
    for (const field of limitFields) {
      const bound = rawLimits[field]; if (typeof bound !== 'number' || !Number.isSafeInteger(bound) || bound <= 0) throw new Error();
    }
    if ((rawLimits['timeoutMs'] as number) > 2_147_483_647) throw new Error();
    const limits: ManagedGuardLimits = Object.freeze({ timeoutMs: rawLimits['timeoutMs'] as number, maxInputBytes: rawLimits['maxInputBytes'] as number,
      maxOutputBytes: rawLimits['maxOutputBytes'] as number, maxOutputTokens: rawLimits['maxOutputTokens'] as number });
    const descriptor: ManagedGuardDescriptor = Object.freeze({ kind: 'moderation', id, version, model, instructions, input, output, egressGuards, limits });
    const handle: ManagedGuardDefinition = Object.freeze({ kind: 'mayura.managed-guard', id, version });
    registrations.set(handle, descriptor); return handle;
  } catch { throw new MayuraError('INVALID_CONFIG', 'Managed guards require valid explicit models, schemas, local screening and finite plain-data configuration.'); }
}

/** Identity-only lookup: forged/proxied/foreign-package handles cannot trigger property reads or fallback execution. */
export function readManagedGuardDefinition(value: unknown): Readonly<ManagedGuardDescriptor> | undefined {
  return value !== null && typeof value === 'object' ? registrations.get(value) : undefined;
}
