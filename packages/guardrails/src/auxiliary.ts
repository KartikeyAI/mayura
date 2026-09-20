import { assertBudget, assertPositiveInteger, assertSchema, Budget, freezeJson, jsonValue, MayuraError, ModelInvocationError, validate,
  type Guard, type GuardContext, type InferInput, type InferOutput, type JsonObject, type JsonValue, type ModelAdapter, type ModelRequest,
  type Outcome, type Permissions, type Schema, type Scope,
} from '@mayura/core';
import { boundedText, Deadline, snapshotContext } from './pipeline.js';

export interface AuxiliaryLimits {
  readonly timeoutMs?: number;
  readonly maxInputBytes?: number;
  readonly maxOutputBytes?: number;
  readonly maxOutputTokens?: number;
}
export interface AuxiliaryOptions<I extends Schema, O extends Schema> {
  readonly id: string;
  readonly version: string;
  readonly model: ModelAdapter;
  readonly instructions: string;
  readonly input: I;
  readonly output: O;
  /** The genuine owning execution account; this helper never manufactures independent credit. */
  readonly budget: Budget;
  readonly permissions: Permissions;
  readonly limits?: AuxiliaryLimits;
  /** Local non-recursive screening of schema-admitted input before provider egress. */
  readonly egressGuards?: readonly Guard[];
}
export interface AuxiliaryEvidence {
  readonly invocationId: string;
  readonly checkId: string;
  readonly checkVersion: string;
  readonly modelId: string;
  readonly runId: string;
  readonly callId: string;
  readonly scope: Scope;
  readonly originalDigest: string;
  readonly inputDigest: string;
  readonly outputDigest: string;
  readonly costMicros: number;
}
export interface AuxiliaryResult<T> {
  readonly original: JsonValue;
  readonly input: JsonValue;
  readonly output: T;
  readonly evidence: AuxiliaryEvidence;
}
export interface AuxiliaryCheck<I extends Schema, O extends Schema> {
  readonly id: string;
  readonly version: string;
  evaluate(value: InferInput<I>, context: GuardContext): Promise<Outcome<AuxiliaryResult<InferOutput<O>>>>;
}
const defaults: Required<AuxiliaryLimits> = Object.freeze({ timeoutMs: 10_000, maxInputBytes: 65_536, maxOutputBytes: 65_536, maxOutputTokens: 1_024 });

function schemaSnapshot<S extends Schema>(schema: S): Schema<InferInput<S>, InferOutput<S>> {
  assertSchema(schema); const standard = schema['~standard'];
  return Object.freeze({ '~standard': Object.freeze({ version: 1 as const, vendor: standard.vendor, validate: standard.validate.bind(standard) }) }) as Schema<InferInput<S>, InferOutput<S>>;
}
function canonical(value: JsonValue): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key]!)}`).join(',')}}`;
}
async function digest(value: JsonValue): Promise<string> {
  try {
    const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`mayura:auxiliary-content:v1\0${canonical(value)}`));
    return [...new Uint8Array(hash)].map(byte => byte.toString(16).padStart(2, '0')).join('');
  } catch { throw new MayuraError('INVALID_INPUT', 'Auxiliary content could not be fingerprinted.'); }
}
function object(value: JsonValue): JsonObject {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
  return value;
}
function exact(value: JsonObject, keys: readonly string[]): void {
  if (Object.keys(value).length !== keys.length || keys.some(key => !Object.hasOwn(value, key))) throw new Error();
}
/** Usage is read separately: malformed output must not erase an independently known charge. */
function knownCost(raw: unknown): number {
  try {
    if (!raw || typeof raw !== 'object' || ![Object.prototype, null].includes(Object.getPrototypeOf(raw))) throw new Error();
    const descriptor = Object.getOwnPropertyDescriptor(raw, 'usage');
    if (!descriptor || !('value' in descriptor)) throw new Error();
    const usage = object(jsonValue(descriptor.value, { maxBytes: 512, maxDepth: 2 })); exact(usage, ['costMicros']);
    const amount = usage['costMicros'];
    if (typeof amount !== 'number' || !Number.isSafeInteger(amount) || amount < 0) throw new Error();
    return amount;
  } catch { throw new MayuraError('MODEL_FAILED', 'The auxiliary model did not establish valid usage.'); }
}
function failedCost(error: unknown): number | undefined {
  try {
    if (!(error instanceof ModelInvocationError)) return undefined;
    const descriptor = Object.getOwnPropertyDescriptor(error, 'costMicros');
    const value: unknown = descriptor && 'value' in descriptor ? descriptor.value : undefined;
    return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
  } catch { return undefined; }
}
function finalOutput(raw: unknown, costMicros: number, maxBytes: number): JsonValue {
  try {
    const response = object(jsonValue(raw, { maxBytes })); exact(response, ['type', 'output', 'usage']);
    if (response['type'] !== 'final' || knownCost(response) !== costMicros) throw new Error();
    return freezeJson(response['output']!);
  } catch { throw new MayuraError('MODEL_FAILED', 'The auxiliary model returned an invalid final envelope.'); }
}

/** Only fixed local messages are public, even for framework-shaped thrown objects. */
function failed(error: unknown): Outcome<never> {
  const messages = {
    INVALID_CONFIG: 'Auxiliary evaluation configuration is invalid.', INVALID_INPUT: 'Auxiliary input did not pass its content boundary.',
    INVALID_OUTPUT: 'Auxiliary output did not pass its schema boundary.', MODEL_FAILED: 'The auxiliary model could not establish a valid result.',
    PERMISSION_DENIED: 'The auxiliary model destination was not granted.', BUDGET_EXCEEDED: 'The shared execution budget could not admit or settle this operation.',
    GUARD_BLOCKED: 'A local egress guard withheld the auxiliary request.', GUARD_UNAVAILABLE: 'A local egress guard could not establish a verdict.',
    CANCELLED: 'The auxiliary evaluation was cancelled.', TIMEOUT: 'The auxiliary evaluation exceeded its deadline.',
  } as const;
  let code: keyof typeof messages = 'MODEL_FAILED';
  try {
    const descriptor = error instanceof MayuraError ? Object.getOwnPropertyDescriptor(error, 'code') : undefined;
    const candidate: unknown = descriptor && 'value' in descriptor ? descriptor.value : undefined;
    if (typeof candidate === 'string' && Object.hasOwn(messages, candidate)) code = candidate as keyof typeof messages;
  } catch { /* Exception proxies cannot control output text. */ }
  const status = code === 'CANCELLED' ? 'cancelled' : ['PERMISSION_DENIED', 'BUDGET_EXCEEDED', 'GUARD_BLOCKED', 'GUARD_UNAVAILABLE'].includes(code) ? 'blocked' : 'failed';
  return Object.freeze({ status, error: Object.freeze({ code, message: messages[code] }) });
}

/**
 * One explicitly authorized, schema-validated auxiliary model call with shared accounting.
 * Model code and local schemas/guards are trusted callbacks; no tools, retries, or continuations.
 */
export function createAuxiliaryCheck<I extends Schema, O extends Schema>(options: AuxiliaryOptions<I, O>): AuxiliaryCheck<I, O> {
  let config;
  try {
    const id = options.id; const version = options.version; const instructions = options.instructions;
    boundedText(id, 'check.id', 128); boundedText(version, 'check.version', 128); boundedText(instructions, 'instructions', 16_384);
    const budget = options.budget; assertBudget(budget);
    const model = options.model; const modelId = model.id; const maxCostMicros = model.maxCostMicros; const generate = model.generate;
    boundedText(modelId, 'model.id', 128);
    if (typeof generate !== 'function' || model.capabilities.structuredOutput !== true || !Number.isSafeInteger(maxCostMicros) || maxCostMicros < 0) throw new Error();
    const grantList = jsonValue(options.permissions.allow, { maxBytes: 131_072 });
    if (!Array.isArray(grantList) || grantList.length > 4_096 || grantList.some(grant => typeof grant !== 'string' || grant.length === 0 || grant.length > 256)) throw new Error();
    const limits = Object.freeze({ ...defaults, ...object(jsonValue(options.limits ?? {}, { maxBytes: 1_024 })) as AuxiliaryLimits });
    for (const [key, value] of Object.entries(limits)) { if (!Object.hasOwn(defaults, key)) throw new Error(); assertPositiveInteger(value, key); }
    if (limits.timeoutMs > 2_147_483_647) throw new Error();
    const supplied = options.egressGuards ?? [];
    if (!Array.isArray(supplied) || supplied.length > 32) throw new Error();
    const ids = new Set<string>();
    const egressGuards = Object.freeze(supplied.map(guard => {
      boundedText(guard.id, 'egressGuard.id', 128);
      if (ids.has(guard.id) || typeof guard.check !== 'function') throw new Error(); ids.add(guard.id);
      return Object.freeze({ id: guard.id, check: guard.check.bind(guard) });
    }));
    config = { id, version, instructions, budget, input: schemaSnapshot(options.input), output: schemaSnapshot(options.output),
      modelId, maxCostMicros, generate: generate.bind(model), allowed: new Set(grantList).has(`model:${modelId}`), limits, egressGuards,
    };
  } catch { throw new MayuraError('INVALID_CONFIG', 'Auxiliary checks require explicit valid schemas, model, budget, permissions and finite limits.'); }
  const captured = config;
  return Object.freeze({ id: captured.id, version: captured.version,
    async evaluate(value: InferInput<I>, supplied: GuardContext): Promise<Outcome<AuxiliaryResult<InferOutput<O>>>> {
      let deadline: Deadline | undefined;
      try {
        let context: GuardContext;
        try { context = snapshotContext(supplied); } catch { throw new MayuraError('INVALID_CONFIG', 'A valid auxiliary execution context is required.'); }
        deadline = new Deadline(context.signal, captured.limits.timeoutMs); context = snapshotContext(context, deadline.controller.signal);
        // Snapshot before any await, preserving the original even if the input schema transforms it.
        let original: JsonValue;
        try { original = freezeJson(jsonValue(value, { maxBytes: captured.limits.maxInputBytes })); }
        catch { throw new MayuraError('INVALID_INPUT', 'Auxiliary input must be bounded plain JSON.'); }
        if (!captured.allowed) throw new MayuraError('PERMISSION_DENIED', 'The auxiliary model destination was not granted.');
        const input = freezeJson(jsonValue(await deadline.run(() => validate(captured.input, original, 'input', { maxBytes: captured.limits.maxInputBytes })), { maxBytes: captured.limits.maxInputBytes }));
        await deadline.run(async () => {
          const verdicts = await Promise.all(captured.egressGuards.map(async guard => {
            try { const decision = (await guard.check(input, context)).decision; if (decision !== 'allow' && decision !== 'block') throw new Error(); return decision; }
            catch { throw new MayuraError('GUARD_UNAVAILABLE', 'A local egress guard could not establish a verdict.'); }
          }));
          if (verdicts.includes('block')) throw new MayuraError('GUARD_BLOCKED', 'A local egress guard withheld the request.');
        });
        const invocationId = crypto.randomUUID();
        const [originalDigest, inputDigest] = await deadline.run(() => Promise.all([digest(original), digest(input)]));
        let request: ModelRequest;
        try {
          const data = freezeJson(jsonValue({ instructions: captured.instructions, messages: [{ role: 'user', content: input }], tools: [], maxOutputTokens: captured.limits.maxOutputTokens }, { maxBytes: captured.limits.maxInputBytes }));
          request = Object.freeze({ ...data as unknown as Omit<ModelRequest, 'signal'>, signal: context.signal });
        } catch { throw new MayuraError('INVALID_INPUT', 'The auxiliary request exceeds its admitted input boundary.'); }
        const response = await deadline.run(async () => {
          const reservation = captured.budget.reserve(captured.maxCostMicros);
          let raw: unknown;
          try { raw = await captured.generate(request); }
          catch (error) {
            const cost = failedCost(error); if (cost !== undefined) reservation.settle(cost);
            throw new MayuraError('MODEL_FAILED', 'The auxiliary provider invocation failed.');
          }
          const costMicros = knownCost(raw); reservation.settle(costMicros);
          // This accounting callback remains attached after cancellation; no late output is released.
          return { output: finalOutput(raw, costMicros, captured.limits.maxOutputBytes), costMicros };
        });
        const output = freezeJson(jsonValue(await deadline.run(() => validate(captured.output, response.output, 'output', { maxBytes: captured.limits.maxOutputBytes })), { maxBytes: captured.limits.maxOutputBytes }));
        const outputDigest = await deadline.run(() => digest(output));
        const evidence: AuxiliaryEvidence = Object.freeze({ invocationId, checkId: captured.id, checkVersion: captured.version, modelId: captured.modelId,
          runId: context.runId, callId: context.callId, scope: context.scope, originalDigest, inputDigest, outputDigest, costMicros: response.costMicros,
        });
        return Object.freeze({ status: 'succeeded', output: Object.freeze({ original, input, output: output as InferOutput<O>, evidence }) });
      } catch (error) { return failed(error); }
      finally { deadline?.close(); }
    },
  });
}
