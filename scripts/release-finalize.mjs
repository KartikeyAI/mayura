// Verify the committed version before building, and the complete immutable receipt before tagging/releasing.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { extensions } from './extensions.mjs';
import { readReleasePlan } from './package-release-plan.mjs';
import { assertPreparedRelease, publicationIdentities, selectFullRelease, selectPlannedRelease } from './release-publisher.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = path => JSON.parse(readFileSync(path, 'utf8'));

/** A tag/GitHub Release is admitted only after every selected archive is verified as published. */
export function assertReleaseReceipt(receipt, entries, version, sourceCommit, qualification, planDigest, tag) {
  assert.equal(receipt.format, 1);
  assert.equal(receipt.status, 'published'); assert.equal(receipt.version, version);
  assert.equal(receipt.sourceCommit, sourceCommit);
  assert.equal(receipt.tag, tag ?? (version.includes('-') ? 'next' : 'latest'));
  assert.equal(receipt.planDigest, planDigest, 'Receipt belongs to a different release plan.');
  assert.deepEqual(receipt.identities, publicationIdentities(entries, planDigest));
  assert.deepEqual([...receipt.verified].sort(), entries.map(e => e.name).sort());
  if (planDigest) assert.deepEqual(Object.keys(receipt.uploads).sort(), entries.map(entry => entry.name).sort(),
    'Upload evidence must cover exactly the planned packages.');
  assert(entries.every(e => ['accepted', 'observed', 'attempting', 'uncertain'].includes(receipt.uploads[e.name])), 'Missing upload evidence.');
  assert.equal(qualification.sourceCommit, sourceCommit); assert.equal(qualification.gate, 'success');
  assert.equal(qualification.planDigest, planDigest, 'Qualification evidence belongs to a different release plan.');
  assert(Number.isSafeInteger(qualification.run) && qualification.run > 0);
}

function main() {
  const [mode, input, ...extra] = process.argv.slice(2);
  assert(['--prepared', '--published', '--prepared-plan', '--published-plan'].includes(mode) && input && extra.length === 0,
    'Use --prepared <version>, --published <version>, --prepared-plan <path> or --published-plan <path>.');
  const reviewedPlan = mode.endsWith('-plan') ? readReleasePlan(input) : undefined;
  const coreVersion = read(join(root, 'package.json')).version;
  const version = reviewedPlan ? coreVersion : input;
  if (!reviewedPlan) assertPreparedRelease(version, coreVersion, version.includes('-') ? 'next' : 'latest');
  execFileSync(process.execPath, ['scripts/version.mjs', 'check'], { cwd: root, stdio: 'inherit' });
  execFileSync('git', ['diff', '--exit-code', 'HEAD', '--'], { cwd: root, stdio: 'ignore' });
  if (reviewedPlan) {
    const trackedPath = execFileSync('git', ['ls-files', '--error-unmatch', '--', reviewedPlan.path], { cwd: root, encoding: 'utf8' }).trim();
    assert.equal(trackedPath, reviewedPlan.path, 'Release plan must be committed before publication.');
  } else {
    assert(readFileSync(join(root, 'CHANGELOG.md'), 'utf8').includes(`## [${version}]`), 'Release notes must be committed.');
  }
  if (mode.startsWith('--published')) {
    const sourceCommit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
    assert.equal(process.env.SOURCE_SHA, sourceCommit);
    const area = join(root, '.artifacts', 'full-release');
    const manifest = read(join(area, 'release-manifest.json'));
    const archiveBytes = filename => readFileSync(join(area, 'tarballs', filename));
    let entries;
    if (reviewedPlan) {
      assert.equal(manifest.planDigest, reviewedPlan.digest, 'Finalization requires the frozen archives for this plan.');
      entries = selectPlannedRelease(manifest, reviewedPlan.plan, reviewedPlan.inventory, sourceCommit, archiveBytes, reviewedPlan.digest);
      assert.deepEqual(readdirSync(join(area, 'tarballs')).sort(), entries.map(entry => entry.filename).sort(),
        'The frozen tarball directory must contain exactly the planned package archives.');
      const verification = read(join(area, 'registry-verification.json'));
      assert.equal(verification.status, 'passed');
      assert.equal(verification.sourceCommit, sourceCommit);
      assert.equal(verification.planDigest, reviewedPlan.digest);
      assert.deepEqual(verification.identities, publicationIdentities(entries, reviewedPlan.digest));
      assert.equal(verification.registrySignaturesAndAttestations, 'verified');
      assert.equal(verification.cleanInstall, true);
      assert.equal(verification.mixedImports, true);
      assert.equal(verification.ragAcceptance, true);
    } else {
      entries = selectFullRelease(manifest, ['mayura', ...extensions().map(e => e.manifest.name)], version, sourceCommit, archiveBytes);
    }
    assertReleaseReceipt(read(join(area, 'receipt.json')), entries, version, sourceCommit, read(join(area, 'qualification.json')),
      reviewedPlan?.digest, reviewedPlan?.tag);
  }
  console.log(JSON.stringify({ status: 'passed', check: mode, version, ...(reviewedPlan ? { planDigest: reviewedPlan.digest } : {}) }));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(); } catch (error) { console.error(error.message); process.exitCode = 1; }
}
