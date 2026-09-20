import {
  freezeJson, jsonValue, MayuraError, ModelInvocationError,
  type Guard, type InferOutput, type JsonValue, type ModelAdapter, type ModelMessage,
  type ModelResponse, type ModelToolCall, type Schema,
} from '@mayura/core';
import { agentAsTool, defineAgent, type AgentDefinition, type AgentToolOptions } from '@mayura/runtime';
import type { AnyTool, ToolDefinition } from '@mayura/tools';
import { assertWorkflow, digest, resolveBinding, type AnyWorkflow, type WorkflowDefinition } from './definition.js';

export interface WorkflowAgentOptions {
  /** Explicit opt-in: no persistence, approval, lease, or restart semantics are implied. */
  readonly profile: 'ephemeral';
  /** Requires an explicit model:<plannerId> grant. The local planner performs no inference. */
  readonly plannerId?: string;
  readonly guards?: { readonly input?: readonly Guard[]; readonly output?: readonly Guard[] };
}
export interface WorkflowToolOptions extends WorkflowAgentOptions, AgentToolOptions {}

/** Reject malformed history without retaining input, result content, or plugin diagnostics. */
function invalid(): never { throw new ModelInvocationError(0); }
function exact(value: object, keys: readonly string[]): void {
  if (Object.keys(value).length !== keys.length || keys.some(key => !Object.hasOwn(value, key))) invalid();
}

/**
 * Reconstruct one finite graph from the owning runtime's admitted history.
 * There is deliberately no run state captured by the shared planner adapter.
 */
function plan(definition: AnyWorkflow, supplied: readonly ModelMessage[]): ModelResponse {
  const messages = jsonValue(supplied, { maxBytes: 8_388_608, maxNodes: 300_000 }) as unknown as readonly ModelMessage[];
  if (!Array.isArray(messages) || messages.length === 0 || messages.length > 257) invalid();
  const first = messages[0];
  if (!first || first.role !== 'user') invalid();
  exact(first, ['role', 'content']);
  const input = first.content;
  const results: Record<string, JsonValue> = Object.create(null) as Record<string, JsonValue>;
  const finished = (id: string): boolean => Object.hasOwn(results, id);
  const ready = (): readonly ModelToolCall[] => {
    // Joins can depend on other joins declared later, so project to a finite fixed point.
    for (let pass = 0; pass < definition.nodes.length; pass++) {
      let changed = false;
      for (const node of definition.nodes) {
        if (node.kind === 'join' && !finished(node.id) && node.dependsOn.every(finished)) {
          results[node.id] = node.dependsOn.map(id => results[id]!);
          changed = true;
        }
      }
      if (!changed) break;
    }
    return definition.nodes.flatMap(node => node.kind === 'tool' && !finished(node.id)
      && (node.dependsOn ?? []).every(finished)
      ? [{ id: node.id, toolId: node.tool.id, input: resolveBinding(node.input, input, results) }] : []);
  };
  let cursor = 1;
  while (cursor < messages.length) {
    const expected = ready();
    const assistant = messages[cursor++];
    if (!assistant || assistant.role !== 'assistant' || expected.length === 0) invalid();
    exact(assistant, ['role', 'calls']);
    if (!Array.isArray(assistant.calls) || assistant.calls.length !== expected.length) invalid();
    for (let index = 0; index < expected.length; index++) {
      const call = assistant.calls[index];
      const wanted = expected[index]!;
      if (!call || typeof call !== 'object') invalid();
      exact(call, ['id', 'toolId', 'input']);
      if (call.id !== wanted.id || call.toolId !== wanted.toolId
        || digest('mayura:workflow-binding:v1', call.input) !== digest('mayura:workflow-binding:v1', wanted.input)) invalid();
      const result = messages[cursor++];
      if (!result || result.role !== 'tool') invalid();
      exact(result, ['role', 'callId', 'toolId', 'result']);
      if (result.callId !== wanted.id || result.toolId !== wanted.toolId || finished(wanted.id)) invalid();
      results[wanted.id] = result.result;
    }
  }
  const calls = ready();
  if (calls.length > 0) return { type: 'tool_calls', calls, usage: { costMicros: 0 } };
  if (!definition.nodes.every(node => finished(node.id))) invalid();
  return { type: 'final', output: resolveBinding(definition.result, input, results), usage: { costMicros: 0 } };
}

/**
 * Compile an approval-free finite workflow into the existing ephemeral execution contract.
 * Each deterministic planning wave consumes a zero-cost model-call/step allowance.
 */
export function workflowAsAgent<I extends Schema, O extends Schema>(
  definition: WorkflowDefinition<I, O>, options: WorkflowAgentOptions,
): AgentDefinition<I, O> {
  assertWorkflow(definition);
  if (options?.profile !== 'ephemeral') throw new MayuraError('UNSUPPORTED_PROFILE', 'Workflow composition requires the explicit ephemeral profile.');
  const tools = new Map<string, AnyTool>();
  for (const node of definition.nodes) {
    if (node.kind !== 'tool') continue;
    if (node.approval) throw new MayuraError('UNSUPPORTED_PROFILE', 'Approval-required workflows need the durable execution profile.');
    const registered = tools.get(node.tool.id);
    if (registered && registered !== node.tool) throw new MayuraError('INVALID_CONFIG', 'Workflow tool identities must resolve to one immutable definition.');
    tools.set(node.tool.id, node.tool);
  }
  const model: ModelAdapter = {
    id: options.plannerId ?? 'mayura.workflow',
    capabilities: { tools: true, structuredOutput: true }, maxCostMicros: 0,
    async generate(request) {
      request.signal.throwIfAborted();
      try {
        const response = plan(definition, request.messages);
        request.signal.throwIfAborted();
        return freezeJson(jsonValue(response, { maxBytes: 8_388_608, maxNodes: 300_000 })) as unknown as ModelResponse;
      } catch { return invalid(); }
    },
  };
  // The workflow stores Standard Schema snapshots, not the consumer library's methods.
  // Its declared generic input/output directions are unchanged by that normalization.
  return defineAgent({
    id: `workflow.${definition.digest}`, version: '1', instructions: 'Execute the registered finite workflow graph.',
    model, tools: [...tools.values()], input: definition.input, output: definition.output,
    ...(options.guards === undefined ? {} : { guards: options.guards }),
  }) as AgentDefinition<I, O>;
}

/** Compose through the same required-child gateway; no independent budget or authority is minted. */
export function workflowAsTool<I extends Schema, O extends Schema>(
  definition: WorkflowDefinition<I, O>, options: WorkflowToolOptions,
): ToolDefinition<I, Schema<InferOutput<O>>> {
  return agentAsTool(workflowAsAgent(definition, options), options);
}
