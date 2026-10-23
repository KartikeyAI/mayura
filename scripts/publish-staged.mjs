// Full release CLI: offline dry run unless --publish, which requires qualified main and release.yml OIDC.
// node scripts/publish-staged.mjs --manifest <release-manifest.json> --tag <latest|next> [--publish]
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { extensions } from './extensions.mjs';
import { assertPublishContext } from './release-safety.mjs';
import { assertPreparedRelease, selectFullRelease, publishRelease } from './release-publisher.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = path => JSON.parse(readFileSync(path, 'utf8'));

async function main() {
  const args = process.argv.slice(2); const options = {}; let publish = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--publish') { assert(!publish); publish = true; }
    else {
      assert(['--manifest', '--tag'].includes(args[i]) && args[i + 1] && !Object.hasOwn(options, args[i]), 'Use --manifest <path> --tag <latest|next> [--publish].');
      const key = args[i]; options[key] = args[++i];
    }
  }
  assert(options['--manifest'], 'An explicit release manifest is required.');
  const tag = options['--tag'];
  const sourceCommit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
  const output = join(root, '.artifacts', 'full-release');
  const frozenPath = join(output, 'release-manifest.json');
  const manifestPath = publish && existsSync(frozenPath) ? frozenPath : resolve(options['--manifest']);
  const manifest = read(manifestPath); const version = manifest.version;
  assertPreparedRelease(version, read(join(root, 'package.json')).version, tag);
  const names = ['mayura', ...extensions().map(e => e.manifest.name)];
  const entries = selectFullRelease(manifest, names, version, sourceCommit,
    filename => readFileSync(join(dirname(manifestPath), 'tarballs', filename)));
  if (publish) {
    assert.equal(process.env.GITHUB_ACTIONS, 'true', 'Live publication requires GitHub Actions.');
    assert.equal(process.env.SOURCE_SHA, sourceCommit, 'Checkout differs from the qualified source.');
    if (process.env.GITHUB_EVENT_NAME === 'workflow_dispatch') assert.equal(process.env.GITHUB_SHA, sourceCommit);
    assert(process.env.ACTIONS_ID_TOKEN_REQUEST_URL && process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN, 'OIDC identity is required.');
    assert(process.env.GITHUB_TOKEN, 'GitHub qualification token is required.');
    execFileSync('git', ['diff', '--exit-code', 'HEAD', '--'], { cwd: root, stdio: 'ignore' });
    // Detect conflicting tags before the first npm write, including when resuming a partial release.
    const tags = execFileSync('git', ['tag', '--list', `v${version}`], { cwd: root, encoding: 'utf8' }).trim();
    if (tags) assert.equal(execFileSync('git', ['rev-parse', `v${version}^{commit}`], { cwd: root, encoding: 'utf8' }).trim(), sourceCommit, 'Release tag points at a different commit.');
  }
  mkdirSync(output, { recursive: true });
  if (publish && manifestPath !== frozenPath) {
    mkdirSync(join(output, 'tarballs'), { recursive: true });
    for (const entry of entries) copyFileSync(join(dirname(manifestPath), 'tarballs', entry.filename), join(output, 'tarballs', entry.filename));
    writeFileSync(frozenPath, JSON.stringify({ ...manifest, packages: entries }, null, 2));
  }
  const controller = new AbortController();
  for (const event of ['SIGINT', 'SIGTERM']) process.once(event, () => controller.abort(new Error('Release cancelled.')));
  const json = async (url, headers = {}) => {
    const response = await fetch(url, { headers, signal: AbortSignal.any([controller.signal, AbortSignal.timeout(30_000)]), redirect: 'error' });
    if (response.status === 404) return null;
    assert.equal(response.status, 200, `Metadata request failed (${response.status}).`); return response.json();
  };
  if (publish) {
    const api = 'https://api.github.com/repos/KartikeyAI/mayura';
    const headers = { authorization: 'Bearer ' + process.env.GITHUB_TOKEN, accept: 'application/vnd.github+json' };
    const runs = await json(`${api}/actions/runs?head_sha=${sourceCommit}&event=push&per_page=100`, headers);
    const run = runs?.workflow_runs.find(r => r.name === 'Mayura qualification' && r.path === '.github/workflows/ci.yml' && r.conclusion === 'success');
    assert(run, 'No green push qualification exists for this commit.');
    const jobs = await json(`${api}/actions/runs/${run.id}/jobs?per_page=100`, headers);
    assert.equal(jobs.jobs.length, jobs.total_count, 'Qualification jobs were truncated.');
    assertPublishContext({ event: process.env.GITHUB_EVENT_NAME, ref: process.env.GITHUB_REF,
      workflowRef: process.env.GITHUB_WORKFLOW_REF, sha: sourceCommit }, run, jobs.jobs,
    await json(`${api}/commits/main`, headers), ['workflow_dispatch', 'workflow_run']);
    writeFileSync(join(output, 'qualification.json'), JSON.stringify({ run: run.id, sourceCommit, gate: 'success' }, null, 2));
  }
  const npmCli = [process.env.MAYURA_NPM_CLI, join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    resolve(dirname(process.execPath), '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js')].filter(Boolean).find(existsSync);
  assert(npmCli, 'Set MAYURA_NPM_CLI to the absolute npm-cli.js path.');
  // No user login/configuration fallback. Both live and offline operations receive an empty user config.
  const npmEnv = { ...process.env, NODE_AUTH_TOKEN: '', NPM_TOKEN: '', npm_config_userconfig: join(output, 'empty.npmrc') };
  delete npmEnv.NPM_CONFIG_USERCONFIG;
  writeFileSync(npmEnv.npm_config_userconfig, 'registry=https://registry.npmjs.org/\n');
  const upload = (entry, signal) => new Promise((done, fail) => {
    const archive = join(publish ? output : dirname(manifestPath), 'tarballs', entry.filename);
    const child = spawn(process.execPath, [npmCli, 'publish', archive, '--tag', tag, '--access', 'public', '--ignore-scripts',
      '--registry=https://registry.npmjs.org/', '--fetch-retries=0', '--fetch-timeout=30000',
      ...(publish ? ['--provenance'] : ['--dry-run', '--offline', '--provenance=false'])],
    { cwd: output, env: npmEnv, signal, stdio: ['ignore', 'inherit', 'inherit'], windowsHide: true });
    child.once('error', () => fail(new Error('npm could not complete; reconcile the receipt before retrying.')));
    child.once('close', code => code === 0 ? done() : fail(new Error('npm stopped; reconcile the receipt before retrying.')));
  });
  if (!publish) {
    for (const entry of entries) await upload(entry, controller.signal);
    console.log(JSON.stringify({ status: 'dry-run', version, tag, sourceCommit, packages: entries.length })); return;
  }
  const receiptPath = join(output, 'receipt.json');
  await publishRelease({ entries, version, sourceCommit, tag, signal: controller.signal, upload, progress: console.log,
    registry: { version: (name, at) => json(`https://registry.npmjs.org/${encodeURIComponent(name)}/${at}?verify=${Date.now()}`),
      tags: name => json(`https://registry.npmjs.org/-/package/${encodeURIComponent(name)}/dist-tags?verify=${Date.now()}`) },
    previous: existsSync(receiptPath) ? read(receiptPath) : undefined,
    save: receipt => { writeFileSync(receiptPath + '.tmp', JSON.stringify(receipt, null, 2)); renameSync(receiptPath + '.tmp', receiptPath); } });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
