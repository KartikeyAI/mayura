import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, readdir, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { MayuraError, assertPositiveInteger } from '@mayura/core';
import type {
  ArtifactClassification,
  ArtifactDisclosure,
  ArtifactDisclosurePolicy,
  ArtifactReference,
  ArtifactScope,
  LocalArtifactStore,
  LocalArtifactStoreOptions,
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

interface StageRecord {
  readonly handle: StagedArtifact;
  readonly path: string;
  readonly scopeDigest: `sha256:${string}`;
  readonly mediaType: string;
  readonly classification: ArtifactClassification;
  readonly filename?: string;
  readonly expiresAt?: number;
}

function sha256(value: Uint8Array | string): `sha256:${string}` {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
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

function objectPath(objectsDirectory: string, reference: ArtifactReference): string {
  const scope = reference.scopeDigest.slice(7);
  const digest = reference.referenceDigest.slice(7);
  return join(objectsDirectory, scope, digest.slice(0, 2), digest);
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
  if (options.clock !== undefined && typeof options.clock !== 'function') throw new MayuraError('INVALID_CONFIG', 'clock must be a function.');

  const root = resolve(options.rootDirectory);
  const stagingDirectory = join(root, 'staging');
  const objectsDirectory = join(root, 'objects');
  const stages = new WeakMap<object, StageRecord>();
  const activeStageIds = new Set<string>();
  const configuredClock = options.clock ?? Date.now;
  let initialized: Promise<void> | undefined;
  let stageTail = Promise.resolve();

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

  const initialize = (): Promise<void> => {
    initialized ??= Promise.all([
      mkdir(stagingDirectory, { recursive: true, mode: 0o700 }),
      mkdir(objectsDirectory, { recursive: true, mode: 0o700 }),
    ]).then(() => undefined);
    return initialized;
  };

  const readVerified = async (rawReference: ArtifactReference, rawScope: ArtifactScope): Promise<{ reference: ArtifactReference; bytes: Uint8Array }> => {
    await initialize();
    const reference = validateReference(rawReference);
    if (reference.scopeDigest !== scopeDigest(rawScope)) throw new MayuraError('PERMISSION_DENIED', 'Artifact scope does not match.');
    if (reference.expiresAt !== undefined && reference.expiresAt <= clock()) throw new MayuraError('NOT_FOUND', 'Artifact is unavailable.');
    if (reference.bytes > options.maxArtifactBytes) integrity();
    const path = objectPath(objectsDirectory, reference);
    if (!(await regularFile(path))) throw new MayuraError('NOT_FOUND', 'Artifact is unavailable.');
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
      await writeFile(path, bytes, { flag: 'wx', mode: 0o600 });
      const handle = Object.freeze({ format: 'mayura-staged-artifact-v1' as const, stageId, digest, bytes: bytes.byteLength });
      stages.set(handle, {
        handle, path, scopeDigest: normalizedScopeDigest, mediaType, classification,
        ...(filename === undefined ? {} : { filename }),
        ...(expiresAt === undefined ? {} : { expiresAt }),
      });
      activeStageIds.add(stageId);
      return handle;
      }));
    },

    async commit(staged: StagedArtifact): Promise<ArtifactReference> {
      return safeStorage(async () => {
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
      const destination = objectPath(objectsDirectory, reference);
      await mkdir(resolve(destination, '..'), { recursive: true, mode: 0o700 });
      if (await regularFile(destination)) {
        const existing = new Uint8Array(await readFile(destination));
        if (existing.byteLength !== reference.bytes || sha256(existing) !== reference.digest) integrity('Committed artifact content conflicts with its digest.');
        await unlink(record.path);
      } else {
        await rename(record.path, destination);
      }
      stages.delete(staged);
      activeStageIds.delete(record.handle.stageId);
      return reference;
      });
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
      if (!Array.isArray(requestedClassifications) || requestedClassifications.length === 0 || requestedClassifications.length > CLASSIFICATIONS.size) {
        invalid('policy.classifications must be a bounded non-empty array.');
      }
      const classifications = new Set(requestedClassifications.map(normalizedClassification));
      if (classifications.size !== requestedClassifications.length) invalid('policy.classifications must not contain duplicates.');
      let mediaTypes: Set<string> | undefined;
      const requestedMediaTypes = fields.get('mediaTypes');
      if (requestedMediaTypes !== undefined) {
        if (!Array.isArray(requestedMediaTypes) || requestedMediaTypes.length === 0 || requestedMediaTypes.length > 64) invalid('policy.mediaTypes must be a bounded non-empty array.');
        mediaTypes = new Set(requestedMediaTypes.map((entry) => normalizedMediaType(entry, 'policy.mediaTypes')));
        if (mediaTypes.size !== requestedMediaTypes.length) invalid('policy.mediaTypes must not contain duplicates.');
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

    async delete(reference: ArtifactReference, scope: ArtifactScope): Promise<boolean> {
      return safeStorage(async () => {
      await initialize();
      const validated = validateReference(reference);
      if (validated.scopeDigest !== scopeDigest(scope)) throw new MayuraError('PERMISSION_DENIED', 'Artifact scope does not match.');
      const path = objectPath(objectsDirectory, validated);
      if (!(await regularFile(path))) return false;
      await unlink(path);
      return true;
      });
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
