// Publish exactly the archives that `pnpm release:artifacts` staged and verified. Dry run unless --publish.
//   node scripts/publish-staged.mjs --tag next [--manifest .artifacts/release-XXXX/release-manifest.json] [--publish]
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const workspace = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const argument = name => { const index = process.argv.indexOf(name); return index < 0 ? undefined : process.argv[index + 1]; };
const publish = process.argv.includes('--publish'); const tag = argument('--tag');
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
if (process.env.GITHUB_REF_NAME) assert.equal(process.env.GITHUB_REF_NAME, `v${manifest.version}`, 'The release tag does not match the staged version.');
assert(!(manifest.version.includes('-') && tag === 'latest'), 'A prerelease version cannot be published to the latest dist-tag.');
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm'; const results = [];
for (const entry of manifest.packages) {
  assert.equal(entry.version, manifest.version, `${entry.name} has a different version.`);
  const archive = join(staged, 'tarballs', entry.filename);
  assert.equal(createHash('sha256').update(readFileSync(archive)).digest('hex'), entry.sha256, `${entry.name} archive checksum changed after staging.`);
  const args = ['publish', archive, '--access', 'public', '--tag', tag, '--provenance', ...(publish ? [] : ['--dry-run'])];
  execFileSync(npm, args, { cwd: staged, stdio: ['ignore', 'ignore', 'inherit'], shell: process.platform === 'win32' });
  results.push({ name: entry.name, version: entry.version });
}
console.log(JSON.stringify({ status: publish ? 'published' : 'dry-run', tag, version: manifest.version, sourceCommit: head, packages: results.length }));
