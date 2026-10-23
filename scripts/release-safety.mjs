// Shared, side-effect-free boundaries for full releases and the scoped RC publisher.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';

export const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
export const archiveIntegrity = bytes => 'sha512-' + createHash('sha512').update(bytes).digest('base64');

/** Read one package manifest from a bounded regular-file archive without extracting or executing it. */
function packageManifest(bytes) {
  const tar = gunzipSync(bytes, { maxOutputLength: 128 * 1024 * 1024 });
  let manifest;
  for (let cursor = 0; cursor + 512 <= tar.length;) {
    const header = tar.subarray(cursor, cursor + 512);
    if (header.every(byte => byte === 0)) break;
    const field = (start, length) => header.subarray(start, start + length).toString().replace(/\0.*$/su, '');
    const name = [field(345, 155), field(0, 100)].filter(Boolean).join('/');
    const type = field(156, 1);
    const size = Number.parseInt(field(124, 12).trim(), 8);
    assert(Number.isSafeInteger(size) && size >= 0 && cursor + 512 + size <= tar.length, 'Invalid archive member.');
    assert(['', '0', '5'].includes(type) && name.startsWith('package/') && !name.includes('\\') &&
      !name.split('/').includes('..'), 'Unsafe archive member.');
    if (name === 'package/package.json') {
      assert(type !== '5' && !manifest, 'Duplicate or invalid package manifest.');
      manifest = JSON.parse(tar.subarray(cursor + 512, cursor + 512 + size));
    }
    cursor += 512 + Math.ceil(size / 512) * 512;
  }
  assert(manifest, 'Archive has no package.json.');
  return manifest;
}

/** Validate all selected archives and their internal dependency closure before any registry write. */
export function selectReleaseArchives(manifest, names, version, sourceCommit, archiveBytes) {
  assert(names.length > 0 && new Set(names).size === names.length, 'Invalid release inventory.');
  assert(names.every(name => name === 'mayura' || /^@mayurajs\/[a-z0-9-]+$/u.test(name)));
  assert.equal(manifest.format, 1);
  assert.equal(manifest.status, 'passed');
  assert.equal(manifest.version, version);
  assert.equal(manifest.sourceCommit, sourceCommit, 'Archives do not belong to this source commit.');
  const inventory = new Map(manifest.packages.map(entry => [entry.name, entry]));
  assert.equal(inventory.size, manifest.packages.length, 'Duplicate archive identities.');
  const filenames = new Set();
  return names.map((name, index) => {
    const entry = inventory.get(name);
    assert(entry, `Missing selected archive: ${name}`);
    assert.equal(entry.version, version);
    assert(/^[a-zA-Z0-9][a-zA-Z0-9._-]*\.tgz$/u.test(entry.filename), 'Unsafe archive filename.');
    assert(!filenames.has(entry.filename), 'Duplicate archive filename.'); filenames.add(entry.filename);
    assert(/^[a-f0-9]{64}$/u.test(entry.sha256));
    const bytes = archiveBytes(entry.filename);
    assert.equal(sha256(bytes), entry.sha256, `Archive changed: ${name}`);
    const pkg = packageManifest(bytes);
    assert.equal(pkg.name, name); assert.equal(pkg.version, version);
    assert.equal(pkg.repository?.url, 'git+https://github.com/KartikeyAI/mayura.git');
    assert.equal(pkg.private, undefined); assert.equal(pkg.scripts, undefined);
    assert.equal(pkg.publishConfig?.access, 'public'); assert.equal(pkg.publishConfig?.provenance, true);
    for (const [dependency, range] of Object.entries({ ...pkg.dependencies, ...pkg.optionalDependencies, ...pkg.peerDependencies })) {
      if (dependency === 'mayura' || dependency.startsWith('@mayurajs/')) {
        assert(names.includes(dependency), `Missing release dependency: ${dependency}`);
        assert([version, '^' + version].includes(range), `Wrong dependency version: ${dependency}`);
        if (Object.hasOwn(pkg.dependencies ?? {}, dependency) || Object.hasOwn(pkg.optionalDependencies ?? {}, dependency)) {
          assert(names.indexOf(dependency) < index, `Release dependency must be published first: ${dependency}`);
        }
      }
    }
    return { ...entry, integrity: archiveIntegrity(bytes) };
  });
}

/** Publishing requires the exact pushed main commit and a complete, successful qualification run. */
export function assertPublishContext(context, run, jobs, main, events = ['workflow_dispatch']) {
  assert(events.includes(context.event), 'Unsupported publishing event.');
  assert.equal(context.ref, 'refs/heads/main');
  assert.equal(context.workflowRef, 'KartikeyAI/mayura/.github/workflows/release.yml@refs/heads/main');
  assert.equal(main.sha, context.sha, 'Main moved before publication.');
  assert.equal(run.name, 'Mayura qualification'); assert.equal(run.path, '.github/workflows/ci.yml');
  assert.equal(run.event, 'push'); assert.equal(run.head_branch, 'main'); assert.equal(run.head_sha, context.sha);
  assert.equal(run.head_repository?.full_name, 'KartikeyAI/mayura');
  assert.equal(run.status, 'completed'); assert.equal(run.conclusion, 'success');
  const gates = jobs.filter(job => job.name === 'Qualification gate');
  assert.equal(gates.length, 1); assert.equal(gates[0].conclusion, 'success');
  assert(jobs.every(job => job.conclusion === 'success'), 'A qualification job did not pass.');
}
