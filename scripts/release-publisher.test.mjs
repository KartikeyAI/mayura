import assert from 'node:assert/strict';
import { test } from 'node:test';
import { gzipSync } from 'node:zlib';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { assertPreparedRelease, publishRelease, selectFullRelease } from './release-publisher.mjs';
import { assertPublishContext, sha256 } from './release-safety.mjs';
import { assertReleaseReceipt } from './release-finalize.mjs';
import { extensions } from './extensions.mjs';

const names = ['mayura', ...extensions().map(e => e.manifest.name)];
const sourceCommit = 'a'.repeat(40); const version = '1.2.0';
function fixture(at = version, change = () => {}) {
  const archives = new Map();
  const packages = names.map(name => {
    const pkg = { name, version: at, repository: { url: 'git+https://github.com/KartikeyAI/mayura.git' },
      publishConfig: { access: 'public', provenance: true }, ...(name === 'mayura' ? {} : { peerDependencies: { mayura: '^' + at } }) };
    change(pkg);
    const content = Buffer.from(JSON.stringify(pkg)); const header = Buffer.alloc(512);
    header.write('package/package.json'); header.write(content.length.toString(8).padStart(11, '0') + '\0', 124); header.write('0', 156);
    const bytes = gzipSync(Buffer.concat([header, content, Buffer.alloc((512 - content.length % 512) % 512 + 1024)]));
    const filename = name.replace(/[@/]/gu, '') + '.tgz'; archives.set(filename, bytes);
    return { name, version: at, filename, sha256: sha256(bytes) };
  });
  const manifest = { format: 1, status: 'passed', version: at, sourceCommit, packages };
  const read = filename => archives.get(filename);
  return { manifest, read, entries: () => selectFullRelease(manifest, names, at, sourceCommit, read) };
}

function registryFixture(entries, at = version) {
  const tag = at.includes('-') ? 'next' : 'latest';
  const versions = new Map(); const tags = new Map(entries.map(e => [e.name, { latest: '1.1.0', next: '1.2.0-rc.1' }]));
  const uploads = []; let receipt;
  const f = { versions, tags, uploads,
    registry: { version: async name => versions.get(name) ?? null, tags: async name => structuredClone(tags.get(name)) },
    reveal(entry) { versions.set(entry.name, { name: entry.name, version: at, dist: { integrity: entry.integrity, attestations: { provenance: {} } } }); tags.get(entry.name)[tag] = at; },
    upload: async entry => { uploads.push(entry.name); },
    save: value => { receipt = structuredClone(value); }, get receipt() { return receipt; },
    run: options => publishRelease({ entries, version: at, sourceCommit, tag, registry: f.registry, upload: f.upload,
      save: f.save, pause: async () => entries.filter(e => uploads.includes(e.name)).forEach(e => f.reveal(e)), ...options }),
  };
  return f;
}

test('all repository packages are selected; archive, identity and dependency drift are rejected before writing', () => {
  const f = fixture(); assert.equal(names.length, 106); assert.equal(f.entries().length, names.length);
  for (const change of [m => m.packages.pop(), m => m.packages.reverse(), m => m.packages.push(m.packages[0]),
    m => m.packages.at(-1).sha256 = '0'.repeat(64), m => m.packages[0].filename = '../escape.tgz']) {
    const m = structuredClone(f.manifest); change(m);
    assert.throws(() => selectFullRelease(m, names, version, sourceCommit, f.read));
  }
  for (const change of [p => p.scripts = { prepublishOnly: 'unreviewed' }, p => p.repository.url = 'https://example.com/fork',
    p => p.dependencies = { '@mayurajs/missing': version }, p => p.dependencies = { '@mayurajs/provider-openai': version },
    p => p.peerDependencies = { mayura: '^1.1.0' }]) assert.throws(() => fixture(version, change).entries());
  assert.throws(() => selectFullRelease(f.manifest, names, version, 'b'.repeat(40), f.read));
});

test('only the committed release version and its correct distribution channel are admitted', () => {
  assert.doesNotThrow(() => assertPreparedRelease(version, version, 'latest'));
  assert.throws(() => assertPreparedRelease(version, '1.1.0', 'latest'), /release version PR/u);
  for (const [at, tag] of [['1.2.0-rc.2', 'latest'], [version, 'next'], ['../1.2.0', 'latest']]) {
    assert.throws(() => assertPreparedRelease(at, at, tag));
  }
});

test('the CLI denies local publication before reading archives or invoking npm', () => {
  const result = spawnSync(process.execPath, ['scripts/publish-staged.mjs', '--manifest', 'nonexistent-manifest.json', '--tag', 'latest', '--publish'],
    { encoding: 'utf8', windowsHide: true, env: { ...process.env, GITHUB_ACTIONS: 'false', NODE_AUTH_TOKEN: '', NPM_TOKEN: '' } });
  assert.equal(result.status, 1); assert.match(result.stderr, /Live publication requires GitHub Actions/u);
  assert.doesNotMatch(result.stderr, /ENOENT/u);
});

test('manual and automatic releases require green exact-main push CI and the complete aggregate gate', () => {
  const context = { event: 'workflow_run', ref: 'refs/heads/main', sha: sourceCommit,
    workflowRef: 'KartikeyAI/mayura/.github/workflows/release.yml@refs/heads/main' };
  const run = { name: 'Mayura qualification', path: '.github/workflows/ci.yml', event: 'push', head_branch: 'main', head_sha: sourceCommit,
    head_repository: { full_name: 'KartikeyAI/mayura' }, status: 'completed', conclusion: 'success' };
  const jobs = [{ name: 'Qualification gate', conclusion: 'success' }, { name: 'Tests', conclusion: 'success' }];
  const invoke = (c = context, r = run, j = jobs, main = { sha: sourceCommit }) => assertPublishContext(c, r, j, main, ['workflow_dispatch', 'workflow_run']);
  invoke(); invoke({ ...context, event: 'workflow_dispatch' });
  assert.throws(() => invoke({ ...context, event: 'pull_request' }));
  assert.throws(() => invoke(context, run, jobs, { sha: 'moved' }));
  assert.throws(() => invoke(context, { ...run, event: 'pull_request' }));
  for (const conclusion of ['cancelled', 'skipped', 'failure', null]) assert.throws(() => invoke(context, run, [jobs[0], { ...jobs[1], conclusion }]));
});

test('106 uploads tolerate scanning delays, preserve next, and reconcile without replaying uploads', async () => {
  const f = registryFixture(fixture().entries()); const receipt = await f.run();
  assert.equal(receipt.status, 'published'); assert.equal(f.uploads.length, 106); assert.equal(receipt.verified.length, 106);
  for (const tags of f.tags.values()) { assert.equal(tags.latest, version); assert.equal(tags.next, '1.2.0-rc.1'); }
  await f.run({ previous: receipt }); assert.equal(f.uploads.length, 106);
});

test('full prereleases preserve latest while advancing next', async () => {
  const at = '1.2.0-rc.2'; const f = registryFixture(fixture(at).entries(), at);
  await f.run(); for (const tags of f.tags.values()) { assert.equal(tags.latest, '1.1.0'); assert.equal(tags.next, at); }
});

test('wrong existing bytes, missing packages, metadata failures and downgrades fail preflight with no uploads', async () => {
  const entries = fixture().entries();
  for (const scenario of ['wrong-bytes', 'missing-package', 'metadata-error', 'downgrade']) {
    const f = registryFixture(entries);
    if (scenario === 'wrong-bytes') f.versions.set(names.at(-1), { name: names.at(-1), version, dist: { integrity: 'wrong' } });
    if (scenario === 'missing-package') f.tags.delete(names.at(-1));
    if (scenario === 'metadata-error') f.registry.version = async () => { throw new Error('metadata unavailable'); };
    if (scenario === 'downgrade') f.tags.get(names.at(-1)).latest = '1.3.0';
    await assert.rejects(f.run()); assert.equal(f.uploads.length, 0);
  }
});

test('cancellation persists uncertainty and refuses replay or further writes until visibility is reconciled', async () => {
  const entries = fixture().entries(); const f = registryFixture(entries); const controller = new AbortController();
  await assert.rejects(f.run({ signal: controller.signal, upload: async entry => {
    f.uploads.push(entry.name); controller.abort(new Error('cancelled')); throw controller.signal.reason;
  } }));
  assert.equal(f.receipt.uploads[names[0]], 'uncertain');
  await assert.rejects(f.run({ previous: f.receipt }), /Uncertain upload/u); assert.equal(f.uploads.length, 1);
  f.reveal(entries[0]); await f.run({ previous: f.receipt }); assert.equal(f.uploads.length, 106);
});

test('cancelling during a registry polling wait interrupts the wait and preserves accepted writes', { timeout: 1000 }, async () => {
  const f = registryFixture(fixture().entries()); const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 0);
  try {
    await assert.rejects(publishRelease({ entries: fixture().entries(), version, sourceCommit, tag: 'latest',
      registry: f.registry, upload: f.upload, save: f.save, signal: controller.signal }), { name: 'AbortError' });
    assert.equal(f.uploads.length, 106); assert.equal(f.receipt.status, 'awaiting_registry');
  } finally { clearTimeout(timer); }
});

test('accepted writes survive visibility timeouts; recovery rejects changed archives and other-channel movement', async () => {
  const entries = fixture().entries(); const f = registryFixture(entries);
  await assert.rejects(f.run({ deadlineMs: 0, now: () => 0 }), /Registry visibility/u);
  assert.equal(f.receipt.status, 'awaiting_registry'); assert.equal(f.uploads.length, 106);
  const receipt = f.receipt; entries.forEach(e => f.reveal(e));
  await f.run({ previous: receipt }); assert.equal(f.uploads.length, 106);
  const changed = structuredClone(receipt); changed.identities[0].sha256 = 'changed';
  await assert.rejects(f.run({ previous: changed }), /different archives/u);
  const incomplete = structuredClone(receipt); delete incomplete.tags[names.at(-1)];
  await assert.rejects(f.run({ previous: incomplete }), /incomplete tag baselines/u);
  f.tags.get(names[0]).next = '1.3.0-rc.0';
  await assert.rejects(f.run({ previous: receipt }), /Non-target tag/u);
});

test('concurrent target changes stop further writes; an existing version with missing provenance is never reuploaded', async () => {
  const entries = fixture().entries(); const f = registryFixture(entries);
  await assert.rejects(f.run({ upload: async entry => { f.uploads.push(entry.name); f.tags.get(entry.name).latest = '1.3.0'; } }), /Target tag/u);
  assert.equal(f.uploads.length, 1);
  const existing = registryFixture(entries); entries.forEach(e => existing.reveal(e));
  delete existing.versions.get(names[0]).dist.attestations;
  await assert.rejects(existing.run({ deadlineMs: 0, now: () => 0 }), /Registry visibility/u);
  assert.equal(existing.uploads.length, 0);
});

test('tagging requires the complete source-bound published receipt and qualification evidence', async () => {
  const entries = fixture().entries(); const f = registryFixture(entries); const receipt = await f.run();
  const qualification = { sourceCommit, gate: 'success', run: 123 };
  assertReleaseReceipt(receipt, entries, version, sourceCommit, qualification);
  for (const change of [r => r.status = 'awaiting_registry', r => r.verified.pop(), r => r.verified.push(names[0]),
    r => r.sourceCommit = 'other', r => r.identities[0].sha256 = 'changed', r => delete r.uploads[names[0]]]) {
    const bad = structuredClone(receipt); change(bad); assert.throws(() => assertReleaseReceipt(bad, entries, version, sourceCommit, qualification));
  }
  assert.throws(() => assertReleaseReceipt(receipt, entries, version, sourceCommit, { ...qualification, gate: 'failure' }));
});

test('full release workflow preserves immutable recovery and never commits, rebases or pushes main', () => {
  const workflow = readFileSync(new URL('../.github/workflows/release.yml', import.meta.url), 'utf8');
  const full = workflow.split(/^  release:\s*$/mu)[1].split(/^  prerelease-22:/mu)[0];
  assert.match(full, /environment: release/u); assert.match(full, /id-token: write/u); assert.match(full, /actions: read/u);
  assert.match(full, /release-finalize\.mjs --prepared/u); assert.match(full, /release-finalize\.mjs --published/u);
  assert.match(full, /run-id: \$\{\{ github\.run_id \}\}/u);
  assert.match(full, /if: always\(\)/u); assert.match(full, /full-release\/receipt\.json/u);
  assert.match(full, /steps\.recover\.outcome == 'success'/u);
  assert.doesNotMatch(full, /version\.mjs set|git commit|git rebase|HEAD:main|git push origin main|secrets\.NPM|full-release\/\*\*/u);
  assert.match(workflow, /dry_run:/u); assert.match(workflow, /current" = "\$VERSION/u);
});
