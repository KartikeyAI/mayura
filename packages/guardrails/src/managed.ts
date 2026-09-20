import { freezeJson, jsonValue, MayuraError, type Guard, type JsonObject, type JsonValue, type ManagedGuardDefinition,
  type ManagedModerationVerdict, type ModelAdapter, type Schema } from '@mayura/core';
import { registerManagedGuardDefinition, type ManagedGuardLimits } from '@mayura/core/host';
import type { AuxiliaryLimits } from './auxiliary.js';

/** Definition-only moderation policy. It can execute only through a qualified owning runtime. */
export interface ManagedModerationOptions {
  readonly id: string;
  readonly version: string;
  readonly model: ModelAdapter;
  readonly instructions: string;
  /** Required explicit choice; [] provides no local destination-screening guarantee. */
  readonly egressGuards: readonly Guard[];
  readonly limits?: AuxiliaryLimits;
}

const defaults: ManagedGuardLimits = Object.freeze({ timeoutMs: 10_000, maxInputBytes: 65_536, maxOutputBytes: 65_536, maxOutputTokens: 1_024 });
const fields = ['id', 'version', 'model', 'instructions', 'egressGuards', 'limits'] as const;

function nativeSchema<I, O>(read: (value: unknown) => O): Schema<I, O> {
  return Object.freeze({ '~standard': Object.freeze({ version: 1 as const, vendor: 'mayura.managed-moderation', validate: (value: unknown) => {
    try { return { value: read(value) }; } catch { return { issues: [{ message: 'Invalid managed moderation structure.' }] }; }
  } }) });
}
const outputSchema: Schema<unknown, ManagedModerationVerdict> = nativeSchema(value => {
  const safe = jsonValue(value, { maxBytes: 65_536 });
  if (!safe || typeof safe !== 'object' || Array.isArray(safe)) throw new Error();
  const keys = Object.keys(safe); const categories = safe['categories']; const decision = safe['decision'];
  if (keys.length !== 2 || !Object.hasOwn(safe, 'decision') || !Object.hasOwn(safe, 'categories') || (decision !== 'allow' && decision !== 'block')
    || !Array.isArray(categories) || categories.length > 32 || categories.some(category => typeof category !== 'string' || !/^[a-z0-9][a-z0-9._-]{0,63}$/.test(category))
    || new Set(categories).size !== categories.length) throw new Error();
  return Object.freeze({ decision, categories: Object.freeze(categories as string[]) });
});

/**
 * Capture a fixed moderation policy without calling a model or allocating a budget. Local guards
 * must capture the application's selected destination policy; no provider URL is inferred here.
 */
export function defineModerationGuard(value: ManagedModerationOptions): ManagedGuardDefinition {
  try {
    if (!value || typeof value !== 'object' || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw new Error();
    const descriptors = Object.getOwnPropertyDescriptors(value); const keys = Reflect.ownKeys(descriptors);
    if (keys.some(key => typeof key !== 'string' || !(fields as readonly string[]).includes(key))) throw new Error();
    const config: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
    for (const key of fields) {
      const descriptor = descriptors[key];
      if (key === 'limits' && !descriptor) continue;
      if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) throw new Error();
      config[key] = descriptor.value;
    }
    let overrides: JsonObject = {};
    if (Object.hasOwn(config, 'limits')) {
      const parsed = jsonValue(config['limits'], { maxBytes: 1_024 });
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || Object.keys(parsed).some(key => !Object.hasOwn(defaults, key))) throw new Error();
      overrides = parsed;
    }
    const limits = Object.freeze({ ...defaults, ...overrides }) as ManagedGuardLimits;
    // Match the explicitly configured boundary instead of imposing jsonValue's unrelated default.
    const input: Schema<JsonValue> = nativeSchema(candidate => freezeJson(jsonValue(candidate, { maxBytes: limits.maxInputBytes })));
    return registerManagedGuardDefinition({ kind: 'moderation', id: config['id'] as string, version: config['version'] as string,
      model: config['model'] as ModelAdapter, instructions: config['instructions'] as string, input, output: outputSchema,
      egressGuards: config['egressGuards'] as readonly Guard[], limits });
  } catch { throw new MayuraError('INVALID_CONFIG', 'Managed moderation requires an explicit model, policy, local screening list and finite limits.'); }
}
