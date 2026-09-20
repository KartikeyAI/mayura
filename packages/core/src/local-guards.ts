import { MayuraError } from './errors.js';
import type { Guard, GuardContext, GuardVerdict } from './contracts.js';
import type { JsonValue } from './json.js';

function field(value: object, name: string): unknown {
  let cursor: object | null = value;
  for (let depth = 0; cursor !== null && cursor !== Object.prototype && depth < 32; depth++) {
    const descriptor = Object.getOwnPropertyDescriptor(cursor, name);
    if (descriptor) { if (!('value' in descriptor)) throw new Error(); return descriptor.value; }
    cursor = Object.getPrototypeOf(cursor) as object | null;
  }
  if (cursor !== null && cursor !== Object.prototype) throw new Error();
  return undefined;
}

/** Trusted-host configuration helper, not a callback executor or managed-definition fallback. */
export function snapshotLocalGuards(value: readonly Guard[]): readonly Guard[] {
  try {
    if (!Array.isArray(value)) throw new Error();
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const length = Object.getOwnPropertyDescriptor(value, 'length');
    if (!length || !('value' in length) || !Number.isSafeInteger(length.value) || length.value < 0 || length.value > 32
      || Reflect.ownKeys(descriptors).length !== length.value + 1) throw new Error();
    const result: Guard[] = [];
    for (let index = 0; index < length.value; index++) {
      const entry = descriptors[String(index)];
      if (!entry || !('value' in entry) || !entry.value || typeof entry.value !== 'object') throw new Error();
      const guard = entry.value as object;
      if (field(guard, 'kind') === 'mayura.managed-guard') throw new Error();
      const id = field(guard, 'id'); const check = field(guard, 'check');
      if (typeof id !== 'string' || id.trim().length === 0 || id.length > 128 || typeof check !== 'function') throw new Error();
      result.push(Object.freeze({ id, check: (candidate: JsonValue, context: GuardContext): GuardVerdict | Promise<GuardVerdict> =>
        Reflect.apply(check, guard, [candidate, context]) as GuardVerdict | Promise<GuardVerdict> }));
    }
    return Object.freeze(result);
  } catch { throw new MayuraError('INVALID_CONFIG', 'Local guards require a bounded dense list of captured data identifiers and callable checks.'); }
}
