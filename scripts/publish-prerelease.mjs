// Publish the reviewed 22-package prerelease set through release.yml's protected OIDC job.
// Dry run: node scripts/publish-prerelease.mjs --manifest <path> --version <prerelease>
// Publishing additionally requires --publish, qualified main, and GitHub Actions OIDC credentials.
import assert from 'node:assert/strict';
import { selectReleaseArchives, assertPublishContext } from './release-safety.mjs';
export { assertPublishContext } from './release-safety.mjs';
import { execFileSync, spawn } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';


const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
/** Preserve the scoped RC contract while sharing archive validation with full releases. */
export function selectPrerelease(manifest, scope, version, sourceCommit, archiveBytes) {
  assert(/^1\.2\.0-rc\.[1-9]\d*$/u.test(version), 'This lane accepts only 1.2.0 RCs after rc.0.');
  assert.equal(scope.format, 1);
  assert.equal(scope.packages.length, 22);
  assert.equal(new Set(scope.packages).size, 22);
  assert.deepEqual(scope.packages.slice(0, 2), ['mayura', '@mayurajs/provider-openai']);
  return selectReleaseArchives(manifest, scope.packages, version, sourceCommit, archiveBytes);
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
