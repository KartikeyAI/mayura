import type { JsonObject, ModelMessage, Outcome, Scope } from '@mayura/core';

/** An approval retained with a run, including across checkpoint resumes. */
export interface RecordedApproval {
  readonly callId: string;
  readonly toolId: string;
  readonly decision: 'approved' | 'rejected' | 'expired';
  readonly actorId?: string;
}
/** Trusted recording context. Bindings contain identifiers only, never credentials. */
export interface RunRecordingContext {
  readonly runId: string;
  readonly scope: Scope;
  readonly binding: JsonObject;
}
/** A terminal run's released conversation and outcome, for idempotent persistence. */
export interface RunRecording extends RunRecordingContext {
  readonly messages: readonly ModelMessage[];
  readonly approvals: readonly RecordedApproval[];
  readonly outcome: Outcome<unknown>;
  /** Trusted, bounded operator receipt for a terminal reconciliation; never a synthetic tool result. */
  readonly reconciliation?: JsonObject;
}
/**
 * Host persistence seam. Persist the association before execution and complete it idempotently. Configure the
 * same recorder on every runtime that resumes these runs. Callbacks are trusted host code, like storage adapters.
 */
export interface RunRecorder {
  begin(context: RunRecordingContext): Promise<void>;
  complete(recording: RunRecording): Promise<void>;
}
