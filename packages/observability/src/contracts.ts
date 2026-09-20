import type { RunEvent, RunHandle } from '@mayura/core';

export type ExactCount = number | string;
export type ObservedStatus = 'unknown' | 'running' | 'succeeded' | 'failed' | 'blocked' | 'cancelled' | 'outcome_unknown';
export type ObservationReason = 'terminal' | 'source_ended' | 'disconnected' | 'timeout' | 'source_failed' | 'invalid_event' | 'observer_closed';
export interface ObservationResult { readonly runId: string; readonly reason: ObservationReason }
export interface Observation {
  readonly runId: string;
  done(): Promise<ObservationResult>;
  /** Stops this subscription only, never the observed execution. */
  disconnect(): void;
}
export interface ObserveOptions { readonly after?: number; readonly signal?: AbortSignal; readonly durationMs?: number }
export interface ObservedCounters {
  readonly events: ExactCount;
  readonly duplicates: ExactCount;
  readonly rejected: ExactCount;
  readonly missing: ExactCount;
  readonly sourceGaps: ExactCount;
  readonly implicitGaps: ExactCount;
  readonly recentEvicted: ExactCount;
  readonly modelStarted: ExactCount;
  readonly modelCompleted: ExactCount;
  readonly toolStarted: ExactCount;
  readonly toolCompleted: ExactCount;
  readonly unknownToolOutcomes: ExactCount;
  readonly unreportedToolReceipts: ExactCount;
}
export interface ObserverMetrics extends ObservedCounters {
  readonly subscriptionsStarted: ExactCount;
  readonly sourceFailures: ExactCount;
  readonly sinkDelivered: ExactCount;
  readonly sinkDropped: ExactCount;
  readonly sinkFailures: ExactCount;
  readonly sinkTimeouts: ExactCount;
}
export interface ObservedGap { readonly from: number; readonly to: number; readonly kind: 'source' | 'discontinuity' }
export interface ReportedCost {
  readonly spentMicros: ExactCount;
  readonly reservedMicros: number;
  readonly calls: number;
  /** Final-event snapshot, not a guarantee that late provider reconciliation has completed. */
  readonly atSequence: number;
}
export interface ObservedRun {
  readonly runId: string;
  readonly cursor: number;
  readonly status: ObservedStatus;
  readonly active: boolean;
  /** An iterator read or cleanup callback has not actually settled; reconnect remains denied. */
  readonly sourcePending: boolean;
  readonly terminal: boolean;
  readonly coverage: 'unknown' | 'partial' | 'complete';
  readonly lastObservation?: ObservationReason;
  readonly rootId?: string;
  readonly parentId?: string;
  readonly agentId?: string;
  readonly cost?: ReportedCost;
  readonly counters: ObservedCounters;
  readonly recent: readonly RunEvent[];
  readonly gaps: readonly ObservedGap[];
}
export interface ObserverSnapshot {
  readonly closed: boolean;
  readonly runs: readonly ObservedRun[];
  readonly metrics: ObserverMetrics;
  readonly sink: { readonly state: 'absent' | 'active' | 'disabled' | 'closed'; readonly pending: number; readonly inFlight: boolean };
}
export interface ObserverOptions {
  readonly maxRuns?: number;
  readonly maxRecentEventsPerRun?: number;
  readonly maxObservationMs?: number;
  readonly maxSinkQueue?: number;
  readonly sinkBatchSize?: number;
  readonly sinkTimeoutMs?: number;
  /** Explicit trusted destination; absent means no export. Exceptions are never public data. */
  readonly sink?: (events: readonly RunEvent[], context: { readonly signal: AbortSignal }) => void | Promise<void>;
}
export interface Observer {
  observe<T>(handle: RunHandle<T>, options?: ObserveOptions): Observation;
  inspect(): ObserverSnapshot;
  inspect(runId: string): ObservedRun | undefined;
  /** Bounded cooperative disconnect. Does not wait for or cancel observed executions. */
  close(): Promise<ObserverSnapshot>;
}
