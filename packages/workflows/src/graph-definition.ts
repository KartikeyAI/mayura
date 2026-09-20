import { assertSchema, MayuraError, type InferInput, type InferOutput, type Schema } from '@mayura/core';
import { assertTool, type AnyTool } from '@mayura/tools';
import { workflowGraphManifest, type WorkflowGraphManifest, type WorkflowGraphTargetBinding } from '@mayura/storage-contracts';
import { digest, type Binding, type WorkflowNode } from './definition.js';

export type { WorkflowGraphTargetBinding } from '@mayura/storage-contracts';
export type WorkflowGraphNode = WorkflowNode | {
  readonly kind: 'wait'; readonly id: string; readonly dependsOn?: readonly string[];
  /** Existing references are resolved from immutable submission input or literal data. */
  readonly targets: WorkflowGraphTargetBinding;
};
export interface WorkflowGraphOptions<I extends Schema, O extends Schema> {
  readonly id: string; readonly version: string; readonly input: I; readonly output: O;
  readonly nodes: readonly WorkflowGraphNode[]; readonly result: Binding;
}
declare const graphDefinitionBrand: unique symbol;
export interface WorkflowGraphDefinition<I extends Schema = Schema, O extends Schema = Schema> {
  readonly [graphDefinitionBrand]: true;
  readonly format: 3; readonly id: string; readonly version: string; readonly digest: string;
  readonly input: Schema<InferInput<I>, InferOutput<I>>;
  readonly output: Schema<InferInput<O>, InferOutput<O>>;
  readonly nodes: readonly WorkflowGraphNode[]; readonly result: Binding;
}
export type AnyWorkflowGraph = WorkflowGraphDefinition;
export type WorkflowGraphOutput<D extends AnyWorkflowGraph> = InferOutput<D['output']>;
const definitions = new WeakSet<object>();

/** A graph definition is local executable code, never a deserialized authority grant. */
export function assertWorkflowGraph(definition: AnyWorkflowGraph): void {
  if (!definitions.has(definition)) throw new MayuraError('INVALID_CONFIG', 'Use defineWorkflowGraph from this package instance.');
}

/** Build the exact versioned, data-only material admitted by the storage contract. */
export function graphManifest(definition: Pick<AnyWorkflowGraph, 'id' | 'version' | 'nodes' | 'result'>): WorkflowGraphManifest {
  try {
    return workflowGraphManifest({ format: 3, id: definition.id, version: definition.version,
      graph: definition.nodes.map(node => node.kind === 'tool'
        ? { id: node.id, kind: node.kind, dependsOn: node.dependsOn ?? [], tool: node.tool.id,
            toolVersion: node.tool.version, effects: node.tool.effects, capabilities: node.tool.capabilities,
            costMicros: node.tool.costMicros, approval: node.approval ?? false, input: node.input }
        : node.kind === 'join' ? { id: node.id, kind: node.kind, dependsOn: node.dependsOn }
          : { id: node.id, kind: node.kind, dependsOn: node.dependsOn ?? [], targets: node.targets }),
      result: definition.result,
    });
  } catch { throw new MayuraError('INVALID_CONFIG', 'Workflow graph metadata is invalid or exceeds its finite bounds.'); }
}

/** Define a finite format-3 graph; existing format-2 factories retain their exact contract. */
export function defineWorkflowGraph<I extends Schema, O extends Schema>(options: WorkflowGraphOptions<I, O>): WorkflowGraphDefinition<I, O> {
  if (!options || !Array.isArray(options.nodes) || options.nodes.length < 1 || options.nodes.length > 128) throw new MayuraError('INVALID_CONFIG', 'A workflow graph requires 1–128 nodes.');
  assertSchema(options.input); assertSchema(options.output);
  const tools = new Map<string, AnyTool>();
  for (const node of options.nodes) {
    if (!node || !['tool', 'join', 'wait'].includes(node.kind)) throw new MayuraError('INVALID_CONFIG', 'Unknown workflow graph node kind.');
    if (node.kind === 'tool') { assertTool(node.tool); tools.set(node.id, node.tool); }
  }
  const manifest = graphManifest(options);
  const nodes: readonly WorkflowGraphNode[] = Object.freeze(manifest.graph.map(node => node.kind === 'tool'
    ? Object.freeze({ kind: node.kind, id: node.id, dependsOn: node.dependsOn,
        tool: tools.get(node.id)!, input: node.input, approval: node.approval })
    : node));
  const snapshot = <S extends Schema>(schema: S): Schema<InferInput<S>, InferOutput<S>> => {
    const standard = schema['~standard'];
    return Object.freeze({ '~standard': Object.freeze({ version: 1 as const, vendor: standard.vendor, validate: standard.validate.bind(standard) }) }) as Schema<InferInput<S>, InferOutput<S>>;
  };
  const definition = Object.freeze({ format: 3 as const, id: manifest.id, version: manifest.version,
    digest: digest('mayura:workflow:v2', manifest), input: snapshot(options.input), output: snapshot(options.output), nodes,
    result: manifest.result }) as WorkflowGraphDefinition<I, O>;
  definitions.add(definition); return definition;
}
