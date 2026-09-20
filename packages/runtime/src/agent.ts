import { assertSchema, jsonValue, MayuraError, type Guard, type InferInput, type InferOutput, type ModelAdapter, type Schema } from '@mayura/core';
import { assertTool, type AnyTool } from '@mayura/tools';

/** An immutable agent definition; executable adapters remain trusted application code. */
export interface AgentDefinition<I extends Schema = Schema, O extends Schema = Schema> {
  readonly id: string;
  readonly version: string;
  readonly instructions: string;
  readonly model: ModelAdapter;
  readonly tools: readonly AnyTool[];
  readonly input: Schema<InferInput<I>, InferOutput<I>>;
  readonly output: Schema<InferInput<O>, InferOutput<O>>;
  readonly guards: { readonly input: readonly Guard[]; readonly output: readonly Guard[] };
}

export type AgentOutput<A extends AgentDefinition> = InferOutput<A['output']>;
export interface AgentOptions<I extends Schema, O extends Schema> {
  readonly id: string;
  readonly version: string;
  readonly instructions: string;
  readonly model: ModelAdapter;
  readonly tools: readonly AnyTool[];
  readonly input: I;
  readonly output: O;
  readonly guards?: { readonly input?: readonly Guard[]; readonly output?: readonly Guard[] };
}

const definitions = new WeakSet<object>();
const identifier = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/;

/** Definition identifiers are bounded metadata, not arbitrary message or secret containers. */
export function isIdentifier(value: unknown): value is string {
  return typeof value === 'string' && identifier.test(value);
}

function snapshotGuards(guards: readonly Guard[]): readonly Guard[] {
  if (!Array.isArray(guards) || guards.length > 32) throw new MayuraError('INVALID_CONFIG', 'A guard boundary supports at most 32 guards.');
  const seen = new Set<string>();
  return Object.freeze(guards.map((guard) => {
    if (!isIdentifier(guard.id) || seen.has(guard.id) || typeof guard.check !== 'function') {
      throw new MayuraError('INVALID_CONFIG', 'Guards require unique bounded identifiers and check functions.');
    }
    seen.add(guard.id);
    return Object.freeze({ id: guard.id, check: guard.check.bind(guard) });
  }));
}

function snapshotSchema<S extends Schema>(schema: S): Schema<InferInput<S>, InferOutput<S>> {
  const standard = schema['~standard'];
  return Object.freeze({ '~standard': Object.freeze({ version: 1 as const, vendor: standard.vendor, validate: standard.validate.bind(standard) }) }) as Schema<InferInput<S>, InferOutput<S>>;
}

/** Define an agent without opening connections, executing tools, or selecting a hidden provider. */
export function defineAgent<I extends Schema, O extends Schema>(options: AgentOptions<I, O>): AgentDefinition<I, O> {
  if (!isIdentifier(options.id) || !isIdentifier(options.version) || typeof options.instructions !== 'string') {
    throw new MayuraError('INVALID_CONFIG', 'Agent identifiers, version, and instructions must be valid.');
  }
  jsonValue(options.instructions, { maxBytes: 65_536 });
  assertSchema(options.input);
  assertSchema(options.output);
  const model = options.model;
  if (!model || !isIdentifier(model.id) || typeof model.generate !== 'function'
    || typeof model.capabilities?.tools !== 'boolean' || typeof model.capabilities.structuredOutput !== 'boolean'
    || !Number.isSafeInteger(model.maxCostMicros) || model.maxCostMicros < 0) {
    throw new MayuraError('INVALID_CONFIG', 'A model adapter with explicit capabilities and bounded cost is required.');
  }
  if (!Array.isArray(options.tools) || options.tools.length > 256) {
    throw new MayuraError('INVALID_CONFIG', 'Agent tools must be an explicit bounded registry.');
  }
  const seen = new Set<string>();
  for (const tool of options.tools) {
    assertTool(tool);
    if (!tool || !isIdentifier(tool.id) || seen.has(tool.id)) {
      throw new MayuraError('INVALID_CONFIG', 'Agent tools require unique identifiers.');
    }
    seen.add(tool.id);
  }
  if (!model.capabilities.structuredOutput || (options.tools.length > 0 && !model.capabilities.tools)) {
    throw new MayuraError('INVALID_CONFIG', 'The model does not support the agent required capabilities.');
  }
  const definition: AgentDefinition<I, O> = Object.freeze({
    id: options.id,
    version: options.version,
    instructions: options.instructions,
    model: Object.freeze({
      id: model.id,
      capabilities: Object.freeze({ tools: model.capabilities.tools, structuredOutput: model.capabilities.structuredOutput }),
      maxCostMicros: model.maxCostMicros,
      generate: model.generate.bind(model),
    }),
    tools: Object.freeze([...options.tools]),
    input: snapshotSchema(options.input),
    output: snapshotSchema(options.output),
    guards: Object.freeze({ input: snapshotGuards(options.guards?.input ?? []), output: snapshotGuards(options.guards?.output ?? []) }),
  });
  definitions.add(definition);
  return definition;
}

/** Reject hand-built definitions whose admission checks never ran. */
export function assertAgent(value: AgentDefinition): void {
  if (!definitions.has(value)) throw new MayuraError('INVALID_CONFIG', 'Use defineAgent to register the agent definition.');
}
