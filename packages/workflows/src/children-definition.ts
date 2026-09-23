import { assertSchema, MayuraError, type InferInput, type InferOutput, type Schema } from '@mayura/core';
import { assertTool, type AnyTool } from '@mayura/tools';
import {
  workflowManifest, workflowResources, workflowTreeManifest,
  type WorkflowManifest, type WorkflowResourcePlan, type WorkflowTreeChildPolicy, type WorkflowTreeManifest,
} from '@mayura/storage-contracts';
import {
  assertWorkflow, digest, type AnyWorkflow, type Binding, type WorkflowDefinition, type WorkflowNode,
} from './definition.js';

export interface WorkflowTreeChildNode {
  readonly kind: 'child'; readonly id: string; readonly dependsOn?: readonly string[];
  readonly workflow: AnyWorkflow; readonly input: Binding;
  readonly policy: WorkflowTreeChildPolicy; readonly resources?: WorkflowResourcePlan;
}
export type WorkflowTreeNode = WorkflowNode | WorkflowTreeChildNode;
export interface WorkflowTreeOptions<I extends Schema,O extends Schema> {
  readonly id: string; readonly version: string; readonly input: I; readonly output: O;
  readonly nodes: readonly WorkflowTreeNode[]; readonly result: Binding;
}
declare const workflowTreeBrand: unique symbol;
export interface WorkflowTreeDefinition<I extends Schema=Schema,O extends Schema=Schema> {
  readonly [workflowTreeBrand]: true; readonly format: 4; readonly id: string; readonly version: string; readonly digest: string;
  readonly input: Schema<InferInput<I>,InferOutput<I>>; readonly output: Schema<InferInput<O>,InferOutput<O>>;
  readonly nodes: readonly WorkflowTreeNode[]; readonly result: Binding;
}
export type AnyWorkflowTree = WorkflowTreeDefinition;
export type WorkflowTreeOutput<D extends AnyWorkflowTree> = InferOutput<D['output']>;
const definitions = new WeakSet<object>();

export function assertWorkflowTree(definition: AnyWorkflowTree): void {
  if (!definitions.has(definition)) throw new MayuraError('INVALID_CONFIG','Use defineWorkflowTree from this package instance.');
}

function manifestFor(definition: AnyWorkflow): WorkflowManifest {
  assertWorkflow(definition);
  const manifest = workflowManifest({ id:definition.id,version:definition.version,
    graph:definition.nodes.map(node => node.kind === 'join'
      ? {kind:'join',id:node.id,dependsOn:node.dependsOn}
      : {kind:'tool',id:node.id,dependsOn:node.dependsOn ?? [],tool:node.tool.id,toolVersion:node.tool.version,
          effects:node.tool.effects,capabilities:node.tool.capabilities,costMicros:node.tool.costMicros,
          approval:node.approval ?? false,input:node.input}),result:definition.result });
  if (digest('mayura:workflow:v1',manifest) !== definition.digest) throw new MayuraError('INVALID_CONFIG','Child workflow metadata does not match its genuine definition.');
  return manifest;
}

export function treeManifest(definition: Pick<AnyWorkflowTree,'id'|'version'|'nodes'|'result'>): WorkflowTreeManifest {
  try {
    return workflowTreeManifest({ format:4,id:definition.id,version:definition.version,
      graph:definition.nodes.map(node => node.kind === 'join'
        ? {kind:'join',id:node.id,dependsOn:node.dependsOn}
        : node.kind === 'tool'
          ? {kind:'tool',id:node.id,dependsOn:node.dependsOn ?? [],tool:node.tool.id,toolVersion:node.tool.version,
              effects:node.tool.effects,capabilities:node.tool.capabilities,costMicros:node.tool.costMicros,
              approval:node.approval ?? false,input:node.input}
          : {kind:'child',id:node.id,dependsOn:node.dependsOn ?? [],workflow:manifestFor(node.workflow),
              policy:node.policy,resources:workflowResources(node.resources ?? {},manifestFor(node.workflow)),input:node.input}),
      result:definition.result });
  } catch { throw new MayuraError('INVALID_CONFIG','Workflow tree metadata is invalid or exceeds its finite bounds.'); }
}

/** Define a finite root with required, one-level tool/join workflow children. */
export function defineWorkflowTree<I extends Schema,O extends Schema>(options: WorkflowTreeOptions<I,O>): WorkflowTreeDefinition<I,O> {
  if (!options || !Array.isArray(options.nodes)) throw new MayuraError('INVALID_CONFIG','Workflow tree options are required.');
  assertSchema(options.input); assertSchema(options.output);
  const tools = new Map<string,AnyTool>(); const children = new Map<string,AnyWorkflow>();
  for (const node of options.nodes) {
    if (node.kind === 'tool') { assertTool(node.tool); tools.set(node.id,node.tool); }
    else if (node.kind === 'child') { assertWorkflow(node.workflow); children.set(node.id,node.workflow); }
    else if (node.kind !== 'join') throw new MayuraError('INVALID_CONFIG','Unknown workflow-tree node kind.');
  }
  const manifest = treeManifest(options as unknown as Pick<AnyWorkflowTree,'id'|'version'|'nodes'|'result'>);
  const nodes = Object.freeze(manifest.graph.map(node => node.kind === 'tool'
    ? Object.freeze({...node,tool:tools.get(node.id)!})
    : node.kind === 'child'
      ? Object.freeze({...node,workflow:children.get(node.id)!})
      : node)) as readonly WorkflowTreeNode[];
  const snapshot = <S extends Schema>(schema:S): Schema<InferInput<S>,InferOutput<S>> => {
    const standard = schema['~standard'];
    return Object.freeze({'~standard':Object.freeze({version:1 as const,vendor:standard.vendor,validate:standard.validate.bind(standard)})}) as Schema<InferInput<S>,InferOutput<S>>;
  };
  const definition = Object.freeze({format:4 as const,id:manifest.id,version:manifest.version,
    digest:digest('mayura:workflow-tree:v1',manifest),input:snapshot(options.input),output:snapshot(options.output),nodes,result:manifest.result}) as WorkflowTreeDefinition<I,O>;
  definitions.add(definition); return definition;
}

/** Leaf definitions remain genuine format-2 workflows, never structural or nested format-4 values. */
export type WorkflowTreeLeaf = WorkflowDefinition;
