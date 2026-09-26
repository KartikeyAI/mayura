import type { JsonValue, LifecycleControl, Scope } from '@mayura/core';

export type ContextKind = 'evidence' | 'instruction' | 'hard_constraint' | 'pending_approval' | 'unresolved_blocker' | 'outstanding_task';
export type ContextTrust = 'untrusted' | 'reviewed' | 'trusted';
export type Sensitivity = 'public' | 'internal' | 'confidential' | 'restricted';
export type SourceKind = 'document' | 'conversation' | 'memory' | 'artifact' | 'repository' | 'tool' | 'application';
export interface ContextSource { readonly id: string; readonly revision: string; readonly kind: SourceKind }
/** Original evidence identity; distinct from a memory record's current canonical ID/version. */
export interface UpstreamEvidence { readonly sourceId: string; readonly revision: string; readonly sha256: string }
/** Inclusive start and exclusive end, with null denoting no declared expiry. */
export interface ContextValidity { readonly from: string; readonly until: string | null }
export interface ContextProvenance {
  readonly reference: string;
  /** Canonical UTC ISO string, compatible with native-memory timestamps. */
  readonly observedAt: string;
  readonly origin: 'observed' | 'inferred';
  readonly confidence: number;
  readonly author?: string;
  readonly upstream?: UpstreamEvidence;
}
export interface ContextCandidate {
  readonly id: string;
  readonly scope: Scope;
  readonly source: ContextSource;
  readonly provenance: ContextProvenance;
  readonly trust: ContextTrust;
  readonly sensitivity: Sensitivity;
  readonly kind: ContextKind;
  readonly priority?: number;
  readonly pinned?: boolean;
  readonly validity?: ContextValidity;
  readonly content: JsonValue;
}
export interface SourceState {
  readonly scope: Scope;
  readonly id: string;
  readonly revision: string;
  readonly status: 'active' | 'deleted';
}
export interface ContextBudget {
  readonly maxBytes: number;
  readonly maxEstimatedTokens: number;
  readonly reservedBytes?: number;
  readonly reservedTokens?: number;
}
/** Trusted local deterministic estimator, not a paid model call or a guaranteed tokenizer. */
export interface TokenEstimator { readonly id: string; estimate(serialized: string): number }
export interface AssembleContextOptions {
  readonly scope: Scope;
  readonly policyVersion: string;
  readonly candidates: readonly ContextCandidate[];
  readonly sources: readonly SourceState[];
  readonly allowedSensitivities: readonly Sensitivity[];
  readonly budget: ContextBudget;
  readonly estimator?: TokenEstimator;
  /** Canonical UTC ISO timestamp; omitted means snapshot the current time once. */
  readonly asOf?: string;
  /** Fail-closed lifecycle hooks around assembly; either can block. */
  readonly hooks?: ContextHooks;
  /** Cancels a pending hook callback; assembly itself performs no I/O. */
  readonly signal?: AbortSignal;
}
/** Metadata-only view before selection. Candidate content is not included. */
export interface BeforeContextBuildEvent {
  readonly scope: Scope;
  readonly policyVersion: string;
  readonly asOf: string;
  readonly candidateCount: number;
  readonly sourceCount: number;
  readonly budget: Required<ContextBudget>;
}
/** Metadata-only view of the finished assembly; selected content is identified by digest, not included. */
export interface AfterContextBuildEvent {
  readonly scope: Scope;
  readonly policyVersion: string;
  readonly asOf: string;
  readonly fingerprint: string;
  readonly selected: readonly { readonly id: string; readonly sourceId: string; readonly revision: string; readonly contentDigest: string }[];
  readonly excluded: readonly ContextExclusion[];
  readonly usage: ContextUsage;
}
export interface ContextHooks {
  readonly beforeContextBuild?: LifecycleControl<BeforeContextBuildEvent, 'beforeContextBuild'>;
  readonly afterContextBuild?: LifecycleControl<AfterContextBuildEvent, 'afterContextBuild'>;
  /** Per-callback deadline in milliseconds (default 5000, maximum 30000). */
  readonly timeoutMs?: number;
}
export type ReadonlyJson = string | number | boolean | null | readonly ReadonlyJson[] | { readonly [key: string]: ReadonlyJson };
export interface ContextItem extends Omit<ContextCandidate, 'content' | 'pinned' | 'priority'> {
  readonly content: ReadonlyJson;
  readonly priority: number;
  readonly pinned: boolean;
  readonly required: boolean;
  readonly contentDigest: string;
}
export type ExclusionReason = 'scope_mismatch' | 'sensitivity_denied' | 'source_missing' | 'source_deleted' | 'stale_revision' | 'not_yet_valid' | 'expired' | 'byte_budget' | 'token_budget';
export interface ContextExclusion {
  readonly position: number;
  readonly reason: ExclusionReason;
  /** Omitted for scope or sensitivity denials; excluded content is never returned. */
  readonly candidateId?: string;
  readonly sourceId?: string;
  readonly revision?: string;
}
export interface ContextUsage {
  readonly bytes: number;
  readonly estimatedTokens: number;
  readonly reservedBytes: number;
  readonly reservedTokens: number;
  readonly maxBytes: number;
  readonly maxEstimatedTokens: number;
  readonly estimatorId: string;
}
export interface ContextAssembly {
  readonly scope: Scope;
  readonly policyVersion: string;
  readonly asOf: string;
  readonly selected: readonly ContextItem[];
  readonly excluded: readonly ContextExclusion[];
  readonly usage: ContextUsage;
  /** Exact canonical JSON payload measured by usage; it does not assign provider message authority. */
  readonly serialized: string;
  readonly fingerprint: string;
}
