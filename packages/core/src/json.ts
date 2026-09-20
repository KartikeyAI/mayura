import { MayuraError, assertPositiveInteger } from './errors.js';

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonObject | JsonValue[];
export interface JsonObject { [key: string]: JsonValue }

export interface JsonLimits { readonly maxBytes?: number; readonly maxDepth?: number; readonly maxNodes?: number }

/**
 * Copies ordinary JSON without invoking getters/toJSON. Rejects ambiguity at the trust boundary.
 * This protects serialized messages, not hostile in-process Proxy objects (trusted-code boundary).
 */
export function jsonValue(input: unknown, limits: JsonLimits = {}): JsonValue {
  const maxBytes = limits.maxBytes ?? 1_048_576;
  const maxDepth = limits.maxDepth ?? 32;
  const maxNodes = limits.maxNodes ?? 100_000;
  assertPositiveInteger(maxBytes, 'maxBytes');
  assertPositiveInteger(maxDepth, 'maxDepth');
  assertPositiveInteger(maxNodes, 'maxNodes');
  const ancestors = new Set<object>();
  let nodes = 0;
  // Account bytes incrementally so oversized text/collections stop before another full copy.
  let bytes = 0;
  const encoder = new TextEncoder();
  const fail = (): never => { throw new MayuraError('INVALID_JSON', 'Value must be bounded, acyclic, plain JSON.'); };
  const charge = (n: number): void => { bytes += n; if (bytes > maxBytes) fail(); };
  const visit = (value: unknown, depth: number): JsonValue => {
    if (++nodes > maxNodes || depth > maxDepth) return fail();
    if (value === null) { charge(4); return null; }
    if (typeof value === 'string') {
      if (value.length > maxBytes - bytes) return fail();
      charge(encoder.encode(JSON.stringify(value)).length); return value;
    }
    if (typeof value === 'boolean') { charge(value ? 4 : 5); return value; }
    if (typeof value === 'number') {
      if (!Number.isFinite(value) || (Number.isInteger(value) && !Number.isSafeInteger(value))) return fail();
      charge(String(value).length); return value;
    }
    if (typeof value !== 'object' || ancestors.has(value)) return fail();
    const array = Array.isArray(value);
    if (array && value.length > maxNodes - nodes) return fail();
    if (!array && Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) return fail();
    if (Object.getOwnPropertySymbols(value).length > 0) return fail();
    const descriptors = Object.getOwnPropertyDescriptors(value);
    ancestors.add(value);
    charge(2);
    try {
      if (array) {
        const result: JsonValue[] = [];
        if (Object.keys(descriptors).length !== value.length + 1) return fail();
        for (let i = 0; i < value.length; i++) {
          const descriptor = descriptors[String(i)];
          if (!descriptor || !('value' in descriptor)) return fail();
          if (i > 0) charge(1);
          result.push(visit(descriptor.value, depth + 1));
        }
        return result;
      }
      const result: JsonObject = {};
      let count = 0;
      for (const [key, descriptor] of Object.entries(descriptors)) {
        if (!descriptor.enumerable || !('value' in descriptor)) return fail();
        if (key === '__proto__' || key === 'constructor' || key === 'prototype') return fail();
        if (count++ > 0) charge(1);
        charge(encoder.encode(JSON.stringify(key)).length + 1);
        result[key] = visit(descriptor.value, depth + 1);
      }
      return result;
    } finally { ancestors.delete(value); }
  };
  return visit(input, 0);
}

/** Freezes validated JSON snapshots before concurrent checks or callbacks inspect them. */
export function freezeJson<T extends JsonValue>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value)) freezeJson(child);
    Object.freeze(value);
  }
  return value;
}
