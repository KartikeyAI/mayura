import { assertSchema, MayuraError, type InferInput, type InferOutput, type Schema } from '@mayura/core';
import { workflowSagaManifest, type WorkflowSagaManifest } from '@mayura/storage-contracts';
import { digest, type Binding } from './definition.js';
import { assertWorkflowLifecycle, type AnyWorkflowLifecycle } from './lifecycle-definition.js';

export interface WorkflowSagaCompensation {
  readonly workflow: AnyWorkflowLifecycle;
  readonly input: Binding;
}

export interface WorkflowSagaStep {
  readonly id: string;
  readonly forward: AnyWorkflowLifecycle;
  readonly input: Binding;
  readonly compensation?: WorkflowSagaCompensation;
}

export interface WorkflowSagaOptions<I extends Schema, O extends Schema> {
  readonly id: string;
  readonly version: string;
  readonly input: I;
  readonly output: O;
  readonly steps: readonly WorkflowSagaStep[];
  readonly result: Binding;
}

declare const sagaDefinitionBrand: unique symbol;
export interface WorkflowSagaDefinition<I extends Schema = Schema, O extends Schema = Schema> {
  readonly [sagaDefinitionBrand]: true;
  readonly format: 1;
  readonly id: string;
  readonly version: string;
  readonly digest: string;
  readonly input: Schema<InferInput<I>, InferOutput<I>>;
  readonly output: Schema<InferInput<O>, InferOutput<O>>;
  readonly steps: readonly WorkflowSagaStep[];
  readonly result: Binding;
  readonly maxCostMicros: number;
  readonly maxCalls: number;
}

export type AnyWorkflowSaga = WorkflowSagaDefinition;
export type WorkflowSagaOutput<D extends AnyWorkflowSaga> = InferOutput<D['output']>;
const definitions = new WeakSet<object>();

function snapshot<S extends Schema>(schema: S): Schema<InferInput<S>, InferOutput<S>> {
  const standard = schema['~standard'];
  return Object.freeze({ '~standard': Object.freeze({ version: 1 as const, vendor: standard.vendor,
    validate: standard.validate.bind(standard) }) }) as Schema<InferInput<S>, InferOutput<S>>;
}

function childBounds(workflow: AnyWorkflowLifecycle): { readonly definitionHash: string; readonly maxCostMicros: number; readonly maxCalls: number } {
  let maxCostMicros = 0; let maxCalls = 0;
  for (const node of workflow.nodes) if (node.kind === 'tool') {
    maxCostMicros += node.tool.costMicros; maxCalls += 1;
    if (!Number.isSafeInteger(maxCostMicros)) throw new MayuraError('INVALID_CONFIG', 'Saga static cost exceeds the safe integer boundary.');
  }
  return Object.freeze({ definitionHash: workflow.digest, maxCostMicros, maxCalls });
}

/** Executable saga definitions must originate from this package instance. */
export function assertWorkflowSaga(definition: AnyWorkflowSaga): void {
  if (!definitions.has(definition)) throw new MayuraError('INVALID_CONFIG', 'Use defineWorkflowSaga from this package instance.');
}

/** Return the strict, callback-free format-1 saga persistence material. */
export function sagaManifest(definition: Pick<AnyWorkflowSaga, 'id' | 'version' | 'steps' | 'result'>): WorkflowSagaManifest {
  try {
    let maxCostMicros = 0; let maxCalls = 0;
    const steps = definition.steps.map(step => {
      assertWorkflowLifecycle(step.forward); const forward = childBounds(step.forward);
      const compensation = step.compensation ? (assertWorkflowLifecycle(step.compensation.workflow), childBounds(step.compensation.workflow)) : null;
      maxCostMicros += forward.maxCostMicros + (compensation?.maxCostMicros ?? 0);
      maxCalls += forward.maxCalls + (compensation?.maxCalls ?? 0);
      if (!Number.isSafeInteger(maxCostMicros) || !Number.isSafeInteger(maxCalls)) throw new Error();
      return { id: step.id, forward, input: step.input, compensation,
        compensationInput: step.compensation?.input ?? null };
    });
    return workflowSagaManifest({ format: 1, id: definition.id, version: definition.version, steps,
      result: definition.result, maxCostMicros, maxCalls });
  } catch {
    throw new MayuraError('INVALID_CONFIG', 'Workflow saga metadata is invalid or exceeds its finite bounds.');
  }
}

/** Define a finite sequential saga whose successful steps compensate in reverse order after failure. */
export function defineWorkflowSaga<I extends Schema, O extends Schema>(options: WorkflowSagaOptions<I, O>): WorkflowSagaDefinition<I, O> {
  if (!options || !Array.isArray(options.steps) || options.steps.length < 1 || options.steps.length > 128) {
    throw new MayuraError('INVALID_CONFIG', 'A workflow saga requires 1–128 steps.');
  }
  assertSchema(options.input); assertSchema(options.output);
  const manifest = sagaManifest(options as Pick<AnyWorkflowSaga, 'id' | 'version' | 'steps' | 'result'>);
  const steps = Object.freeze(manifest.steps.map((step, index) => {
    const source = options.steps[index]!;
    return Object.freeze({ id: step.id, forward: source.forward, input: step.input,
      ...(source.compensation ? { compensation: Object.freeze({ workflow: source.compensation.workflow,
        input: step.compensationInput! }) } : {}) });
  }));
  const definition = Object.freeze({ format: 1 as const, id: manifest.id, version: manifest.version,
    digest: digest('mayura:workflow-saga:v1', manifest), input: snapshot(options.input), output: snapshot(options.output),
    steps, result: manifest.result, maxCostMicros: manifest.maxCostMicros, maxCalls: manifest.maxCalls,
  }) as WorkflowSagaDefinition<I, O>;
  definitions.add(definition); return definition;
}
