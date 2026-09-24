import { assertSchema, MayuraError, type InferInput, type InferOutput, type Schema } from '@mayura/core';
import { workflowLoopManifest, type WorkflowLoopBinding, type WorkflowLoopManifest } from '@mayura/storage-contracts';
import { digest, type Binding } from './definition.js';
import { assertWorkflowLifecycle, type AnyWorkflowLifecycle } from './lifecycle-definition.js';

export interface WorkflowLoopOptions<I extends Schema, O extends Schema> {
  readonly id: string; readonly version: string; readonly input: I; readonly output: O;
  readonly body: AnyWorkflowLifecycle; readonly maxIterations: number; readonly initial: Exclude<Binding, { readonly kind: 'step' }>;
  readonly next: WorkflowLoopBinding; readonly continueWhen: WorkflowLoopBinding; readonly result: WorkflowLoopBinding;
}

declare const loopDefinitionBrand: unique symbol;
export interface WorkflowLoopDefinition<I extends Schema = Schema, O extends Schema = Schema> {
  readonly [loopDefinitionBrand]: true; readonly format: 1; readonly id: string; readonly version: string;
  readonly digest: string; readonly input: Schema<InferInput<I>, InferOutput<I>>;
  readonly output: Schema<InferInput<O>, InferOutput<O>>; readonly body: AnyWorkflowLifecycle;
  readonly maxIterations: number; readonly initial: Exclude<Binding, { readonly kind: 'step' }>; readonly next: WorkflowLoopBinding;
  readonly continueWhen: WorkflowLoopBinding; readonly result: WorkflowLoopBinding;
  readonly maxCostMicros: number; readonly maxCalls: number;
}
export type AnyWorkflowLoop = WorkflowLoopDefinition;
export type WorkflowLoopOutput<D extends AnyWorkflowLoop> = InferOutput<D['output']>;
const definitions = new WeakSet<object>();

function snapshot<S extends Schema>(schema: S): Schema<InferInput<S>, InferOutput<S>> {
  const standard = schema['~standard'];
  return Object.freeze({ '~standard': Object.freeze({ version: 1 as const, vendor: standard.vendor,
    validate: standard.validate.bind(standard) }) }) as Schema<InferInput<S>, InferOutput<S>>;
}
function bodyBounds(body: AnyWorkflowLifecycle) {
  let maxCostMicros = 0; let maxCalls = 0;
  for (const node of body.nodes) if (node.kind === 'tool') { maxCostMicros += node.tool.costMicros; maxCalls += 1; }
  if (!Number.isSafeInteger(maxCostMicros)) throw new MayuraError('INVALID_CONFIG', 'Loop static cost exceeds the safe integer boundary.');
  return { definitionHash: body.digest, maxCostMicros, maxCalls };
}

export function assertWorkflowLoop(definition: AnyWorkflowLoop): void {
  if (!definitions.has(definition)) throw new MayuraError('INVALID_CONFIG', 'Use defineWorkflowLoop from this package instance.');
}

export function loopManifest(definition: Pick<AnyWorkflowLoop, 'id' | 'version' | 'body' | 'maxIterations' |
  'initial' | 'next' | 'continueWhen' | 'result'>): WorkflowLoopManifest {
  try {
    assertWorkflowLifecycle(definition.body); const body = bodyBounds(definition.body);
    return workflowLoopManifest({ format: 1, id: definition.id, version: definition.version, body,
      maxIterations: definition.maxIterations, initial: definition.initial, next: definition.next,
      continueWhen: definition.continueWhen, result: definition.result,
      maxCostMicros: body.maxCostMicros * definition.maxIterations, maxCalls: body.maxCalls * definition.maxIterations });
  } catch { throw new MayuraError('INVALID_CONFIG', 'Workflow loop metadata is invalid or exceeds its finite bounds.'); }
}

/** Define an explicitly bounded durable loop whose condition is read from admitted JSON state. */
export function defineWorkflowLoop<I extends Schema, O extends Schema>(options: WorkflowLoopOptions<I, O>): WorkflowLoopDefinition<I, O> {
  if (!options) throw new MayuraError('INVALID_CONFIG', 'Workflow loop options are required.');
  assertSchema(options.input); assertSchema(options.output); const manifest = loopManifest(options);
  const definition = Object.freeze({ format: 1 as const, id: manifest.id, version: manifest.version,
    digest: digest('mayura:workflow-loop:v1', manifest), input: snapshot(options.input), output: snapshot(options.output),
    body: options.body, maxIterations: manifest.maxIterations, initial: manifest.initial, next: manifest.next,
    continueWhen: manifest.continueWhen, result: manifest.result,
    maxCostMicros: manifest.maxCostMicros, maxCalls: manifest.maxCalls }) as WorkflowLoopDefinition<I, O>;
  definitions.add(definition); return definition;
}
