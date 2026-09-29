import { assertSchema, freezeJson, jsonSchemaOf, jsonValue, MayuraError, MEDIA_TYPES, type Guard, type JsonObject, type ManagedGuardDefinition, type InferInput, type InferOutput, type MediaPolicy, type MediaType, type ModelAdapter, type ModelMediaCapability, type Schema } from '@mayura/core';
import { mediaPolicy, readManagedGuardDefinition, snapshotLocalGuards, type ResolvedMediaPolicy } from '@mayura/core/host';
import { assertTool, type AnyTool } from '@mayura/tools';
import { snapshotHooks, type HookDefinition } from './hooks.js';

export type AgentGuard = Guard | ManagedGuardDefinition;

/** An immutable agent definition; executable adapters remain trusted application code. */
export interface AgentDefinition<I extends Schema = Schema, O extends Schema = Schema> {
  readonly id: string;
  readonly version: string;
  readonly instructions: string;
  readonly model: ModelAdapter;
  readonly tools: readonly AnyTool[];
  readonly input: Schema<InferInput<I>, InferOutput<I>>;
  readonly output: Schema<InferInput<O>, InferOutput<O>>;
  readonly guards: { readonly input: readonly AgentGuard[]; readonly output: readonly AgentGuard[] };
  readonly hooks: readonly HookDefinition[];
  readonly stream?: AgentStreamPolicy;
  /** The input as JSON Schema, when the input validator can describe itself; `agentAsTool` shows it to a parent model. */
  readonly inputJsonSchema?: JsonObject;
  /** The output as JSON Schema, sent with every model request: given in the options or generated from `output`. */
  readonly outputJsonSchema?: JsonObject;
  /** The media (images, PDFs) the agent accepts with its input, with defaults filled in; absent when it accepts none. */
  readonly media?: ResolvedMediaPolicy;
}

/**
 * Opt-in streaming of one text field of the final output (the "guarded batches" policy). Without it, output is
 * buffered: nothing is released until the complete output has passed validation and every output guard.
 */
export interface AgentStreamPolicy {
  /** Path of the string field to stream, for example `['reply']`. */
  readonly field: readonly string[];
  /**
   * Local guards run on each batch before it is released, with up to 512 characters of already released text for
   * context. A block (or an unavailable guard) stops further release for that model call. Pass `[]` explicitly to
   * stream without batch checks. Released text cannot be retracted by a later verdict; the complete output still
   * passes the agent's output guards before the run succeeds.
   */
  readonly guards: readonly Guard[];
  /** Characters per batch: at least `minChars` ending at whitespace (default 24), at most `maxChars` (default 512). */
  readonly batch?: { readonly minChars?: number; readonly maxChars?: number };
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
  readonly guards?: { readonly input?: readonly AgentGuard[]; readonly output?: readonly AgentGuard[] };
  readonly hooks?: readonly HookDefinition[];
  readonly stream?: AgentStreamPolicy;
  /**
   * The output as JSON Schema, for model providers. Leave it out to generate it from `output` (Zod 4.2 and later
   * validators can describe themselves); give it when yours cannot, or to tell the model something narrower.
   */
  readonly outputJsonSchema?: JsonObject;
  /**
   * Images or PDFs the agent accepts with its input (`runtime.submit(agent, { input, media })`), for a model that can
   * see them. Nothing is accepted unless declared here.
   */
  readonly media?: MediaPolicy;
}

const definitions = new WeakSet<object>();

/** The media a model could be sent by this agent: with its input, or returned by its tools. */
function mediaNeeds(agentMedia: ResolvedMediaPolicy | undefined, tools: readonly AnyTool[]): { readonly types: readonly MediaType[]; readonly urls: boolean } | undefined {
  const policies = [agentMedia, ...tools.map(tool => tool.media)].filter((policy): policy is ResolvedMediaPolicy => policy !== undefined);
  if (policies.length === 0) return undefined;
  const types = MEDIA_TYPES.filter(type => policies.some(policy => policy.accept.includes(type)));
  return Object.freeze({ types: Object.freeze(types), urls: policies.some(policy => policy.urls.length > 0) });
}

/** A copy of a model's declared media capability, or undefined when it declares none (or an invalid one). */
function mediaCapability(value: unknown): ModelMediaCapability | undefined {
  if (value === undefined) return undefined;
  const capability = value as Partial<ModelMediaCapability> | null;
  if (!capability || !Array.isArray(capability.types) || capability.types.some(type => !MEDIA_TYPES.includes(type)) || typeof capability.urls !== 'boolean') {
    throw new MayuraError('INVALID_CONFIG', 'A model adapter\'s capabilities.media must list media types and say whether it takes URLs.');
  }
  return Object.freeze({ types: Object.freeze([...new Set(capability.types)]), urls: capability.urls });
}
const identifier = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/;

/** Definition identifiers are bounded metadata, not arbitrary message or secret containers. */
export function isIdentifier(value: unknown): value is string {
  return typeof value === 'string' && identifier.test(value);
}
const modelIdentifier = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;
/** A model adapter's id: an identifier that may also contain `:`, as provider model names do (`ollama/llama3.1:8b`). */
export function isModelId(value: unknown): value is string {
  return typeof value === 'string' && modelIdentifier.test(value);
}

function snapshotGuards(guards: readonly AgentGuard[]): readonly AgentGuard[] {
  try {
    if (!Array.isArray(guards)) throw new Error();
    const fields = Object.getOwnPropertyDescriptors(guards);
    const length = Object.getOwnPropertyDescriptor(guards, 'length');
    if (!length || !('value' in length) || !Number.isSafeInteger(length.value) || length.value < 0 || length.value > 32
      || Reflect.ownKeys(fields).length !== length.value + 1) throw new Error();
    const seen = new Set<string>(); const result: AgentGuard[] = [];
    for (let index = 0; index < length.value; index++) {
      const entry = fields[String(index)];
      if (!entry || !('value' in entry)) throw new Error();
      const guard: unknown = entry.value;
      const descriptor = readManagedGuardDefinition(guard);
      const captured = descriptor ? guard as ManagedGuardDefinition : snapshotLocalGuards([guard as Guard])[0]!;
      if (!isIdentifier(captured.id) || seen.has(captured.id)) throw new Error();
      seen.add(captured.id);
      result.push(captured); // Preserve genuine managed identity; never clone its authority.
    }
    return Object.freeze(result);
  } catch { throw new MayuraError('INVALID_CONFIG', 'Guards require a dense data list of unique local callbacks or genuinely registered managed definitions.'); }
}

function snapshotSchema<S extends Schema>(schema: S): Schema<InferInput<S>, InferOutput<S>> {
  const standard = schema['~standard'];
  return Object.freeze({ '~standard': Object.freeze({ version: 1 as const, vendor: standard.vendor, validate: standard.validate.bind(standard) }) }) as Schema<InferInput<S>, InferOutput<S>>;
}

/** Do not execute a newly introduced hooks accessor while capturing the agent configuration. */
function agentHooks(options: object): readonly HookDefinition[] {
  try {
    const field = Object.getOwnPropertyDescriptor(options, 'hooks');
    if (!field) {
      if ('hooks' in options) throw new Error();
      return snapshotHooks([]);
    }
    if (!field.enumerable || !('value' in field)) throw new Error();
    return snapshotHooks(field.value === undefined ? [] : field.value);
  } catch { throw new MayuraError('INVALID_CONFIG', 'Agent hooks must be an own data configuration containing genuine hook definitions.'); }
}

function streamPolicy(value: AgentStreamPolicy): AgentStreamPolicy {
  try {
    const field = value.field; const batch = value.batch ?? {};
    if (!Array.isArray(field) || field.length < 1 || field.length > 8 || field.some(part => typeof part !== 'string' || part.length < 1 || part.length > 128)) throw new Error();
    const minChars = batch.minChars ?? 24; const maxChars = batch.maxChars ?? 512;
    if (!Number.isSafeInteger(minChars) || !Number.isSafeInteger(maxChars) || minChars < 1 || maxChars < minChars || maxChars > 4_096) throw new Error();
    // Batch checks run on every release, so they must be local callbacks, never model-backed managed guards.
    if (!Array.isArray(value.guards) || value.guards.some(guard => readManagedGuardDefinition(guard))) throw new Error();
    return Object.freeze({ field: Object.freeze([...field]), guards: snapshotGuards(value.guards) as readonly Guard[], batch: Object.freeze({ minChars, maxChars }) });
  } catch { throw new MayuraError('INVALID_CONFIG', 'Agent streaming needs a field path (1–8 parts), explicit local batch guards and bounded batch sizes.'); }
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
  if (!model || !isModelId(model.id) || typeof model.generate !== 'function'
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
  // Media reaches the model with the input and from tools; the model must be able to see every type either may carry.
  const agentMedia = options.media === undefined ? undefined : mediaPolicy(options.media, `Agent ${options.id}`);
  const needs = mediaNeeds(agentMedia, options.tools);
  const canSee = mediaCapability(model.capabilities.media);
  if (needs) {
    const unseen = needs.types.filter(type => !canSee?.types.includes(type));
    if (unseen.length > 0) {
      throw new MayuraError('INVALID_CONFIG', `Agent ${options.id}: its model (${model.id}) cannot see ${unseen.join(', ')}, which the agent accepts or its tools return. `
        + (canSee ? `It can see ${canSee.types.join(', ') || 'no media'}.` : 'Its adapter declares no media capability; use a model that can see, or set the adapter\'s media option if it can.'));
    }
    if (needs.urls && !canSee?.urls) throw new MayuraError('INVALID_CONFIG', `Agent ${options.id}: its model (${model.id}) cannot take media URLs; remove media.urls and send the bytes.`);
  }
  let outputJsonSchema: JsonObject | undefined;
  if (options.outputJsonSchema === undefined) outputJsonSchema = jsonSchemaOf(options.output);
  else {
    const given = jsonValue(options.outputJsonSchema, { maxBytes: 262_144 });
    if (!given || typeof given !== 'object' || Array.isArray(given)) throw new MayuraError('INVALID_CONFIG', 'outputJsonSchema must be a JSON Schema object.');
    outputJsonSchema = freezeJson(given) as JsonObject;
  }
  const inputJsonSchema = jsonSchemaOf(options.input);
  // The adapter checks now what it would otherwise refuse on the first call, such as a schema its provider rejects.
  if (typeof model.checkDefinition === 'function') {
    const tools = options.tools.map(tool => Object.freeze({ id: tool.id, description: tool.description, ...(tool.inputJsonSchema === undefined ? {} : { inputJsonSchema: tool.inputJsonSchema }) }));
    try { model.checkDefinition(Object.freeze({ tools: Object.freeze(tools), ...(outputJsonSchema === undefined ? {} : { outputJsonSchema }), ...(needs ? { media: needs } : {}) })); }
    catch (error) {
      if (error instanceof MayuraError && error.code === 'INVALID_CONFIG') throw new MayuraError('INVALID_CONFIG', `Agent ${options.id}: ${error.message}`);
      throw new MayuraError('INVALID_CONFIG', `Agent ${options.id}: the model adapter refused this agent's tools or output schema.`);
    }
  }
  const definition: AgentDefinition<I, O> = Object.freeze({
    id: options.id,
    version: options.version,
    instructions: options.instructions,
    model: Object.freeze({
      id: model.id,
      capabilities: Object.freeze({ tools: model.capabilities.tools, structuredOutput: model.capabilities.structuredOutput, ...(canSee ? { media: canSee } : {}) }),
      maxCostMicros: model.maxCostMicros,
      generate: model.generate.bind(model),
      ...(typeof model.stream === 'function' ? { stream: model.stream.bind(model) } : {}),
    }),
    tools: Object.freeze([...options.tools]),
    input: snapshotSchema(options.input),
    output: snapshotSchema(options.output),
    guards: Object.freeze({ input: snapshotGuards(options.guards?.input ?? []), output: snapshotGuards(options.guards?.output ?? []) }),
    hooks: agentHooks(options),
    ...(options.stream === undefined ? {} : { stream: streamPolicy(options.stream) }),
    ...(inputJsonSchema === undefined ? {} : { inputJsonSchema }),
    ...(outputJsonSchema === undefined ? {} : { outputJsonSchema }),
    ...(agentMedia === undefined ? {} : { media: agentMedia }),
  });
  definitions.add(definition);
  return definition;
}

/** Reject hand-built definitions whose admission checks never ran. */
export function assertAgent(value: AgentDefinition): void {
  if (!definitions.has(value)) throw new MayuraError('INVALID_CONFIG', 'Use defineAgent to register the agent definition.');
}
