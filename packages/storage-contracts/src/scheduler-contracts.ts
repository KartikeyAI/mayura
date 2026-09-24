import type { ExecutionReceipt, ExecutionSettlement, JsonObject, JsonValue } from '@mayura/core';
import type { AggregateStore, StoredEvent } from './contracts.js';

export type JobState = 'ready' | 'leased' | 'started' | 'succeeded' | 'failed' | 'blocked' | 'cancelled' | 'outcome_unknown';
export interface JobKey { readonly scope: string; readonly jobId: string }
export interface Claim extends JobKey {
  readonly workerId: string; readonly fence: number;
  /** Informational only; the store always checks its persisted expiry. */
  readonly leaseUntilMs: number;
}
export interface JobReservation extends JobKey {
  readonly reservationKey: string; readonly runId: string; readonly nodeId: string; readonly invocationId: string;
  readonly definitionHash: string; readonly candidateHash: string;
  /** Safe bounded metadata, including required toolId and callId; never credentials. */
  readonly intent: JsonObject;
  readonly resourceKeys: readonly string[];
  readonly delayMs: number; readonly deadlineAfterMs?: number;
}
export interface JobRecord extends JobKey {
  readonly runId: string; readonly nodeId: string; readonly invocationId: string;
  readonly definitionHash: string; readonly candidateHash: string; readonly intent: JsonObject;
  readonly resourceKeys: readonly string[]; readonly state: JobState; readonly version: number; readonly fence: number;
  readonly workerId: string | null; readonly dueAtMs: number; readonly deadlineAtMs: number | null;
  readonly leaseUntilMs: number | null; readonly startedAtMs: number | null;
  readonly leaseRevoked: boolean; readonly cancelRequested: boolean;
  readonly receipt: ExecutionReceipt | null; readonly output: JsonValue | null;
}
export type EvidenceDisposition = 'current' | 'late' | 'conflicting';
export interface SchedulerEvidence {
  readonly evidenceId: string; readonly receipt: ExecutionReceipt;
  /** Optional for generic scheduler users; integrated metered workflows require it. */
  readonly settlement?: ExecutionSettlement;
  readonly disposition: EvidenceDisposition; readonly recordedAtMs: number;
}
export interface ReceiptCommand extends JobKey {
  readonly fence: number; readonly evidenceId: string; readonly receipt: ExecutionReceipt;
  readonly settlement?: ExecutionSettlement;
}
export interface CompleteJobCommand {
  readonly claim: Claim; readonly commandId: string; readonly evidenceId: string;
  readonly outcome: 'succeeded' | 'failed' | 'blocked'; readonly output: JsonValue | null;
}
/** Trusted standalone job ledger. It does not fence ordinary AggregateStore/workflow writes. */
export interface SchedulerStore {
  initialize(): Promise<void>;
  reserve(command: JobReservation): Promise<{ readonly job: JobRecord; readonly created: boolean }>;
  read(key: JobKey): Promise<JobRecord | undefined>;
  claim(command: { readonly scope: string; readonly workerId: string; readonly limit: number; readonly leaseMs: number }): Promise<readonly { readonly job: JobRecord; readonly claim: Claim }[]>;
  renew(command: { readonly claim: Claim; readonly leaseMs: number }): Promise<Claim>;
  /** Only status=started grants one fresh dispatch; retries never grant a second dispatch. */
  start(command: { readonly claim: Claim; readonly candidateHash: string }): Promise<{ readonly status: 'started' | 'already_started'; readonly job: JobRecord }>;
  recordReceipt(command: ReceiptCommand): Promise<{ readonly disposition: EvidenceDisposition; readonly job: JobRecord }>;
  receipts(command: JobKey & { readonly fence: number }): Promise<readonly SchedulerEvidence[]>;
  complete(command: CompleteJobCommand): Promise<JobRecord>;
  cancel(command: JobKey & { readonly commandId: string }): Promise<JobRecord>;
  recover(command: { readonly scope: string; readonly limit: number }): Promise<readonly JobRecord[]>;
  events(command: { readonly scope: string; readonly runId: string; readonly after?: number; readonly limit?: number }): Promise<readonly StoredEvent[]>;
}
/** Scheduler and aggregate operations share one backend and lifecycle. */
export interface SchedulerAggregateStore extends AggregateStore { readonly scheduler: SchedulerStore }
