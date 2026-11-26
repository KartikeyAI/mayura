// Offline dry run unless --publish, which requires qualified main and release.yml OIDC.
// node scripts/publish-staged.mjs --plan <plan> --manifest <release-manifest.json> --tag <latest|next>
//   [--output .artifacts/<fresh-rehearsal-directory> | --publish]
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { extensions } from './extensions.mjs';
import { findPublishQualification, sha256 } from './release-safety.mjs';
import { readReleasePlan } from './package-release-plan.mjs';
import { assertPlannedPreflight, assertPreparedRelease, publicationIdentities, selectFullRelease, selectPlannedRelease, publishRelease } from './release-publisher.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = path => JSON.parse(readFileSync(path, 'utf8'));
const artifacts = join(root, '.artifacts');
const usage = 'Use [--plan <path>] --manifest <path> --tag <latest|next> [--output .artifacts/<name> | --publish].';

async function main() {
  const args = process.argv.slice(2); const options = {}; let publish = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--publish') { assert(!publish); publish = true; }
    else {
      assert(['--manifest', '--plan', '--tag', '--output'].includes(args[i]) && args[i + 1] && !Object.hasOwn(options, args[i]), usage);
      const key = args[i]; options[key] = args[++i];
    }
  }
  const outputOverride = options['--output'];
  if (publish) {
    assert(!outputOverride, 'Only a dry run can select a different output directory.');
    assert.equal(process.env.GITHUB_ACTIONS, 'true', 'Live publication requires GitHub Actions.');
  }
  assert(options['--manifest'], 'An explicit release manifest is required.');
  const output = outputOverride ? resolve(outputOverride) : join(artifacts, 'full-release');
  if (outputOverride) {
    assert(dirname(output) === artifacts && /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/u.test(basename(output)),
      'Choose a fresh rehearsal directory directly under .artifacts.');
    assert(!existsSync(output), 'The rehearsal output directory already exists.');
  }
  const tag = options['--tag'];
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
  const sourceCommit = git('rev-parse', 'HEAD');
  const reviewedPlan = options['--plan'] ? readReleasePlan(options['--plan']) : undefined;
  if (reviewedPlan) assert.equal(reviewedPlan.tag, tag, 'Distribution tag does not match the release plan.');
  const frozenPath = join(output, 'release-manifest.json');
  const sourceManifestPath = resolve(options['--manifest']);
  const manifestPath = (publish || reviewedPlan) && existsSync(frozenPath) ? frozenPath : sourceManifestPath;
  const manifest = read(manifestPath);
  const version = manifest.version;
  const selectedArchives = (document, path) => {
    const archiveBytes = filename => readFileSync(join(dirname(path), 'tarballs', filename));
    if (reviewedPlan) {
      return selectPlannedRelease(document, reviewedPlan.plan, reviewedPlan.inventory, sourceCommit, archiveBytes, reviewedPlan.digest);
    }
    assertPreparedRelease(document.version, read(join(root, 'package.json')).version, tag);
    return selectFullRelease(document, ['mayura', ...extensions().map(e => e.manifest.name)], document.version, sourceCommit, archiveBytes);
  };
  if (reviewedPlan && manifestPath === frozenPath) {
    assert.equal(manifest.planDigest, reviewedPlan.digest, 'Recovery requires the frozen selected archives for this plan.');
  }
  const entries = selectedArchives(manifest, manifestPath);
  if (reviewedPlan && manifestPath !== sourceManifestPath) {
    const staged = selectedArchives(read(sourceManifestPath), sourceManifestPath);
    assert.deepEqual(publicationIdentities(staged, reviewedPlan.digest), publicationIdentities(entries, reviewedPlan.digest),
      'Recovered archives differ from the source build.');
  }
  if (publish) {
    assert.equal(process.env.SOURCE_SHA, sourceCommit, 'Checkout differs from the qualified source.');
    if (process.env.GITHUB_EVENT_NAME === 'workflow_dispatch') assert.equal(process.env.GITHUB_SHA, sourceCommit);
    assert(process.env.ACTIONS_ID_TOKEN_REQUEST_URL && process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN, 'OIDC identity is required.');
    assert(process.env.GITHUB_TOKEN, 'GitHub qualification token is required.');
    execFileSync('git', ['diff', '--exit-code', 'HEAD', '--'], { cwd: root, stdio: 'ignore' });
    if (reviewedPlan) {
      assert.equal(git('ls-files', '--error-unmatch', '--', reviewedPlan.path), reviewedPlan.path,
        'Release plan must be committed before publication.');
      assertPlannedPreflight(read(join(output, 'mixed-install-verification.json')), entries, sourceCommit, reviewedPlan.digest);
    }
    // Detect conflicting tags before the first npm write, including when resuming a partial release.
    for (const sourceTag of reviewedPlan?.tags ?? [`v${version}`]) {
      if (git('tag', '--list', sourceTag)) assert.equal(git('rev-parse', `refs/tags/${sourceTag}^{commit}`), sourceCommit,
        `Release tag ${sourceTag} points at a different commit.`);
    }
  }
  if (outputOverride) {
    mkdirSync(artifacts, { recursive: true });
    assert(lstatSync(artifacts).isDirectory(), 'The .artifacts path must be a real directory.');
    mkdirSync(output);
  } else {
    mkdirSync(output, { recursive: true });
  }
  if ((publish || reviewedPlan) && manifestPath !== frozenPath) {
    mkdirSync(join(output, 'tarballs'), { recursive: true });
    for (const entry of entries) {
      const target = join(output, 'tarballs', entry.filename);
      if (existsSync(target)) assert.equal(sha256(readFileSync(target)), entry.sha256, 'An existing staged archive has different bytes.');
      else copyFileSync(join(dirname(manifestPath), 'tarballs', entry.filename), target);
    }
    const frozen = { ...manifest, ...(reviewedPlan ? { planDigest: reviewedPlan.digest } : {}), packages: entries };
    writeFileSync(frozenPath, JSON.stringify(frozen, null, 2), { flag: 'wx' });
  }
  if (reviewedPlan) assert.deepEqual(readdirSync(join(output, 'tarballs')).sort(), entries.map(entry => entry.filename).sort(),
    'The frozen tarball directory must contain exactly the planned package archives.');
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
    const run = await findPublishQualification({ event: process.env.GITHUB_EVENT_NAME, ref: process.env.GITHUB_REF,
      workflowRef: process.env.GITHUB_WORKFLOW_REF, sha: sourceCommit }, path => json(`${api}${path}`, headers),
    reviewedPlan ? ['workflow_dispatch'] : ['workflow_dispatch', 'workflow_run']);
    writeFileSync(join(output, 'qualification.json'), JSON.stringify({
      run: run.id, event: run.event, sourceCommit, gate: 'success', ...(reviewedPlan ? { planDigest: reviewedPlan.digest } : {}),
    }, null, 2));
  }
  const npmCli = [process.env.MAYURA_NPM_CLI, join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    resolve(dirname(process.execPath), '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js')].filter(Boolean).find(existsSync);
  assert(npmCli, 'Set MAYURA_NPM_CLI to the absolute npm-cli.js path.');
  // No user login/configuration fallback. Both live and offline operations receive an empty user config.
  const npmEnv = { ...process.env, NODE_AUTH_TOKEN: '', NPM_TOKEN: '', npm_config_userconfig: join(output, 'empty.npmrc') };
  delete npmEnv.NPM_CONFIG_USERCONFIG;
  writeFileSync(npmEnv.npm_config_userconfig, 'registry=https://registry.npmjs.org/\n');
  const upload = (entry, signal) => new Promise((done, fail) => {
    const archive = join(publish || reviewedPlan ? output : dirname(manifestPath), 'tarballs', entry.filename);
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
  await publishRelease({ entries, version, sourceCommit, tag, planDigest: reviewedPlan?.digest, signal: controller.signal, upload, progress: console.log,
    registry: { version: (name, at) => json(`https://registry.npmjs.org/${encodeURIComponent(name)}/${at}?verify=${Date.now()}`),
      tags: name => json(`https://registry.npmjs.org/-/package/${encodeURIComponent(name)}/dist-tags?verify=${Date.now()}`) },
    previous: existsSync(receiptPath) ? read(receiptPath) : undefined,
    save: receipt => { writeFileSync(receiptPath + '.tmp', JSON.stringify(receipt, null, 2)); renameSync(receiptPath + '.tmp', receiptPath); } });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
