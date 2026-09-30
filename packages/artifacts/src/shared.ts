// Artifact identity, validation and the pure parts of every operation, shared by the local store and the file store
// store. Nothing here touches Node.js: hashing is core's portable SHA-256, and base64 does not use Buffer.
import { MayuraError, assertPositiveInteger } from '@mayura/core';
import { sha256Hex } from '@mayura/core/host';
import type {
  ArtifactClassification, ArtifactDisclosure, ArtifactReference, ArtifactReconciliationCursor, ArtifactScope, StageArtifactInput,
} from './contracts.js';

export const DIGEST = /^sha256:[0-9a-f]{64}$/u;
const MEDIA_TYPE = /^[a-z0-9][a-z0-9!#$&^_.+-]{0,62}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,62}$/u;
export const CLASSIFICATIONS = new Set<ArtifactClassification>(['public', 'internal', 'confidential', 'restricted']);
export const MAX_BUFFERED_ARTIFACT_BYTES = 64 * 1_024 * 1_024;
export const MAX_STAGED_ARTIFACTS = 4_096;
export const MAX_COMMITTED_ARTIFACTS_PER_SCOPE = 65_536;
export const MAX_BACKUP_ARTIFACTS = 256;
export const MAX_BACKUP_CONTENT_BYTES = 64 * 1_024 * 1_024;
export const MAX_BACKUP_ARCHIVE_BYTES = 96 * 1_024 * 1_024;

export type Digest = `sha256:${string}`;

export function sha256(value: Uint8Array | string): Digest {
  return `sha256:${sha256Hex(value)}`;
}

export function canonicalBase64(value: Uint8Array): string {
  let binary = '';
  for (let offset = 0; offset < value.byteLength; offset += 0x8000) binary += String.fromCharCode(...value.subarray(offset, offset + 0x8000));
  return btoa(binary);
}

export function decodeBase64(value: unknown, field: string, maximum: number): Uint8Array {
  if (typeof value !== 'string' || value.length > Math.ceil(maximum / 3) * 4 + 4 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(value)) invalid(`${field} is not canonical base64.`);
  const binary = atob(value); const decoded = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) decoded[index] = binary.charCodeAt(index);
  if (decoded.byteLength > maximum || canonicalBase64(decoded) !== value) invalid(`${field} is not canonical base64.`);
  return decoded;
}

function stableScope(scope: ArtifactScope): { readonly principalId: string; readonly projectId: string } {
  const fields = plainData(scope, 'scope', new Set(['principalId', 'projectId']));
  return Object.freeze({ principalId: boundedIdentity(fields.get('principalId'), 'scope.principalId'), projectId: boundedIdentity(fields.get('projectId'), 'scope.projectId') });
}

/** The same digest the store used when this field was called tenantId, so artifacts stored earlier stay reachable. */
export function scopeDigest(scope: ArtifactScope): Digest {
  const value = stableScope(scope);
  return sha256(JSON.stringify([value.principalId, value.projectId]));
}

function boundedIdentity(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 256 || /[\u0000-\u001f\u007f]/u.test(value)) {
    invalid(`${field} must be a non-empty bounded string without control characters.`);
  }
  return value.normalize('NFC');
}

export function normalizedMediaType(value: unknown, field = 'mediaType'): string {
  if (typeof value !== 'string') invalid(`${field} must be a registered media type without parameters.`);
  const normalized = value.toLowerCase();
  if (!MEDIA_TYPE.test(normalized)) invalid(`${field} must be a registered media type without parameters.`);
  return normalized;
}

export function normalizedClassification(value: unknown): ArtifactClassification {
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

export function invalid(message: string): never {
  throw new MayuraError('INVALID_INPUT', message);
}

export function plainData(value: unknown, field: string, allowed: ReadonlySet<string>): ReadonlyMap<string, unknown> {
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

export function plainArray(value: unknown, field: string, maximum: number, minimum = 0): readonly unknown[] {
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

export function integrity(message = 'Artifact integrity verification failed.'): never {
  throw new MayuraError('INTEGRITY_VIOLATION', message);
}

export function hasOwn(value: object, key: PropertyKey): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

export function validateReference(value: ArtifactReference): ArtifactReference {
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
  const expected = makeReference(referenceScopeDigest as Digest, digest as Digest, bytes as number, mediaType, classification, filename, expiresAt as number | undefined);
  if (suppliedReferenceDigest !== expected.referenceDigest) integrity('Artifact reference metadata failed integrity verification.');
  return expected;
}

/** The frozen reference binding a committed artifact's scope, content and metadata together. */
export function makeReference(scope: Digest, digest: Digest, bytes: number, mediaType: string, classification: ArtifactClassification,
  filename: string | undefined, expiresAt: number | undefined): ArtifactReference {
  return Object.freeze({
    format: 'mayura-artifact-v1' as const,
    scopeDigest: scope,
    referenceDigest: sha256(JSON.stringify(['mayura-artifact-v1', scope, digest, bytes, mediaType, classification, filename ?? null, expiresAt ?? null])),
    digest, bytes, mediaType, classification,
    ...(filename === undefined ? {} : { filename }),
    ...(expiresAt === undefined ? {} : { expiresAt }),
  });
}

export function validatedCursor(value: ArtifactReconciliationCursor, expectedScope: Digest): ArtifactReconciliationCursor {
  const fields = plainData(value, 'reconciliation cursor', new Set(['format', 'scopeDigest', 'after']));
  const cursorScope = fields.get('scopeDigest'); const after = fields.get('after');
  if (fields.get('format') !== 'mayura-artifact-reconciliation-cursor-v1' || typeof cursorScope !== 'string' ||
    !DIGEST.test(cursorScope) || typeof after !== 'string' || !DIGEST.test(after)) invalid('reconciliation cursor is invalid.');
  if (cursorScope !== expectedScope) throw new MayuraError('PERMISSION_DENIED', 'Reconciliation cursor scope does not match.');
  return Object.freeze({ format: 'mayura-artifact-reconciliation-cursor-v1', scopeDigest: cursorScope as Digest, after: after as Digest });
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

/** A stage request, validated, with its content copied and digested. */
export interface ParsedStage {
  readonly bytes: Uint8Array;
  readonly digest: Digest;
  readonly scopeDigest: Digest;
  readonly mediaType: string;
  readonly classification: ArtifactClassification;
  readonly filename?: string;
  readonly expiresAt?: number;
}
export function parseStage(input: StageArtifactInput, maxArtifactBytes: number, now: number): ParsedStage {
  const fields = plainData(input, 'artifact input', new Set(['scope', 'content', 'mediaType', 'classification', 'filename', 'expiresAt']));
  const content = fields.get('content');
  if (!(content instanceof Uint8Array)) invalid('content must be a Uint8Array.');
  if (typeof SharedArrayBuffer !== 'undefined' && content.buffer instanceof SharedArrayBuffer) invalid('content must not use shared memory.');
  if (content.byteLength > maxArtifactBytes) throw new MayuraError('LIMIT_EXCEEDED', 'Artifact exceeds maxArtifactBytes.');
  const bytes = new Uint8Array(content);
  const filename = normalizedFilename(fields.get('filename'));
  const expiresAt = normalizedExpiry(fields.get('expiresAt'), now);
  return { bytes, digest: sha256(bytes), scopeDigest: scopeDigest(fields.get('scope') as ArtifactScope), mediaType: normalizedMediaType(fields.get('mediaType')),
    classification: normalizedClassification(fields.get('classification')), ...(filename === undefined ? {} : { filename }), ...(expiresAt === undefined ? {} : { expiresAt }) };
}

/**
 * A disclosure policy, validated before anything is read: returns the function that turns verified bytes into a
 * download, allowed by classification and size, and never active markup.
 */
export function disclosurePolicy(policy: unknown): (reference: ArtifactReference, bytes: Uint8Array) => ArtifactDisclosure {
  const fields = plainData(policy, 'disclosure policy', new Set(['classifications', 'maxBytes', 'mediaTypes']));
  const maxBytes = fields.get('maxBytes');
  if (typeof maxBytes !== 'number') invalid('policy.maxBytes must be a number.');
  assertPositiveInteger(maxBytes, 'policy.maxBytes');
  const classificationEntries = plainArray(fields.get('classifications'), 'policy.classifications', CLASSIFICATIONS.size, 1);
  const classifications = new Set(classificationEntries.map(normalizedClassification));
  if (classifications.size !== classificationEntries.length) invalid('policy.classifications must not contain duplicates.');
  let mediaTypes: Set<string> | undefined;
  const requestedMediaTypes = fields.get('mediaTypes');
  if (requestedMediaTypes !== undefined) {
    const mediaTypeEntries = plainArray(requestedMediaTypes, 'policy.mediaTypes', 64, 1);
    mediaTypes = new Set(mediaTypeEntries.map((entry) => normalizedMediaType(entry, 'policy.mediaTypes')));
    if (mediaTypes.size !== mediaTypeEntries.length) invalid('policy.mediaTypes must not contain duplicates.');
  }
  return (reference, bytes) => {
    if (!classifications.has(reference.classification)) throw new MayuraError('PERMISSION_DENIED', 'Artifact classification is not permitted.');
    if (reference.bytes > maxBytes) throw new MayuraError('LIMIT_EXCEEDED', 'Artifact exceeds the disclosure limit.');
    if (activeMediaType(reference.mediaType) || (mediaTypes !== undefined && !mediaTypes.has(reference.mediaType))) {
      throw new MayuraError('PERMISSION_DENIED', 'Artifact media type is not permitted.');
    }
    const filename = safeDownloadName(reference.filename, reference.digest);
    return Object.freeze({
      body: bytes,
      headers: Object.freeze({
        'Content-Disposition': `attachment; filename="${filename}"`,
        'Content-Length': String(reference.bytes),
        'Content-Type': reference.mediaType,
        'X-Content-Type-Options': 'nosniff' as const,
      }),
    });
  };
}

/** An audit request, validated: every reference in the scope, no duplicates, within the byte budget. */
export function parseAudit(references: unknown, scope: ArtifactScope, auditOptions: unknown): { readonly references: readonly ArtifactReference[]; readonly admittedBytes: number } {
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
  return { references: validated, admittedBytes };
}

/** A reconciliation plan request, validated. */
export interface ParsedPlan {
  readonly scopeDigest: Digest;
  readonly retained: ReadonlySet<string>;
  readonly olderThan: number;
  readonly maxExamined: number;
  readonly maxDeletes: number;
  readonly cursor?: ArtifactReconciliationCursor;
}
export function parsePlan(rawOptions: unknown, now: number, maxCommittedArtifactsPerScope: number): ParsedPlan {
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
  if (typeof olderThan !== 'number' || !Number.isSafeInteger(olderThan) || olderThan < 0 || olderThan > now) {
    invalid('olderThan must be a past Unix millisecond timestamp.');
  }
  if (typeof maxExamined !== 'number' || typeof maxDeletes !== 'number') invalid('reconciliation limits must be numbers.');
  assertPositiveInteger(maxExamined, 'maxExamined'); assertPositiveInteger(maxDeletes, 'maxDeletes');
  if (maxExamined > 256 || maxDeletes > maxExamined) invalid('reconciliation limits exceed their supported bounds.');
  const rawCursor = fields.get('cursor');
  const cursor = rawCursor === undefined ? undefined : validatedCursor(rawCursor as ArtifactReconciliationCursor, expectedScope);
  return { scopeDigest: expectedScope, retained, olderThan, maxExamined, maxDeletes, ...(cursor === undefined ? {} : { cursor }) };
}

/** A backup request, validated: the complete set of unexpired references in one scope, within the byte budget, sorted. */
export function parseBackup(rawOptions: unknown, now: number): { readonly scope: ArtifactScope; readonly scopeDigest: Digest; readonly references: readonly ArtifactReference[]; readonly referenceDigests: ReadonlySet<string> } {
  const fields = plainData(rawOptions, 'backup options', new Set(['scope', 'references', 'authoritativeSetComplete', 'maxTotalBytes']));
  if (fields.get('authoritativeSetComplete') !== true) invalid('authoritativeSetComplete must be true.');
  const rawReferences = plainArray(fields.get('references'), 'backup references', MAX_BACKUP_ARTIFACTS);
  const maxTotalBytes = fields.get('maxTotalBytes');
  if (typeof maxTotalBytes !== 'number') invalid('maxTotalBytes must be a number.');
  assertPositiveInteger(maxTotalBytes, 'maxTotalBytes');
  if (maxTotalBytes > MAX_BACKUP_CONTENT_BYTES) invalid('maxTotalBytes exceeds the backup limit.');
  const scope = fields.get('scope') as ArtifactScope;
  const expectedScope = scopeDigest(scope);
  const references: ArtifactReference[] = []; const referenceDigests = new Set<string>(); let contentBytes = 0;
  for (const rawReference of rawReferences) {
    const reference = validateReference(rawReference as ArtifactReference);
    if (reference.scopeDigest !== expectedScope) throw new MayuraError('PERMISSION_DENIED', 'Backup reference scope does not match.');
    if (reference.expiresAt !== undefined && reference.expiresAt <= now) throw new MayuraError('NOT_FOUND', 'Backup contains an unavailable artifact.');
    if (referenceDigests.has(reference.referenceDigest)) invalid('backup references must not contain duplicates.');
    referenceDigests.add(reference.referenceDigest); contentBytes += reference.bytes;
    if (!Number.isSafeInteger(contentBytes) || contentBytes > maxTotalBytes) throw new MayuraError('LIMIT_EXCEEDED', 'Backup exceeds maxTotalBytes.');
    references.push(reference);
  }
  references.sort((left, right) => left.referenceDigest < right.referenceDigest ? -1 : left.referenceDigest > right.referenceDigest ? 1 : 0);
  return { scope, scopeDigest: expectedScope, references, referenceDigests };
}

/** The backup archive of verified entries, in reference order: an envelope with the digest of its payload. */
export function encodeBackup(expectedScope: Digest, entries: readonly { readonly reference: ArtifactReference; readonly bytes: Uint8Array }[]): Uint8Array {
  const payload = JSON.stringify({
    format: 'mayura-artifact-backup-v1', scopeDigest: expectedScope,
    artifacts: entries.map(entry => ({ reference: entry.reference, content: canonicalBase64(entry.bytes) })),
  });
  const payloadBytes = new TextEncoder().encode(payload);
  const archive = new TextEncoder().encode(JSON.stringify({ format: 'mayura-artifact-backup-envelope-v1', digest: sha256(payloadBytes), payload }));
  if (archive.byteLength > MAX_BACKUP_ARCHIVE_BYTES) throw new MayuraError('LIMIT_EXCEEDED', 'Encoded backup exceeds the archive limit.');
  return archive;
}

/** A backup archive to restore, verified entry by entry before anything is written. */
export interface ParsedRestore {
  readonly scopeDigest: Digest;
  readonly entries: readonly { readonly reference: ArtifactReference; readonly content: Uint8Array }[];
  readonly references: ReadonlyMap<string, ArtifactReference>;
  readonly contentBytes: number;
}
export function parseRestore(archive: unknown, rawScope: ArtifactScope, rawOptions: unknown, maxArtifactBytes: number, now: number): ParsedRestore {
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
  const entries: { reference: ArtifactReference; content: Uint8Array }[] = []; const references = new Map<string, ArtifactReference>(); let contentBytes = 0; let previous = '';
  for (const rawEntry of rawEntries) {
    const entry = plainData(rawEntry, 'backup artifact', new Set(['reference', 'content']));
    const reference = validateReference(entry.get('reference') as ArtifactReference);
    if (reference.scopeDigest !== expectedScope) throw new MayuraError('PERMISSION_DENIED', 'Backup artifact scope does not match.');
    if (reference.referenceDigest <= previous || references.has(reference.referenceDigest)) integrity('Backup artifacts are not uniquely sorted.');
    if (reference.expiresAt !== undefined && reference.expiresAt <= now) throw new MayuraError('NOT_FOUND', 'Backup contains an unavailable artifact.');
    const content = decodeBase64(entry.get('content'), 'backup artifact content', maxArtifactBytes);
    if (content.byteLength !== reference.bytes || sha256(content) !== reference.digest) integrity('Backup artifact content failed integrity verification.');
    contentBytes += content.byteLength;
    if (!Number.isSafeInteger(contentBytes) || contentBytes > maxTotalBytes) throw new MayuraError('LIMIT_EXCEEDED', 'Backup content exceeds maxTotalBytes.');
    previous = reference.referenceDigest; references.set(reference.referenceDigest, reference); entries.push({ reference, content });
  }
  return { scopeDigest: expectedScope, entries, references, contentBytes };
}

/** A staging cleanup request, validated. */
export function parseStagingReconciliation(reconciliation: unknown, now: number): { readonly olderThan: number; readonly maxDeletes: number } {
  const fields = plainData(reconciliation, 'reconciliation options', new Set(['olderThan', 'maxDeletes']));
  const olderThan = fields.get('olderThan');
  const maxDeletes = fields.get('maxDeletes');
  if (typeof olderThan !== 'number' || !Number.isSafeInteger(olderThan) || olderThan < 0 || olderThan > now) {
    invalid('olderThan must be a past Unix millisecond timestamp.');
  }
  if (typeof maxDeletes !== 'number') invalid('maxDeletes must be a number.');
  assertPositiveInteger(maxDeletes, 'maxDeletes');
  return { olderThan, maxDeletes };
}
