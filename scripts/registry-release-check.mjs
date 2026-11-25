// Read-only registry verification. The runtime probes run in a separate process against the npm installation.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { cli, run, workspace } from './local-packages.mjs';
import { workDirectory } from './work-directory.mjs';
import { extensions } from './extensions.mjs';
import { readReleasePlan } from './package-release-plan.mjs';
import { selectPlannedRelease } from './release-publisher.mjs';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const [mode, input, ...extra] = process.argv.slice(2);
const [planFlag, planPath, stageFlag] = extra;
assert(input && ((mode === '--version' && extra.length === 0) || (mode === '--manifest' &&
  (extra.length === 0 || (planFlag === '--plan' && planPath && (extra.length === 2 || (extra.length === 3 && stageFlag === '--staged')))))),
  'Use --manifest <release-manifest.json> [--plan <path> [--staged]] or --version <published version>.');
const staged = stageFlag === '--staged';
const manifestPath = mode === '--manifest' ? resolve(input) : undefined;
const manifest = manifestPath ? JSON.parse(await readFile(manifestPath, 'utf8')) : undefined;
const version = manifest?.version ?? input;
assert(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(version), 'Expected an exact npm version.');
const planned = planPath ? readReleasePlan(planPath) : undefined;
const inventory = planned?.inventory ?? ['mayura', ...extensions().map(entry => entry.manifest.name)].map(name => ({ name, version }));
const names = inventory.map(entry => entry.name);
const sourceCommit = planned ? execFileSync('git', ['rev-parse', 'HEAD'], { cwd: workspace, encoding: 'utf8' }).trim() : manifest?.sourceCommit;
const archivePath = filename => join(dirname(manifestPath), 'tarballs', filename);
const entries = planned ? selectPlannedRelease(manifest, planned.plan, inventory, sourceCommit, filename => readFileSync(archivePath(filename)), planned.digest) : manifest?.packages;
if (manifest && !planned) {
  assert.equal(manifest.status, 'passed');
  assert.deepEqual(manifest.packages.map(item => item.name), names, 'Unexpected package inventory.');
}
const selected = new Map(entries?.map(entry => [entry.name, entry]) ?? []);
const installSpec = ({ name, version }) => staged && selected.has(name) ? pathToFileURL(archivePath(selected.get(name).filename)).href : version;

const artifacts = join(workspace, '.artifacts');
await mkdir(artifacts, { recursive: true });
const output = await workDirectory(join(artifacts, 'registry-release-check-'));
const userConfig = join(output, 'user.npmrc');
const globalConfig = join(output, 'global.npmrc');
await Promise.all([writeFile(userConfig, ''), writeFile(globalConfig, '')]);
const npm = cli('npm');
const registry = 'https://registry.npmjs.org';
const config = ['--userconfig', userConfig, '--globalconfig', globalConfig, '--cache', join(output, 'cache'), '--registry', registry];

async function install(label, dependencies) {
  const directory = join(output, label);
  await mkdir(directory);
  await writeFile(join(directory, 'package.json'), JSON.stringify({ name: label, private: true, type: 'module', dependencies }));
  await run([npm, 'install', ...config, '--ignore-scripts', '--no-audit', '--no-fund'], directory, { timeout: 600_000 });
  return directory;
}

const core = inventory.find(entry => entry.name === 'mayura');
assert(core);
const light = await install('mayura-registry-light', { mayura: installSpec(core) });
const exec = (...args) => run([npm, 'exec', ...config, '--offline', '--', 'mayura', ...args], light);
assert.equal((await exec('--version')).stdout.trim(), core.version);
assert.match((await exec('--help')).stdout, /mayura <command>/u);
if (manifest) {
  const { starters } = JSON.parse((await exec('starters')).stdout);
  assert(starters.some(starter => starter.name === 'rag-modal-pinecone'), 'Published CLI is missing the RAG starter.');
}

const full = await install('mayura-registry-full', { ...Object.fromEntries(inventory.map(entry => [entry.name, installSpec(entry)])), 'better-sqlite3': '13.0.3' });
const lock = JSON.parse(await readFile(join(full, 'package-lock.json'), 'utf8'));
if (planned) {
  const installedCores = Object.keys(lock.packages).filter(path => /(?:^|\/)node_modules\/mayura$/u.test(path));
  assert.deepEqual(installedCores, ['node_modules/mayura'],
    'A nested copy of Mayura would hide incompatibility with the selected core version.');
}
for (const { name, version } of inventory) {
  const installed = lock.packages[`node_modules/${name}`];
  assert(installed && installed.version === version && /^sha512-/u.test(installed.integrity), `Unexpected registry installation for ${name}.`);
  const entry = selected.get(name);
  if (staged && entry) assert(installed.resolved?.startsWith('file:'), `Expected the staged archive for ${name}.`);
  else assert.equal(new URL(installed.resolved).origin, registry);
  if (entry) {
    assert(entry.filename === `${name.replace(/^@/u, '').replace('/', '-')}-${version}.tgz`);
    const bytes = await readFile(archivePath(entry.filename));
    assert.equal(createHash('sha256').update(bytes).digest('hex'), entry.sha256);
    assert.equal(installed.integrity, `sha512-${createHash('sha512').update(bytes).digest('base64')}`);
  }
}
if (!staged) {
  const verified = JSON.parse((await run([npm, 'audit', 'signatures', ...config, '--json'], full, { timeout: 600_000 })).stdout);
  assert.deepEqual(verified.invalid, []);
  assert.deepEqual(verified.missing, []);
}

if (planned) {
  await writeFile(join(full, 'import-check.mjs'), `
import assert from 'node:assert/strict';
for (const name of ${JSON.stringify(names)}) {
  assert(Object.keys(await import(name)).length > 0, \`No runtime exports: \${name}\`);
}
`);
  await run(['import-check.mjs'], full, { timeout: 180_000 });
}

// Reuse the same deterministic scenarios run against locally packed archives in CI.
await copyFile(join(workspace, 'scripts', 'rag-acceptance', 'consumer.mts'), join(full, 'rag-acceptance.mts'));
await run(['--experimental-strip-types', '--test', 'rag-acceptance.mts'], full, { timeout: 180_000 });
const report = { status: 'passed', version, packages: names.length, archiveIntegrity: manifest ? 'verified' : 'registry-only',
  sourceCommit: sourceCommit ?? null, ...(planned ? { planDigest: planned.digest, selectedPackages: planned.plan.packages,
    identities: entries.map(({ name, version, sha256 }) => ({ name, version, sha256 })), mixedImports: true } : {}),
  registrySignaturesAndAttestations: staged ? 'pending-publication' : 'verified', cleanInstall: true, ragAcceptance: true };
if (manifestPath) await writeFile(resolve(manifestPath, '..', staged ? 'mixed-install-verification.json' : 'registry-verification.json'), `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify(report));
