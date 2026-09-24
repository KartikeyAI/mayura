import { MayuraError, type InferInput, type InferOutput, type Permissions, type Schema } from '@mayura/core';
import { assertAgent, createRuntime, type AgentDefinition, type RuntimeLimits } from '@mayura/runtime';
import { defineTool } from '@mayura/tools';
import { defineWorkflow, type WorkflowDefinition } from './definition.js';

export interface DurableAgentWorkflowOptions {
  readonly id?: string;
  readonly version?: string;
  /** Authority available inside the admitted agent phase; it is still intersected with outer workflow authority. */
  readonly permissions: Permissions;
  readonly limits?: RuntimeLimits;
  /** Host/model phases require approval by default. */
  readonly approval?: boolean;
}

function identity<T>(vendor: string): Schema<T> {
  return Object.freeze({ '~standard': Object.freeze({ version: 1 as const, vendor, validate: (value: unknown) => ({ value: value as T }) }) });
}

/**
 * Compile one genuine agent definition into a conservative scheduled-workflow phase.
 * The phase is restart-safe at its outer intent/receipt boundary, but the in-phase
 * model loop is not checkpointed; an interrupted host effect becomes unknown and is
 * never replayed automatically.
 */
export function agentAsDurableWorkflow<I extends Schema, O extends Schema>(
  agent: AgentDefinition<I, O>, options: DurableAgentWorkflowOptions,
): WorkflowDefinition<Schema<InferInput<I>>, Schema<InferOutput<O>>> {
  assertAgent(agent);
  if (!Array.isArray(options?.permissions?.allow)) throw new MayuraError('INVALID_CONFIG', 'Durable agent phases require explicit inner authority.');
  const permissions = Object.freeze({ allow: Object.freeze([...options.permissions.allow]) });
  const limits = Object.freeze({ ...options.limits });
  const maximumCost = limits.maxCostMicros ?? 0;
  if (!Number.isSafeInteger(maximumCost) || maximumCost < 0) throw new MayuraError('INVALID_CONFIG', 'Durable agent cost must be explicitly bounded.');
  const input = identity<InferInput<I>>('mayura.durable-agent-input');
  const output = identity<InferOutput<O>>('mayura.durable-agent-output');
  const phase = defineTool<Schema<InferInput<I>>, Schema<InferOutput<O>>>({
    id: `${options.id ?? agent.id}.agent`, version: options.version ?? agent.version,
    description: `Execute the registered ${agent.id} agent definition as one durable phase.`, input, output,
    effects: 'host', capabilities: ['agent:durable', `model:${agent.model.id}`], costMicros: maximumCost,
    timeoutMs: limits.maxDurationMs ?? 60_000,
    execute: async (supplied, context) => {
      const runtime = createRuntime({ profile: 'ephemeral', scope: context.scope, permissions, limits });
      try {
        const run = runtime.submit<I, O>(agent, { input: supplied });
        const outcome = await run.result();
        const inspection = runtime.inspect(run);
        if (outcome.status !== 'succeeded') throw new MayuraError('TOOL_FAILED', 'The durable agent phase did not succeed.');
        const spent = inspection.budget.spentMicros;
        if (typeof spent !== 'number') throw new MayuraError('BUDGET_EXCEEDED', 'The durable agent phase exceeded numeric accounting bounds.');
        context.reportUsage({ knownCostMicros: spent, unknownCostMicros: 0 });
        return outcome.output;
      } finally { await runtime.close(); }
    },
  });
  return defineWorkflow({
    id: options.id ?? `agent.${agent.id}`, version: options.version ?? agent.version, input, output,
    nodes: [{ kind: 'tool', id: 'execute', tool: phase, input: { kind: 'input', path: [] }, approval: options.approval ?? true }],
    result: { kind: 'step', stepId: 'execute', path: [] },
  });
}
