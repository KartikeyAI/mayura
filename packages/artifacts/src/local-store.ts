import { createHash, randomUUID } from 'node:crypto';
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
  ArtifactReconciliationCursor,
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

const DIGEST = /^sha256:[0-9a-f]{64}$/u;
const MEDIA_TYPE = /^[a-z0-9][a-z0-9!#$&^_.+-]{0,62}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,62}$/u;
const STAGE_FILE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.stage$/u;
const CLASSIFICATIONS = new Set<ArtifactClassification>(['public', 'internal', 'confidential', 'restricted']);
const MAX_BUFFERED_ARTIFACT_BYTES = 64 * 1_024 * 1_024;
const MAX_STAGED_ARTIFACTS = 4_096;
const MAX_COMMITTED_ARTIFACTS_PER_SCOPE = 65_536;
const MAX_BACKUP_ARTIFACTS = 256;
const MAX_BACKUP_CONTENT_BYTES = 64 * 1_024 * 1_024;
const MAX_BACKUP_ARCHIVE_BYTES = 96 * 1_024 * 1_024;
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

interface BackupEntry {
  readonly reference: ArtifactReference;
  readonly content: Uint8Array;
}

function sha256(value: Uint8Array | string): `sha256:${string}` {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

function canonicalBase64(value: Uint8Array): string {
  return Buffer.from(value).toString('base64');
}

function decodeBase64(value: unknown, field: string, maximum: number): Uint8Array {
  if (typeof value !== 'string' || value.length > Math.ceil(maximum / 3) * 4 + 4 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(value)) invalid(`${field} is not canonical base64.`);
  const decoded = new Uint8Array(Buffer.from(value, 'base64'));
  if (decoded.byteLength > maximum || canonicalBase64(decoded) !== value) invalid(`${field} is not canonical base64.`);
  return decoded;
}

function stableScope(scope: ArtifactScope): { readonly tenantId: string; readonly projectId?: string } {
  const fields = plainData(scope, 'scope', new Set(['tenantId', 'projectId']));
  const tenantId = boundedIdentity(fields.get('tenantId'), 'scope.tenantId');
  const projectId = fields.get('projectId');
  if (projectId === undefined) return Object.freeze({ tenantId });
  return Object.freeze({ tenantId, projectId: boundedIdentity(projectId, 'scope.projectId') });
}

function scopeDigest(scope: ArtifactScope): `sha256:${string}` {
  const value = stableScope(scope);
  return sha256(JSON.stringify([value.tenantId, value.projectId ?? null]));
}

function boundedIdentity(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 256 || /[\u0000-\u001f\u007f]/u.test(value)) {
    invalid(`${field} must be a non-empty bounded string without control characters.`);
  }
  return value.normalize('NFC');
}

function normalizedMediaType(value: unknown, field = 'mediaType'): string {
  if (typeof value !== 'string') invalid(`${field} must be a registered media type without parameters.`);
  const normalized = value.toLowerCase();
  if (!MEDIA_TYPE.test(normalized)) invalid(`${field} must be a registered media type without parameters.`);
  return normalized;
}

function normalizedClassification(value: unknown): ArtifactClassification {
  if (typeof value !== 'string' || !CLASSIFICATIONS.has(value as ArtifactClassification)) {
    invalid('classification is unsupported.');
  }
  return value as ArtifactClassification;
}

function normalizedFilename(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || value.length === 0 || value.length > 512 || /[\u0000-\u001f\u007f]/u.test(value)) {
    invalid('filename must be a non-empty bounded string without control characters.');
  }
  return value.normalize('NFC');
}

function normalizedExpiry(value: unknown, now: number): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || (value as number) <= now) invalid('expiresAt must be a future Unix millisecond timestamp.');
  return value as number;
}

function invalid(message: string): never {
  throw new MayuraError('INVALID_INPUT', message);
}

function plainData(value: unknown, field: string, allowed: ReadonlySet<string>): ReadonlyMap<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) {
    invalid(`${field} must be a plain object.`);
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const data = new Map<string, unknown>();
  for (const [key, descriptor] of Object.entries(descriptors)) {
    if (!allowed.has(key)) invalid(`${field} contains an unsupported field.`);
    if (!hasOwn(descriptor, 'value') || descriptor.get !== undefined || descriptor.set !== undefined) invalid(`${field} must contain only data fields.`);
    data.set(key, descriptor.value);
  }
  return data;
}

function plainArray(value: unknown, field: string, maximum: number, minimum = 0): readonly unknown[] {
  if (!Array.isArray(value) || value.length < minimum || value.length > maximum || Object.getPrototypeOf(value) !== Array.prototype) {
    invalid(`${field} must contain ${minimum}–${maximum} entries.`);
  }
  const descriptors = Object.getOwnPropertyDescriptors(value); const result: unknown[] = [];
  for (const key of Object.keys(descriptors)) {
    if (key === 'length') continue;
    if (!/^(?:0|[1-9][0-9]*)$/u.test(key) || Number(key) >= value.length) invalid(`${field} contains an unsupported field.`);
  }
  for (let index = 0; index < value.length; index++) {
    const descriptor = descriptors[String(index)];
    if (descriptor === undefined || !hasOwn(descriptor, 'value') || descriptor.get !== undefined || descriptor.set !== undefined) {
      invalid(`${field} must be dense and contain only data entries.`);
    }
    result.push(descriptor.value);
  }
  return Object.freeze(result);
}

function integrity(message = 'Artifact integrity verification failed.'): never {
  throw new MayuraError('INTEGRITY_VIOLATION', message);
}

async function safeStorage<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof MayuraError) throw error;
    throw new MayuraError('STORAGE_UNAVAILABLE', 'Artifact storage is unavailable. Inspect authorized local diagnostics.');
  }
}

function hasOwn(value: object, key: PropertyKey): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function validateReference(value: ArtifactReference): ArtifactReference {
  const allowed = new Set(['format', 'scopeDigest', 'referenceDigest', 'digest', 'bytes', 'mediaType', 'classification', 'filename', 'expiresAt']);
  const fields = plainData(value, 'artifact reference', allowed);
  const format = fields.get('format');
  const referenceScopeDigest = fields.get('scopeDigest');
  const suppliedReferenceDigest = fields.get('referenceDigest');
  const digest = fields.get('digest');
  const bytes = fields.get('bytes');
  if (format !== 'mayura-artifact-v1' || typeof referenceScopeDigest !== 'string' || !DIGEST.test(referenceScopeDigest) ||
    typeof suppliedReferenceDigest !== 'string' || !DIGEST.test(suppliedReferenceDigest) || typeof digest !== 'string' || !DIGEST.test(digest)) {
    invalid('artifact reference identity is invalid.');
  }
  if (!Number.isSafeInteger(bytes) || (bytes as number) < 0) invalid('artifact reference byte length is invalid.');
  const mediaType = normalizedMediaType(fields.get('mediaType'), 'reference.mediaType');
  const classification = normalizedClassification(fields.get('classification'));
  const filename = normalizedFilename(fields.get('filename'));
  const expiresAt = fields.get('expiresAt');
  if (expiresAt !== undefined && (typeof expiresAt !== 'number' || !Number.isSafeInteger(expiresAt) || expiresAt <= 0)) invalid('artifact reference expiry is invalid.');
  const expectedReferenceDigest = sha256(JSON.stringify(['mayura-artifact-v1', referenceScopeDigest, digest, bytes, mediaType,
    classification, filename ?? null, expiresAt ?? null]));
  if (suppliedReferenceDigest !== expectedReferenceDigest) integrity('Artifact reference metadata failed integrity verification.');
  const reference: ArtifactReference = {
    format: 'mayura-artifact-v1', scopeDigest: referenceScopeDigest as `sha256:${string}`,
    referenceDigest: suppliedReferenceDigest as `sha256:${string}`, digest: digest as `sha256:${string}`,
    bytes: bytes as number, mediaType, classification,
    ...(filename === undefined ? {} : { filename }),
    ...(expiresAt === undefined ? {} : { expiresAt: expiresAt as number }),
  };
  return Object.freeze(reference);
}

function validatedCursor(value: ArtifactReconciliationCursor, expectedScope: `sha256:${string}`): ArtifactReconciliationCursor {
  const fields = plainData(value, 'reconciliation cursor', new Set(['format', 'scopeDigest', 'after']));
  const cursorScope = fields.get('scopeDigest'); const after = fields.get('after');
  if (fields.get('format') !== 'mayura-artifact-reconciliation-cursor-v1' || typeof cursorScope !== 'string' ||
    !DIGEST.test(cursorScope) || typeof after !== 'string' || !DIGEST.test(after)) invalid('reconciliation cursor is invalid.');
  if (cursorScope !== expectedScope) throw new MayuraError('PERMISSION_DENIED', 'Reconciliation cursor scope does not match.');
  return Object.freeze({ format: 'mayura-artifact-reconciliation-cursor-v1', scopeDigest: cursorScope as `sha256:${string}`,
    after: after as `sha256:${string}` });
}

function safeDownloadName(value: string | undefined, digest: string): string {
  const fallback = `artifact-${digest.slice(7, 19)}`;
  if (value === undefined) return fallback;
  const ascii = value.normalize('NFKC').replace(/[^A-Za-z0-9._-]+/gu, '_').replace(/^[. _-]+/u, '').slice(0, 120);
  return ascii.length === 0 ? fallback : ascii;
}

function activeMediaType(mediaType: string): boolean {
  return mediaType === 'text/html' || mediaType === 'image/svg+xml' || mediaType === 'application/xhtml+xml' ||
    mediaType === 'application/xml' || mediaType === 'text/xml' || mediaType.endsWith('+xml');
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
      const inputKeys = new Set(['scope', 'content', 'mediaType', 'classification', 'filename', 'expiresAt']);
      const fields = plainData(input, 'artifact input', inputKeys);
      const content = fields.get('content');
      if (!(content instanceof Uint8Array)) invalid('content must be a Uint8Array.');
      if (typeof SharedArrayBuffer !== 'undefined' && content.buffer instanceof SharedArrayBuffer) invalid('content must not use shared memory.');
      if (content.byteLength > options.maxArtifactBytes) throw new MayuraError('LIMIT_EXCEEDED', 'Artifact exceeds maxArtifactBytes.');
      const bytes = new Uint8Array(content);
      const digest = sha256(bytes);
      const normalizedScopeDigest = scopeDigest(fields.get('scope') as ArtifactScope);
      const mediaType = normalizedMediaType(fields.get('mediaType'));
      const classification = normalizedClassification(fields.get('classification'));
      const filename = normalizedFilename(fields.get('filename'));
      const expiresAt = normalizedExpiry(fields.get('expiresAt'), clock());
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
      const reference: ArtifactReference = Object.freeze({
        format: 'mayura-artifact-v1' as const,
        scopeDigest: record.scopeDigest,
        referenceDigest: sha256(JSON.stringify(['mayura-artifact-v1', record.scopeDigest, record.handle.digest, record.handle.bytes,
          record.mediaType, record.classification, record.filename ?? null, record.expiresAt ?? null])),
        digest: record.handle.digest,
        bytes: record.handle.bytes,
        mediaType: record.mediaType,
        classification: record.classification,
        ...(record.filename === undefined ? {} : { filename: record.filename }),
        ...(record.expiresAt === undefined ? {} : { expiresAt: record.expiresAt }),
      });
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
      const keys = new Set(['classifications', 'maxBytes', 'mediaTypes']);
      const fields = plainData(policy, 'disclosure policy', keys);
      const maxBytes = fields.get('maxBytes');
      if (typeof maxBytes !== 'number') invalid('policy.maxBytes must be a number.');
      assertPositiveInteger(maxBytes, 'policy.maxBytes');
      const requestedClassifications = fields.get('classifications');
      const classificationEntries = plainArray(requestedClassifications, 'policy.classifications', CLASSIFICATIONS.size, 1);
      const classifications = new Set(classificationEntries.map(normalizedClassification));
      if (classifications.size !== classificationEntries.length) invalid('policy.classifications must not contain duplicates.');
      let mediaTypes: Set<string> | undefined;
      const requestedMediaTypes = fields.get('mediaTypes');
      if (requestedMediaTypes !== undefined) {
        const mediaTypeEntries = plainArray(requestedMediaTypes, 'policy.mediaTypes', 64, 1);
        mediaTypes = new Set(mediaTypeEntries.map((entry) => normalizedMediaType(entry, 'policy.mediaTypes')));
        if (mediaTypes.size !== mediaTypeEntries.length) invalid('policy.mediaTypes must not contain duplicates.');
      }
      const verified = await readVerified(reference, scope);
      if (!classifications.has(verified.reference.classification)) throw new MayuraError('PERMISSION_DENIED', 'Artifact classification is not permitted.');
      if (verified.reference.bytes > maxBytes) throw new MayuraError('LIMIT_EXCEEDED', 'Artifact exceeds the disclosure limit.');
      if (activeMediaType(verified.reference.mediaType) || (mediaTypes !== undefined && !mediaTypes.has(verified.reference.mediaType))) {
        throw new MayuraError('PERMISSION_DENIED', 'Artifact media type is not permitted.');
      }
      const filename = safeDownloadName(verified.reference.filename, verified.reference.digest);
      return Object.freeze({
        body: verified.bytes,
        headers: Object.freeze({
          'Content-Disposition': `attachment; filename="${filename}"`,
          'Content-Length': String(verified.reference.bytes),
          'Content-Type': verified.reference.mediaType,
          'X-Content-Type-Options': 'nosniff' as const,
        }),
      });
      });
    },

    async audit(references: readonly ArtifactReference[], scope: ArtifactScope, auditOptions: ArtifactAuditOptions): Promise<ArtifactAuditResult> {
      return safeStorage(async () => {
        const referenceEntries = plainArray(references, 'audit references', 128, 1);
        const fields = plainData(auditOptions, 'audit options', new Set(['maxTotalBytes']));
        const maxTotalBytes = fields.get('maxTotalBytes');
        if (typeof maxTotalBytes !== 'number') invalid('maxTotalBytes must be a number.');
        assertPositiveInteger(maxTotalBytes, 'maxTotalBytes');
        const expectedScope = scopeDigest(scope); const validated: ArtifactReference[] = []; const seen = new Set<string>(); let admittedBytes = 0;
        for (const rawReference of referenceEntries) {
          const reference = validateReference(rawReference as ArtifactReference);
          if (reference.scopeDigest !== expectedScope) throw new MayuraError('PERMISSION_DENIED', 'Artifact scope does not match.');
          if (seen.has(reference.referenceDigest)) invalid('audit references must not contain duplicates.');
          seen.add(reference.referenceDigest); admittedBytes += reference.bytes;
          if (!Number.isSafeInteger(admittedBytes) || admittedBytes > maxTotalBytes) throw new MayuraError('LIMIT_EXCEEDED', 'Artifact audit exceeds maxTotalBytes.');
          validated.push(reference);
        }
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
        const fields = plainData(rawOptions, 'reconciliation plan options', new Set([
          'scope', 'retainedReferences', 'authoritativeSetComplete', 'olderThan', 'maxExamined', 'maxDeletes', 'cursor',
        ]));
        if (fields.get('authoritativeSetComplete') !== true) invalid('authoritativeSetComplete must be true.');
        const expectedScope = scopeDigest(fields.get('scope') as ArtifactScope);
        const retainedInput = plainArray(fields.get('retainedReferences'), 'retainedReferences', maxCommittedArtifactsPerScope);
        const retained = new Set<string>();
        for (const rawReference of retainedInput) {
          const reference = validateReference(rawReference as ArtifactReference);
          if (reference.scopeDigest !== expectedScope) throw new MayuraError('PERMISSION_DENIED', 'Retained artifact scope does not match.');
          if (retained.has(reference.referenceDigest)) invalid('retainedReferences must not contain duplicates.');
          retained.add(reference.referenceDigest);
        }
        const olderThan = fields.get('olderThan'); const maxExamined = fields.get('maxExamined'); const maxDeletes = fields.get('maxDeletes');
        if (typeof olderThan !== 'number' || !Number.isSafeInteger(olderThan) || olderThan < 0 || olderThan > clock()) {
          invalid('olderThan must be a past Unix millisecond timestamp.');
        }
        if (typeof maxExamined !== 'number' || typeof maxDeletes !== 'number') invalid('reconciliation limits must be numbers.');
        assertPositiveInteger(maxExamined, 'maxExamined'); assertPositiveInteger(maxDeletes, 'maxDeletes');
        if (maxExamined > 256 || maxDeletes > maxExamined) invalid('reconciliation limits exceed their supported bounds.');
        const rawCursor = fields.get('cursor');
        const cursor = rawCursor === undefined ? undefined : validatedCursor(rawCursor as ArtifactReconciliationCursor, expectedScope);
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
        const fields = plainData(rawOptions, 'backup options', new Set([
          'scope', 'references', 'authoritativeSetComplete', 'maxTotalBytes',
        ]));
        if (fields.get('authoritativeSetComplete') !== true) invalid('authoritativeSetComplete must be true.');
        const rawReferences = plainArray(fields.get('references'), 'backup references', MAX_BACKUP_ARTIFACTS);
        const maxTotalBytes = fields.get('maxTotalBytes');
        if (typeof maxTotalBytes !== 'number') invalid('maxTotalBytes must be a number.');
        assertPositiveInteger(maxTotalBytes, 'maxTotalBytes');
        if (maxTotalBytes > MAX_BACKUP_CONTENT_BYTES) invalid('maxTotalBytes exceeds the backup limit.');
        const expectedScope = scopeDigest(fields.get('scope') as ArtifactScope);
        const references: ArtifactReference[] = []; const referenceDigests = new Set<string>(); let contentBytes = 0;
        for (const rawReference of rawReferences) {
          const reference = validateReference(rawReference as ArtifactReference);
          if (reference.scopeDigest !== expectedScope) throw new MayuraError('PERMISSION_DENIED', 'Backup reference scope does not match.');
          if (reference.expiresAt !== undefined && reference.expiresAt <= clock()) throw new MayuraError('NOT_FOUND', 'Backup contains an unavailable artifact.');
          if (referenceDigests.has(reference.referenceDigest)) invalid('backup references must not contain duplicates.');
          referenceDigests.add(reference.referenceDigest); contentBytes += reference.bytes;
          if (!Number.isSafeInteger(contentBytes) || contentBytes > maxTotalBytes) throw new MayuraError('LIMIT_EXCEEDED', 'Backup exceeds maxTotalBytes.');
          references.push(reference);
        }
        const inventory = await listScopeObjects(expectedScope);
        if (inventory.anomalies > 0) integrity('Artifact scope contains structural anomalies and cannot be backed up.');
        if (inventory.objects.length !== references.length || inventory.objects.some((entry) => !referenceDigests.has(entry.referenceDigest))) {
          throw new MayuraError('CONFLICT', 'Backup references are not the complete authoritative scope set.');
        }
        references.sort((left, right) => left.referenceDigest < right.referenceDigest ? -1 : left.referenceDigest > right.referenceDigest ? 1 : 0);
        const entries = [];
        for (const reference of references) {
          const verified = await readVerified(reference, fields.get('scope') as ArtifactScope);
          entries.push({ reference: verified.reference, content: canonicalBase64(verified.bytes) });
        }
        const payload = JSON.stringify({
          format: 'mayura-artifact-backup-v1', scopeDigest: expectedScope, artifacts: entries,
        });
        const payloadBytes = new TextEncoder().encode(payload);
        const archive = new TextEncoder().encode(JSON.stringify({
          format: 'mayura-artifact-backup-envelope-v1', digest: sha256(payloadBytes), payload,
        }));
        if (archive.byteLength > MAX_BACKUP_ARCHIVE_BYTES) throw new MayuraError('LIMIT_EXCEEDED', 'Encoded backup exceeds the archive limit.');
        return archive;
      }));
    },

    async restore(archive: Uint8Array, rawScope: ArtifactScope, rawOptions: ArtifactRestoreOptions): Promise<ArtifactRestoreResult> {
      return safeStorage(() => withCommitLock(async () => {
        const fields = plainData(rawOptions, 'restore options', new Set(['maxArchiveBytes', 'maxTotalBytes', 'maxArtifacts']));
        const maxArchiveBytes = fields.get('maxArchiveBytes'); const maxTotalBytes = fields.get('maxTotalBytes');
        const maxArtifacts = fields.get('maxArtifacts');
        if (typeof maxArchiveBytes !== 'number' || typeof maxTotalBytes !== 'number' || typeof maxArtifacts !== 'number') {
          invalid('restore limits must be numbers.');
        }
        assertPositiveInteger(maxArchiveBytes, 'maxArchiveBytes'); assertPositiveInteger(maxTotalBytes, 'maxTotalBytes');
        assertPositiveInteger(maxArtifacts, 'maxArtifacts');
        if (maxArchiveBytes > MAX_BACKUP_ARCHIVE_BYTES || maxTotalBytes > MAX_BACKUP_CONTENT_BYTES || maxArtifacts > MAX_BACKUP_ARTIFACTS) {
          invalid('restore limits exceed the supported bounds.');
        }
        if (!(archive instanceof Uint8Array) || (typeof SharedArrayBuffer !== 'undefined' && archive.buffer instanceof SharedArrayBuffer)) {
          invalid('archive must be an unshared Uint8Array.');
        }
        if (archive.byteLength > maxArchiveBytes) throw new MayuraError('LIMIT_EXCEEDED', 'Backup exceeds maxArchiveBytes.');
        let envelopeValue: unknown;
        try { envelopeValue = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(new Uint8Array(archive))); }
        catch { integrity('Backup envelope is not valid UTF-8 JSON.'); }
        const envelope = plainData(envelopeValue, 'backup envelope', new Set(['format', 'digest', 'payload']));
        const digest = envelope.get('digest');
        if (envelope.get('format') !== 'mayura-artifact-backup-envelope-v1' || typeof digest !== 'string' || !DIGEST.test(digest)) {
          integrity('Backup envelope identity is invalid.');
        }
        const payloadText = envelope.get('payload');
        if (typeof payloadText !== 'string') integrity('Backup payload must be encoded JSON text.');
        const payloadBytes = new TextEncoder().encode(payloadText);
        if (payloadBytes.byteLength > maxArchiveBytes || sha256(payloadBytes) !== digest) integrity('Backup payload digest does not match.');
        let payloadValue: unknown;
        try { payloadValue = JSON.parse(payloadText); }
        catch { integrity('Backup payload is not valid JSON.'); }
        const payload = plainData(payloadValue, 'backup payload', new Set(['format', 'scopeDigest', 'artifacts']));
        const expectedScope = scopeDigest(rawScope); const payloadScope = payload.get('scopeDigest');
        if (payload.get('format') !== 'mayura-artifact-backup-v1' || typeof payloadScope !== 'string' || !DIGEST.test(payloadScope)) {
          integrity('Backup payload identity is invalid.');
        }
        if (payloadScope !== expectedScope) throw new MayuraError('PERMISSION_DENIED', 'Backup scope does not match the restore scope.');
        const rawEntries = plainArray(payload.get('artifacts'), 'backup artifacts', MAX_BACKUP_ARTIFACTS);
        if (rawEntries.length > maxArtifacts) throw new MayuraError('LIMIT_EXCEEDED', 'Backup exceeds maxArtifacts.');
        const entries: BackupEntry[] = []; const references = new Map<string, ArtifactReference>(); let contentBytes = 0; let previous = '';
        for (const rawEntry of rawEntries) {
          const entry = plainData(rawEntry, 'backup artifact', new Set(['reference', 'content']));
          const reference = validateReference(entry.get('reference') as ArtifactReference);
          if (reference.scopeDigest !== expectedScope) throw new MayuraError('PERMISSION_DENIED', 'Backup artifact scope does not match.');
          if (reference.referenceDigest <= previous || references.has(reference.referenceDigest)) integrity('Backup artifacts are not uniquely sorted.');
          if (reference.expiresAt !== undefined && reference.expiresAt <= clock()) throw new MayuraError('NOT_FOUND', 'Backup contains an unavailable artifact.');
          const content = decodeBase64(entry.get('content'), 'backup artifact content', options.maxArtifactBytes);
          if (content.byteLength !== reference.bytes || sha256(content) !== reference.digest) integrity('Backup artifact content failed integrity verification.');
          contentBytes += content.byteLength;
          if (!Number.isSafeInteger(contentBytes) || contentBytes > maxTotalBytes) throw new MayuraError('LIMIT_EXCEEDED', 'Backup content exceeds maxTotalBytes.');
          previous = reference.referenceDigest; references.set(reference.referenceDigest, reference); entries.push({ reference, content });
        }
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
      const fields = plainData(reconciliation, 'reconciliation options', new Set(['olderThan', 'maxDeletes']));
      const olderThan = fields.get('olderThan');
      const maxDeletes = fields.get('maxDeletes');
      if (typeof olderThan !== 'number' || !Number.isSafeInteger(olderThan) || olderThan < 0 || olderThan > clock()) {
        invalid('olderThan must be a past Unix millisecond timestamp.');
      }
      if (typeof maxDeletes !== 'number') invalid('maxDeletes must be a number.');
      assertPositiveInteger(maxDeletes, 'maxDeletes');
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
