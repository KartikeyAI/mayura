import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { assertPublishContext, publishPrerelease, selectPrerelease } from './publish-prerelease.mjs';

const scope = JSON.parse(readFileSync(new URL('../compatibility/prerelease-22.json', import.meta.url)));
const version = '1.2.0-rc.1'; const sourceCommit = 'a'.repeat(40);
function fixture(change = () => {}) {
  const archives = new Map(); const packages = [];
  for (const name of scope.packages) {
    const pkg = { name, version, repository: { url: 'git+https://github.com/KartikeyAI/mayura.git' },
      publishConfig: { access: 'public', provenance: true }, ...(name === 'mayura' ? {} : { peerDependencies: { mayura: '^' + version } }) };
    change(pkg);
    const content = Buffer.from(JSON.stringify(pkg)); const header = Buffer.alloc(512);
    header.write('package/package.json'); header.write(content.length.toString(8).padStart(11, '0') + '\0', 124);
    header.write('0', 156); header.fill(32, 148, 156);
    header.write([...header].reduce((sum, byte) => sum + byte, 0).toString(8).padStart(6, '0') + '\0 ', 148);
    const bytes = gzipSync(Buffer.concat([header, content, Buffer.alloc((512 - content.length % 512) % 512 + 1024)]));
    const filename = name.replace(/[@/]/gu, '') + '.tgz'; archives.set(filename, bytes);
    packages.push({ name, version, filename, sha256: createHash('sha256').update(bytes).digest('hex') });
  }
  const manifest = { format: 1, status: 'passed', version, sourceCommit, packages };
  return { manifest, read: filename => archives.get(filename) };
}
const entries = () => { const f = fixture(); return selectPrerelease(f.manifest, scope, version, sourceCommit, f.read); };

test('the complete reviewed set is selected and archive or dependency drift fails before publication', () => {
  assert.deepEqual(entries().map(entry => entry.name), scope.packages);
  const f = fixture();
  for (const at of ['1.2.0', '1.2.0-rc.0', '1.2.0-rc.1;echo']) assert.throws(() => selectPrerelease(f.manifest, scope, at, sourceCommit, f.read));
  assert.throws(() => selectPrerelease(f.manifest, scope, version, 'b'.repeat(40), f.read));
  for (const change of [m => m.packages.pop(), m => m.packages[0].sha256 = '0'.repeat(64),
    m => m.packages[0].filename = '../wrong.tgz', m => m.packages.push(m.packages[0])]) {
    const m = structuredClone(f.manifest); change(m); assert.throws(() => selectPrerelease(m, scope, version, sourceCommit, f.read));
  }
  for (const change of [p => p.scripts = { prepublishOnly: 'unreviewed' }, p => p.repository.url = 'git+https://example.com/fork.git',
    p => p.dependencies = { '@mayurajs/not-selected': version }]) {
    const bad = fixture(change); assert.throws(() => selectPrerelease(bad.manifest, scope, version, sourceCommit, bad.read));
  }
});

test('a manual release requires exact-main push qualification and every gate/job to pass', () => {
  const context = { event: 'workflow_dispatch', ref: 'refs/heads/main', sha: sourceCommit,
    workflowRef: 'KartikeyAI/mayura/.github/workflows/release.yml@refs/heads/main' };
  const run = { name: 'Mayura qualification', path: '.github/workflows/ci.yml', event: 'push', head_branch: 'main', head_sha: sourceCommit,
    head_repository: { full_name: 'KartikeyAI/mayura' }, status: 'completed', conclusion: 'success' };
  const jobs = [{ name: 'Qualification gate', conclusion: 'success' }, { name: 'Tests', conclusion: 'success' }];
  assert.doesNotThrow(() => assertPublishContext(context, run, jobs, { sha: sourceCommit }));
  assert.throws(() => assertPublishContext({ ...context, ref: 'refs/heads/other' }, run, jobs, { sha: sourceCommit }));
  assert.throws(() => assertPublishContext(context, run, jobs, { sha: 'moved' }));
  assert.throws(() => assertPublishContext(context, { ...run, event: 'pull_request' }, jobs, { sha: sourceCommit }));
  assert.throws(() => assertPublishContext(context, { ...run, path: '.github/workflows/other.yml' }, jobs, { sha: sourceCommit }));
  for (const conclusion of ['failure', 'skipped', 'cancelled', null]) {
    assert.throws(() => assertPublishContext(context, run, [jobs[0], { ...jobs[1], conclusion }], { sha: sourceCommit }));
  }
  assert.throws(() => assertPublishContext(context, run, [], { sha: sourceCommit }));
});

function registryFixture(selected) {
  const tags = new Map(selected.map((entry, index) => [entry.name, { latest: index < 2 ? '1.1.0' : '1.2.0-rc.0', next: '1.2.0-rc.0' }]));
  const versions = new Map(); const uploaded = [];
  return { tags, versions, uploaded, registry: {
    tags: async name => structuredClone(tags.get(name)),
    version: async (name, at) => at === '1.2.0-rc.0' ? { name, version: at } : versions.get(name) ?? null,
  }, upload: async entry => { uploaded.push(entry.name); }, reveal() {
    for (const entry of selected.filter(entry => uploaded.includes(entry.name))) {
      versions.set(entry.name, { name: entry.name, version, dist: { integrity: entry.integrity, attestations: { provenance: {} } } });
      tags.get(entry.name).next = version;
    }
  } };
}

test('accepted uploads survive scanning delays and recovery preserves all existing latest tags', async () => {
  const selected = entries(); const f = registryFixture(selected); let receipt;
  const invoke = previous => publishPrerelease({ entries: selected, version, sourceCommit, registry: f.registry,
    upload: f.upload, save: value => { receipt = structuredClone(value); }, previous,
    pause: async () => f.reveal() });
  const result = await invoke();
  assert.equal(result.status, 'published'); assert.equal(result.verified.length, 22);
  assert.deepEqual(f.uploaded, scope.packages);
  for (const [name, tags] of f.tags) { assert.equal(tags.latest, receipt.latest[name]); assert.equal(tags.next, version); }
  await invoke(receipt); assert.equal(f.uploaded.length, 22, 'Recovery must not upload again.');
});

test('missing bootstrap, wrong published bytes, or changed latest tags fail without another upload', async () => {
  const selected = entries();
  for (const scenario of ['missing-bootstrap', 'wrong-bytes', 'changed-latest']) {
    const f = registryFixture(selected); let saved;
    const registry = { ...f.registry };
    if (scenario === 'missing-bootstrap') registry.version = async () => null;
    if (scenario === 'wrong-bytes') f.versions.set(selected[0].name, { dist: { integrity: 'different' } });
    if (scenario === 'changed-latest') {
      f.upload = async entry => { f.uploaded.push(entry.name); f.tags.get(entry.name).latest = version; f.reveal(); };
    }
    await assert.rejects(publishPrerelease({ entries: selected, version, sourceCommit, registry, upload: f.upload,
      save: r => { saved = structuredClone(r); }, pause: async () => f.reveal() }));
    assert.equal(f.uploaded.length, scenario === 'changed-latest' ? 1 : 0);
    if (saved) assert.notEqual(saved.status, 'published');
  }
});

test('cancellation records an uncertain upload and recovery refuses replay or further writes', async () => {
  const selected = entries(); const f = registryFixture(selected); const controller = new AbortController(); let receipt;
  const save = r => { receipt = structuredClone(r); };
  await assert.rejects(publishPrerelease({ entries: selected, version, sourceCommit, registry: f.registry, save,
    signal: controller.signal, upload: async entry => { f.uploaded.push(entry.name); controller.abort(new Error('cancelled')); throw controller.signal.reason; } }));
  assert.equal(receipt.uploads[selected[0].name], 'uncertain');
  await assert.rejects(publishPrerelease({ entries: selected, version, sourceCommit, registry: f.registry,
    save, previous: receipt, upload: f.upload }), /Uncertain upload/u);
  assert.equal(f.uploaded.length, 1);
});

test('visibility timeout preserves accepted receipts; recovery neither reuploads nor rebases latest', async () => {
  const selected = entries(); const f = registryFixture(selected); let receipt;
  const save = r => { receipt = structuredClone(r); };
  await assert.rejects(publishPrerelease({ entries: selected, version, sourceCommit, registry: f.registry,
    upload: f.upload, save, now: () => 0, deadlineMs: 0 }), /Registry visibility/u);
  assert.equal(receipt.status, 'awaiting_registry');
  assert.equal(Object.values(receipt.uploads).filter(state => state === 'accepted').length, 22);
  const old = structuredClone(receipt); f.reveal();
  const result = await publishPrerelease({ entries: selected, version, sourceCommit, registry: f.registry,
    upload: f.upload, save, previous: receipt });
  assert.equal(result.status, 'published'); assert.equal(f.uploaded.length, 22);
  f.tags.get(selected[0].name).latest = version;
  await assert.rejects(publishPrerelease({ entries: selected, version, sourceCommit, registry: f.registry,
    upload: f.upload, save, previous: old }), /Latest changed/u);
  assert.equal(f.uploaded.length, 22);
});

test('the selected workflow job uses the protected OIDC environment without global release writes', () => {
  const workflow = readFileSync(new URL('../.github/workflows/release.yml', import.meta.url), 'utf8');
  const scoped = workflow.split(/^  prerelease-22:\s*$/mu)[1];
  assert(scoped); assert.match(scoped, /environment: release/u); assert.match(scoped, /id-token: write/u);
  assert.match(scoped, /contents: read/u); assert.match(scoped, /publish-prerelease\.mjs/u);
  assert.match(scoped, /fetch-depth: 0/u);
  assert.doesNotMatch(scoped, /git push|gh release|publish-staged\.mjs|secrets\.NPM/u);
  assert.match(workflow.split(/^  release:\s*$/mu)[1].split(/^  prerelease-22:/mu)[0], /inputs\.package_set != 'prerelease-22'/u);
});
