import type { Effect, ExecutionReceipt, ExecutionSettlement, JsonObject, JsonValue, Scope } from '@mayura/core';
import type { AggregateStore, StoredRecord } from './contracts.js';
import type { Claim, JobRecord, SchedulerEvidenceSource, SchedulerStore } from './scheduler-contracts.js';

export type WorkflowBinding =
  | { readonly kind: 'literal'; readonly value: JsonValue }
  | { readonly kind: 'input'; readonly path: readonly string[] }
  | { readonly kind: 'step'; readonly stepId: string; readonly path: readonly string[] };
export type WorkflowManifestNode =
  | { readonly kind: 'join'; readonly id: string; readonly dependsOn: readonly string[] }
  | { readonly kind: 'tool'; readonly id: string; readonly dependsOn: readonly string[];
      readonly tool: string; readonly toolVersion: string; readonly effects: Effect;
      readonly capabilities: readonly string[]; readonly costMicros: number;
      readonly approval: boolean; readonly input: WorkflowBinding };
/** Data-only material reproducing the existing mayura:workflow:v1 definition digest. */
export interface WorkflowManifest {
  readonly id: string; readonly version: string; readonly graph: readonly WorkflowManifestNode[];
  readonly result: WorkflowBinding;
}
/** Exact legacy policy material; permissions preserve duplicates for hash compatibility. */
export interface WorkflowPolicyManifest {
  readonly scope: Scope; readonly permissions: readonly string[]; readonly policyVersion: string;
  readonly maxCostMicros: number; readonly maxOutputBytes: number; readonly approvalTtlMs: number;
}
export type WorkflowResourcePlan = Readonly<Record<string, readonly string[]>>;
export interface ScheduledRunKey { readonly scope: string; readonly id: string }
export interface ScheduledRunAccess extends ScheduledRunKey { readonly policyHash: string }
export interface ScheduledWrite extends ScheduledRunAccess {
  readonly expectedVersion: number;
  /** Stable logical command ID. Retried expectedVersion is not semantic command content. */
  readonly commandId: string;
}
export interface ScheduledWorkflowSnapshot {
  readonly record: StoredRecord;
  readonly profile: 'scheduled-v1';
  readonly manifestHash: string;
  readonly policyHash: string;
  readonly resourceHash: string;
  readonly jobs: readonly JobRecord[];
}
export interface ScheduledEnrollment {
  readonly manifest: WorkflowManifest; readonly policy: WorkflowPolicyManifest;
  readonly resources: WorkflowResourcePlan;
}
/** Finite trusted persistence commands. No callback, arbitrary replacement state, or user clock. */
/** A reviewed migration command. `state` is the complete migrated state; the store decides whether it is safe. */
export interface ScheduledMigrate extends ScheduledWrite {
  readonly manifest: WorkflowManifest | import('./workflow-graph-contracts.js').WorkflowGraphManifest;
  readonly resources: WorkflowResourcePlan;
  readonly state: JsonObject;
  readonly migrationId: string;
  readonly actorId: string;
}
export interface ScheduledWorkflowStore {
  initialize(): Promise<void>;
  submit(command: ScheduledEnrollment & { readonly input: JsonValue; readonly idempotencyKey: string }): Promise<{ readonly snapshot: ScheduledWorkflowSnapshot; readonly created: boolean }>;
  attach(command: ScheduledWrite & ScheduledEnrollment): Promise<ScheduledWorkflowSnapshot>;
  inspect(command: ScheduledRunAccess): Promise<ScheduledWorkflowSnapshot>;
  requestApproval(command: ScheduledWrite & { readonly nodeId: string; readonly input: JsonValue }): Promise<ScheduledWorkflowSnapshot>;
  approve(command: ScheduledWrite & { readonly nodeId: string; readonly digest: string; readonly humanId: string }): Promise<ScheduledWorkflowSnapshot>;
  prepare(command: ScheduledWrite & { readonly nodeId: string; readonly input: JsonValue }): Promise<ScheduledWorkflowSnapshot>;
  claim(command: ScheduledRunAccess & { readonly workerId: string; readonly limit: number; readonly leaseMs: number }): Promise<readonly { readonly job: JobRecord; readonly claim: Claim }[]>;
  renew(command: ScheduledRunAccess & { readonly claim: Claim; readonly leaseMs: number }): Promise<Claim>;
  start(command: ScheduledWrite & { readonly claim: Claim; readonly input: JsonValue }): Promise<{ readonly status: 'started' | 'already_started'; readonly snapshot: ScheduledWorkflowSnapshot }>;
  recordReceipt(command: ScheduledRunAccess & { readonly jobId: string; readonly fence: number; readonly evidenceId: string;
    readonly receipt: ExecutionReceipt; readonly settlement?: ExecutionSettlement; readonly source?: SchedulerEvidenceSource }): Promise<ScheduledWorkflowSnapshot>;
  complete(command: ScheduledWrite & { readonly claim: Claim; readonly evidenceId: string; readonly outcome: 'succeeded' | 'failed' | 'blocked'; readonly output: JsonValue | null }): Promise<ScheduledWorkflowSnapshot>;
  abandon(command: ScheduledWrite & { readonly claim: Claim; readonly outcome: 'failed' | 'blocked' }): Promise<ScheduledWorkflowSnapshot>;
  failNode(command: ScheduledWrite & { readonly nodeId: string; readonly outcome: 'failed' | 'blocked' }): Promise<ScheduledWorkflowSnapshot>;
  advance(command: ScheduledWrite): Promise<ScheduledWorkflowSnapshot>;
  finalize(command: ScheduledWrite & ({ readonly validation: 'passed'; readonly output: JsonValue } | { readonly validation: 'failed' })): Promise<ScheduledWorkflowSnapshot>;
  cancel(command: ScheduledWrite): Promise<ScheduledWorkflowSnapshot>;
  /** Optional quiescent operator pause; refused while any job is leased or started. */
  pause?(command: ScheduledWrite): Promise<ScheduledWorkflowSnapshot>;
  resume?(command: ScheduledWrite): Promise<ScheduledWorkflowSnapshot>;
  /**
   * Optional reviewed in-place migration of a paused run to a new manifest. The store re-verifies everything: steps with
   * scheduler history and started waits must be unchanged, no other run may wait on this one, and the new state must
   * satisfy the new manifest. The previous definition digest joins the owner lineage so existing job history stays valid.
   */
  migrate?(command: ScheduledMigrate): Promise<ScheduledWorkflowSnapshot>;
  recover(command: ScheduledWrite): Promise<ScheduledWorkflowSnapshot>;
}
/** Explicit opt-in capability; conservative/custom aggregate-only adapters remain supported. */
export interface ScheduledWorkflowAggregateStore extends AggregateStore {
  readonly scheduler: SchedulerStore;
  readonly workflows: ScheduledWorkflowStore;
}
