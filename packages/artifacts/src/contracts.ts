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
  readonly clock?: () => number;
}

export interface LocalArtifactStore {
  stage(input: StageArtifactInput): Promise<StagedArtifact>;
  commit(staged: StagedArtifact): Promise<ArtifactReference>;
  read(reference: ArtifactReference, scope: ArtifactScope): Promise<Uint8Array>;
  disclose(reference: ArtifactReference, scope: ArtifactScope, policy: ArtifactDisclosurePolicy): Promise<ArtifactDisclosure>;
  delete(reference: ArtifactReference, scope: ArtifactScope): Promise<boolean>;
  reconcileStaging(options: StagingReconciliationOptions): Promise<StagingReconciliationResult>;
}
