import { MayuraError, type Effect, type InferInput, type InferOutput, type Media, type RunHandle, type Schema } from '@mayura/core';
import { assertAgent, createRuntime, type AgentDefinition, type RuntimeLimits } from '@mayura/runtime';
import { defineTool, ToolRefusal, type AnyTool, type ToolDefinition, type ToolExecutionContext } from '@mayura/tools';

/** The agent's runtime limits. `maxCostMicros` is required: it is the most the step may spend. */
export type AgentStepLimits = Omit<RuntimeLimits, 'maxCostMicros'> & { readonly maxCostMicros: number };

interface AgentStepCommon<SI extends Schema, SO extends Schema, AI, AO> {
  /** The step tool's id: the workflow's policy grants `tool:<id>`. */
  readonly id: string;
  readonly version?: string;
  readonly description?: string;
  /**
   * Grants for the agent's own model and tool calls, for example `model:openai.responses` and `tool:tickets.label`.
   * The workflow's grants never widen them: the workflow grants the step, this grants the agent inside it.
   */
  readonly permissions: readonly string[];
  /**
   * Limits of the agent's run. `maxCostMicros` is the step's ceiling: the run budget reserves it before the step
   * starts and is charged what the agent actually spent. Use 0 only for a model that costs nothing.
   */
  readonly limits: AgentStepLimits;
  /** Extra grants the workflow's policy must hold to run the step. */
  readonly capabilities?: readonly string[];
  /** The step's deadline. Default: the agent's `maxDurationMs` (default 60 s) plus 15 s, so the agent's own limit fires first. */
  readonly timeoutMs?: number;
  /** Turn the step's input into the agent's input. Default: the step input is the agent input. */
  readonly prepare?: (input: InferOutput<SI>, context: ToolExecutionContext) => AI | Promise<AI>;
  /**
   * Images or PDFs for the agent to see, found when the step runs: for example read from an artifact store with
   * `mediaFromArtifact`, using a reference in the step's input. The workflow keeps only that JSON input, never media
   * bytes. A failure here is a refusal, like `prepare`.
   */
  readonly media?: (input: InferOutput<SI>, context: ToolExecutionContext) => readonly Media[] | Promise<readonly Media[]>;
  /**
   * Turn a successful agent output into the step's output, or throw to fail the step (for example after checking the
   * output). Default: the agent output is the step output.
   */
  readonly finish?: (output: AO, input: InferOutput<SI>, context: ToolExecutionContext) => InferInput<SO> | Promise<InferInput<SO>>;
  /**
   * Called once the agent's run starts, for example to observe or trace it. A returned function is awaited once the
   * run settles. Neither can fail the step: their errors are ignored.
   */
  readonly onRun?: (run: RunHandle<AO>, context: ToolExecutionContext) => void | (() => void | Promise<void>);
}

/** Options for an agent step whose agent is fixed. */
export interface AgentStepOptions<SI extends Schema, SO extends Schema, AI, AO> extends AgentStepCommon<SI, SO, AI, AO> {
  /** The step's input schema. Default: the agent's input. */
  readonly input?: SI;
  /** The step's output schema. Default: the agent's output. */
  readonly output?: SO;
}

/** Options for an agent step that builds its agent for each run, for example with tools bound to that run. */
export interface AgentStepFactoryOptions<SI extends Schema, SO extends Schema, AI, AO> extends AgentStepCommon<SI, SO, AI, AO> {
  readonly input: SI;
  readonly output: SO;
  /** The strongest effect the built agent's tools may have. A built agent with stronger tools fails the step before it runs. */
  readonly effects: Effect;
}

const rank: Readonly<Record<Effect, number>> = Object.freeze({ none: 0, read: 1, write: 2, host: 3 });
const effectsOf = (tools: readonly AnyTool[]): Effect =>
  tools.reduce<Effect>((strongest, tool) => rank[tool.effects] > rank[strongest] ? tool.effects : strongest, 'none');
const identifier = /^[A-Za-z][A-Za-z0-9._/-]{0,127}$/;

/**
 * An agent as one workflow step: a tool for a `tool` node of a lifecycle workflow (or any workflow that runs tools).
 *
 * Each time the step runs, it starts an in-process runtime with the run's scope, `permissions` and `limits`, runs the
 * agent, and reports what the agent actually spent, so the run budget is charged the real cost (never less than the
 * agent's known spending, never more than `limits.maxCostMicros`). The agent's outcome decides the step's:
 *
 * - `succeeded`: the step succeeds with the agent's output (or what `finish` returns);
 * - `failed`, `blocked` or `cancelled`: the step fails;
 * - `outcome_unknown`: the step is `unknown`, and the run needs reconciling. Its ceiling stays reserved.
 *
 * Cancelling or timing out the step cancels the agent. If the agent's tools can change things (`write` or `host`
 * effects), an interrupted step is `unknown`, because the agent may have been part-way through an effect.
 * A failure before the agent starts (building it, `prepare`) is a refusal: the step fails and is charged nothing.
 *
 * The workflow's policy must grant `tool:<id>`, each of `capabilities`, and `effect:<kind>` for the strongest effect
 * among the agent's tools. The model loop inside the step is not checkpointed: a crash mid-step leaves the step
 * dispatching until its timeout and a margin pass, when the next pass settles it as unknown (or `recoverAbandoned` does it
 * sooner). The agent is never run again by itself.
 */
export function agentStep<AI extends Schema, AO extends Schema, SI extends Schema = AI, SO extends Schema = AO>(
  agent: AgentDefinition<AI, AO>, options: AgentStepOptions<SI, SO, InferInput<AI>, InferOutput<AO>>): ToolDefinition<SI, SO>;
export function agentStep<SI extends Schema, SO extends Schema, AI extends Schema, AO extends Schema>(
  agent: (input: InferOutput<SI>, context: ToolExecutionContext) => AgentDefinition<AI, AO>,
  options: AgentStepFactoryOptions<SI, SO, InferInput<AI>, InferOutput<AO>>): ToolDefinition<SI, SO>;
export function agentStep(agent: AgentDefinition | ((input: unknown, context: ToolExecutionContext) => AgentDefinition),
  options: AgentStepOptions<Schema, Schema, unknown, unknown> & { readonly effects?: Effect }): AnyTool {
  if (!options || typeof options !== 'object' || typeof options.id !== 'string' || !identifier.test(options.id)) {
    throw new MayuraError('INVALID_CONFIG', 'agentStep needs an id: a letter, then up to 127 letters, digits, ".", "_", "/" or "-".');
  }
  const built = typeof agent === 'function';
  if (!built) assertAgent(agent);
  else if (!options.input || !options.output || !Object.hasOwn(rank, options.effects ?? '')) {
    throw new MayuraError('INVALID_CONFIG', `agentStep "${options.id}" builds its agent per run, so it needs input and output schemas and the effects of the agent's tools.`);
  }
  const grants: unknown = options.permissions;
  if (!Array.isArray(grants) || grants.length > 4_096 || grants.some(grant => typeof grant !== 'string' || grant.length < 1 || grant.length > 384)) {
    throw new MayuraError('INVALID_CONFIG', `agentStep "${options.id}" needs permissions: an array of the grants its agent may use.`);
  }
  const permissions = Object.freeze({ allow: Object.freeze([...grants as string[]]) });
  const limits = Object.freeze({ ...options.limits });
  const ceiling = limits.maxCostMicros;
  if (!Number.isSafeInteger(ceiling) || ceiling < 0) {
    throw new MayuraError('INVALID_CONFIG', `agentStep "${options.id}" needs limits.maxCostMicros: the most the step may spend (0 for a free model).`);
  }
  const effects: Effect = built ? options.effects! : effectsOf(agent.tools);
  // Only an agent that can change something outside the run can leave the step's outcome uncertain.
  const acting = effects === 'write' || effects === 'host';
  // How the step records an uncertain outcome. With a ceiling, the step is declared effect-free and reports the rest
  // of its ceiling as unknown cost, which makes its outcome unknown while a failed agent stays a plain failure. A step
  // that may spend nothing cannot report cost, so an acting agent's step declares the agent's effects instead: an
  // uncertain outcome is then unknown by itself, and a failure is a refusal (it spent nothing).
  const direct = acting && ceiling === 0;
  const capabilities = [...new Set([...(options.capabilities ?? []), ...(effects === 'none' || direct ? [] : [`effect:${effects}`])])];
  const timeoutMs = options.timeoutMs ?? (limits.maxDurationMs ?? 60_000) + 15_000;
  const name = built ? options.id : agent.id;
  return defineTool({
    id: options.id,
    version: options.version ?? (built ? '1' : agent.version),
    description: options.description ?? `Run the ${name} agent as one workflow step.`,
    input: (options.input ?? (agent as AgentDefinition).input) as Schema,
    output: (options.output ?? (agent as AgentDefinition).output) as Schema,
    // The step itself only runs the agent: its effects are the agent's, recorded by the agent's own runtime and
    // required as the `effect:<kind>` grant.
    effects: direct ? effects : 'none', capabilities, costMicros: ceiling, timeoutMs,
    execute: async (input, context) => {
      const refuse = (stage: string): never => { throw new ToolRefusal(`The agent step "${options.id}" ${stage}.`); };
      // Until the agent starts, nothing has run or been spent: a failure here is a refusal, charged nothing.
      let definition: AgentDefinition | undefined; let agentInput: unknown; let agentMedia: readonly Media[] = [];
      try {
        definition = built ? agent(input, context) : agent;
        assertAgent(definition);
        if (rank[effectsOf(definition.tools)] > rank[effects]) definition = undefined;
        else {
          agentInput = options.prepare ? await options.prepare(input, context) : input;
          if (options.media) agentMedia = await options.media(input, context);
        }
      } catch { definition = undefined; }
      if (!definition) return refuse('could not prepare its agent');
      const runtime = createRuntime({ profile: 'ephemeral', scope: context.scope, permissions, limits });
      let run: RunHandle<unknown> | undefined; let reported = false;
      const spent = (): number => {
        if (!run) return 0;
        const value = runtime.inspect(run).budget.spentMicros;
        // An overrun beyond safe integers, or beyond the ceiling, is charged the ceiling: the most the step may cost.
        return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? Math.min(value, ceiling) : ceiling;
      };
      const report = (knownCostMicros: number, unknownCostMicros: number): void => {
        if (reported) return; reported = true; context.reportUsage({ knownCostMicros, unknownCostMicros });
      };
      // Charge the whole ceiling: what the agent spent so far as known, the rest as unknown. Reported unknown cost is
      // what makes the step's outcome unknown.
      const uncertain = (): void => { const known = Math.min(spent(), ceiling - 1); report(known, ceiling - known); };
      /** A known failure: charged what the agent spent. */
      const fail = (stage: string): never => {
        if (direct) return refuse(stage);
        report(spent(), 0); throw new MayuraError('TOOL_FAILED', `The agent step "${options.id}" ${stage}.`);
      };
      const interrupt = (): void => {
        // Runs synchronously while the step is being cancelled or timed out, before the step's outcome is decided.
        if (acting && !direct && run) { try { uncertain(); } catch { /* The outcome is then decided without it. */ } }
        run?.cancel();
      };
      context.signal.addEventListener('abort', interrupt, { once: true });
      try {
        if (context.signal.aborted) return refuse('was cancelled before its agent started');
        let current: RunHandle<unknown>;
        try { current = runtime.submit(definition, { input: agentInput as never, ...(agentMedia.length > 0 ? { media: agentMedia } : {}) }); }
        catch { return refuse('could not start its agent'); }
        run = current;
        let finished: (() => void | Promise<void>) | void = undefined;
        try { finished = options.onRun?.(current, context); } catch { /* Observers never fail the step. */ }
        let outcome;
        try { outcome = await current.result(); }
        finally { try { if (typeof finished === 'function') await finished(); } catch { /* Observers never fail the step. */ } }
        if (outcome.status === 'outcome_unknown') {
          if (direct) throw new MayuraError('OUTCOME_UNKNOWN', `The agent step "${options.id}" has an unknown outcome.`);
          // Returning (rather than throwing) with unknown cost reported is how a tool says its outcome is unknown.
          if (ceiling > 0) { uncertain(); return undefined; }
        }
        if (outcome.status !== 'succeeded') return fail(`ended ${outcome.status}`);
        let output: unknown;
        try { output = options.finish ? await options.finish(outcome.output, input, context) : outcome.output; }
        catch { return fail('refused its agent\'s output'); }
        report(spent(), 0); return output;
      } finally {
        context.signal.removeEventListener('abort', interrupt);
        await runtime.close();
      }
    },
  }) as AnyTool;
}
