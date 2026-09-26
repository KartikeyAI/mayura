import type { InferInput, Schema } from '@mayura/core';
import type { ExecutionRef, WorkflowGraphAggregateStore, WorkflowGraphFormat3Step } from '@mayura/storage-contracts';
import { createScheduledDriver, type ReconcileExternalEffectCommand, type ScheduledWorkflowRuntimeOptions } from './scheduled.js';
import type { WorkflowSnapshot } from './runtime.js';
import type { AnyWorkflowGraph, WorkflowGraphDefinition } from './graph-definition.js';

export { defineWorkflowGraph, type WorkflowGraphDefinition, type WorkflowGraphOptions,
  type WorkflowGraphNode, type WorkflowGraphTargetBinding, type WorkflowGraphOutput } from './graph-definition.js';
export { createWorkflowGraphDiscovery, type WorkflowGraphDiscovery, type WorkflowGraphDiscoveryOptions,
  type WorkflowGraphDiscoveryCandidate, type WorkflowGraphDiscoveryCursor, type WorkflowGraphDiscoveryPage } from './graph-discovery.js';
export { createWorkflowGraphCoordinator, type WorkflowGraphCoordinator, type WorkflowGraphCoordinatorOptions,
  type WorkflowGraphCatalogEntry, type WorkflowGraphPageReport, type WorkflowGraphCandidateOutcome } from './graph-coordinator.js';

export interface WorkflowGraphSnapshot extends Omit<WorkflowSnapshot, 'steps'> {
  readonly steps: Readonly<Record<string, Readonly<WorkflowGraphFormat3Step>>>;
}
export interface WorkflowGraphRuntimeOptions extends Omit<ScheduledWorkflowRuntimeOptions, 'store'> {
  readonly store: WorkflowGraphAggregateStore;
}
export interface WorkflowGraphRuntime {
  readonly profile: 'scheduled-v2';
  submit<I extends Schema, O extends Schema>(definition: WorkflowGraphDefinition<I, O>, command: {
    readonly input: InferInput<I>; readonly idempotencyKey: string;
  }): Promise<WorkflowGraphSnapshot>;
  inspect(id: string): Promise<WorkflowGraphSnapshot>;
  /** Exact scoped metadata, not an authorization capability or backend identity proof. */
  reference(id: string): Promise<ExecutionRef>;
  events(id: string, after?: number): ReturnType<WorkflowGraphAggregateStore['events']>;
  runUntilSettled(definition: AnyWorkflowGraph, id: string): Promise<WorkflowGraphSnapshot>;
  reconcile(definition: AnyWorkflowGraph, command: ReconcileExternalEffectCommand): Promise<WorkflowGraphSnapshot>;
  approve(command: { readonly id: string; readonly nodeId: string; readonly digest: string; readonly credential: unknown }): Promise<WorkflowGraphSnapshot>;
  cancel(id: string): Promise<WorkflowGraphSnapshot>;
  /** Persist a quiescent operator pause; claimed or in-flight effects must settle or be recovered first. */
  pause(id: string): Promise<WorkflowGraphSnapshot>;
  /** Resume scheduling only; unresolved waits and approvals remain unresolved. */
  resume(id: string): Promise<WorkflowGraphSnapshot>;
  recoverExpired(id: string): Promise<WorkflowGraphSnapshot>;
  /** Stop this finite driver without cancelling durable waits or closing caller-owned storage. */
  close(): Promise<void>;
}

/** Opt in explicitly to format-3 graph waits; no fallback to legacy or unfenced execution. */
export function createWorkflowGraphRuntime(options: WorkflowGraphRuntimeOptions): WorkflowGraphRuntime {
  return createScheduledDriver(options, 'scheduled-v2') as WorkflowGraphRuntime;
}
