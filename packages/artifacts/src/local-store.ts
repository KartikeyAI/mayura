import { randomUUID } from 'node:crypto';
import { link, lstat, mkdir, opendir, readFile, readdir, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { MayuraError, assertPositiveInteger } from '@mayura/core';
import type {
  ArtifactAuditOptions,
  ArtifactAuditResult,
  ArtifactBackupOptions,
  ArtifactClassification,
  ArtifactDisclosure,
  ArtifactDisclosurePolicy,
  ArtifactReference,
  ArtifactReconciliationPlan,
  ArtifactReconciliationResult,
  ArtifactRestoreOptions,
  ArtifactRestoreResult,
  ArtifactScope,
  LocalArtifactStore,
  LocalArtifactStoreOptions,
  PlanArtifactReconciliationOptions,
  StageArtifactInput,
  StagedArtifact,
  StagingReconciliationOptions,
  StagingReconciliationResult,
} from './contracts.js';
import {
  MAX_BUFFERED_ARTIFACT_BYTES, MAX_COMMITTED_ARTIFACTS_PER_SCOPE, MAX_STAGED_ARTIFACTS, disclosurePolicy, encodeBackup, integrity, invalid, makeReference,
  parseAudit, parseBackup, parsePlan, parseRestore, parseStage, parseStagingReconciliation, scopeDigest, sha256, validateReference,
} from './shared.js';

const STAGE_FILE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.stage$/u;
const OBJECT_NAME = /^[0-9a-f]{64}$/u;
const OBJECT_PREFIX = /^[0-9a-f]{2}$/u;

interface StageRecord {
  readonly handle: StagedArtifact;
  readonly path: string;
  readonly scopeDigest: `sha256:${string}`;
  readonly mediaType: string;
  readonly classification: ArtifactClassification;
  readonly filename?: string;
  readonly expiresAt?: number;
}

interface StoredObject {
  readonly referenceDigest: `sha256:${string}`;
  readonly path: string;
  readonly bytes: number;
  readonly modifiedAt: number;
  readonly device: number;
  readonly inode: number;
}

interface InternalReconciliationPlan {
  readonly scopeDigest: `sha256:${string}`;
  readonly candidates: readonly StoredObject[];
}

async function safeStorage<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof MayuraError) throw error;
    throw new MayuraError('STORAGE_UNAVAILABLE', 'Artifact storage is unavailable. Inspect authorized local diagnostics.');
  }
}

async function regularFile(path: string): Promise<boolean> {
  try {
    const details = await lstat(path);
    return details.isFile() && !details.isSymbolicLink();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

export function createLocalArtifactStore(options: LocalArtifactStoreOptions): LocalArtifactStore {
  if (options === null || typeof options !== 'object' || Array.isArray(options)) throw new MayuraError('INVALID_CONFIG', 'options must be an object.');
  if (typeof options.rootDirectory !== 'string' || !isAbsolute(options.rootDirectory)) {
    throw new MayuraError('INVALID_CONFIG', 'rootDirectory must be an absolute path.');
  }
  assertPositiveInteger(options.maxArtifactBytes, 'maxArtifactBytes');
  if (options.maxArtifactBytes > MAX_BUFFERED_ARTIFACT_BYTES) throw new MayuraError('INVALID_CONFIG', 'maxArtifactBytes exceeds the local adapter limit.');
  const maxStagedArtifacts = options.maxStagedArtifacts ?? 128;
  assertPositiveInteger(maxStagedArtifacts, 'maxStagedArtifacts');
  if (maxStagedArtifacts > MAX_STAGED_ARTIFACTS) throw new MayuraError('INVALID_CONFIG', 'maxStagedArtifacts exceeds the local adapter limit.');
  const maxCommittedArtifactsPerScope = options.maxCommittedArtifactsPerScope ?? 4_096;
  assertPositiveInteger(maxCommittedArtifactsPerScope, 'maxCommittedArtifactsPerScope');
  if (maxCommittedArtifactsPerScope > MAX_COMMITTED_ARTIFACTS_PER_SCOPE) {
    throw new MayuraError('INVALID_CONFIG', 'maxCommittedArtifactsPerScope exceeds the local adapter limit.');
  }
  if (options.clock !== undefined && typeof options.clock !== 'function') throw new MayuraError('INVALID_CONFIG', 'clock must be a function.');

  const root = resolve(options.rootDirectory);
  const stagingDirectory = join(root, 'staging');
  const objectsDirectory = join(root, 'objects');
  const stages = new WeakMap<object, StageRecord>();
  const issuedStages = new WeakSet<object>();
  const activeStageIds = new Set<string>();
  const reconciliationPlans = new WeakMap<object, InternalReconciliationPlan>();
  const configuredClock = options.clock ?? Date.now;
  let initialized: Promise<void> | undefined;
  let stageTail = Promise.resolve();
  let commitTail = Promise.resolve();

  const clock = (): number => {
    const value = configuredClock();
    if (!Number.isSafeInteger(value) || value < 0) throw new MayuraError('INVALID_CONFIG', 'clock must return a non-negative safe Unix millisecond timestamp.');
    return value;
  };

  const withStageLock = <T>(operation: () => Promise<T>): Promise<T> => {
    const result = stageTail.then(operation, operation);
    stageTail = result.then(() => undefined, () => undefined);
    return result;
  };

  const withCommitLock = <T>(operation: () => Promise<T>): Promise<T> => {
    const result = commitTail.then(operation, operation);
    commitTail = result.then(() => undefined, () => undefined);
    return result;
  };

  const initialize = (): Promise<void> => {
    initialized ??= Promise.all([
      mkdir(stagingDirectory, { recursive: true, mode: 0o700 }),
      mkdir(objectsDirectory, { recursive: true, mode: 0o700 }),
    ]).then(async () => {
      for (const path of [stagingDirectory, objectsDirectory]) {
        const details = await lstat(path);
        if (!details.isDirectory() || details.isSymbolicLink()) integrity('Artifact store contains an unsafe internal directory.');
      }
    });
    return initialized;
  };

  const storagePath = async (targetScopeDigest: `sha256:${string}`, referenceDigest: `sha256:${string}`,
    create: boolean): Promise<string | undefined> => {
    await initialize();
    const scopeDirectory = join(objectsDirectory, targetScopeDigest.slice(7));
    const prefixDirectory = join(scopeDirectory, referenceDigest.slice(7, 9));
    for (const path of [scopeDirectory, prefixDirectory]) {
      if (create) await mkdir(path, { recursive: true, mode: 0o700 });
      let details;
      try { details = await lstat(path); }
      catch (error) {
        if (!create && (error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
        throw error;
      }
      if (!details.isDirectory() || details.isSymbolicLink()) integrity('Artifact store contains an unsafe object directory.');
    }
    return join(prefixDirectory, referenceDigest.slice(7));
  };

  const listScopeObjects = async (targetScopeDigest: `sha256:${string}`): Promise<{ readonly objects: readonly StoredObject[]; readonly anomalies: number }> => {
    await initialize();
    const scopeDirectory = join(objectsDirectory, targetScopeDigest.slice(7));
    try {
      const scopeDetails = await lstat(scopeDirectory);
      if (!scopeDetails.isDirectory() || scopeDetails.isSymbolicLink()) integrity('Artifact store contains an unsafe scope directory.');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { objects: Object.freeze([]), anomalies: 0 };
      throw error;
    }
    let directory: Awaited<ReturnType<typeof opendir>>;
    try { directory = await opendir(scopeDirectory); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { objects: Object.freeze([]), anomalies: 0 };
      throw error;
    }
    const prefixes: string[] = []; let anomalies = 0; let outerExamined = 0;
    try {
      for await (const entry of directory) {
        outerExamined += 1;
        if (outerExamined > 512) integrity('Artifact scope directory exceeds its structural bound.');
        if (!OBJECT_PREFIX.test(entry.name)) { anomalies += 1; continue; }
        const path = join(scopeDirectory, entry.name); const details = await lstat(path);
        if (!details.isDirectory() || details.isSymbolicLink()) { anomalies += 1; continue; }
        prefixes.push(entry.name);
      }
    } finally { await directory.close().catch(() => undefined); }
    prefixes.sort();
    const objects: StoredObject[] = []; let innerExamined = 0;
    for (const prefix of prefixes) {
      const prefixDirectory = join(scopeDirectory, prefix); const handle = await opendir(prefixDirectory);
      try {
        for await (const entry of handle) {
          innerExamined += 1;
          if (innerExamined > maxCommittedArtifactsPerScope + 1_024) integrity('Artifact scope contains excessive unrecognized entries.');
          if (!OBJECT_NAME.test(entry.name) || !entry.name.startsWith(prefix)) { anomalies += 1; continue; }
          const path = join(prefixDirectory, entry.name); const details = await lstat(path);
          if (!details.isFile() || details.isSymbolicLink()) { anomalies += 1; continue; }
          objects.push(Object.freeze({ referenceDigest: `sha256:${entry.name}` as const, path, bytes: details.size,
            modifiedAt: details.mtimeMs, device: details.dev, inode: details.ino }));
          if (objects.length > maxCommittedArtifactsPerScope) throw new MayuraError('LIMIT_EXCEEDED', 'Committed artifact scope exceeds its configured capacity.');
        }
      } finally { await handle.close().catch(() => undefined); }
    }
    objects.sort((left, right) => left.referenceDigest < right.referenceDigest ? -1 : left.referenceDigest > right.referenceDigest ? 1 : 0);
    return { objects: Object.freeze(objects), anomalies };
  };

  const readVerified = async (rawReference: ArtifactReference, rawScope: ArtifactScope): Promise<{ reference: ArtifactReference; bytes: Uint8Array }> => {
    await initialize();
    const reference = validateReference(rawReference);
    if (reference.scopeDigest !== scopeDigest(rawScope)) throw new MayuraError('PERMISSION_DENIED', 'Artifact scope does not match.');
    if (reference.expiresAt !== undefined && reference.expiresAt <= clock()) throw new MayuraError('NOT_FOUND', 'Artifact is unavailable.');
    if (reference.bytes > options.maxArtifactBytes) integrity();
    const path = await storagePath(reference.scopeDigest, reference.referenceDigest, false);
    if (path === undefined || !(await regularFile(path))) throw new MayuraError('NOT_FOUND', 'Artifact is unavailable.');
    const details = await stat(path);
    if (details.size !== reference.bytes) integrity();
    const bytes = new Uint8Array(await readFile(path));
    if (sha256(bytes) !== reference.digest) integrity();
    return { reference, bytes };
  };

  return Object.freeze({
    async stage(input: StageArtifactInput): Promise<StagedArtifact> {
      return safeStorage(() => withStageLock(async () => {
      await initialize();
      const stagedCount = (await readdir(stagingDirectory)).filter((entry) => STAGE_FILE.test(entry)).length;
      if (stagedCount >= maxStagedArtifacts) throw new MayuraError('LIMIT_EXCEEDED', 'Staging capacity is exhausted.');
      const { bytes, digest, scopeDigest: normalizedScopeDigest, mediaType, classification, filename, expiresAt } = parseStage(input, options.maxArtifactBytes, clock());
      const stageId = randomUUID();
      const path = join(stagingDirectory, `${stageId}.stage`);
      try { await writeFile(path, bytes, { flag: 'wx', mode: 0o600 }); }
      catch (error) {
        // A full device can leave a short file even though writeFile rejects. Remove it before
        // returning; restart reconciliation remains the fallback if the process dies first.
        await unlink(path).catch(() => undefined);
        throw error;
      }
      const handle = Object.freeze({ format: 'mayura-staged-artifact-v1' as const, stageId, digest, bytes: bytes.byteLength });
      stages.set(handle, {
        handle, path, scopeDigest: normalizedScopeDigest, mediaType, classification,
        ...(filename === undefined ? {} : { filename }),
        ...(expiresAt === undefined ? {} : { expiresAt }),
      });
      issuedStages.add(handle);
      activeStageIds.add(stageId);
      return handle;
      }));
    },

    async commit(staged: StagedArtifact): Promise<ArtifactReference> {
      return safeStorage(() => withStageLock(() => withCommitLock(async () => {
      await initialize();
      if (staged === null || typeof staged !== 'object') {
        invalid('staged artifact handle is invalid.');
      }
      const record = stages.get(staged);
      if (record === undefined) invalid('staged artifact handle was not issued by this store.');
      if (!(await regularFile(record.path))) integrity('Staged artifact is unavailable.');
      const details = await stat(record.path);
      if (details.size !== record.handle.bytes) integrity('Staged artifact size changed.');
      const bytes = new Uint8Array(await readFile(record.path));
      if (sha256(bytes) !== record.handle.digest) integrity('Staged artifact content changed.');
      const reference = makeReference(record.scopeDigest, record.handle.digest, record.handle.bytes, record.mediaType, record.classification,
        record.filename, record.expiresAt);
      const destination = (await storagePath(reference.scopeDigest, reference.referenceDigest, true))!;
      if (await regularFile(destination)) {
        const existing = new Uint8Array(await readFile(destination));
        if (existing.byteLength !== reference.bytes || sha256(existing) !== reference.digest) integrity('Committed artifact content conflicts with its digest.');
        await unlink(record.path);
      } else {
        const inventory = await listScopeObjects(record.scopeDigest);
        if (inventory.objects.length >= maxCommittedArtifactsPerScope) throw new MayuraError('LIMIT_EXCEEDED', 'Committed artifact scope capacity is exhausted.');
        await rename(record.path, destination);
      }
      stages.delete(staged);
      activeStageIds.delete(record.handle.stageId);
      return reference;
      })));
    },

    async discard(staged: StagedArtifact): Promise<boolean> {
      return safeStorage(() => withStageLock(async () => {
        if (staged === null || typeof staged !== 'object' || !issuedStages.has(staged)) invalid('staged artifact handle was not issued by this store.');
        const record = stages.get(staged);
        if (record === undefined) return false;
        let removed = true;
        try { await unlink(record.path); }
        catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') removed = false;
          else throw error;
        }
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
          const expectedPath = await storagePath(internal.scopeDigest, candidate.referenceDigest, false);
          if (expectedPath === undefined) { missing += 1; continue; }
          if (expectedPath !== candidate.path) integrity('Reconciliation candidate path changed.');
          let details;
          try { details = await lstat(candidate.path); }
          catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT') { missing += 1; continue; }
            throw error;
          }
          if (!details.isFile() || details.isSymbolicLink() || details.size !== candidate.bytes || details.mtimeMs !== candidate.modifiedAt ||
            details.dev !== candidate.device || details.ino !== candidate.inode) { changed += 1; continue; }
          try { await unlink(candidate.path); deleted += 1; }
          catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT') missing += 1;
            else throw error;
          }
        }
        return Object.freeze({ deleted, changed, missing });
      }));
    },

    async backup(rawOptions: ArtifactBackupOptions): Promise<Uint8Array> {
      return safeStorage(() => withCommitLock(async () => {
        const { scope: backupScope, scopeDigest: expectedScope, references, referenceDigests } = parseBackup(rawOptions, clock());
        const inventory = await listScopeObjects(expectedScope);
        if (inventory.anomalies > 0) integrity('Artifact scope contains structural anomalies and cannot be backed up.');
        if (inventory.objects.length !== references.length || inventory.objects.some((entry) => !referenceDigests.has(entry.referenceDigest))) {
          throw new MayuraError('CONFLICT', 'Backup references are not the complete authoritative scope set.');
        }
        const entries = [];
        for (const reference of references) {
          const verified = await readVerified(reference, backupScope);
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
        for (const object of inventory.objects) {
          await readVerified(references.get(object.referenceDigest)!, rawScope); existing += 1;
        }
        let restored = 0;
        for (const entry of entries) {
          if (inventory.objects.some((object) => object.referenceDigest === entry.reference.referenceDigest)) continue;
          const destination = (await storagePath(expectedScope, entry.reference.referenceDigest, true))!;
          const temporary = join(stagingDirectory, `${randomUUID()}.stage`);
          try {
            await writeFile(temporary, entry.content, { flag: 'wx', mode: 0o600 });
            try { await link(temporary, destination); restored += 1; }
            catch (error) {
              if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
              const bytes = new Uint8Array(await readFile(destination));
              if (bytes.byteLength !== entry.reference.bytes || sha256(bytes) !== entry.reference.digest) {
                integrity('Concurrent restore object conflicts with the backup.');
              }
              existing += 1;
            }
          } finally {
            await unlink(temporary).catch((error: NodeJS.ErrnoException) => { if (error.code !== 'ENOENT') throw error; });
          }
        }
        return Object.freeze({ artifacts: entries.length, restored, existing, contentBytes });
      }));
    },

    async delete(reference: ArtifactReference, scope: ArtifactScope): Promise<boolean> {
      return safeStorage(() => withCommitLock(async () => {
      await initialize();
      const validated = validateReference(reference);
      if (validated.scopeDigest !== scopeDigest(scope)) throw new MayuraError('PERMISSION_DENIED', 'Artifact scope does not match.');
      const path = await storagePath(validated.scopeDigest, validated.referenceDigest, false);
      if (path === undefined || !(await regularFile(path))) return false;
      await unlink(path);
      return true;
      }));
    },

    async reconcileStaging(reconciliation: StagingReconciliationOptions): Promise<StagingReconciliationResult> {
      return safeStorage(() => withStageLock(async () => {
      await initialize();
      const { olderThan, maxDeletes } = parseStagingReconciliation(reconciliation, clock());
      const entries = (await readdir(stagingDirectory)).sort();
      let examined = 0;
      let deleted = 0;
      let eligible = 0;
      for (const entry of entries) {
        if (!STAGE_FILE.test(entry)) continue;
        examined += 1;
        const stageId = entry.slice(0, -6);
        if (activeStageIds.has(stageId)) continue;
        const path = join(stagingDirectory, entry);
        const details = await lstat(path);
        if (!details.isFile() || details.isSymbolicLink() || details.mtimeMs > olderThan) continue;
        eligible += 1;
        if (deleted < maxDeletes) {
          await unlink(path);
          deleted += 1;
        }
      }
      return Object.freeze({ examined, deleted, remaining: eligible > deleted });
      }));
    },
  });
}
