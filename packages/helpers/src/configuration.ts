import {
  MayuraError, assertPositiveInteger, assertSchema, freezeJson, jsonValue, publicError, validate,
  type InferOutput, type JsonLimits, type JsonObject, type JsonValue, type PublicError, type Schema,
} from '@mayura/core';

export interface SecretReference {
  readonly provider: string;
  readonly key: string;
  readonly version?: string;
}

const identifier = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/u;

/** Creates an immutable credential handle. Secret values never belong in this object. */
export function secretReference(input: SecretReference): SecretReference {
  let provider: unknown; let key: unknown; let version: unknown;
  try {
    const descriptors = Object.getOwnPropertyDescriptors(input);
    const names = Reflect.ownKeys(descriptors);
    if (![Object.prototype, null].includes(Object.getPrototypeOf(input))
      || names.some(name => !['provider', 'key', 'version'].includes(String(name)))) throw new Error();
    for (const name of ['provider', 'key'] as const) if (!descriptors[name] || !('value' in descriptors[name])) throw new Error();
    provider = descriptors['provider']!.value; key = descriptors['key']!.value;
    const versionDescriptor = descriptors['version'];
    if (versionDescriptor && !('value' in versionDescriptor)) throw new Error();
    version = versionDescriptor?.value;
  } catch { throw new MayuraError('INVALID_CONFIG', 'Secret references must contain plain bounded identifiers.'); }
  if (typeof provider !== 'string' || !identifier.test(provider) || typeof key !== 'string' || !identifier.test(key)
    || (version !== undefined && (typeof version !== 'string' || !identifier.test(version)))) {
    throw new MayuraError('INVALID_CONFIG', 'Secret references must contain plain bounded identifiers.');
  }
  return Object.freeze({ provider, key, ...(version === undefined ? {} : { version }) });
}

/** Validates and freezes bounded JSON configuration without reflecting rejected values. */
export async function validatedConfig<S extends Schema>(schema: S, value: unknown, limits?: JsonLimits): Promise<InferOutput<S>> {
  const output = await validate(schema, value, 'input', limits);
  return freezeJson(jsonValue(output, limits)) as InferOutput<S>;
}

export interface EnvironmentConfig<S extends Schema> {
  readonly schema: S;
  /** Explicit source; this package never reads ambient process state. */
  readonly source: Readonly<Record<string, string | undefined>>;
  /** Output property to source-variable name. */
  readonly fields: Readonly<Record<string, string>>;
  readonly allowEmpty?: boolean;
  readonly limits?: JsonLimits;
}

/** Selects an allowlisted environment view and validates it as ordinary configuration. */
export async function validatedEnvironment<S extends Schema>(options: EnvironmentConfig<S>): Promise<InferOutput<S>> {
  const entries = Object.entries(options.fields);
  if (entries.length === 0 || entries.length > 128) throw new MayuraError('INVALID_CONFIG', 'Environment configuration requires 1–128 explicit fields.');
  const value: JsonObject = {};
  const outputNames = new Set<string>(); const sourceNames = new Set<string>();
  for (const [outputName, sourceName] of entries) {
    if (!identifier.test(outputName) || !/^[A-Z][A-Z0-9_]{0,127}$/u.test(sourceName)
      || outputNames.has(outputName) || sourceNames.has(sourceName)) {
      throw new MayuraError('INVALID_CONFIG', 'Environment field mappings must be unique bounded identifiers.');
    }
    outputNames.add(outputName); sourceNames.add(sourceName);
    const selected = options.source[sourceName];
    if (selected !== undefined) {
      if ((!options.allowEmpty && selected.length === 0) || selected.length > 16_384) {
        throw new MayuraError('INVALID_CONFIG', 'Environment values must satisfy configured bounds.');
      }
      value[outputName] = selected;
    }
  }
  return validatedConfig(options.schema, value, options.limits);
}

export interface ProviderSchemaBinding<S extends Schema> {
  readonly schema: S;
  readonly jsonSchema: JsonObject;
}

/**
 * Binds a runtime validator to an explicit provider schema. Mayura cannot safely infer
 * provider constraints from an arbitrary Standard Schema and therefore never drops them silently.
 */
export function providerSchema<S extends Schema>(schema: S, jsonSchema: unknown): ProviderSchemaBinding<S> {
  assertSchema(schema);
  const value = freezeJson(jsonValue(jsonSchema, { maxBytes: 65_536, maxDepth: 32, maxNodes: 4_096 }));
  if (value === null || Array.isArray(value) || typeof value !== 'object') {
    throw new MayuraError('INVALID_CONFIG', 'Provider JSON Schema must be a bounded object.');
  }
  return Object.freeze({ schema, jsonSchema: value as JsonObject });
}

/** Converts unknown failures into stable public errors without leaking thrown text. */
export async function capture<T>(operation: () => T | Promise<T>): Promise<
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: PublicError }
> {
  try { return Object.freeze({ ok: true as const, value: await operation() }); }
  catch (error) {
    return Object.freeze({ ok: false as const, error: Object.freeze(publicError(error)) });
  }
}

/** Validates a positive bounded integer used by helper contracts. */
export function helperLimit(value: number, name: string, maximum: number): number {
  assertPositiveInteger(value, name);
  if (value > maximum) throw new MayuraError('LIMIT_EXCEEDED', `${name} exceeds the helper limit.`);
  return value;
}

export type { JsonValue };
