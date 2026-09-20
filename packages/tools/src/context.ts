import { MayuraError, type ExecutionContext } from '@mayura/core';

/** Opaque trusted binding. Serializing or copying its public shape conveys no authority. */
export interface ToolContextBinding { readonly kind: 'mayura.tool-context' }
export interface ToolContextSlot<T> {
  /** Bind trusted application state; this is never serialized into a tool input or event. */
  bind(value: T): ToolContextBinding;
  /** Only a broker-minted context carrying this exact slot can return its value. */
  get(context: ExecutionContext): T | undefined;
}
const bindings = new WeakMap<object, { readonly key: object; readonly value: unknown }>();
const contexts = new WeakMap<object, ReadonlyMap<object, unknown>>();

/** Create an isolated extension slot, not a global service locator or sandbox. */
export function createToolContextSlot<T>(): ToolContextSlot<T> {
  const key = Object.freeze({});
  return Object.freeze({
    bind(value: T): ToolContextBinding {
      const binding = Object.freeze({ kind: 'mayura.tool-context' as const });
      bindings.set(binding, { key, value });
      return binding;
    },
    get(context: ExecutionContext): T | undefined { return contexts.get(context)?.get(key) as T | undefined; },
  });
}

/** Internal broker seam: snapshot and validate every binding before any await. */
export function snapshotToolContextBindings(supplied: readonly ToolContextBinding[] = []): readonly ToolContextBinding[] {
  try {
    if (!Array.isArray(supplied)) throw new Error();
    const descriptors = Object.getOwnPropertyDescriptors(supplied) as unknown as Record<string, PropertyDescriptor>;
    const length = descriptors['length']?.value as unknown;
    if (typeof length !== 'number' || !Number.isSafeInteger(length) || length < 0 || length > 32) throw new Error();
    const result: ToolContextBinding[] = [];
    const keys = new Set<object>();
    for (let index = 0; index < length; index++) {
      const descriptor = descriptors[String(index)];
      if (!descriptor || !('value' in descriptor)) throw new Error();
      const binding = descriptor.value as ToolContextBinding;
      const entry = bindings.get(binding);
      if (!entry || keys.has(entry.key)) throw new Error();
      keys.add(entry.key); result.push(binding);
    }
    return Object.freeze(result);
  } catch {
    throw new MayuraError('INVALID_CONFIG', 'Tool context bindings must be bounded, genuine, unique plain entries.');
  }
}
export function attachToolContext(context: ExecutionContext, supplied: readonly ToolContextBinding[] = []): void {
  const values = new Map<object, unknown>();
  for (const binding of snapshotToolContextBindings(supplied)) {
    const entry = bindings.get(binding)!;
    values.set(entry.key, entry.value);
  }
  contexts.set(context, values);
}
