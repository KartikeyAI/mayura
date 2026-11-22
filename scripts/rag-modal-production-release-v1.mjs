/** Verify the Loki-v28 release from already retained evidence. This command has no provider transports. */
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFile, writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {MODAL_PRODUCTION_CLEANUP_AUDIT_PHASES_V1 as phases} from '../deploy/rag-modal/production-cleanup-audit-v1.mjs';
// Canonical serialization for the retained pipeline evidence, independent of the provider runner.
const freeze = value => {if (value && typeof value === 'object') {Object.values(value).forEach(freeze); Object.freeze(value);} return value;};
const own = (value, key) => {const d = Object.getOwnPropertyDescriptor(value, key); assert.ok(d && Object.hasOwn(d, 'value'), 'PIPELINE_ACCESSOR_DENIED'); return d.value;};
function data(value, sorted, seen = new Set()) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {assert.ok(Number.isFinite(value), 'PIPELINE_NONFINITE_DATA'); return value;}
  assert.ok(value && typeof value === 'object' && !seen.has(value), 'PIPELINE_PLAIN_DATA_REQUIRED'); seen.add(value); let result;
  if (Array.isArray(value)) {assert.equal(Reflect.ownKeys(value).length, value.length + 1, 'PIPELINE_ARRAY_FIELDS');
    result = Array.from({length: value.length}, (_, i) => data(own(value, String(i)), sorted, seen));}
  else {assert.ok([Object.prototype, null].includes(Object.getPrototypeOf(value)), 'PIPELINE_PLAIN_DATA_REQUIRED');
    const keys = Reflect.ownKeys(value); assert.ok(keys.every(k => typeof k === 'string'), 'PIPELINE_SYMBOL_FIELDS');
    result = Object.fromEntries((sorted ? keys.sort() : keys).map(key => [key, data(own(value, key), sorted, seen)]));}
  seen.delete(value); return result;
}
/** Clone/freeze plain data while preserving insertion order, including every original wire BODY. */
export const snapshotV1 = value => freeze(data(value, false));
export const canonicalDataV1 = value => data(value, true);
export const canonicalJsonV1 = value => JSON.stringify(canonicalDataV1(value));
export const hashV1 = value => createHash('sha256').update(canonicalJsonV1(value)).digest('hex');
/** Existing model/provider wire hashes never use metadata canonicalization. */
export const wireHashV1 = value => createHash('sha256').update(JSON.stringify(snapshotV1(value))).digest('hex');
export const sealV1 = body => {assert.ok(!Object.hasOwn(body, 'digest'), 'PIPELINE_SEAL_BODY_HAS_DIGEST'); const value = snapshotV1(body); return freeze({...value, digest: hashV1(value)});};
export function checkSealV1(value) {const copy = snapshotV1(value), {digest, ...body} = copy; assert.equal(hashV1(body), digest, 'PIPELINE_SEAL_CHANGED'); return copy;}
const checked = checkSealV1;
const seal = sealV1;

const artifact = '.artifacts/';
const final = `${artifact}modal-production-final-verification-v2/`;
const scope = `${artifact}modal-production-remaining-operations-v3/scope-security/`;
const reportPath = 'compatibility/rag-modal-pinecone-loki-production-v1.json';
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const read = async path => checked(JSON.parse(await readFile(path)));
const stopped = state => [5, 7].includes(state);
const terminal = status => [1, 2, 3, 4].includes(status);
const sameIds = (actual, expected) => assert.deepEqual([...actual].sort(), [...expected].sort());

export async function loadModalProductionReleaseEvidenceV1() {
  const paths = {
    binding: `${final}cleanup-binding.json`,
    original: `${final}cleanup-collector.json`,
    live: `${final}cleanup-live.json`,
    document: `${artifact}modal-production-document-fresh-live-v2/attempt-1/result.json`,
    olderNomic: `${artifact}modal-nomic-load-campaign-v1/scopes/scope-02/independent-provider-observation-v1.json`,
    olderNative: `${artifact}modal-native600-attempt-v8/scopes/scope-04/independent-provider-observation-v2.json`,
    semantic: `${artifact}modal-loki-shared-auth-v14/closeout-v28.json`,
    load: `${artifact}modal-production-loki-load-v1/closeout.json`,
    nativeHost: `${artifact}modal-production-loki-load-v1/native600/result.json`,
    nativeLeaf: `${artifact}modal-production-loki-load-v1/native600/retained-result.json`,
    nativeRetention: `${final}native600-bundle.json`,
    recovery: `${artifact}modal-production-remaining-operations-v5/recovery7/closeout-v1.json`,
    recoveryRetention: `${artifact}modal-production-final-verification-v1/recovery-retention.json`,
    security: `${scope}result.json`,
    securityLeaf: `${scope}retained-result.json`,
  };
  const evidence = Object.fromEntries(await Promise.all(Object.entries(paths).map(async ([name, path]) => [name, await read(path)])));
  const auditPin = evidence.original.collector.originalPhaseResult.auditReceiptPin;
  assert.match(auditPin.path, /^\.artifacts\/modal-selected-root-cleanup-audit-v2\/[a-f0-9]{32}\/read-only-audit\/receipt\.json$/u);
  const auditBytes = await readFile(auditPin.path);
  assert.equal(auditBytes.length, auditPin.bytes);
  assert.equal(sha(auditBytes), auditPin.sha256);
  const historicalBytes = await readFile(`${artifact}modal-historical-cleanup-verification-v1/result.json`);
  const exactAppReceiptSha256 = sha(historicalBytes);
  assert.equal(exactAppReceiptSha256, 'ec71980ef7618c21985db45284e2a088d5e9de5b81f1990c5fff7559478cedd6');
  return {...evidence, audit: checked(JSON.parse(auditBytes)), historical: JSON.parse(historicalBytes), exactAppReceiptSha256};
}

function verifyArchivedLoads(binding, receipts) {
  for (const [phaseId, receipt] of receipts) {
    const owner = binding.older.find(row => row.phaseId === phaseId);
    const {app, runner, model, catalog} = receipt.raw;
    assert.equal(receipt.digest, owner.cleanupDigest);
    assert.equal(receipt.observedAtMs, owner.observedAtMs);
    assert.deepEqual([app.id], owner.ownedAppIds);
    const sandboxes = model ? [runner, model] : [runner];
    sameIds(sandboxes.map(row => row.id), owner.ownedSandboxIds);
    assert.ok(sandboxes.every(({response}) => terminal(response.result.status) && response.metadata.appId === app.id));
    assert.ok(stopped(app.lifecycle.lifecycle.appState) && app.listed.nRunningTasks === 0);
    assert.equal(receipt.remainingOwnedTasks, 0);
    assert.equal(receipt.remainingOwnedIndexes, 0);
    assert.ok(owner.ownedIndexNames.every(name => catalog.indexes.every(row => row.name !== name)));
  }
}

function verifyCleanup({binding, original, audit, live, document, olderNomic, olderNative, historical}) {
  const selected = binding.phaseBindings;
  assert.deepEqual(selected.map(row => row.phaseId), phases);
  assert.equal(live.campaignBindingDigest, binding.digest);
  assert.equal(audit.campaignDigest, binding.digest);
  assert.equal(audit.registrationDigest, binding.registrationDigest);
  assert.equal(audit.digest, original.collector.originalPhaseResult.auditDigest);
  assert.equal(audit.mode, 'live');
  assert.ok(audit.originalCriticalBytesVerifiedBeforeProviderReads && audit.originalSqlWalRequestsAndRawAcksRetained &&
    audit.originalArchiveReferencesUnchanged);
  const expectedPins = new Map(selected.flatMap(row => row.originalRetentionRefs.flatMap(({sourcePin, archivePin}) =>
    [sourcePin, archivePin].map(pin => [pin.path, pin]))));
  assert.equal(audit.retentionReadbackPins.length, expectedPins.size);
  sameIds(audit.retentionReadbackPins.map(pin => pin.path), expectedPins.keys());
  for (const pin of audit.retentionReadbackPins) assert.deepEqual(pin, expectedPins.get(pin.path));

  const [documentOwner] = selected;
  const {rootCleanup, controllerCleanup, modelCleanup} = document;
  assert.equal(document.digest, documentOwner.runDigest);
  assert.deepEqual([rootCleanup.appId], documentOwner.ownedAppIds);
  assert.deepEqual(documentOwner.ownedIndexNames, []);
  assert.ok(document.cleanupVerified && rootCleanup.providerCleanupVerified && rootCleanup.appStopped && rootCleanup.appTasksZero);
  const historicalDocuments = [controllerCleanup, modelCleanup];
  sameIds(historicalDocuments.map(row => row.sandboxId), documentOwner.ownedSandboxIds);
  for (const row of historicalDocuments) {
    checked(row);
    assert.ok(row.providerBackedSandboxAbsenceObserved && row.sandboxExitObserved && row.cleanupVerified);
    assert.ok(row.observations.some(event => event.kind === 'exit' && event.sandboxId === row.sandboxId && Number.isInteger(event.code)));
  }
  verifyArchivedLoads(binding, [['nomic120', olderNomic], ['native600', olderNative]]);

  assert.equal(live.activeOrUnknown.length, 0);
  assert.equal(live.ownedIndexesListed.length, 0);
  assert.equal(live.unrelatedIndexesStillListed, true);
  assert.match(live.pineconeCatalogSha256, /^[a-f0-9]{64}$/u);
  const roster = [...selected, ...binding.older];
  const owningApps = roster.flatMap(row => row.ownedAppIds);
  assert.equal(new Set(owningApps).size, owningApps.length);
  assert.equal(live.appCount, owningApps.length);
  sameIds([...live.ownedAppsListed.map(row => row.appId), ...live.absentFromCurrentAppCatalog], owningApps);
  assert.ok(live.ownedAppsListed.every(row => stopped(row.state) && row.nRunningTasks === 0));
  const expectedSandboxes = roster.flatMap(owner => owner.ownedSandboxIds);
  assert.equal(new Set(expectedSandboxes).size, expectedSandboxes.length);
  sameIds(live.sandboxObservations.map(row => row.sandboxId), expectedSandboxes);
  const observed = new Map(live.sandboxObservations.map(row => [row.sandboxId, row]));
  const archivedApps = new Set([rootCleanup.appId, olderNomic.raw.app.id, olderNative.raw.app.id]);
  let currentSandboxes = 0;
  for (const owner of roster) {
    const [appId] = owner.ownedAppIds;
    assert.equal(owner.ownedAppIds.length, 1);
    const appWasArchived = archivedApps.has(appId);
    assert.ok(appWasArchived || live.ownedAppsListed.some(row => row.appId === appId));
    for (const sandboxId of owner.ownedSandboxIds) {
      const row = observed.get(sandboxId);
      assert.equal(row.phaseId, owner.phaseId);
      assert.equal(row.appId, appId);
      // Catalog omission or a failed lookup never establishes terminal status.
      // For the three exact historical owners the original provider receipts supply that observation.
      if (appWasArchived && row.status === null) continue;
      assert.ok(row.confirmedTerminal && terminal(row.status) && row.observedAppId === appId);
      if (selected.includes(owner) && !appWasArchived) currentSandboxes++;
    }
  }

  // The old API list omitted this app. Require the retained direct provider reply for its exact ID in the same workspace.
  const [preexisting] = binding.preexisting.modalApps;
  assert.equal(binding.preexisting.modalApps.length, 1);
  assert.equal(historical.registeredCleanupBindingDigest, binding.digest);
  assert.equal(historical.workspaceId, audit.collectorBinding.modalWorkspaceId);
  const identities = historical.providerReads.filter(row => row.method === 'TokenInfoGet' && row.target === 'workspace');
  assert.equal(identities.length, 1);
  assert.equal(identities[0].response.workspaceId, historical.workspaceId);
  assert.equal(historical.preexistingApp.appId, preexisting.appId);
  const lifecycle = historical.providerReads.filter(row => row.method === 'AppGetLifecycle' && row.target === preexisting.appId);
  assert.equal(lifecycle.length, 1);
  const state = lifecycle[0].response;
  assert.deepEqual(state, historical.preexistingApp.directLifecycle);
  assert.ok(stopped(state.state) && Number.isFinite(state.createdAt) && state.createdAt > 0 &&
    Number.isFinite(state.stoppedAt) && state.stoppedAt >= state.createdAt && state.stoppedAt * 1000 <= live.observedAtMs);
  return {currentSandboxes, historicalDocumentSandboxes: historicalDocuments.length, supersededLoadSandboxes: 3,
    campaignApps: owningApps.length, campaignSandboxes: expectedSandboxes.length, preexistingAppsVerifiedByExactId: 1,
    ownedIndexesRemaining: 0, retainedFilesPreviouslyVerified: expectedPins.size, originalAuditPassed: original.collector.phasePassed};
}

export function verifyModalProductionReleaseV1(evidence) {
  const {binding, original, audit, live, document, olderNomic, olderNative, historical, exactAppReceiptSha256,
    semantic, load, nativeHost, nativeLeaf, nativeRetention, recovery, recoveryRetention, security, securityLeaf} = evidence;
  const cleanup = verifyCleanup({binding, original, audit, live, document, olderNomic, olderNative, historical});
  const owner = phase => binding.phaseBindings.find(row => row.phaseId === phase);
  const prior = phase => binding.priorObservations.find(row => row.phaseId === phase).receiptDigest;
  assert.equal(semantic.digests.cleanup, prior('semantic40'));
  assert.equal(load.lokiPassDigest, semantic.digest);
  assert.equal(load.nomicRegistrationDigest, binding.registrationDigest);
  assert.equal(recovery.lokiPassDigest, semantic.digest);
  assert.equal(recovery.native600PassDigest, load.originalNativePassDigest);
  assert.ok(semantic.captureComplete && semantic.retentionComplete && semantic.sourceReviewCompleted && semantic.semanticPhasePassed &&
    semantic.rankingGatePassed && semantic.cleanupVerified && semantic.runFailure === null);
  assert.equal(semantic.totalCases, 40);
  assert.equal(semantic.completedRankings, 40);
  assert.equal(semantic.completedAnswers, 40);
  assert.equal(semantic.originalP95MaximumMs, 5000);
  assert.ok(Number.isFinite(semantic.rankingP95UpperBoundMs) && semantic.rankingP95UpperBoundMs > 0 &&
    semantic.rankingP95UpperBoundMs <= semantic.originalP95MaximumMs);
  assert.deepEqual(load.phases.map(row => row.phase), ['nomic120', 'native600']);
  const [nomic, native] = load.phases;
  for (const [row, queries] of [[nomic, 120], [native, 600]]) {
    assert.ok(row.phasePassed && row.providerCleanupVerified);
    assert.equal(row.resultDigest, owner(row.phase).runDigest);
    assert.equal(row.cleanupDigest, prior(row.phase));
    assert.equal(row.rawQueryCount, queries);
    assert.equal(row.metrics.queries, queries);
  }
  assert.ok(nomic.fullArchiveRetained && nomic.hostSuccessful);
  assert.equal(nativeRetention.runDigest, native.resultDigest);
  assert.equal(nativeHost.digest, native.resultDigest);
  assert.equal(nativeHost.remoteResultDigest, nativeLeaf.digest);
  assert.ok(nativeLeaf.phaseLeafPassed);
  assert.equal(nativeRetention.bundle.nativeRunDigest, nativeLeaf.result.originalReceipt.digest);
  assert.equal(nativeRetention.bundle.sourceRetentionDigest, nativeHost.retentionDigest);
  assert.equal(nativeRetention.bundle.digest, binding.restoredNativeDigest);
  assert.equal(nativeRetention.bundle.verifiedTimedQueries, 600);
  assert.deepEqual(nativeRetention.bundle.originalRetentionRefs, owner('native600').originalRetentionRefs);
  assert.equal(recovery.runDigest, owner('recovery7').runDigest);
  assert.equal(recovery.originalCrashCheckpoints, 7);
  assert.equal(recovery.additionalRecoveryChecks, 4);
  assert.equal(recovery.queryNoReplayProbes, 2);
  assert.ok(recovery.liveRecoveryChecksPassed && recovery.providerCleanupVerified && recovery.pineconeIndexAbsent &&
    Number.isFinite(recovery.maximumRecoveryMs) && recovery.maximumRecoveryMs > 0 && recovery.maximumRecoveryMs <= 30_000);
  assert.equal(recoveryRetention.sourceDigest, recovery.digest);
  assert.equal(recoveryRetention.digest, binding.verifiedRecoveryRetentionDigest);
  assert.equal(recoveryRetention.bundle.verifiedRawFileCount, recovery.verifiedRawFiles);
  assert.ok(recoveryRetention.bundle.completeRecoveryVerifierInventoryRetained && !recoveryRetention.bundle.originalsModified);
  assert.deepEqual(recoveryRetention.bundle.originalRetentionRefs, owner('recovery7').originalRetentionRefs);
  assert.equal(security.digest, owner('scope-security').runDigest);
  assert.equal(security.cleanupDigest, prior('scope-security'));
  assert.equal(security.remoteResultDigest, securityLeaf.digest);
  assert.ok(security.successful && security.leafPassed && security.providerBackedCleanup && security.nativeCleanupVerified &&
    securityLeaf.phaseLeafPassed && securityLeaf.result.phasePassed && securityLeaf.result.cleanupVerified);
  for (const row of [binding, original, live, document, semantic, load, nativeRetention, recovery, recoveryRetention, security, securityLeaf]) {
    assert.equal(row.originalLoadQueries, 600);
    assert.equal(row.gatesChanged, false);
  }

  return seal({kind: 'modal-pinecone-loki-production-qualification-v1', profile: 'Modal + Pinecone / Loki v28',
    status: 'stable-for-bound-profile', registrationDigest: binding.registrationDigest,
    gates: {documentPreparation: true, semanticQualityAndLatency: true, nomic120: true, native600: true,
      recovery: true, scopeSecurity: true, campaignCleanup: true},
    metrics: {semanticCases: 40, semanticRankingP95UpperBoundMs: semantic.rankingP95UpperBoundMs,
      semanticRankingP95GateMs: semantic.originalP95MaximumMs, nomicQueries: 120,
      nomicAcquisitionP95Ms: nomic.metrics.acquisitionP95Ms, nativeQueries: 600, nativeP95Ms: native.metrics.p95Ms,
      recoveryCheckpoints: recovery.originalCrashCheckpoints, maximumRecoveryMs: recovery.maximumRecoveryMs},
    cleanup: {...cleanup, policy: 'current-provider-inventory-and-exact-historical-shutdown-v2',
      providerInventoryObservedAtMs: live.observedAtMs},
    evidence: {cleanupBinding: binding.digest, originalCleanup: original.digest, originalAudit: audit.digest, providerInventory: live.digest,
      documentPreparation: document.digest, olderNomic: olderNomic.digest, olderNative: olderNative.digest, exactAppReceiptSha256,
      semantic: semantic.digest, load: load.digest, nativeRetention: nativeRetention.digest, recovery: recovery.digest,
      recoveryRetention: recoveryRetention.digest, scopeSecurity: security.digest},
    originalLoadQueries: 600, originalQualityAndLatencyGatesChanged: false, budgetsChanged: false,
    newQueries: 0, newProviderReads: 0, paidCalls: 0, originalReceiptsPreserved: true});
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const mode = process.argv[2];
  assert.ok(['--check', '--record', '--verify-report'].includes(mode), 'Pass --check, --record, or --verify-report');
  const report = mode === '--verify-report' ? await read(reportPath) : verifyModalProductionReleaseV1(await loadModalProductionReleaseEvidenceV1());
  assert.equal(report.kind, 'modal-pinecone-loki-production-qualification-v1');
  assert.equal(report.status, 'stable-for-bound-profile');
  assert.deepEqual(report.gates, {documentPreparation: true, semanticQualityAndLatency: true, nomic120: true, native600: true,
    recovery: true, scopeSecurity: true, campaignCleanup: true});
  assert.equal(report.originalLoadQueries, 600);
  const bytes = JSON.stringify(report, null, 2) + '\n';
  if (mode === '--record') await writeFile(reportPath, bytes, {flag: 'wx', flush: true});
  console.log(mode === '--record' ? reportPath : `${report.status} ${report.digest}`);
}
