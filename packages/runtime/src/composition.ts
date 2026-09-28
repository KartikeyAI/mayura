import { jsonValue, MayuraError, type InferInput, type InferOutput, type JsonObject, type Permissions, type RunHandle, type Schema } from '@mayura/core';
import { createToolContextSlot, defineTool, type AnyTool, type ToolDefinition } from '@mayura/tools';
import { assertAgent, type AgentDefinition } from './agent.js';
import type { RuntimeLimits } from './runtime.js';

export interface ChildOptions {
  readonly permissions: Permissions;
  readonly limits?: RuntimeLimits;
}
export interface AgentToolOptions extends ChildOptions {
  readonly id: string;
  readonly description: string;
  readonly inputJsonSchema?: JsonObject;
}
/** Private execution capability, provided only to broker-minted contexts in the owning runtime. */
export const childGateway = createToolContextSlot<{
  spawn(agent: AgentDefinition, input: unknown, options: ChildOptions, signal: AbortSignal): RunHandle<unknown>;
}>();
const composed = new WeakSet<object>();
export function isAgentTool(tool: AnyTool): boolean { return composed.has(tool); }

/** Expose an agent through the same tool broker without new credit, authority, or transcript inheritance. */
export function agentAsTool<I extends Schema, O extends Schema>(
  agent: AgentDefinition<I, O>, options: AgentToolOptions,
): ToolDefinition<I, Schema<InferOutput<O>>> {
  assertAgent(agent);
  const permissions = options.permissions;
  if (!Array.isArray(permissions?.allow) || permissions.allow.length > 4096
    || permissions.allow.some((value) => typeof value !== 'string' || value.length === 0 || value.length > 256)) {
    throw new MayuraError('INVALID_CONFIG', 'Child permissions must be an explicit bounded grant list.');
  }
  const childOptions: ChildOptions = Object.freeze({
    permissions: Object.freeze({ allow: Object.freeze([...new Set(permissions.allow)]) }),
    ...(options.limits === undefined ? {} : { limits: Object.freeze({ ...options.limits }) }),
  });
  // The child owns output schema transformation. The wrapper only checks bounded JSON.
  const output: Schema<InferOutput<O>> = { '~standard': { version: 1, vendor: 'mayura', validate: (value) => ({ value: value as InferOutput<O> }) } };
  // Enforce the raw child's boundary before a transforming schema can shrink a large input.
  const input: Schema<InferInput<I>, InferOutput<I>> = { '~standard': {
    version: 1, vendor: 'mayura', validate: (value) => {
      try { jsonValue(value, { maxBytes: childOptions.limits?.maxInputBytes ?? 1_048_576 }); }
      catch { return { issues: [{ message: 'Child input exceeds its JSON boundary.' }] }; }
      return agent.input['~standard'].validate(value);
    },
  } };
  const tool = defineTool<Schema<InferInput<I>, InferOutput<I>>, Schema<InferOutput<O>>>({
    id: options.id, version: agent.version, description: options.description, input, output,
    effects: 'none', capabilities: ['agent:delegate'], costMicros: 0,
    timeoutMs: options.limits?.maxDurationMs ?? 2_147_483_647,
    // A parent model is told the child's input: as given, or the child's own input as JSON Schema.
    ...(options.inputJsonSchema !== undefined ? { inputJsonSchema: options.inputJsonSchema } : agent.inputJsonSchema !== undefined ? { inputJsonSchema: agent.inputJsonSchema } : {}),
    execute: async (input, context) => {
      const gateway = childGateway.get(context);
      if (!gateway) throw new MayuraError('PERMISSION_DENIED', 'Agent composition requires a live owning runtime.');
      // Input has passed the broker's schema. The non-exported gateway records that provenance.
      const child = gateway.spawn(agent, input, childOptions, context.signal);
      const outcome = await child.result();
      if (outcome.status !== 'succeeded') throw new MayuraError('TOOL_FAILED', 'A required child did not succeed.');
      return outcome.output as InferInput<typeof output>;
    },
  });
  composed.add(tool);
  return tool as ToolDefinition<I, Schema<InferOutput<O>>>;
}
