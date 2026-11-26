// Shared, side-effect-free boundaries for full releases and the scoped RC publisher.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { satisfies } from 'semver';

export const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
export const archiveIntegrity = bytes => 'sha512-' + createHash('sha512').update(bytes).digest('base64');
const publicPackage = name => name === 'mayura' || /^@mayurajs\/[a-z0-9-]+$/u.test(name);
const identities = entries => entries.map(({ name, version }) => ({ name, version }));

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

/** Validate a reviewed package identity, archive and immutable npm publication metadata. */
function validatedArchive(entry, name, version, archiveBytes, filenames) {
  assert(entry, `Missing selected archive: ${name}`);
  assert.equal(entry.version, version, `Wrong archive version: ${name}`);
  assert(/^[a-zA-Z0-9][a-zA-Z0-9._-]*\.tgz$/u.test(entry.filename), 'Unsafe archive filename.');
  assert(!filenames.has(entry.filename), 'Duplicate archive filename.'); filenames.add(entry.filename);
  assert(/^[a-f0-9]{64}$/u.test(entry.sha256));
  const bytes = archiveBytes(entry.filename);
  assert.equal(sha256(bytes), entry.sha256, `Archive changed: ${name}`);
  const pkg = packageManifest(bytes);
  assert.equal(pkg.name, name); assert.equal(pkg.version, version);
  assert.equal(pkg.repository?.url, 'git+https://github.com/KartikeyAI/mayura.git');
  assert.equal(pkg.private, undefined); assert.equal(pkg.scripts, undefined);
  assert.deepEqual(pkg.publishConfig, { access: 'public', provenance: true }, 'Archive cannot override the registry, tag or publication settings.');
  return { pkg, integrity: archiveIntegrity(bytes) };
}

function manifestInventory(manifest, version, sourceCommit) {
  assert.equal(manifest.format, 1);
  assert.equal(manifest.status, 'passed');
  assert.equal(manifest.version, version);
  assert.equal(manifest.sourceCommit, sourceCommit, 'Archives do not belong to this source commit.');
  const inventory = new Map(manifest.packages.map(entry => [entry.name, entry]));
  assert.equal(inventory.size, manifest.packages.length, 'Duplicate archive identities.');
  return inventory;
}

/** Validate all selected archives and their internal dependency closure before any registry write. */
export function selectReleaseArchives(manifest, names, version, sourceCommit, archiveBytes) {
  assert(names.length > 0 && new Set(names).size === names.length, 'Invalid release inventory.');
  assert(names.every(publicPackage));
  const inventory = manifestInventory(manifest, version, sourceCommit);
  const filenames = new Set();
  return names.map((name, index) => {
    const entry = inventory.get(name);
    const { pkg, integrity } = validatedArchive(entry, name, version, archiveBytes, filenames);
    for (const kind of ['dependencies', 'optionalDependencies', 'peerDependencies']) {
      for (const [dependency, range] of Object.entries(pkg[kind] ?? {})) {
        if (dependency === 'mayura' || dependency.startsWith('@mayurajs/')) {
          assert(names.includes(dependency), `Missing release dependency: ${dependency}`);
          assert([version, '^' + version].includes(range), `Wrong dependency version: ${dependency}`);
          if (kind !== 'peerDependencies') {
            assert(names.indexOf(dependency) < index, `Release dependency must be published first: ${dependency}`);
          }
        }
      }
    }
    return { ...entry, integrity };
  });
}

/** Admit the selected package versions from a reviewed plan and the exact commit's archive inventory. */
export function selectPlannedRelease(manifest, plan, inventory, sourceCommit, archiveBytes, planDigest) {
  assert.equal(plan.format, 1);
  assert(/^[a-f0-9]{64}$/u.test(planDigest), 'Package release plan digest is required.');
  assert.equal(inventory[0]?.name, 'mayura', 'Source package inventory must start with mayura.');
  const source = new Map(inventory.map(({ name, version }) => [name, version]));
  assert.equal(source.size, inventory.length, 'Duplicate source package identities.');
  const selected = new Map(plan.packages.map(({ name, version }, index) => [name, { version, index }]));
  assert(selected.size > 0 && selected.size === plan.packages.length, 'Invalid planned release inventory.');
  assert.deepEqual(plan.packages, inventory.filter(({ name }) => selected.has(name)),
    'Planned release identities must match the reviewed source inventory in dependency order.');
  const archives = manifestInventory(manifest, source.get('mayura'), sourceCommit);
  if (manifest.planDigest === undefined) {
    assert.deepEqual(identities(manifest.packages), inventory, 'Staged archives differ from the source inventory.');
  } else {
    assert.equal(manifest.planDigest, planDigest, 'Frozen archives belong to a different release plan.');
    assert.deepEqual(identities(manifest.packages), plan.packages, 'Frozen archives differ from the release plan.');
  }
  const filenames = new Set();
  return plan.packages.map(({ name, version }, index) => {
    assert(publicPackage(name));
    const entry = archives.get(name);
    const { pkg, integrity } = validatedArchive(entry, name, version, archiveBytes, filenames);
    assert.equal(entry.filename, `${name.replace(/^@/u, '').replace('/', '-')}-${version}.tgz`,
      'Archive filename differs from the planned package identity.');
    const external = new Map();
    for (const kind of ['dependencies', 'optionalDependencies', 'peerDependencies']) {
      for (const [dependency, range] of Object.entries(pkg[kind] ?? {})) {
        if (dependency !== 'mayura' && !dependency.startsWith('@mayurajs/')) continue;
        const dependencyVersion = source.get(dependency);
        assert(dependencyVersion, `Unknown release dependency: ${dependency}`);
        const admitsSource = dependency === 'mayura' && kind === 'peerDependencies'
          ? typeof range === 'string' && satisfies(dependencyVersion, range)
          : [dependencyVersion, '^' + dependencyVersion].includes(range);
        assert(admitsSource,
          `Wrong dependency version: ${dependency}@${range} does not admit ${dependencyVersion}.`);
        if (selected.has(dependency)) {
          assert(selected.get(dependency).index < index, `Release dependency must be published first: ${dependency}`);
        } else {
          external.set(dependency, dependencyVersion);
        }
      }
    }
    return { ...entry, integrity, externalDependencies: [...external].map(([name, version]) => ({ name, version })) };
  });
}

// Keep the publication contract tied to each matrix member, even when a website-only run passes the same PR gate.
const ciPlatforms = ['ubuntu-latest', 'windows-latest', 'macos-latest'];
const ciNodeVersions = ['22.23.2', '24.14.1'];
const ciShards = [1, 2];
export const FULL_QUALIFICATION_JOBS = Object.freeze([
  'Shared checks', 'runtimes', 'Qualification gate', 'container (22)', 'container (24)',
  ...ciNodeVersions.flatMap(node => ciShards.map(shard => `postgres (${node}, ${shard})`)),
  ...ciPlatforms.flatMap(os => ciNodeVersions.flatMap(node => [
    `consumers (${os}, ${node})`,
    ...ciShards.flatMap(shard => [`Tests (${os}, ${node}, ${shard}/2)`, `Bundle (${os}, ${node}, ${shard}/2)`]),
  ])),
]);

function assertPublishSource(context, events) {
  assert(events.includes(context.event), 'Unsupported publishing event.');
  assert.equal(context.ref, 'refs/heads/main');
  assert.equal(context.workflowRef, 'KartikeyAI/mayura/.github/workflows/release.yml@refs/heads/main');
}

function matchesMainQualification(run, sourceCommit) {
  return run?.name === 'Mayura qualification' && run.path === '.github/workflows/ci.yml'
    && ['push', 'workflow_dispatch'].includes(run.event) && run.head_branch === 'main' && run.head_sha === sourceCommit
    && run.head_repository?.full_name === 'KartikeyAI/mayura' && run.status === 'completed' && run.conclusion === 'success';
}

function hasFullQualification(jobs) {
  if (!Array.isArray(jobs)) return false;
  const results = new Map(jobs.map(job => [job?.name, job?.conclusion]));
  return results.size === jobs.length && FULL_QUALIFICATION_JOBS.every(name => results.get(name) === 'success')
    && jobs.every(job => job?.conclusion === 'success' || (job?.name === 'Website checks' && job.conclusion === 'skipped'));
}

/** Publishing requires the exact current main commit and a complete, successful qualification run. */
export function assertPublishContext(context, run, jobs, main, events = ['workflow_dispatch']) {
  assertPublishSource(context, events);
  assert.equal(main.sha, context.sha, 'Main moved before publication.');
  assert(matchesMainQualification(run, context.sha), 'The qualification run must be an exact-main push or manual run.');
  assert(hasFullQualification(jobs), 'The full framework qualification matrix and gate must pass before publication.');
}

/** Website-only pushes may pass the PR gate; look for a full push or manual run on the same source. */
export async function findPublishQualification(context, github, events = ['workflow_dispatch']) {
  assertPublishSource(context, events);
  const runs = await github(`/actions/workflows/ci.yml/runs?branch=main&head_sha=${context.sha}&status=success&per_page=100`);
  for (const run of runs?.workflow_runs ?? []) {
    if (!matchesMainQualification(run, context.sha)) continue;
    assert(Number.isSafeInteger(run.id) && run.id > 0, 'Invalid qualification run ID.');
    const jobs = await github(`/actions/runs/${run.id}/jobs?per_page=100`);
    assert(Array.isArray(jobs?.jobs) && jobs.jobs.length === jobs.total_count, 'Qualification jobs were truncated or unavailable.');
    if (!hasFullQualification(jobs.jobs)) continue;
    assertPublishContext(context, run, jobs.jobs, await github('/commits/main'), events);
    return run;
  }
  throw new Error('No full framework qualification passed for this commit. Run Mayura qualification manually on main before releasing.');
}
