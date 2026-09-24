export type ArtifactClassification = 'public' | 'internal' | 'confidential' | 'restricted';

export interface ArtifactScope {
  readonly tenantId: string;
  readonly projectId?: string;
}

export interface StageArtifactInput {
  readonly scope: ArtifactScope;
  readonly content: Uint8Array;
  readonly mediaType: string;
  readonly classification: ArtifactClassification;
  readonly filename?: string;
  readonly expiresAt?: number;
}

export interface StagedArtifact {
  readonly format: 'mayura-staged-artifact-v1';
  readonly stageId: string;
  readonly digest: `sha256:${string}`;
  readonly bytes: number;
}

export interface ArtifactReference {
  readonly format: 'mayura-artifact-v1';
  readonly scopeDigest: `sha256:${string}`;
  readonly referenceDigest: `sha256:${string}`;
  readonly digest: `sha256:${string}`;
  readonly bytes: number;
  readonly mediaType: string;
  readonly classification: ArtifactClassification;
  readonly filename?: string;
  readonly expiresAt?: number;
}

export interface ArtifactDisclosurePolicy {
  readonly classifications: readonly ArtifactClassification[];
  readonly maxBytes: number;
  readonly mediaTypes?: readonly string[];
}

export interface ArtifactDisclosure {
  readonly body: Uint8Array;
  readonly headers: Readonly<{
    'Content-Disposition': string;
    'Content-Length': string;
    'Content-Type': string;
    'X-Content-Type-Options': 'nosniff';
  }>;
}

export interface StagingReconciliationOptions {
  readonly olderThan: number;
  readonly maxDeletes: number;
}

export interface StagingReconciliationResult {
  readonly examined: number;
  readonly deleted: number;
  readonly remaining: boolean;
}

export interface LocalArtifactStoreOptions {
  readonly rootDirectory: string;
  readonly maxArtifactBytes: number;
  readonly maxStagedArtifacts?: number;
  readonly maxCommittedArtifactsPerScope?: number;
  readonly clock?: () => number;
}

export type ArtifactAuditStatus = 'ok' | 'missing' | 'expired' | 'integrity_failed';

export interface ArtifactAuditObservation {
  readonly referenceDigest: `sha256:${string}`;
  readonly status: ArtifactAuditStatus;
}

export interface ArtifactAuditOptions {
  readonly maxTotalBytes: number;
}

export interface ArtifactAuditResult {
  readonly observations: readonly ArtifactAuditObservation[];
  readonly admittedBytes: number;
}

export interface ArtifactReconciliationCursor {
  readonly format: 'mayura-artifact-reconciliation-cursor-v1';
  readonly scopeDigest: `sha256:${string}`;
  readonly after: `sha256:${string}`;
}

export interface PlanArtifactReconciliationOptions {
  readonly scope: ArtifactScope;
  readonly retainedReferences: readonly ArtifactReference[];
  readonly authoritativeSetComplete: true;
  readonly olderThan: number;
  readonly maxExamined: number;
  readonly maxDeletes: number;
  readonly cursor?: ArtifactReconciliationCursor;
}

export interface ArtifactReconciliationCandidate {
  readonly referenceDigest: `sha256:${string}`;
  readonly bytes: number;
  readonly modifiedAt: number;
}

declare const reconciliationPlanBrand: unique symbol;
export interface ArtifactReconciliationPlan {
  readonly [reconciliationPlanBrand]: true;
  readonly format: 'mayura-artifact-reconciliation-plan-v1';
  readonly scopeDigest: `sha256:${string}`;
  readonly examined: number;
  readonly anomalies: number;
  readonly candidates: readonly ArtifactReconciliationCandidate[];
  readonly nextCursor?: ArtifactReconciliationCursor;
}

export interface ArtifactReconciliationResult {
  readonly deleted: number;
  readonly changed: number;
  readonly missing: number;
}

export interface LocalArtifactStore {
  stage(input: StageArtifactInput): Promise<StagedArtifact>;
  commit(staged: StagedArtifact): Promise<ArtifactReference>;
  discard(staged: StagedArtifact): Promise<boolean>;
  read(reference: ArtifactReference, scope: ArtifactScope): Promise<Uint8Array>;
  disclose(reference: ArtifactReference, scope: ArtifactScope, policy: ArtifactDisclosurePolicy): Promise<ArtifactDisclosure>;
  delete(reference: ArtifactReference, scope: ArtifactScope): Promise<boolean>;
  reconcileStaging(options: StagingReconciliationOptions): Promise<StagingReconciliationResult>;
  audit(references: readonly ArtifactReference[], scope: ArtifactScope, options: ArtifactAuditOptions): Promise<ArtifactAuditResult>;
  planReconciliation(options: PlanArtifactReconciliationOptions): Promise<ArtifactReconciliationPlan>;
  applyReconciliation(plan: ArtifactReconciliationPlan): Promise<ArtifactReconciliationResult>;
}
