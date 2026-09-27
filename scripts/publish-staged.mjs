// Publish exactly the archives that `pnpm release:artifacts` staged and verified. Dry run unless --publish.
//   node scripts/publish-staged.mjs --tag next [--manifest .artifacts/release-XXXX/release-manifest.json] [--publish]
//     [--registry https://npm.pkg.github.com]
// A version already on the registry is skipped, so a release that stopped part-way can be run again. Provenance is
// attached on the public npm registry only. For another registry the token comes from NODE_AUTH_TOKEN, which npm reads
// from the environment through a temporary config that names the variable, never its value.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const workspace = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const argument = name => { const index = process.argv.indexOf(name); return index < 0 ? undefined : process.argv[index + 1]; };
const publish = process.argv.includes('--publish'); const tag = argument('--tag');
const registry = argument('--registry') ?? 'https://registry.npmjs.org/'; const publicRegistry = /^https:\/\/registry\.npmjs\.org\/?$/u.test(registry);
assert(/^https:\/\/[A-Za-z0-9.-]+(?::\d+)?\/?$/u.test(registry), '--registry must be an https:// registry URL.');
assert(tag && /^[a-z][a-z0-9-]{0,31}$/.test(tag), 'A --tag dist-tag such as next or latest is required.');
const latestManifest = () => {
  const root = join(workspace, '.artifacts');
  const candidates = readdirSync(root).filter(name => name.startsWith('release-')).map(name => join(root, name, 'release-manifest.json'))
    .filter(path => { try { return statSync(path).isFile(); } catch { return false; } }).sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
  assert(candidates.length > 0, 'Run pnpm release:artifacts first.'); return candidates[0];
};
const manifestPath = resolve(argument('--manifest') ?? latestManifest()); const staged = dirname(manifestPath);
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
assert.equal(manifest.format, 1); assert.equal(manifest.status, 'passed', 'The release artifact check did not pass.');
const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: workspace, encoding: 'utf8' }).trim();
assert.equal(manifest.sourceCommit, head, 'Staged archives were not built from the current commit.');
// Releases run from main; a run started from a tag must name the staged version.
if (process.env.GITHUB_REF_TYPE === 'tag') assert.equal(process.env.GITHUB_REF_NAME, `v${manifest.version}`, 'The release tag does not match the staged version.');
else if (process.env.GITHUB_ACTIONS === 'true') assert.equal(process.env.GITHUB_REF_NAME, 'main', 'Releases are published from main only.');
assert(!(manifest.version.includes('-') && tag === 'latest'), 'A prerelease version cannot be published to the latest dist-tag.');
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm'; const results = [];
let config; let scratch;
if (!publicRegistry) {
  scratch = mkdtempSync(join(tmpdir(), 'mayura-publish-')); config = join(scratch, 'npmrc');
  writeFileSync(config, `registry=${registry}\n//${new URL(registry).host}/:_authToken=\${NODE_AUTH_TOKEN}\n`, { mode: 0o600 });
}
const registryArgs = ['--registry', registry, ...(config ? ['--userconfig', config] : [])];
const published = (name, version) => {
  try { return execFileSync(npm, ['view', `${name}@${version}`, 'version', ...registryArgs], { cwd: staged, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], shell: process.platform === 'win32' }).trim() === version; }
  catch { return false; }
};
for (const entry of manifest.packages) {
  assert.equal(entry.version, manifest.version, `${entry.name} has a different version.`);
  const archive = join(staged, 'tarballs', entry.filename);
  assert.equal(createHash('sha256').update(readFileSync(archive)).digest('hex'), entry.sha256, `${entry.name} archive checksum changed after staging.`);
  if (published(entry.name, entry.version)) { results.push({ name: entry.name, version: entry.version, skipped: 'already published' }); continue; }
  const args = ['publish', archive, '--access', 'public', '--tag', tag, publicRegistry ? '--provenance' : '--provenance=false', ...registryArgs, ...(publish ? [] : ['--dry-run'])];
  execFileSync(npm, args, { cwd: staged, stdio: ['ignore', 'ignore', 'inherit'], shell: process.platform === 'win32' });
  results.push({ name: entry.name, version: entry.version });
}
if (scratch) rmSync(scratch, { recursive: true, force: true });
console.log(JSON.stringify({ status: publish ? 'published' : 'dry-run', registry, tag, version: manifest.version, sourceCommit: head,
  packages: results.filter(item => !item.skipped).length, skipped: results.filter(item => item.skipped).length }));
