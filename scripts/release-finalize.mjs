// Verify the committed version before building, and the complete immutable receipt before tagging/releasing.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { extensions } from './extensions.mjs';
import { assertPreparedRelease, selectFullRelease } from './release-publisher.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = path => JSON.parse(readFileSync(path, 'utf8'));

/** A tag/GitHub Release is admitted only after every selected archive is verified as published. */
export function assertReleaseReceipt(receipt, entries, version, sourceCommit, qualification) {
  assert.equal(receipt.status, 'published'); assert.equal(receipt.version, version);
  assert.equal(receipt.sourceCommit, sourceCommit);
  assert.equal(receipt.tag, version.includes('-') ? 'next' : 'latest');
  assert.deepEqual(receipt.identities, entries.map(({ name, sha256 }) => ({ name, sha256 })));
  assert.deepEqual([...receipt.verified].sort(), entries.map(e => e.name).sort());
  assert(entries.every(e => ['accepted', 'observed', 'attempting', 'uncertain'].includes(receipt.uploads[e.name])), 'Missing upload evidence.');
  assert.equal(qualification.sourceCommit, sourceCommit); assert.equal(qualification.gate, 'success');
  assert(Number.isSafeInteger(qualification.run) && qualification.run > 0);
}

function main() {
  const [mode, version, ...extra] = process.argv.slice(2);
  assert(['--prepared', '--published'].includes(mode) && extra.length === 0, 'Use --prepared <version> or --published <version>.');
  assertPreparedRelease(version, read(join(root, 'package.json')).version, version?.includes('-') ? 'next' : 'latest');
  execFileSync(process.execPath, ['scripts/version.mjs', 'check'], { cwd: root, stdio: 'inherit' });
  execFileSync('git', ['diff', '--exit-code', 'HEAD', '--'], { cwd: root, stdio: 'ignore' });
  assert(readFileSync(join(root, 'CHANGELOG.md'), 'utf8').includes(`## [${version}]`), 'Release notes must be committed.');
  if (mode === '--published') {
    const sourceCommit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
    assert.equal(process.env.SOURCE_SHA, sourceCommit);
    const area = join(root, '.artifacts', 'full-release');
    const entries = selectFullRelease(read(join(area, 'release-manifest.json')), ['mayura', ...extensions().map(e => e.manifest.name)],
      version, sourceCommit, filename => readFileSync(join(area, 'tarballs', filename)));
    assertReleaseReceipt(read(join(area, 'receipt.json')), entries, version, sourceCommit, read(join(area, 'qualification.json')));
  }
  console.log(JSON.stringify({ status: 'passed', check: mode, version }));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(); } catch (error) { console.error(error.message); process.exitCode = 1; }
}
