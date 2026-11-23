// Read-only registry verification. The runtime probes run in a separate process against the npm installation.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { cli, run, workspace } from './local-packages.mjs';
import { workDirectory } from './work-directory.mjs';
import { extensions } from './extensions.mjs';

const [mode, input, ...extra] = process.argv.slice(2);
assert((mode === '--manifest' || mode === '--version') && input && extra.length === 0,
  'Use registry-release-check.mjs --manifest <release-manifest.json> or --version <published version>.');
const manifestPath = mode === '--manifest' ? resolve(input) : undefined;
const manifest = manifestPath ? JSON.parse(await readFile(manifestPath, 'utf8')) : undefined;
const version = manifest?.version ?? input;
assert(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(version), 'Expected an exact npm version.');
const names = ['mayura', ...extensions().map(entry => entry.manifest.name)];
if (manifest) {
  assert.equal(manifest.status, 'passed');
  assert.deepEqual(manifest.packages.map(item => item.name), names, 'Unexpected package inventory.');
}

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

const light = await install('mayura-registry-light', { mayura: version });
const exec = (...args) => run([npm, 'exec', ...config, '--offline', '--', 'mayura', ...args], light);
assert.equal((await exec('--version')).stdout.trim(), version);
assert.match((await exec('--help')).stdout, /mayura <command>/u);
if (manifest) {
  const { starters } = JSON.parse((await exec('starters')).stdout);
  assert(starters.some(starter => starter.name === 'rag-modal-pinecone'), 'Published CLI is missing the RAG starter.');
}

const full = await install('mayura-registry-full', { ...Object.fromEntries(names.map(name => [name, version])), 'better-sqlite3': '13.0.3' });
const lock = JSON.parse(await readFile(join(full, 'package-lock.json'), 'utf8'));
for (const name of names) {
  const installed = lock.packages[`node_modules/${name}`];
  assert(installed && installed.version === version && /^sha512-/u.test(installed.integrity), `Unexpected registry installation for ${name}.`);
  assert.equal(new URL(installed.resolved).origin, registry);
  if (manifest) {
    const entry = manifest.packages.find(item => item.name === name);
    assert(entry.filename === `${name.replace(/^@/u, '').replace('/', '-')}-${version}.tgz`);
    const bytes = await readFile(join(dirname(manifestPath), 'tarballs', entry.filename));
    assert.equal(createHash('sha256').update(bytes).digest('hex'), entry.sha256);
    assert.equal(installed.integrity, `sha512-${createHash('sha512').update(bytes).digest('base64')}`);
  }
}
const verified = JSON.parse((await run([npm, 'audit', 'signatures', ...config, '--json'], full, { timeout: 600_000 })).stdout);
assert.deepEqual(verified.invalid, []);
assert.deepEqual(verified.missing, []);

// Reuse the same deterministic scenarios run against locally packed archives in CI.
await copyFile(join(workspace, 'scripts', 'rag-acceptance', 'consumer.mts'), join(full, 'rag-acceptance.mts'));
await run(['--experimental-strip-types', '--test', 'rag-acceptance.mts'], full, { timeout: 180_000 });
const report = { status: 'passed', version, packages: names.length, archiveIntegrity: manifest ? 'verified' : 'registry-only',
  sourceCommit: manifest?.sourceCommit ?? null, registrySignaturesAndAttestations: 'verified', cleanInstall: true, ragAcceptance: true };
if (manifestPath) await writeFile(resolve(manifestPath, '..', 'registry-verification.json'), `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify(report));
