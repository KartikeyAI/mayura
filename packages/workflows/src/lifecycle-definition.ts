import { assertSchema, MayuraError, type InferInput, type InferOutput, type Schema } from '@mayura/core';
import { workflowLifecycleManifest, type WorkflowLifecycleHumanKind, type WorkflowLifecycleManifest } from '@mayura/storage-contracts';
import { assertTool } from '@mayura/tools';
import { digest, type Binding, type WorkflowNode } from './definition.js';

export interface WorkflowLifecycleHumanNode<S extends Schema = Schema> {
  readonly kind: 'human';
  readonly id: string;
  readonly dependsOn?: readonly string[];
  readonly request: {
    readonly kind: WorkflowLifecycleHumanKind;
    readonly schemaId: string;
    readonly schemaDigest: string;
    readonly prompt: string;
    readonly response: S;
    readonly context?: Binding;
    readonly subjectDigest?: Binding;
    readonly deadlineAtMs?: Binding;
  };
}

export interface WorkflowLifecycleTimerNode {
  readonly kind: 'timer';
  readonly id: string;
  readonly dependsOn?: readonly string[];
  readonly fireAtMs: Binding;
}

export type WorkflowLifecycleNode = WorkflowNode | WorkflowLifecycleHumanNode | WorkflowLifecycleTimerNode;

export interface WorkflowLifecycleOptions<I extends Schema, O extends Schema> {
  readonly id: string;
  readonly version: string;
  readonly input: I;
  readonly output: O;
  readonly nodes: readonly WorkflowLifecycleNode[];
  readonly result: Binding;
}

declare const lifecycleDefinitionBrand: unique symbol;
export interface WorkflowLifecycleDefinition<I extends Schema = Schema, O extends Schema = Schema> {
  readonly [lifecycleDefinitionBrand]: true;
  readonly format: 5;
  readonly id: string;
  readonly version: string;
  readonly digest: string;
  readonly input: Schema<InferInput<I>, InferOutput<I>>;
  readonly output: Schema<InferInput<O>, InferOutput<O>>;
  readonly nodes: readonly WorkflowLifecycleNode[];
  readonly result: Binding;
}

export type AnyWorkflowLifecycle = WorkflowLifecycleDefinition;
export type WorkflowLifecycleOutput<D extends AnyWorkflowLifecycle> = InferOutput<D['output']>;
const definitions = new WeakSet<object>();

function snapshot<S extends Schema>(schema: S): Schema<InferInput<S>, InferOutput<S>> {
  const standard = schema['~standard'];
  return Object.freeze({ '~standard': Object.freeze({
    version: 1 as const,
    vendor: standard.vendor,
    validate: standard.validate.bind(standard),
  }) }) as Schema<InferInput<S>, InferOutput<S>>;
}

/** Executable lifecycle definitions must originate from this package instance. */
export function assertWorkflowLifecycle(definition: AnyWorkflowLifecycle): void {
  if (!definitions.has(definition)) throw new MayuraError('INVALID_CONFIG', 'Use defineWorkflowLifecycle from this package instance.');
}

/** Build the strict data-only format-5 material; response validators are never persisted. */
export function lifecycleManifest(
  definition: Pick<AnyWorkflowLifecycle, 'id' | 'version' | 'nodes' | 'result'>,
): WorkflowLifecycleManifest {
  try {
    return workflowLifecycleManifest({
      format: 5,
      id: definition.id,
      version: definition.version,
      graph: definition.nodes.map(node => {
        if (node.kind === 'tool') return {
          kind: node.kind, id: node.id, dependsOn: node.dependsOn ?? [], tool: node.tool.id,
          toolVersion: node.tool.version, effects: node.tool.effects, capabilities: node.tool.capabilities,
          costMicros: node.tool.costMicros, approval: node.approval ?? false, input: node.input,
        };
        if (node.kind === 'join') return { kind: node.kind, id: node.id, dependsOn: node.dependsOn };
        if (node.kind === 'timer') return { kind: node.kind, id: node.id, dependsOn: node.dependsOn ?? [], fireAtMs: node.fireAtMs };
        if (node.kind === 'human') return {
          kind: node.kind, id: node.id, dependsOn: node.dependsOn ?? [], requestKind: node.request.kind,
          schemaId: node.request.schemaId, schemaDigest: node.request.schemaDigest, prompt: node.request.prompt,
          context: node.request.context ?? null, subjectDigest: node.request.subjectDigest ?? null,
          deadlineAtMs: node.request.deadlineAtMs ?? null,
        };
        throw new MayuraError('INVALID_CONFIG', 'Unknown workflow lifecycle node kind.');
      }),
      result: definition.result,
    });
  } catch {
    throw new MayuraError('INVALID_CONFIG', 'Workflow lifecycle metadata is invalid or exceeds its finite bounds.');
  }
}

/** Define an acyclic format-5 graph with explicit human and timer suspension nodes. */
export function defineWorkflowLifecycle<I extends Schema, O extends Schema>(
  options: WorkflowLifecycleOptions<I, O>,
): WorkflowLifecycleDefinition<I, O> {
  if (!options || !Array.isArray(options.nodes) || options.nodes.length < 1 || options.nodes.length > 128) {
    throw new MayuraError('INVALID_CONFIG', 'A workflow lifecycle requires 1–128 nodes.');
  }
  assertSchema(options.input); assertSchema(options.output);
  const tools = new Map<string, Extract<WorkflowLifecycleNode, { readonly kind: 'tool' }>['tool']>();
  const responses = new Map<string, Schema>();
  for (const node of options.nodes) {
    if (!node || !['tool', 'join', 'human', 'timer'].includes(node.kind)) {
      throw new MayuraError('INVALID_CONFIG', 'Unknown workflow lifecycle node kind.');
    }
    if (node.kind === 'tool') { assertTool(node.tool); tools.set(node.id, node.tool); }
    if (node.kind === 'human') { assertSchema(node.request.response); responses.set(node.id, snapshot(node.request.response)); }
  }
  const manifest = lifecycleManifest(options);
  const nodes = Object.freeze(manifest.graph.map(node => {
    if (node.kind === 'tool') return Object.freeze({
      kind: node.kind, id: node.id, dependsOn: node.dependsOn, tool: tools.get(node.id)!,
      input: node.input, approval: node.approval,
    });
    if (node.kind === 'join') return node;
    if (node.kind === 'timer') return Object.freeze({
      kind: node.kind, id: node.id, dependsOn: node.dependsOn, fireAtMs: node.fireAtMs,
    });
    return Object.freeze({
      kind: node.kind, id: node.id, dependsOn: node.dependsOn,
      request: Object.freeze({
        kind: node.requestKind, schemaId: node.schemaId, schemaDigest: node.schemaDigest,
        prompt: node.prompt, response: responses.get(node.id)!, context: node.context ?? undefined,
        subjectDigest: node.subjectDigest ?? undefined, deadlineAtMs: node.deadlineAtMs ?? undefined,
      }),
    });
  })) as readonly WorkflowLifecycleNode[];
  const definition = Object.freeze({
    format: 5 as const,
    id: manifest.id,
    version: manifest.version,
    digest: digest('mayura:workflow-lifecycle:v1', manifest),
    input: snapshot(options.input),
    output: snapshot(options.output),
    nodes,
    result: manifest.result,
  }) as WorkflowLifecycleDefinition<I, O>;
  definitions.add(definition);
  return definition;
}
