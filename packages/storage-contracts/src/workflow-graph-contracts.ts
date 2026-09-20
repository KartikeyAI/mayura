import type { JsonValue } from '@mayura/core';
import type { ExecutionRef, ExecutionWaitAggregateStore } from './execution-wait-contracts.js';
import type { ScheduledEnrollment, ScheduledWorkflowSnapshot, ScheduledWorkflowStore, WorkflowBinding, WorkflowManifestNode } from './scheduled-workflow-contracts.js';
import type { WorkflowFormat2State, WorkflowFormat2Step } from './workflow-format2.js';

/** References are fixed before parent creation; step outputs cannot introduce future back-edges. */
export type WorkflowGraphTargetBinding =
  | { readonly kind: 'literal'; readonly value: readonly ExecutionRef[] }
  | { readonly kind: 'input'; readonly path: readonly string[] };
export type WorkflowGraphManifestNode = WorkflowManifestNode | {
  readonly kind: 'wait'; readonly id: string; readonly dependsOn: readonly string[];
  readonly targets: WorkflowGraphTargetBinding;
};
/** The explicit format and v2 hash domain keep legacy definitions byte-compatible. */
export interface WorkflowGraphManifest {
  readonly format: 3; readonly id: string; readonly version: string;
  readonly graph: readonly WorkflowGraphManifestNode[]; readonly result: WorkflowBinding;
}
export interface WorkflowGraphFormat3Step extends Omit<WorkflowFormat2Step, 'kind'> { kind: 'tool' | 'join' | 'wait' }
export interface WorkflowGraphFormat3State extends Omit<WorkflowFormat2State, 'format' | 'steps'> {
  format: 3; steps: Record<string, WorkflowGraphFormat3Step>;
}
export interface WorkflowGraphStoreSnapshot extends Omit<ScheduledWorkflowSnapshot, 'profile'> { readonly profile: 'scheduled-v2' }
export interface WorkflowGraphEnrollment extends Omit<ScheduledEnrollment, 'manifest'> { readonly manifest: WorkflowGraphManifest }

/** Only the profile-specific manifest/result change; finite command identities retain their existing semantics. */
type GraphResponse<T> = T extends ScheduledWorkflowSnapshot ? WorkflowGraphStoreSnapshot
  : T extends { readonly snapshot: ScheduledWorkflowSnapshot } ? Omit<T, 'snapshot'> & { readonly snapshot: WorkflowGraphStoreSnapshot }
  : T;
type GraphControlStore = {
  [K in Exclude<keyof ScheduledWorkflowStore, 'submit' | 'attach'>]:
    (...args: Parameters<ScheduledWorkflowStore[K]>) => Promise<GraphResponse<Awaited<ReturnType<ScheduledWorkflowStore[K]>>>>;
};
/** New optional capability: never widens or silently changes custom scheduled-v1 adapters. */
export interface WorkflowGraphStore extends GraphControlStore {
  submit(command: WorkflowGraphEnrollment & { readonly input: JsonValue; readonly idempotencyKey: string }): Promise<{ readonly snapshot: WorkflowGraphStoreSnapshot; readonly created: boolean }>;
}
export interface WorkflowGraphAggregateStore extends ExecutionWaitAggregateStore { readonly workflowGraphs: WorkflowGraphStore }
