import { MayuraError } from './errors.js';
import { jsonValue, type JsonLimits } from './json.js';

/** Structural Standard Schema v1 contract; no mandatory validator runtime dependency. */
export interface Schema<Input = unknown, Output = Input> {
  readonly '~standard': {
    readonly version: 1;
    readonly vendor: string;
    readonly validate: (value: unknown) =>
      | { readonly value: Output; readonly issues?: undefined }
      | { readonly issues: readonly { readonly message: string; readonly path?: readonly unknown[] | undefined }[] }
      | Promise<
          | { readonly value: Output; readonly issues?: undefined }
          | { readonly issues: readonly { readonly message: string; readonly path?: readonly unknown[] | undefined }[] }
        >;
    readonly types?: { readonly input: Input; readonly output: Output } | undefined;
  };
}
export type InferInput<S extends Schema> = NonNullable<S['~standard']['types']>['input'];
export type InferOutput<S extends Schema> = NonNullable<S['~standard']['types']>['output'];

/** Validates both schema behavior and JSON boundaries; does not echo validator error messages. */
export async function validate<S extends Schema>(
  schema: S, value: unknown, boundary: 'input' | 'output', limits?: JsonLimits,
): Promise<InferOutput<S>> {
  const code = boundary === 'input' ? 'INVALID_INPUT' : 'INVALID_OUTPUT';
  try {
    const candidate = jsonValue(value, limits);
    const result = await schema['~standard'].validate(candidate);
    if (result.issues !== undefined) throw new MayuraError(code, `${boundary} does not match its schema.`);
    jsonValue(result.value, limits);
    return result.value as InferOutput<S>;
  } catch {
    throw new MayuraError(code, `${boundary} must match its schema and JSON limits.`);
  }
}

/** Checks schema identity at definition time, before an invocation can cause an effect. */
export function assertSchema(schema: Schema): void {
  if (!schema || schema['~standard']?.version !== 1 || typeof schema['~standard'].validate !== 'function' || typeof schema['~standard'].vendor !== 'string' || schema['~standard'].vendor.length === 0 || schema['~standard'].vendor.length > 128) {
    throw new MayuraError('INVALID_CONFIG', 'A Standard Schema v1 validator is required.');
  }
}
