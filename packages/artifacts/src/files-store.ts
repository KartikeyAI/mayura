import { MayuraError, assertPositiveInteger } from '@mayura/core';
import type { FileInfo, FileStore } from '@mayura/files';
import type {
  ArtifactAuditOptions, ArtifactAuditResult, ArtifactBackupOptions, ArtifactClassification, ArtifactDisclosure, ArtifactDisclosurePolicy,
  ArtifactReference, ArtifactReconciliationPlan, ArtifactReconciliationResult, ArtifactRestoreOptions, ArtifactRestoreResult, ArtifactScope,
  LocalArtifactStore, PlanArtifactReconciliationOptions, StageArtifactInput, StagedArtifact, StagingReconciliationOptions, StagingReconciliationResult,
} from './contracts.js';
import {
  MAX_BUFFERED_ARTIFACT_BYTES, MAX_COMMITTED_ARTIFACTS_PER_SCOPE, MAX_STAGED_ARTIFACTS, disclosurePolicy, encodeBackup, integrity, invalid, makeReference,
  parseAudit, parseBackup, parsePlan, parseRestore, parseStage, parseStagingReconciliation, scopeDigest, sha256, validateReference, type Digest,
} from './shared.js';

/** An artifact store: the same methods and guarantees whether it keeps files on local disk or in a file store. */
export type ArtifactStore = LocalArtifactStore;

export interface ArtifactStoreOptions {
  /**
   * Where the artifacts live: a file store (`mayura/files`) that keeps preconditions (`conditionalWrites`), such as
   * S3, R2, GCS or Azure Blob. Give it a view of its own (`files.within('artifacts')`): the store writes `staging/` and
   * `objects/` under it and treats anything else there as not its own.
   */
  readonly files: FileStore;
  /** The largest artifact accepted, up to 64 MiB and the file store's `maxFileBytes`. Artifacts are held in memory while stored. */
  readonly maxArtifactBytes: number;
  /** Staged artifacts not yet committed or discarded, up to 4,096; 128 by default. */
  readonly maxStagedArtifacts?: number;
  /** Committed artifacts per scope, up to 65,536; 4,096 by default. */
  readonly maxCommittedArtifactsPerScope?: number;
  readonly clock?: () => number;
}

const STAGE_KEY = /^staging\/([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/u;
const OBJECT_NAME = /^[0-9a-f]{64}$/u;

interface StageRecord {
  readonly handle: StagedArtifact;
  readonly key: string;
  readonly scopeDigest: Digest;
  readonly mediaType: string;
  readonly classification: ArtifactClassification;
  readonly filename?: string;
  readonly expiresAt?: number;
}
interface StoredObject {
  readonly referenceDigest: Digest;
  readonly key: string;
  readonly bytes: number;
  readonly modifiedAt: number;
  readonly etag: string;
}

async function safeStorage<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof MayuraError) throw error;
    throw new MayuraError('STORAGE_UNAVAILABLE', 'Artifact storage is unavailable. Inspect authorized local diagnostics.');
  }
}
const isConflict = (error: unknown) => error instanceof MayuraError && error.code === 'CONFLICT';

/**
 * Artifacts in a file store: `createArtifactStore({ files: s3.within('artifacts'), maxArtifactBytes })`. It keeps
 * every guarantee of the local store (content addressed by SHA-256, partitioned by scope, checked on every read,
 * downloads only under a policy, audits, reconciliation and backups) on any file store that keeps preconditions, and
 * runs wherever the file store does, edge runtimes included.
 */
export function createArtifactStore(options: ArtifactStoreOptions): ArtifactStore {
  if (options === null || typeof options !== 'object' || Array.isArray(options)) throw new MayuraError('INVALID_CONFIG', 'options must be an object.');
  const files = options.files;
  if (!files || typeof files.put !== 'function' || typeof files.within !== 'function') throw new MayuraError('INVALID_CONFIG', 'files must be a file store.');
  if (!files.conditionalWrites) throw new MayuraError('INVALID_CONFIG', `The ${files.id} file store cannot write conditionally, which artifacts need to commit and restore safely.`);
  assertPositiveInteger(options.maxArtifactBytes, 'maxArtifactBytes');
  if (options.maxArtifactBytes > MAX_BUFFERED_ARTIFACT_BYTES) throw new MayuraError('INVALID_CONFIG', 'maxArtifactBytes exceeds the artifact store limit.');
  if (options.maxArtifactBytes > files.maxFileBytes) throw new MayuraError('INVALID_CONFIG', "maxArtifactBytes exceeds the file store's maxFileBytes.");
  const maxStagedArtifacts = options.maxStagedArtifacts ?? 128;
  assertPositiveInteger(maxStagedArtifacts, 'maxStagedArtifacts');
  if (maxStagedArtifacts > MAX_STAGED_ARTIFACTS) throw new MayuraError('INVALID_CONFIG', 'maxStagedArtifacts exceeds the artifact store limit.');
  const maxCommittedArtifactsPerScope = options.maxCommittedArtifactsPerScope ?? 4_096;
  assertPositiveInteger(maxCommittedArtifactsPerScope, 'maxCommittedArtifactsPerScope');
  if (maxCommittedArtifactsPerScope > MAX_COMMITTED_ARTIFACTS_PER_SCOPE) throw new MayuraError('INVALID_CONFIG', 'maxCommittedArtifactsPerScope exceeds the artifact store limit.');
  if (options.clock !== undefined && typeof options.clock !== 'function') throw new MayuraError('INVALID_CONFIG', 'clock must be a function.');

  const stages = new WeakMap<object, StageRecord>();
  const issuedStages = new WeakSet<object>();
  const activeStageIds = new Set<string>();
  const reconciliationPlans = new WeakMap<object, { readonly scopeDigest: Digest; readonly candidates: readonly StoredObject[] }>();
  const configuredClock = options.clock ?? Date.now;
  let stageTail = Promise.resolve();
  let commitTail = Promise.resolve();
  const clock = (): number => {
    const value = configuredClock();
    if (!Number.isSafeInteger(value) || value < 0) throw new MayuraError('INVALID_CONFIG', 'clock must return a non-negative safe Unix millisecond timestamp.');
    return value;
  };
  const withStageLock = <T>(operation: () => Promise<T>): Promise<T> => {
    const result = stageTail.then(operation, operation); stageTail = result.then(() => undefined, () => undefined); return result;
  };
  const withCommitLock = <T>(operation: () => Promise<T>): Promise<T> => {
    const result = commitTail.then(operation, operation); commitTail = result.then(() => undefined, () => undefined); return result;
  };
  const objectKey = (scope: Digest, reference: Digest) => `objects/${scope.slice(7)}/${reference.slice(7)}`;

  /** Every file under a prefix, page by page, refusing more than `max`. */
  const listAll = async (prefix: string, max: number, overflow: () => never): Promise<FileInfo[]> => {
    const found: FileInfo[] = []; let cursor: string | undefined;
    do {
      const page = await files.list({ prefix, ...(cursor === undefined ? {} : { cursor }) });
      found.push(...page.files); cursor = page.cursor;
      if (found.length > max) overflow();
    } while (cursor !== undefined);
    return found;
  };
  const listScopeObjects = async (target: Digest): Promise<{ readonly objects: readonly StoredObject[]; readonly anomalies: number }> => {
    const prefix = `objects/${target.slice(7)}/`;
    const entries = await listAll(prefix, maxCommittedArtifactsPerScope + 1_024, () => integrity('Artifact scope contains excessive unrecognized entries.'));
    const objects: StoredObject[] = []; let anomalies = 0;
    for (const entry of entries) {
      const name = entry.key.slice(prefix.length);
      if (!OBJECT_NAME.test(name)) { anomalies += 1; continue; }
      objects.push(Object.freeze({ referenceDigest: `sha256:${name}` as const, key: entry.key, bytes: entry.size, modifiedAt: entry.lastModified ?? 0, etag: entry.etag }));
      if (objects.length > maxCommittedArtifactsPerScope) throw new MayuraError('LIMIT_EXCEEDED', 'Committed artifact scope exceeds its configured capacity.');
    }
    objects.sort((left, right) => left.referenceDigest < right.referenceDigest ? -1 : left.referenceDigest > right.referenceDigest ? 1 : 0);
    return { objects: Object.freeze(objects), anomalies };
  };
  /** The bytes under `key` if they are exactly `bytes` long with this digest; a longer file is a failed integrity check. */
  const readExact = async (key: string, bytes: number, digest: Digest, missing: () => never): Promise<Uint8Array> => {
    let file;
    try { file = await files.get(key, { maxBytes: bytes }); }
    catch (error) { if (error instanceof MayuraError && error.code === 'LIMIT_EXCEEDED') integrity(); throw error; }
    if (file === undefined) missing();
    if (file.size !== bytes || file.data.byteLength !== bytes || sha256(file.data) !== digest) integrity();
    return file.data;
  };
  const readVerified = async (rawReference: ArtifactReference, rawScope: ArtifactScope): Promise<{ reference: ArtifactReference; bytes: Uint8Array }> => {
    const reference = validateReference(rawReference);
    if (reference.scopeDigest !== scopeDigest(rawScope)) throw new MayuraError('PERMISSION_DENIED', 'Artifact scope does not match.');
    if (reference.expiresAt !== undefined && reference.expiresAt <= clock()) throw new MayuraError('NOT_FOUND', 'Artifact is unavailable.');
    if (reference.bytes > options.maxArtifactBytes) integrity();
    const bytes = await readExact(objectKey(reference.scopeDigest, reference.referenceDigest), reference.bytes, reference.digest,
      () => { throw new MayuraError('NOT_FOUND', 'Artifact is unavailable.'); });
    return { reference, bytes };
  };
  /**
   * Writes an object only if none exists at its key. When one does, it must hold exactly these bytes (the same
   * artifact, committed or restored concurrently): returns whether this call created it.
   */
  const createObject = async (key: string, bytes: Uint8Array, digest: Digest): Promise<boolean> => {
    try { await files.put(key, bytes, { ifNoneMatch: '*', contentType: 'application/octet-stream' }); return true; }
    catch (error) {
      if (!isConflict(error)) throw error;
      await readExact(key, bytes.byteLength, digest, () => integrity('A concurrent artifact object disappeared.'));
      return false;
    }
  };

  return Object.freeze({
    async stage(input: StageArtifactInput): Promise<StagedArtifact> {
      return safeStorage(() => withStageLock(async () => {
        const staged = await listAll('staging/', maxStagedArtifacts, () => { throw new MayuraError('LIMIT_EXCEEDED', 'Staging capacity is exhausted.'); });
        if (staged.filter(file => STAGE_KEY.test(file.key)).length >= maxStagedArtifacts) throw new MayuraError('LIMIT_EXCEEDED', 'Staging capacity is exhausted.');
        const parsed = parseStage(input, options.maxArtifactBytes, clock());
        const stageId = crypto.randomUUID();
        const key = `staging/${stageId}`;
        try { await files.put(key, parsed.bytes, { ifNoneMatch: '*', contentType: 'application/octet-stream' }); }
        catch (error) { await files.delete(key).catch(() => undefined); throw error; }
        const handle = Object.freeze({ format: 'mayura-staged-artifact-v1' as const, stageId, digest: parsed.digest, bytes: parsed.bytes.byteLength });
        stages.set(handle, { handle, key, scopeDigest: parsed.scopeDigest, mediaType: parsed.mediaType, classification: parsed.classification,
          ...(parsed.filename === undefined ? {} : { filename: parsed.filename }), ...(parsed.expiresAt === undefined ? {} : { expiresAt: parsed.expiresAt }) });
        issuedStages.add(handle); activeStageIds.add(stageId);
        return handle;
      }));
    },

    async commit(staged: StagedArtifact): Promise<ArtifactReference> {
      return safeStorage(() => withStageLock(() => withCommitLock(async () => {
        if (staged === null || typeof staged !== 'object') invalid('staged artifact handle is invalid.');
        const record = stages.get(staged);
        if (record === undefined) invalid('staged artifact handle was not issued by this store.');
        const bytes = await readExact(record.key, record.handle.bytes, record.handle.digest, () => integrity('Staged artifact is unavailable.'));
        const reference = makeReference(record.scopeDigest, record.handle.digest, record.handle.bytes, record.mediaType, record.classification, record.filename, record.expiresAt);
        const destination = objectKey(reference.scopeDigest, reference.referenceDigest);
        if (await files.head(destination) === undefined) {
          const inventory = await listScopeObjects(record.scopeDigest);
          if (inventory.objects.length >= maxCommittedArtifactsPerScope) throw new MayuraError('LIMIT_EXCEEDED', 'Committed artifact scope capacity is exhausted.');
        }
        await createObject(destination, bytes, reference.digest);
        await files.delete(record.key);
        stages.delete(staged); activeStageIds.delete(record.handle.stageId);
        return reference;
      })));
    },

    async discard(staged: StagedArtifact): Promise<boolean> {
      return safeStorage(() => withStageLock(async () => {
        if (staged === null || typeof staged !== 'object' || !issuedStages.has(staged)) invalid('staged artifact handle was not issued by this store.');
        const record = stages.get(staged);
        if (record === undefined) return false;
        const removed = await files.head(record.key) !== undefined;
        await files.delete(record.key);
        stages.delete(staged); activeStageIds.delete(record.handle.stageId);
        return removed;
      }));
    },

    async read(reference: ArtifactReference, scope: ArtifactScope): Promise<Uint8Array> {
      return safeStorage(async () => (await readVerified(reference, scope)).bytes);
    },

    async disclose(reference: ArtifactReference, scope: ArtifactScope, policy: ArtifactDisclosurePolicy): Promise<ArtifactDisclosure> {
      return safeStorage(async () => {
        const disclose = disclosurePolicy(policy);
        const verified = await readVerified(reference, scope);
        return disclose(verified.reference, verified.bytes);
      });
    },

    async delete(reference: ArtifactReference, scope: ArtifactScope): Promise<boolean> {
      return safeStorage(() => withCommitLock(async () => {
        const validated = validateReference(reference);
        if (validated.scopeDigest !== scopeDigest(scope)) throw new MayuraError('PERMISSION_DENIED', 'Artifact scope does not match.');
        const key = objectKey(validated.scopeDigest, validated.referenceDigest);
        if (await files.head(key) === undefined) return false;
        await files.delete(key);
        return true;
      }));
    },

    async reconcileStaging(reconciliation: StagingReconciliationOptions): Promise<StagingReconciliationResult> {
      return safeStorage(() => withStageLock(async () => {
        const { olderThan, maxDeletes } = parseStagingReconciliation(reconciliation, clock());
        const entries = await listAll('staging/', MAX_STAGED_ARTIFACTS + 1_024, () => integrity('Artifact staging contains excessive entries.'));
        let examined = 0; let deleted = 0; let eligible = 0;
        for (const entry of entries) {
          const match = STAGE_KEY.exec(entry.key);
          if (!match) continue;
          examined += 1;
          if (activeStageIds.has(match[1]!)) continue;
          // A file store that does not report when a file was written cannot show that a stage is old: keep it.
          if (entry.lastModified === undefined || entry.lastModified > olderThan) continue;
          eligible += 1;
          if (deleted < maxDeletes) { await files.delete(entry.key); deleted += 1; }
        }
        return Object.freeze({ examined, deleted, remaining: eligible > deleted });
      }));
    },

    async audit(references: readonly ArtifactReference[], scope: ArtifactScope, auditOptions: ArtifactAuditOptions): Promise<ArtifactAuditResult> {
      return safeStorage(async () => {
        const { references: validated, admittedBytes } = parseAudit(references, scope, auditOptions);
        const observations = [];
        for (const reference of validated) {
          let status: 'ok' | 'missing' | 'expired' | 'integrity_failed';
          if (reference.expiresAt !== undefined && reference.expiresAt <= clock()) status = 'expired';
          else {
            try { await readVerified(reference, scope); status = 'ok'; }
            catch (error) {
              if (error instanceof MayuraError && error.code === 'NOT_FOUND') status = 'missing';
              else if (error instanceof MayuraError && error.code === 'INTEGRITY_VIOLATION') status = 'integrity_failed';
              else throw error;
            }
          }
          observations.push(Object.freeze({ referenceDigest: reference.referenceDigest, status }));
        }
        return Object.freeze({ observations: Object.freeze(observations), admittedBytes });
      });
    },

    async planReconciliation(rawOptions: PlanArtifactReconciliationOptions): Promise<ArtifactReconciliationPlan> {
      return safeStorage(async () => {
        const { scopeDigest: expectedScope, retained, olderThan, maxExamined, maxDeletes, cursor } = parsePlan(rawOptions, clock(), maxCommittedArtifactsPerScope);
        const inventory = await listScopeObjects(expectedScope);
        const available = inventory.objects.filter((entry) => cursor === undefined || entry.referenceDigest > cursor.after);
        const candidates: StoredObject[] = []; let examined = 0;
        for (const entry of available) {
          if (examined >= maxExamined || candidates.length >= maxDeletes) break;
          examined += 1;
          if (!retained.has(entry.referenceDigest) && entry.modifiedAt <= olderThan) candidates.push(entry);
        }
        const last = examined === 0 ? undefined : available[examined - 1];
        const nextCursor = last !== undefined && available.length > examined
          ? Object.freeze({ format: 'mayura-artifact-reconciliation-cursor-v1' as const, scopeDigest: expectedScope, after: last.referenceDigest })
          : undefined;
        const publicCandidates = Object.freeze(candidates.map((entry) => Object.freeze({ referenceDigest: entry.referenceDigest,
          bytes: entry.bytes, modifiedAt: Math.trunc(entry.modifiedAt) })));
        const plan = Object.freeze({ format: 'mayura-artifact-reconciliation-plan-v1' as const, scopeDigest: expectedScope,
          examined, anomalies: inventory.anomalies, candidates: publicCandidates,
          ...(nextCursor === undefined ? {} : { nextCursor }) }) as ArtifactReconciliationPlan;
        reconciliationPlans.set(plan, { scopeDigest: expectedScope, candidates: Object.freeze(candidates) });
        return plan;
      });
    },

    async applyReconciliation(plan: ArtifactReconciliationPlan): Promise<ArtifactReconciliationResult> {
      return safeStorage(() => withCommitLock(async () => {
        if (plan === null || typeof plan !== 'object') invalid('reconciliation plan is invalid.');
        const internal = reconciliationPlans.get(plan);
        if (internal === undefined) invalid('reconciliation plan was not issued by this store or was already consumed.');
        reconciliationPlans.delete(plan);
        let deleted = 0; let changed = 0; let missing = 0;
        for (const candidate of internal.candidates) {
          if (candidate.key !== objectKey(internal.scopeDigest, candidate.referenceDigest)) integrity('Reconciliation candidate path changed.');
          const current = await files.head(candidate.key);
          if (current === undefined) { missing += 1; continue; }
          if (current.size !== candidate.bytes || current.etag !== candidate.etag) { changed += 1; continue; }
          try { await files.delete(candidate.key, files.conditionalDelete ? { ifMatch: candidate.etag } : {}); deleted += 1; }
          catch (error) { if (isConflict(error)) changed += 1; else throw error; }
        }
        return Object.freeze({ deleted, changed, missing });
      }));
    },

    async backup(rawOptions: ArtifactBackupOptions): Promise<Uint8Array> {
      return safeStorage(() => withCommitLock(async () => {
        const { scope, scopeDigest: expectedScope, references, referenceDigests } = parseBackup(rawOptions, clock());
        const inventory = await listScopeObjects(expectedScope);
        if (inventory.anomalies > 0) integrity('Artifact scope contains structural anomalies and cannot be backed up.');
        if (inventory.objects.length !== references.length || inventory.objects.some((entry) => !referenceDigests.has(entry.referenceDigest))) {
          throw new MayuraError('CONFLICT', 'Backup references are not the complete authoritative scope set.');
        }
        const entries = [];
        for (const reference of references) {
          const verified = await readVerified(reference, scope);
          entries.push({ reference: verified.reference, bytes: verified.bytes });
        }
        return encodeBackup(expectedScope, entries);
      }));
    },

    async restore(archive: Uint8Array, rawScope: ArtifactScope, rawOptions: ArtifactRestoreOptions): Promise<ArtifactRestoreResult> {
      return safeStorage(() => withCommitLock(async () => {
        const { scopeDigest: expectedScope, entries, references, contentBytes } = parseRestore(archive, rawScope, rawOptions, options.maxArtifactBytes, clock());
        const inventory = await listScopeObjects(expectedScope);
        if (inventory.anomalies > 0) integrity('Restore scope contains structural anomalies.');
        if (inventory.objects.some((entry) => !references.has(entry.referenceDigest))) {
          throw new MayuraError('CONFLICT', 'Restore scope contains objects outside the authoritative backup.');
        }
        if (entries.length > maxCommittedArtifactsPerScope) throw new MayuraError('LIMIT_EXCEEDED', 'Backup exceeds the configured scope capacity.');
        let existing = 0;
        for (const object of inventory.objects) { await readVerified(references.get(object.referenceDigest)!, rawScope); existing += 1; }
        let restored = 0;
        for (const entry of entries) {
          if (inventory.objects.some((object) => object.referenceDigest === entry.reference.referenceDigest)) continue;
          if (await createObject(objectKey(expectedScope, entry.reference.referenceDigest), entry.content, entry.reference.digest)) restored += 1;
          else existing += 1;
        }
        return Object.freeze({ artifacts: entries.length, restored, existing, contentBytes });
      }));
    },
  });
}
