// Publish the reviewed 22-package prerelease set through release.yml's protected OIDC job.
// Dry run: node scripts/publish-prerelease.mjs --manifest <path> --version <prerelease>
// Publishing additionally requires --publish, qualified main, and GitHub Actions OIDC credentials.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const digest = (bytes, algorithm = 'sha256', encoding = 'hex') => createHash(algorithm).update(bytes).digest(encoding);
const integrity = bytes => 'sha512-' + digest(bytes, 'sha512', 'base64');

/** Read only the manifest from a bounded tarball; never extract or execute its contents. */
function packageManifest(bytes) {
  const tar = gunzipSync(bytes, { maxOutputLength: 128 * 1024 * 1024 });
  for (let cursor = 0; cursor + 512 <= tar.length;) {
    const header = tar.subarray(cursor, cursor + 512);
    if (header.every(byte => byte === 0)) break;
    const name = header.subarray(0, 100).toString().replace(/\0.*$/su, '');
    const size = Number.parseInt(header.subarray(124, 136).toString().trim(), 8);
    assert(Number.isSafeInteger(size) && size >= 0 && cursor + 512 + size <= tar.length, 'Invalid archive member.');
    if (name === 'package/package.json') return JSON.parse(tar.subarray(cursor + 512, cursor + 512 + size));
    cursor += 512 + Math.ceil(size / 512) * 512;
  }
  throw new Error('Archive has no package.json.');
}

/** Validate the entire allowlisted dependency closure and every archive before the first registry write. */
export function selectPrerelease(manifest, scope, version, sourceCommit, archiveBytes) {
  assert(/^1\.2\.0-rc\.[1-9]\d*$/u.test(version), 'This lane accepts only 1.2.0 RCs after rc.0.');
  assert.equal(scope.format, 1);
  assert.equal(scope.packages.length, 22);
  assert.equal(new Set(scope.packages).size, 22);
  assert.deepEqual(scope.packages.slice(0, 2), ['mayura', '@mayurajs/provider-openai']);
  assert(scope.packages.every(name => name === 'mayura' || /^@mayurajs\/[a-z0-9-]+$/u.test(name)));
  assert.equal(manifest.format, 1);
  assert.equal(manifest.status, 'passed');
  assert.equal(manifest.version, version);
  assert.equal(manifest.sourceCommit, sourceCommit, 'Archives do not belong to this source commit.');
  const inventory = new Map(manifest.packages.map(entry => [entry.name, entry]));
  assert.equal(inventory.size, manifest.packages.length, 'Duplicate archive identities.');
  return scope.packages.map(name => {
    const entry = inventory.get(name);
    assert(entry, `Missing selected archive: ${name}`);
    assert.equal(entry.version, version);
    assert(/^[a-zA-Z0-9][a-zA-Z0-9._-]*\.tgz$/u.test(entry.filename), 'Unsafe archive filename.');
    assert(/^[a-f0-9]{64}$/u.test(entry.sha256));
    const bytes = archiveBytes(entry.filename);
    assert.equal(digest(bytes), entry.sha256, `Archive changed: ${name}`);
    const pkg = packageManifest(bytes);
    assert.equal(pkg.name, name);
    assert.equal(pkg.version, version);
    assert.equal(pkg.repository?.url, 'git+https://github.com/KartikeyAI/mayura.git');
    assert.equal(pkg.private, undefined);
    assert.equal(pkg.scripts, undefined);
    assert.equal(pkg.publishConfig?.access, 'public');
    assert.equal(pkg.publishConfig?.provenance, true);
    for (const [dependency, range] of Object.entries({ ...pkg.dependencies, ...pkg.optionalDependencies, ...pkg.peerDependencies })) {
      if (dependency === 'mayura' || dependency.startsWith('@mayurajs/')) {
        assert(scope.packages.includes(dependency), `Missing prerelease dependency: ${dependency}`);
        assert([version, '^' + version].includes(range), `Wrong dependency version: ${dependency}`);
      }
    }
    return { ...entry, integrity: integrity(bytes) };
  });
}

/** A manual dispatch still has to publish the exact, fully qualified main commit. */
export function assertPublishContext(context, run, jobs, main) {
  assert.equal(context.event, 'workflow_dispatch');
  assert.equal(context.ref, 'refs/heads/main');
  assert.equal(context.workflowRef, 'KartikeyAI/mayura/.github/workflows/release.yml@refs/heads/main');
  assert.equal(main.sha, context.sha, 'Main moved before publication.');
  assert.equal(run.name, 'Mayura qualification');
  assert.equal(run.path, '.github/workflows/ci.yml');
  assert.equal(run.event, 'push');
  assert.equal(run.head_branch, 'main');
  assert.equal(run.head_sha, context.sha);
  assert.equal(run.head_repository?.full_name, 'KartikeyAI/mayura');
  assert.equal(run.status, 'completed');
  assert.equal(run.conclusion, 'success');
  const gates = jobs.filter(job => job.name === 'Qualification gate');
  assert.equal(gates.length, 1);
  assert.equal(gates[0].conclusion, 'success');
  assert(jobs.every(job => job.conclusion === 'success'), 'A qualification job did not pass.');
}

/** Accepted or uncertain uploads are reconciled, never replayed after a crash or cancellation. */
export async function publishPrerelease({ entries, version, sourceCommit, registry, upload, save, previous,
  signal, pause = () => new Promise(done => setTimeout(done, 15_000)), now = Date.now,
  deadlineMs = 20 * 60_000, progress = () => {} }) {
  const identities = entries.map(({ name, sha256 }) => ({ name, sha256 }));
  const receipt = previous ?? { format: 1, version, sourceCommit, tag: 'next', identities, latest: {}, uploads: {}, verified: [] };
  assert.equal(receipt.format, 1);
  assert.equal(receipt.version, version);
  assert.equal(receipt.sourceCommit, sourceCommit);
  assert.equal(receipt.tag, 'next');
  assert.deepEqual(receipt.identities, identities, 'Recovered receipt belongs to different archives.');
  const checkAbort = () => signal?.throwIfAborted();
  // All packages must already exist, preventing npm's automatic first-publish latest assignment.
  for (const entry of entries) {
    checkAbort();
    const baseline = await registry.version(entry.name, '1.2.0-rc.0');
    assert.equal(baseline?.name, entry.name, `Missing rc.0 bootstrap: ${entry.name}`);
    assert.equal(baseline?.version, '1.2.0-rc.0');
    const tags = await registry.tags(entry.name);
    assert(typeof tags?.latest === 'string' && tags.latest.length > 0, 'Existing latest tag required.');
    if (Object.hasOwn(receipt.latest, entry.name)) assert.equal(tags.latest, receipt.latest[entry.name], 'Latest changed since the previous attempt.');
    else receipt.latest[entry.name] = tags.latest;
    const existing = await registry.version(entry.name, version);
    if (existing) assert.equal(existing.dist?.integrity, entry.integrity, 'An existing version has different archive bytes.');
    else if (receipt.uploads[entry.name] && receipt.uploads[entry.name] !== 'accepted') {
      throw new Error(`Uncertain upload is not yet visible: ${entry.name}; reconcile it before any further uploads.`);
    }
  }
  save(receipt);
  for (const entry of entries) {
    checkAbort();
    assert.equal((await registry.tags(entry.name)).latest, receipt.latest[entry.name], `Latest changed: ${entry.name}`);
    const existing = await registry.version(entry.name, version);
    if (existing) {
      assert.equal(existing.dist?.integrity, entry.integrity);
      continue;
    }
    if (receipt.uploads[entry.name]) continue;
    receipt.uploads[entry.name] = 'attempting';
    save(receipt); // Persist before starting npm: a crash leaves an uncertain result, never a license to replay.
    try {
      await upload(entry, signal);
      receipt.uploads[entry.name] = 'accepted';
      save(receipt);
      progress(`${entry.name}: OIDC upload accepted`);
    } catch (error) {
      receipt.uploads[entry.name] = 'uncertain';
      save(receipt);
      throw error;
    }
    assert.equal((await registry.tags(entry.name)).latest, receipt.latest[entry.name], `Latest changed: ${entry.name}`);
  }
  const deadline = now() + deadlineMs;
  // Resumed receipts are always checked again; prior success is not a substitute for current registry state.
  receipt.verified = [];
  while (receipt.verified.length < entries.length) {
    for (const entry of entries) {
      checkAbort();
      const tags = await registry.tags(entry.name);
      assert.equal(tags?.latest, receipt.latest[entry.name], `Latest changed: ${entry.name}`);
      const published = await registry.version(entry.name, version);
      if (!published) continue;
      assert.equal(published.dist?.integrity, entry.integrity, `Published archive mismatch: ${entry.name}`);
      if (tags.next !== version || !published.dist.attestations?.provenance) continue;
      if (!receipt.verified.includes(entry.name)) receipt.verified.push(entry.name);
    }
    receipt.status = receipt.verified.length === entries.length ? 'published' : 'awaiting_registry';
    save(receipt);
    progress(`${receipt.verified.length}/${entries.length} versions, provenance and unchanged latest tags verified`);
    if (receipt.status === 'published') break;
    assert(now() < deadline, 'Registry visibility is still pending; recover the receipt and reconcile without re-uploading.');
    checkAbort();
    await pause(signal);
  }
  return receipt;
}

async function main() {
  const args = process.argv.slice(2);
  assert(args.length === 4 || args.length === 5, 'Usage: --manifest <path> --version <rc> [--publish]');
  assert.equal(args[0], '--manifest'); assert.equal(args[2], '--version');
  assert(args.length === 4 || args[4] === '--publish');
  const publish = args[4] === '--publish'; const version = args[3];
  const sourceCommit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
  const output = join(root, '.artifacts', 'prerelease-22'); mkdirSync(output, { recursive: true });
  const frozenManifest = join(output, 'release-manifest.json');
  const manifestPath = existsSync(frozenManifest) ? frozenManifest : resolve(args[1]);
  const manifest = JSON.parse(readFileSync(manifestPath));
  const scope = JSON.parse(readFileSync(join(root, 'compatibility', 'prerelease-22.json')));
  const entries = selectPrerelease(manifest, scope, version, sourceCommit, filename => readFileSync(join(dirname(manifestPath), 'tarballs', filename)));
  mkdirSync(join(output, 'tarballs'), { recursive: true });
  if (manifestPath !== frozenManifest) {
    for (const entry of entries) copyFileSync(join(dirname(manifestPath), 'tarballs', entry.filename), join(output, 'tarballs', entry.filename));
    writeFileSync(frozenManifest, JSON.stringify({ ...manifest, packages: entries }, null, 2));
  }
  const controller = new AbortController();
  for (const event of ['SIGTERM', 'SIGINT']) process.once(event, () => controller.abort(new Error('Publication cancelled.')));
  const npmEnv = { ...process.env, NODE_AUTH_TOKEN: '', NPM_TOKEN: '', npm_config_userconfig: join(output, 'empty.npmrc') };
  delete npmEnv.NPM_CONFIG_USERCONFIG;
  writeFileSync(npmEnv.npm_config_userconfig, 'registry=https://registry.npmjs.org/\n');
  // Invoke npm through Node rather than Windows shell shims; archive paths may contain spaces.
  const npmCli = [process.env.MAYURA_NPM_CLI, join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    resolve(dirname(process.execPath), '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js')]
    .filter(Boolean).find(path => existsSync(path));
  assert(npmCli, 'Set MAYURA_NPM_CLI to the absolute npm-cli.js path.');
  const upload = (entry, signal) => new Promise((done, fail) => {
    const child = spawn(process.execPath, [npmCli, 'publish', join(output, 'tarballs', entry.filename), '--access', 'public', '--tag', 'next',
      '--ignore-scripts', '--registry=https://registry.npmjs.org/', '--fetch-retries=0', '--fetch-timeout=30000',
      ...(publish ? ['--provenance'] : ['--dry-run', '--offline', '--provenance=false'])], {
      cwd: output, env: npmEnv, stdio: ['ignore', 'inherit', 'inherit'], signal, windowsHide: true,
    });
    child.once('error', () => fail(new Error('npm could not complete; receipt preserves the uncertain upload.')));
    child.once('close', code => code === 0 ? done() : fail(new Error('npm stopped; reconcile the receipt before another attempt.')));
  });
  if (!publish) {
    for (const entry of entries) await upload(entry, controller.signal);
    console.log(JSON.stringify({ status: 'dry-run', version, packages: entries.length, sourceCommit }));
    return;
  }
  assert.equal(process.env.GITHUB_ACTIONS, 'true', 'Publishing is only allowed in GitHub Actions.');
  assert.equal(process.env.GITHUB_SHA, sourceCommit, 'Checkout differs from the dispatched commit.');
  assert(process.env.ACTIONS_ID_TOKEN_REQUEST_URL && process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN, 'OIDC identity is required.');
  assert(process.env.GITHUB_TOKEN, 'A read-only GitHub token is required to verify qualification.');
  const json = async (url, headers = {}) => {
    const response = await fetch(url, { headers, signal: AbortSignal.any([controller.signal, AbortSignal.timeout(30_000)]), redirect: 'error' });
    if (response.status === 404) return null;
    assert.equal(response.status, 200, `Metadata request failed (${response.status}).`);
    return response.json();
  };
  const api = 'https://api.github.com/repos/KartikeyAI/mayura';
  const headers = { authorization: 'Bearer ' + process.env.GITHUB_TOKEN, accept: 'application/vnd.github+json' };
  const runs = await json(`${api}/actions/runs?head_sha=${sourceCommit}&event=push&per_page=100`, headers);
  const run = runs?.workflow_runs.find(item => item.name === 'Mayura qualification' && item.path === '.github/workflows/ci.yml' && item.conclusion === 'success');
  assert(run, 'No green push qualification exists for this commit.');
  const jobs = await json(`${api}/actions/runs/${run.id}/jobs?per_page=100`, headers);
  assert.equal(jobs.jobs.length, jobs.total_count, 'Qualification jobs were truncated.');
  const mainCommit = await json(`${api}/commits/main`, headers);
  assertPublishContext({ event: process.env.GITHUB_EVENT_NAME, ref: process.env.GITHUB_REF,
    workflowRef: process.env.GITHUB_WORKFLOW_REF, sha: sourceCommit }, run, jobs.jobs, mainCommit);
  writeFileSync(join(output, 'qualification.json'), JSON.stringify({ run: run.id, sourceCommit, gate: 'success' }, null, 2));
  const registry = {
    version: (name, at) => json(`https://registry.npmjs.org/${encodeURIComponent(name)}/${at}?verify=${Date.now()}`),
    tags: name => json(`https://registry.npmjs.org/-/package/${encodeURIComponent(name)}/dist-tags?verify=${Date.now()}`),
  };
  const receiptPath = join(output, 'receipt.json');
  const save = receipt => { writeFileSync(receiptPath + '.tmp', JSON.stringify(receipt, null, 2)); renameSync(receiptPath + '.tmp', receiptPath); };
  await publishPrerelease({ entries, version, sourceCommit, registry, upload, save,
    previous: existsSync(receiptPath) ? JSON.parse(readFileSync(receiptPath)) : undefined,
    signal: controller.signal, progress: console.log });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
