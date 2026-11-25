// Pure publication state machine. All I/O is injected; tests never use npm credentials or a network.
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { selectReleaseArchives } from './release-safety.mjs';
import { requestedRelease } from './version.mjs';
export { selectPlannedRelease } from './release-safety.mjs';

/** A live release must publish the version already reviewed and committed through a release PR. */
export function assertPreparedRelease(version, committedVersion, tag) {
  assert(/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u.test(version), 'Invalid release version.');
  assert.equal(committedVersion, version, 'Merge and qualify a release version PR before publishing.');
  assert.equal(tag, version.includes('-') ? 'next' : 'latest', 'Distribution tag does not match the release version.');
}

/** Full releases must exactly match the repository inventory, including dependency order. */
export function selectFullRelease(manifest, names, version, sourceCommit, archiveBytes) {
  assertPreparedRelease(version, version, version.includes('-') ? 'next' : 'latest');
  assert.equal(names[0], 'mayura');
  assert.deepEqual(manifest.packages.map(entry => entry.name), names, 'Full release inventory differs from the repository.');
  return selectReleaseArchives(manifest, names, version, sourceCommit, archiveBytes);
}

/** Legacy full-release receipts predate package-level versions. */
export function publicationIdentities(entries, planDigest) {
  return entries.map(({ name, version, sha256 }) => planDigest ? { name, version, sha256 } : { name, sha256 });
}

/** The mixed install must have exercised the exact archives before the first npm write. */
export function assertPlannedPreflight(report, entries, sourceCommit, planDigest) {
  assert.equal(report.status, 'passed', 'Mixed-install verification did not pass.');
  assert.equal(report.sourceCommit, sourceCommit);
  assert.equal(report.planDigest, planDigest);
  assert.deepEqual(report.identities, publicationIdentities(entries, planDigest));
  assert.equal(report.cleanInstall, true);
  assert.equal(report.mixedImports, true);
  assert.equal(report.ragAcceptance, true);
  assert.equal(report.registrySignaturesAndAttestations, 'pending-publication');
}

/**
 * Reconcile accepted/uncertain uploads without replay. Preserve the other channel and only admit this release's
 * target-tag movement. Snapshot the complete registry state before writing; persist intent before invoking npm.
 */
export async function publishRelease({ entries, version, sourceCommit, tag, planDigest, registry, upload, save, previous,
  signal, pause = signal => delay(15_000, undefined, { signal }), now = Date.now,
  deadlineMs = 20 * 60_000, progress = () => {} }) {
  assert(entries.length > 0 && new Set(entries.map(e => e.name)).size === entries.length);
  if (planDigest === undefined) assertPreparedRelease(version, version, tag);
  else {
    assert(/^[a-f0-9]{64}$/u.test(planDigest), 'Invalid release plan digest.');
    for (const entry of entries) assertPreparedRelease(entry.version, entry.version, tag);
  }
  const at = entry => planDigest ? entry.version : version;
  const identities = publicationIdentities(entries, planDigest);
  const receipt = previous ? structuredClone(previous) : {
    format: 1, version, sourceCommit, tag, ...(planDigest ? { planDigest } : {}),
    identities, tags: {}, uploads: {}, verified: [], status: 'prepared',
  };
  assert.equal(receipt.format, 1); assert.equal(receipt.version, version);
  assert.equal(receipt.sourceCommit, sourceCommit); assert.equal(receipt.tag, tag);
  assert.equal(receipt.planDigest, planDigest, 'Recovered receipt belongs to a different release plan.');
  assert.deepEqual(receipt.identities, identities, 'Recovered receipt belongs to different archives.');
  if (previous) assert.deepEqual(Object.keys(receipt.tags).sort(), entries.map(e => e.name).sort(), 'Recovered receipt has incomplete tag baselines.');
  for (const [name, state] of Object.entries(receipt.uploads)) {
    assert(entries.some(e => e.name === name) && ['attempting', 'accepted', 'uncertain', 'observed'].includes(state), 'Invalid upload receipt.');
    assert(Object.hasOwn(receipt.tags, name), 'Upload receipt has no tag baseline.');
  }
  const other = tag === 'latest' ? 'next' : 'latest';
  const abort = () => signal?.throwIfAborted();
  const checkVersion = (entry, published) => {
    if (!published) return;
    assert.equal(published.name, entry.name); assert.equal(published.version, at(entry));
    assert.equal(published.dist?.integrity, entry.integrity, `Published archive mismatch: ${entry.name}`);
  };
  const checkTags = (entry, tags, published) => {
    const before = receipt.tags[entry.name];
    assert(tags && typeof tags.latest === 'string', `Package must already exist: ${entry.name}`);
    assert.equal(tags[other] ?? null, before[other], `Non-target tag changed: ${entry.name}`);
    const target = tags[tag] ?? null;
    assert(target === before[tag] || (target === at(entry) && (published || receipt.uploads[entry.name])), `Target tag changed unexpectedly: ${entry.name}`);
  };

  // Resolve the exact reviewed versions of separately published dependencies before any npm write.
  const external = new Map(entries.flatMap(entry => (entry.externalDependencies ?? []).map(({ name, version }) => [name, version])));
  for (const [name, version] of external) {
    abort(); const dependency = await registry.version(name, version);
    assert(dependency?.name === name && dependency.version === version && /^sha512-/u.test(dependency.dist?.integrity),
      `Missing published dependency ${name}@${version}; publish it first or include it in the release plan.`);
  }
  // A transient metadata failure is never treated as version absence or permission to replay a write.
  for (const entry of entries) {
    abort(); const tags = await registry.tags(entry.name);
    assert(tags && typeof tags.latest === 'string', `Package must already exist: ${entry.name}`);
    const published = await registry.version(entry.name, at(entry)); checkVersion(entry, published);
    requestedRelease(at(entry), { tags: tags[tag] ? [`v${tags[tag]}`] : [], current: at(entry) });
    assert(published || tags[tag] !== at(entry) || receipt.uploads[entry.name],
      `Target tag already points to an unverified version: ${entry.name}.`);
    if (!Object.hasOwn(receipt.tags, entry.name)) receipt.tags[entry.name] = { latest: tags.latest, next: tags.next ?? null };
    checkTags(entry, tags, published);
    if (!published && ['attempting', 'uncertain', 'observed'].includes(receipt.uploads[entry.name])) {
      throw new Error(`Uncertain upload is not yet visible: ${entry.name}; reconcile before further writes.`);
    }
  }
  receipt.status = 'publishing'; receipt.verified = []; save(receipt);
  for (const entry of entries) {
    abort(); const published = await registry.version(entry.name, at(entry)); checkVersion(entry, published);
    checkTags(entry, await registry.tags(entry.name), published);
    if (published) { receipt.uploads[entry.name] ??= 'observed'; save(receipt); continue; }
    if (receipt.uploads[entry.name]) continue;
    receipt.uploads[entry.name] = 'attempting'; save(receipt);
    try {
      abort(); await upload(entry, signal);
      receipt.uploads[entry.name] = 'accepted'; save(receipt); progress(`${entry.name}: OIDC upload accepted`);
    } catch (error) {
      receipt.uploads[entry.name] = 'uncertain'; save(receipt); throw error;
    }
    checkTags(entry, await registry.tags(entry.name), null);
  }
  const deadline = now() + deadlineMs;
  do {
    // Recheck all entries each pass: a previous success must not hide subsequent tag movement.
    receipt.verified = [];
    for (const entry of entries) {
      abort(); const published = await registry.version(entry.name, at(entry)); checkVersion(entry, published);
      const tags = await registry.tags(entry.name); checkTags(entry, tags, published);
      if (published?.dist?.attestations?.provenance && tags[tag] === at(entry)) receipt.verified.push(entry.name);
    }
    receipt.status = receipt.verified.length === entries.length ? 'published' : 'awaiting_registry'; save(receipt);
    progress(`${receipt.verified.length}/${entries.length} versions, provenance and distribution tags verified`);
    if (receipt.status === 'published') return receipt;
    assert(now() < deadline, 'Registry visibility pending; recover the original receipt without re-uploading.');
    abort(); await pause(signal);
  } while (true);
}
