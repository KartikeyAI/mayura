/**
 * Additive, read-only cleanup reconciliation for the seven frozen production phases.
 * Provider and durable-storage capabilities are supplied explicitly. This module
 * imports no provider SDK, credential reader, filesystem, SQL engine or network.
 * A complete join describes retained observations; it grants no qualification.
 */
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {productionHoldoutHashV1 as hash, sealProductionHoldoutReviewV1 as seal}
  from './production-holdout-review-v1.mjs';

export const MODAL_PRODUCTION_CLEANUP_AUDIT_PERMISSION_V1 = 'rag:audit:modal-production-cleanup';
export const MODAL_PRODUCTION_CLEANUP_AUDIT_PHASES_V1 = Object.freeze([
  'document-preparation', 'semantic40', 'nomic120', 'native600', 'recovery7', 'scope-security', 'root-cleanup-audit',
]);
export const MODAL_PRODUCTION_CLEANUP_AUDIT_LIMITS_V1 = Object.freeze({
  maximumProviderReads: 64, maximumReadMs: 15000, maximumAuditMs: 90000,
  maximumResponseBytes: 1048576, maximumTotalResponseBytes: 16777216,
  maximumArchiveFileBytes: 2147483648, maximumArchiveReadBytes: 8589934592, maximumArchiveChunkBytes: 65536,
  automaticRetries: 0, automaticReplacements: 0,
});
const PHASES = MODAL_PRODUCTION_CLEANUP_AUDIT_PHASES_V1;
const MODEL_PHASES = ['document-preparation', 'semantic40', 'nomic120', 'recovery7', 'scope-security'];
const ROLES = ['sqlite', 'wal', 'requests', 'raw-acks'];
const FALSE_AUTHORITY = {executionAllowed: false, provisioningAllowed: false, spendingAllowed: false,
  qualificationAllowed: false, productionReady: false, ragStatus: 'experimental'};
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const jsonBytes = value => new TextEncoder().encode(JSON.stringify(value));
const plain = value => seal({value}).value;
const checked = value => {const copy = plain(value), {digest, ...body} = copy;
  assert.equal(hash(body), digest, 'PRODUCTION_CLEANUP_SEAL_CHANGED'); return copy;};
const hex = value => assert.match(value ?? '', /^[a-f0-9]{64}$/u, 'PRODUCTION_CLEANUP_PIN_REQUIRED');
const integer = value => assert.ok(Number.isSafeInteger(value) && value >= 0, 'PRODUCTION_CLEANUP_INTEGER_REQUIRED');
const positive = value => {integer(value); assert.ok(value > 0, 'PRODUCTION_CLEANUP_POSITIVE_REQUIRED');};
const exact = (value, keys) => assert.deepEqual(Object.keys(value).sort(), [...keys].sort(), 'PRODUCTION_CLEANUP_FIELDS_CHANGED');
const path = value => {assert.equal(typeof value, 'string'); assert.ok(value.length <= 512 &&
  /^\.artifacts\/[A-Za-z0-9._/-]+$/u.test(value) && !value.split('/').some(part =>
    !part || ['.', '..'].includes(part) || /^\.env(?:\.|$)/u.test(part) || /credential|token|secret|auth\.toml/iu.test(part)),
  'PRODUCTION_CLEANUP_PUBLIC_ARCHIVE_PATH_REQUIRED');};
const pin = value => {exact(value, ['path', 'bytes', 'sha256']); path(value.path); integer(value.bytes); hex(value.sha256);};
const sourcePin = value => {exact(value, ['path', 'bytes', 'sha256']);
  assert.equal(typeof value.path, 'string'); assert.ok(value.path.length <= 512 &&
    /^(?:scripts|deploy|\.artifacts)\/[A-Za-z0-9._/-]+$/u.test(value.path) &&
    !value.path.split('/').some(part => !part || ['.', '..'].includes(part) || /^\.env(?:\.|$)/u.test(part)),
    'PRODUCTION_CLEANUP_PUBLIC_SOURCE_PATH_REQUIRED'); integer(value.bytes); hex(value.sha256);};
const modalId = (value, prefix) => assert.match(value ?? '', new RegExp('^' + prefix + '-[A-Za-z0-9_-]{1,128}$', 'u'));
const indexName = value => assert.match(value ?? '', /^[a-z0-9](?:[a-z0-9-]{0,43}[a-z0-9])?$/u);
const active = (permissions, signal) => {assert.ok(Array.isArray(permissions?.allow) &&
  permissions.allow.includes(MODAL_PRODUCTION_CLEANUP_AUDIT_PERMISSION_V1), 'PRODUCTION_CLEANUP_PERMISSION_DENIED');
  assert.ok(signal instanceof AbortSignal, 'PRODUCTION_CLEANUP_SIGNAL_REQUIRED'); signal.throwIfAborted();};
const unique = values => assert.equal(new Set(values).size, values.length, 'PRODUCTION_CLEANUP_DUPLICATE_IDENTITY');

/**
 * Freeze exact owners and original/archive byte pins before any observation.
 * Critical files remain separate: references never authorize moving or deleting
 * them. Missing WALs must be represented by a separately retained absence receipt
 * as the WAL reference, rather than silently omitted from the retention inventory.
 */
export function buildModalProductionCleanupAuditPlanV1(input, {permissions, signal} = {}) {
  active(permissions, signal); input = plain(input);
  exact(input, ['auditScope', 'registrationDigest', 'campaignDigest', 'collectorBinding', 'phaseBindings', 'preexisting', 'limits']);
  path(input.auditScope); hex(input.registrationDigest); hex(input.campaignDigest);
  exact(input.collectorBinding, ['sourcePin', 'transportProfileDigest', 'modalWorkspaceId', 'pineconeProjectId']);
  sourcePin(input.collectorBinding.sourcePin); hex(input.collectorBinding.transportProfileDigest);
  for (const id of [input.collectorBinding.modalWorkspaceId, input.collectorBinding.pineconeProjectId])
    assert.ok(typeof id === 'string' && /^[A-Za-z0-9_-]{1,160}$/u.test(id));
  exact(input.limits, Object.keys(MODAL_PRODUCTION_CLEANUP_AUDIT_LIMITS_V1));
  for (const [key, ceiling] of Object.entries(MODAL_PRODUCTION_CLEANUP_AUDIT_LIMITS_V1)) {
    integer(input.limits[key]); assert.ok(input.limits[key] <= ceiling, 'PRODUCTION_CLEANUP_BOUND_INCREASED');
    if (!key.startsWith('automatic')) positive(input.limits[key]);
  }
  assert.ok(input.limits.maximumReadMs <= input.limits.maximumAuditMs);
  assert.ok(input.limits.maximumResponseBytes <= input.limits.maximumTotalResponseBytes);
  assert.ok(input.limits.maximumArchiveFileBytes <= input.limits.maximumArchiveReadBytes);
  assert.ok(input.limits.maximumArchiveChunkBytes <= input.limits.maximumArchiveFileBytes);
  assert.ok(Array.isArray(input.phaseBindings) && input.phaseBindings.length === 7, 'PRODUCTION_CLEANUP_SEVEN_PHASES_REQUIRED');
  assert.deepEqual(input.phaseBindings.map(row => row.phaseId), PHASES, 'PRODUCTION_CLEANUP_PHASE_POPULATION_CHANGED');
  const sandboxIds = [], appIds = [], indexNames = [], readPins = new Map();
  for (const row of input.phaseBindings) {
    exact(row, ['phaseId', 'runDigest', 'ownedSandboxIds', 'ownedAppIds', 'ownedIndexNames', 'originalRetentionRefs']);
    hex(row.runDigest);
    assert.ok(Array.isArray(row.ownedSandboxIds) && row.ownedSandboxIds.length ===
      (MODEL_PHASES.includes(row.phaseId) ? 2 : 1), 'PRODUCTION_CLEANUP_COMPLETE_SANDBOX_INVENTORY_REQUIRED');
    assert.ok(Array.isArray(row.ownedAppIds) && row.ownedAppIds.length === 1);
    assert.ok(Array.isArray(row.ownedIndexNames) && row.ownedIndexNames.length <= 4);
    row.ownedSandboxIds.forEach(id => modalId(id, 'sb')); row.ownedAppIds.forEach(id => modalId(id, 'ap'));
    row.ownedIndexNames.forEach(indexName);
    sandboxIds.push(...row.ownedSandboxIds); appIds.push(...row.ownedAppIds); indexNames.push(...row.ownedIndexNames);
    assert.ok(Array.isArray(row.originalRetentionRefs) && row.originalRetentionRefs.length === 4);
    assert.deepEqual(row.originalRetentionRefs.map(ref => ref.role).sort(), [...ROLES].sort(), 'PRODUCTION_CLEANUP_CRITICAL_RETENTION_MISSING');
    for (const ref of row.originalRetentionRefs) {
      exact(ref, ['role', 'sourcePin', 'archivePin']); pin(ref.sourcePin); pin(ref.archivePin);
      assert.notEqual(ref.sourcePin.path, ref.archivePin.path, 'PRODUCTION_CLEANUP_DISTINCT_ARCHIVE_REQUIRED');
      assert.equal(ref.sourcePin.bytes, ref.archivePin.bytes); assert.equal(ref.sourcePin.sha256, ref.archivePin.sha256);
      for (const value of [ref.sourcePin, ref.archivePin]) {
        assert.ok(value.bytes <= input.limits.maximumArchiveFileBytes, 'PRODUCTION_CLEANUP_ARCHIVE_FILE_BOUND');
        const prior = readPins.get(value.path); if (prior) assert.deepEqual(prior, value, 'PRODUCTION_CLEANUP_ARCHIVE_PIN_CONFLICT');
        readPins.set(value.path, value);
      }
    }
  }
  unique(sandboxIds); unique(appIds); unique(indexNames);
  assert.ok([...readPins.values()].reduce((total, value) => total + value.bytes, 0) <= input.limits.maximumArchiveReadBytes,
    'PRODUCTION_CLEANUP_ARCHIVE_TOTAL_BOUND');
  exact(input.preexisting, ['modalApps', 'pineconeIndexes']);
  assert.ok(Array.isArray(input.preexisting.modalApps) && input.preexisting.modalApps.length <= 1000);
  assert.ok(Array.isArray(input.preexisting.pineconeIndexes) && input.preexisting.pineconeIndexes.length <= 1000);
  for (const app of input.preexisting.modalApps) {modalId(app.appId, 'ap'); assert.ok(!appIds.includes(app.appId));}
  for (const index of input.preexisting.pineconeIndexes) {indexName(index.name); assert.ok(!indexNames.includes(index.name));}
  unique(input.preexisting.modalApps.map(row => row.appId)); unique(input.preexisting.pineconeIndexes.map(row => row.name));
  // The inventory and all referenced original bytes are external bindings, not
  // an assertion that a provider or storage system has already been checked.
  return seal({kind: 'modal-production-cleanup-audit-plan-v1', ...input,
    ownedResourceCounts: {sandboxes: sandboxIds.length, apps: appIds.length, indexes: indexNames.length},
    originalArchiveBytesBound: [...readPins.values()].reduce((sum, value) => sum + value.bytes, 0),
    originalLoadQueries: 600, originalLoadGateChanged: false, hostedMutationsAllowed: false,
    retainCriticalBeforeArchive: true, cleanupOnFailureOrCancellation: true, ...FALSE_AUTHORITY});
}

/** Bound a capability even when its implementation ignores cancellation. */
async function bounded(callback, signal) {
  signal.throwIfAborted(); let abort;
  const cancelled = new Promise((_, reject) => {abort = () => reject(Error('PRODUCTION_CLEANUP_CANCELLED'));
    signal.addEventListener('abort', abort, {once: true}); if (signal.aborted) abort();});
  try {return await Promise.race([Promise.resolve().then(() => {signal.throwIfAborted(); return callback();}), cancelled]);}
  finally {signal.removeEventListener('abort', abort);}
}
const bytesOnly = (value, maximum) => {assert.ok(value instanceof Uint8Array, 'PRODUCTION_CLEANUP_RAW_BYTES_REQUIRED');
  assert.ok(value.byteLength <= maximum, 'PRODUCTION_CLEANUP_RAW_BYTE_BOUND'); return new Uint8Array(value);};
const parse = bytes => plain(JSON.parse(new TextDecoder('utf-8', {fatal: true}).decode(bytes)));
const completeCatalog = (value, key) => {assert.ok(Array.isArray(value[key]) && value[key].length <= 10000,
  'PRODUCTION_CLEANUP_COMPLETE_CATALOG_REQUIRED');
  assert.ok(!value.nextToken && !value.nextCursor && !value.nextPageToken && !value.next_token && !value.next_cursor &&
    !value.next_page_token && !value.hasMore && !value.has_more && !value.truncated &&
    !value.pagination?.next && !value.pagination?.nextToken && !value.pagination?.next_cursor,
    'PRODUCTION_CLEANUP_TRUNCATED_CATALOG'); return value[key];};
const samePreexisting = (expected, actual, key) => expected.every(row => {
  const current = actual.find(value => value[key] === row[key]); return current && hash(current) === hash(row);
});

/**
 * Independently reread owners through allowlisted read capabilities. Each read
 * has a write-once, byte-verified before claim and retained raw ACK before it is
 * interpreted. A failed claim is never replayed. Readiness flags from another
 * process, a controller's cleanup flag, and a self-sealed success boolean are
 * not accepted as provider observations.
 *
 * `archive.writeOnce({path, bytes, signal})` must atomically refuse an existing
 * path and durably flush new bytes. `archive.read({pin, signal,
 * maximumChunkBytes})` returns an async iterable of raw chunks. A single small
 * Uint8Array is also accepted. Originals and archives are hashed separately,
 * incrementally; even a two-GiB native-load journal is never buffered here.
 * The provider ports return exact raw JSON response bytes and must be
 * authenticated and independently reviewed outside this module. The returned
 * join explicitly does not claim cryptographic provider authentication.
 */
export async function collectModalProductionCleanupAuditV1({plan: rawPlan, expectedPlanDigest,
  ports, permissions, signal, mode = 'simulation', now = Date.now}) {
  active(permissions, signal); hex(expectedPlanDigest); const plan = checked(rawPlan);
  assert.ok(['live', 'simulation'].includes(mode), 'PRODUCTION_CLEANUP_MODE_REQUIRED');
  assert.equal(plan.digest, expectedPlanDigest); assert.equal(plan.kind, 'modal-production-cleanup-audit-plan-v1');
  // Revalidate the entire frozen plan, including its seven owners and limits.
  const inputKeys = ['auditScope', 'registrationDigest', 'campaignDigest', 'collectorBinding', 'phaseBindings', 'preexisting', 'limits'];
  const rebuilt = buildModalProductionCleanupAuditPlanV1(Object.fromEntries(inputKeys.map(key => [key, plan[key]])), {permissions, signal});
  assert.equal(rebuilt.digest, plan.digest, 'PRODUCTION_CLEANUP_PLAN_FIELDS_CHANGED');
  exact(ports, ['archive', 'modal', 'pinecone']); exact(ports.archive, ['writeOnce', 'read']);
  exact(ports.modal, ['identity', 'sandboxStatus', 'appLifecycle', 'listApps']); exact(ports.pinecone, ['listIndexes']);
  for (const group of Object.values(ports)) for (const method of Object.values(group)) assert.equal(typeof method, 'function');
  assert.equal(typeof now, 'function');
  const startedAtMs = now(); integer(startedAtMs);
  const deadline = AbortSignal.timeout(plan.limits.maximumAuditMs), auditSignal = AbortSignal.any([signal, deadline]);
  let providerReads = 0, responseBytes = 0, archiveReadBytes = 0, previousNow = startedAtMs;
  const readJournal = [], retentionReadbackPins = [], phaseObservations = [];
  let failure = null, uncertainRead = null;
  const clock = () => {const value = now(); integer(value); assert.ok(value >= previousNow, 'PRODUCTION_CLEANUP_CLOCK_CHANGED');
    previousNow = value; assert.ok(value - startedAtMs <= plan.limits.maximumAuditMs, 'PRODUCTION_CLEANUP_TIME_BOUND'); return value;};
  const scoped = () => AbortSignal.any([auditSignal, AbortSignal.timeout(plan.limits.maximumReadMs)]);
  const readPin = async (expected, maximum) => {
    pin(expected); const readSignal = scoped();
    assert.ok(expected.bytes <= maximum, 'PRODUCTION_CLEANUP_ARCHIVE_FILE_BOUND');
    const source = await bounded(() => ports.archive.read({pin: expected, signal: readSignal,
      maximumChunkBytes: plan.limits.maximumArchiveChunkBytes}), readSignal);
    // No original bytes escape this function. Only the digest and byte count
    // survive; the current chunk is released before requesting its successor.
    const stream = source instanceof Uint8Array ? (async function* () {if (source.length) yield source;})() : source;
    assert.equal(typeof stream?.[Symbol.asyncIterator], 'function', 'PRODUCTION_CLEANUP_ARCHIVE_STREAM_REQUIRED');
    const iterator = stream[Symbol.asyncIterator](), digest = createHash('sha256'); let length = 0, exhausted = false;
    try {
      for (;;) {
        const item = await bounded(() => iterator.next(), readSignal);
        if (item.done) {exhausted = true; break;}
        const chunk = bytesOnly(item.value, plan.limits.maximumArchiveChunkBytes);
        assert.ok(chunk.byteLength > 0, 'PRODUCTION_CLEANUP_EMPTY_ARCHIVE_CHUNK');
        length += chunk.byteLength; archiveReadBytes += chunk.byteLength;
        assert.ok(length <= expected.bytes && length <= maximum, 'PRODUCTION_CLEANUP_ARCHIVE_FILE_BOUND');
        assert.ok(archiveReadBytes <= plan.limits.maximumArchiveReadBytes, 'PRODUCTION_CLEANUP_ARCHIVE_TOTAL_BOUND');
        digest.update(chunk); clock();
      }
    } finally {
      // An uncooperative iterator cannot extend the audit after cancellation.
      if (!exhausted && typeof iterator.return === 'function') void Promise.resolve().then(() => iterator.return()).catch(() => {});
    }
    assert.equal(length, expected.bytes); assert.equal(digest.digest('hex'), expected.sha256, 'PRODUCTION_CLEANUP_RETAINED_BYTES_CHANGED');
    clock();
  };
  const retain = async (relativePath, bytes) => {
    const expected = {path: plan.auditScope + '/' + relativePath, bytes: bytes.byteLength, sha256: sha(bytes)};
    path(expected.path); const writeSignal = scoped();
    const stored = plain(await bounded(() => ports.archive.writeOnce({...expected, bytes, signal: writeSignal}), writeSignal));
    assert.deepEqual(stored, expected, 'PRODUCTION_CLEANUP_DURABLE_PIN_CHANGED');
    await readPin(expected, plan.limits.maximumArchiveFileBytes); return expected;
  };
  const readProvider = async (phaseId, method, request, callback) => {
    active(permissions, auditSignal); assert.ok(providerReads < plan.limits.maximumProviderReads, 'PRODUCTION_CLEANUP_CALL_BOUND');
    const remainingBytes = Math.min(plan.limits.maximumResponseBytes, plan.limits.maximumTotalResponseBytes - responseBytes);
    assert.ok(remainingBytes > 0, 'PRODUCTION_CLEANUP_RESPONSE_TOTAL_BOUND');
    const ordinal = providerReads + 1, operationId = String(ordinal).padStart(3, '0');
    const claim = seal({kind: 'modal-production-cleanup-read-before-v1', planDigest: plan.digest, operationId,
      phaseId, method, request, issuedAtMs: clock(), automaticRetries: 0, readOnly: true});
    const beforePin = await retain('reads/' + operationId + '-before.json', jsonBytes(claim));
    active(permissions, auditSignal); const callSignal = scoped();
    const row = {ordinal, phaseId, method, requestDigest: hash(request), beforePin, state: 'claimed', rawPin: null};
    readJournal.push(row); providerReads++; uncertainRead = {phaseId, method, beforePin};
    const raw = await bounded(() => callback({...request, signal: callSignal, retries: 0,
      maximumResponseBytes: remainingBytes}), callSignal);
    assert.ok(raw instanceof Uint8Array, 'PRODUCTION_CLEANUP_RAW_BYTES_REQUIRED');
    // Include bytes already returned by a misbehaving collector in the honest
    // accounting, even though the oversized body cannot be retained or trusted.
    responseBytes += raw.byteLength;
    assert.ok(responseBytes <= plan.limits.maximumTotalResponseBytes, 'PRODUCTION_CLEANUP_RESPONSE_TOTAL_BOUND');
    const bytes = bytesOnly(raw, remainingBytes);
    row.rawPin = await retain('reads/' + operationId + '-raw.bin', bytes);
    const value = parse(bytes); row.state = 'observed'; uncertainRead = null; clock(); return value;
  };
  try {
    // Verify originals and their separate archive copies before the first
    // provider read. Reads are raw bytes: SQL/WAL engines are never opened.
    const seen = new Map();
    for (const phase of plan.phaseBindings) for (const ref of phase.originalRetentionRefs) {
      for (const original of [ref.sourcePin, ref.archivePin]) if (!seen.has(original.path)) {
        await readPin(original, plan.limits.maximumArchiveFileBytes); seen.set(original.path, original);
        retentionReadbackPins.push(original);
      }
    }
    const identity = await readProvider('root-cleanup-audit', 'modal.identity', {}, ports.modal.identity);
    assert.equal(identity.workspaceId, plan.collectorBinding.modalWorkspaceId, 'PRODUCTION_CLEANUP_FOREIGN_WORKSPACE');
    for (const phase of plan.phaseBindings) {
      const sandboxes = [], apps = [];
      for (const sandboxId of phase.ownedSandboxIds) {
        const value = await readProvider(phase.phaseId, 'modal.sandboxStatus', {sandboxId, timeout: 0}, ports.modal.sandboxStatus);
        if (Object.hasOwn(value, 'sandboxId')) assert.equal(value.sandboxId, sandboxId, 'PRODUCTION_CLEANUP_FOREIGN_SANDBOX');
        sandboxes.push({sandboxId, terminal: [1, 2, 3, 4].includes(value.result?.status), status: value.result?.status ?? null});
      }
      for (const appId of phase.ownedAppIds) {
        const value = await readProvider(phase.phaseId, 'modal.appLifecycle', {appId}, ports.modal.appLifecycle);
        if (Object.hasOwn(value, 'appId')) assert.equal(value.appId, appId, 'PRODUCTION_CLEANUP_FOREIGN_APP');
        const stoppedAt = value.lifecycle?.stoppedAt;
        const stoppedAtMs = typeof stoppedAt === 'number' ? stoppedAt : typeof stoppedAt === 'string' ? Date.parse(stoppedAt) : NaN;
        apps.push({appId, stopped: [5, 7].includes(value.lifecycle?.appState) && Number.isFinite(stoppedAtMs) && stoppedAtMs > 0});
      }
      const appCatalog = completeCatalog(await readProvider(phase.phaseId, 'modal.listApps',
        {environmentName: 'main'}, ports.modal.listApps), 'apps');
      const indexCatalog = completeCatalog(await readProvider(phase.phaseId, 'pinecone.listIndexes',
        {projectId: plan.collectorBinding.pineconeProjectId, apiVersion: '2025-10'}, ports.pinecone.listIndexes), 'indexes');
      appCatalog.forEach(row => modalId(row.appId, 'ap')); indexCatalog.forEach(row => indexName(row.name));
      unique(appCatalog.map(row => row.appId)); unique(indexCatalog.map(row => row.name));
      const ownedTaskCounts = apps.map(app => {
        const listed = appCatalog.find(row => row.appId === app.appId);
        return Number.isSafeInteger(listed?.nRunningTasks) && listed.nRunningTasks >= 0 ? listed.nRunningTasks : null;
      });
      const ownedTasksRemaining = ownedTaskCounts.every(count => count !== null) ?
        ownedTaskCounts.reduce((total, count) => total + count, 0) : null;
      const ownedIndexesRemaining = phase.ownedIndexNames.filter(name => indexCatalog.some(row => row.name === name));
      const preexistingResourcesPreserved = samePreexisting(plan.preexisting.modalApps, appCatalog, 'appId') &&
        samePreexisting(plan.preexisting.pineconeIndexes, indexCatalog, 'name');
      const complete = sandboxes.every(row => row.terminal) && apps.every(row => row.stopped) &&
        ownedTasksRemaining === 0 && ownedIndexesRemaining.length === 0 && preexistingResourcesPreserved;
      phaseObservations.push({phaseId: phase.phaseId, runDigest: phase.runDigest, sandboxes, apps,
        ownedTasksRemaining, ownedIndexesRemaining, preexistingResourcesPreserved,
        originalRetentionReferences: phase.originalRetentionRefs, complete,
        status: complete ? 'provider-absence-observed' : 'cleanup-not-proven'});
    }
  } catch {
    // Never serialize provider exception messages: they may contain credentials.
    // Claimed reads and their already-retained ACKs remain available unchanged.
    failure = auditSignal.aborted ? 'cancelled-or-time-bound' : 'retention-or-provider-observation-failed';
  }
  const complete = failure === null && phaseObservations.length === 7 && phaseObservations.every(row => row.complete);
  const criticalRetentionVerified = retentionReadbackPins.length > 0 &&
    plan.phaseBindings.every(phase => phase.originalRetentionRefs.every(ref =>
      [ref.sourcePin, ref.archivePin].every(value => retentionReadbackPins.some(pin => pin.path === value.path))));
  const receipt = seal({kind: 'modal-production-cleanup-audit-receipt-v1', mode, planDigest: plan.digest,
    registrationDigest: plan.registrationDigest, campaignDigest: plan.campaignDigest,
    collectorBinding: plan.collectorBinding, phaseOrder: PHASES, phaseObservations, readJournal,
    unobservedPhaseIds: PHASES.filter(id => !phaseObservations.some(row => row.phaseId === id)),
    startedAtMs, lastObservedAtMs: previousNow,
    complete, status: complete ? 'observations-complete-awaiting-independent-verification' : 'incomplete',
    failure, uncertainRead, providerReads, responseBytes, archiveReadBytes, retentionReadbackPins,
    originalCriticalBytesVerifiedBeforeProviderReads: criticalRetentionVerified,
    originalSqlWalRequestsAndRawAcksRetained: criticalRetentionVerified,
    rawEvidenceDigests: readJournal.flatMap(row => row.rawPin ? [row.rawPin.sha256] : []),
    readOnlyProviderPortsUsed: true, providerEvidenceCryptographicallyAuthenticated: false,
    independentEvidenceAuthorityAccepted: false, originalArchiveReferencesUnchanged: true,
    originalLoadQueries: 600, originalLoadGateChanged: false, oldClaimsWritten: 0, oldHoldsReleased: 0,
    hostedMutations: 0, modelCalls: 0, paidInferenceCalls: 0, automaticRetries: 0, automaticReplacements: 0,
    originalSqliteEngineOpens: 0, ...FALSE_AUTHORITY});
  // Cancellation must not prevent returning the honest in-memory result. The
  // separate owner may retain it later; this function never retries a failed write.
  let receiptPin = null;
  try {receiptPin = await retain('receipt.json', jsonBytes(receipt));} catch { /* Explicitly unretained below. */ }
  return Object.freeze({receipt, receiptPin, resultDurablyRecorded: receiptPin !== null});
}
