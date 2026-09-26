// Upgrade compatibility (F6): durable state created by a baseline version must resume on this version.
//   node scripts/upgrade-compat.mjs [--baseline <git ref>] [--keep]
// The baseline defaults to the previous `v*` release tag (skipped when there is none). It is checked out into a temporary git worktree, installed
// offline from the local pnpm store and built. The baseline starts a durable human-plus-timer run and writes compact
// memory; this checkout then resumes the run to completion and reads the memory. Nothing outside the temporary
// directory changes.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const workspace = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const argument = name => { const index = process.argv.indexOf(name); return index < 0 ? undefined : process.argv[index + 1]; };
/** Locate pnpm's JavaScript entry next to this Node (npm global or corepack), so no shell is involved. */
function pnpmCli() {
  const directories = [dirname(process.execPath), ...(process.env.PATH ?? process.env.Path ?? '').split(delimiter).filter(Boolean)];
  const found = ['pnpm/bin/pnpm.cjs', 'corepack/dist/pnpm.js'].flatMap(suffix => directories.flatMap(directory =>
    [join(directory, 'node_modules', suffix), resolve(directory, '..', 'lib', 'node_modules', suffix)])).find(existsSync);
  assert(found, 'Could not locate the local pnpm CLI.'); return found;
}
const run = async (command, args, cwd, timeout = 600_000) => {
  try { return await exec(command, args, { cwd, timeout, maxBuffer: 32 * 1_048_576, windowsHide: true }); }
  catch (error) { throw new Error(`Command failed: ${[command, ...args].join(' ')}\n${error.stdout ?? ''}\n${error.stderr ?? ''}`); }
};
const git = args => run('git', args, workspace);

let baseline = argument('--baseline');
if (!baseline) {
  // The previous release: the newest v* tag that does not point at the commit being released.
  const head = (await git(['rev-parse', 'HEAD'])).stdout.trim();
  const tags = (await git(['tag', '--list', 'v*', '--sort=-v:refname'])).stdout.split('\n').map(tag => tag.trim()).filter(Boolean);
  for (const tag of tags) if ((await git(['rev-parse', `${tag}^{commit}`])).stdout.trim() !== head) { baseline = tag; break; }
  if (!baseline) { console.log(JSON.stringify({ status: 'skipped', reason: 'no previous release tag' })); process.exit(0); }
}
const commit = (await git(['rev-parse', '--verify', `${baseline}^{commit}`])).stdout.trim();
const root = await mkdtemp(join(tmpdir(), 'mayura-upgrade-'));
const tree = join(root, 'baseline'); const database = join(root, 'upgrade.sqlite');
try {
  await git(['worktree', 'add', '--detach', tree, commit]);
  await run(process.execPath, [pnpmCli(), 'install', '--frozen-lockfile', '--offline', '--ignore-scripts'], tree);
  await run(process.execPath, [join(tree, 'node_modules', 'typescript', 'bin', 'tsc'), '--build'], tree);
  assert(existsSync(join(workspace, 'packages', 'workflows', 'dist', 'lifecycle.js')), 'Build this checkout first (pnpm build).');
  const scenario = join(workspace, 'scripts', 'upgrade-scenario.mjs');
  const started = JSON.parse((await run(process.execPath, [scenario, tree, database, 'start'], workspace)).stdout.trim().split('\n').at(-1));
  const resumed = JSON.parse((await run(process.execPath, [scenario, workspace, database, 'resume', started.runId], workspace)).stdout.trim().split('\n').at(-1));
  assert.equal(resumed.definition, started.definition, 'The definition digest changed between versions.');
  console.log(JSON.stringify({ status: 'passed', baseline, commit, runId: started.runId, definition: started.definition, result: resumed.status }));
} finally {
  if (!process.argv.includes('--keep')) {
    await git(['worktree', 'remove', '--force', tree]).catch(() => {});
    await rm(root, { recursive: true, force: true });
  }
}
