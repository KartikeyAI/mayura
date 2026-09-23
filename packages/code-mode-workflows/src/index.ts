import { MayuraError, type Effect, type Schema } from '@mayura/core';
import { assertCodeMode, assertCodeProgram, type CodeMode, type CodeProgramDefinition } from '@mayura/code-mode';
import { defineTool } from '@mayura/tools';
import { defineWorkflow, type Binding, type WorkflowDefinition } from '@mayura/workflows';

export interface DurableCodePhase {
  readonly id: string;
  readonly program: CodeProgramDefinition;
  readonly input: Binding;
  readonly dependsOn?: readonly string[];
}

export interface DurableCodeWorkflowOptions<I extends Schema, O extends Schema> {
  readonly id: string;
  readonly version: string;
  readonly input: I;
  readonly output: O;
  readonly codeMode: CodeMode;
  readonly phases: readonly DurableCodePhase[];
  readonly result: Binding;
}

const effectRank: Readonly<Record<Effect, number>> = Object.freeze({ none: 0, read: 1, write: 2, host: 3 });

function data(value: unknown, fields: readonly string[], required: readonly string[] = fields): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new MayuraError('INVALID_CONFIG', 'Durable Code Mode definitions must be plain data.');
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(descriptors).some(key => typeof key !== 'string' || !fields.includes(key))
    || required.some(key => !descriptors[key])) throw new MayuraError('INVALID_CONFIG', 'Durable Code Mode fields are invalid.');
  const result: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const [key, descriptor] of Object.entries(descriptors)) {
    if (!descriptor.enumerable || !('value' in descriptor)) throw new MayuraError('INVALID_CONFIG', 'Durable Code Mode fields must be data properties.');
    if (descriptor.value !== undefined || required.includes(key)) result[key] = descriptor.value;
  }
  return result;
}

function phaseTool(mode: CodeMode, program: CodeProgramDefinition) {
  assertCodeProgram(program);
  const maximumToolCost = program.manifest.tools.reduce((maximum, tool) => Math.max(maximum, tool.costMicros), 0);
  const costMicros = maximumToolCost * program.manifest.limits.maxToolCalls;
  if (!Number.isSafeInteger(costMicros)) throw new MayuraError('LIMIT_EXCEEDED', 'Durable phase maximum tool cost exceeds safe accounting.');
  const effects = program.manifest.tools.reduce<Effect>((strongest, tool) => effectRank[tool.effects] > effectRank[strongest] ? tool.effects : strongest, 'none');
  return defineTool({
    id: `code.${program.manifest.digest.slice(0, 32)}`,
    version: program.manifest.digest,
    description: `Approved Code Mode phase: ${program.manifest.id}`,
    input: program.input,
    output: program.output,
    effects,
    capabilities: [`code:execute`, `code:program:${program.manifest.digest}`],
    timeoutMs: program.manifest.limits.wallTimeMillis,
    costMicros,
    execute: async (input, context) => {
      const outcome = await mode.execute(program, input, { runId: context.runId, executionId: `${context.callId}:sandbox`,
        scope: context.scope, signal: context.signal });
      if (outcome.status === 'succeeded') return outcome.output;
      throw new MayuraError(outcome.error.code, 'Durable Code Mode phase failed; nested details are withheld.');
    },
  });
}

/**
 * Creates a finite durable workflow whose Code Mode phases all require exact human approval.
 * Persistence, leasing and no-replay behavior are supplied by the selected scheduled-workflow runtime.
 */
export function defineDurableCodeWorkflow<I extends Schema, O extends Schema>(
  options: DurableCodeWorkflowOptions<I, O>,
): WorkflowDefinition<I, O> {
  const value = data(options, ['id', 'version', 'input', 'output', 'codeMode', 'phases', 'result']);
  const mode = value['codeMode'] as CodeMode;
  assertCodeMode(mode);
  if (!Array.isArray(value['phases']) || value['phases'].length < 1 || value['phases'].length > 128) {
    throw new MayuraError('INVALID_CONFIG', 'Durable Code Mode requires 1–128 explicit phases.');
  }
  const phases = value['phases'].map(item => {
    const phase = data(item, ['id', 'program', 'input', 'dependsOn'], ['id', 'program', 'input']);
    if (typeof phase['id'] !== 'string') throw new MayuraError('INVALID_CONFIG', 'Durable Code Mode phase id is invalid.');
    const program = phase['program'] as CodeProgramDefinition;
    return Object.freeze({ kind: 'tool' as const, id: phase['id'], tool: phaseTool(mode, program), input: phase['input'] as Binding,
      ...(phase['dependsOn'] === undefined ? {} : { dependsOn: phase['dependsOn'] as readonly string[] }), approval: true });
  });
  return defineWorkflow({ id: value['id'] as string, version: value['version'] as string, input: value['input'] as I,
    output: value['output'] as O, nodes: phases, result: value['result'] as Binding });
}

