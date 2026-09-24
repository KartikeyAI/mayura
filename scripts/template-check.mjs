import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { closeSync, existsSync, openSync, readSync, realpathSync, statSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { delimiter, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { applyProjectPlan, planProject, readProject, TEMPLATE_NAMES } from '../packages/cli/dist/index.js';

const exec = promisify(execFile);
const workspace = await realpath(resolve(dirname(fileURLToPath(import.meta.url)), '..'));
const mayuraPackages = ['adapter-code-quickjs', 'client', 'code-mode', 'code-mode-workflows', 'core', 'memory', 'runtime', 'sdk',
  'server', 'server-node', 'storage-contracts', 'storage-sql', 'storage-sqlite', 'testing', 'tools', 'workflows'];

function inside(parent, child) {
  const value = relative(parent, child); return value !== '..' && !value.startsWith(`..${sep}`) && !isAbsolute(value);
}

function environment() {
  const allowed = new Set(['PATH', 'PATHEXT', 'SYSTEMROOT', 'WINDIR', 'TEMP', 'TMP', 'TMPDIR', 'HOME', 'USERPROFILE',
    'LOCALAPPDATA', 'APPDATA', 'PROGRAMFILES', 'COREPACK_HOME']);
  return { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => allowed.has(key.toUpperCase()))),
    COREPACK_ENABLE_NETWORK: '0', COREPACK_ENABLE_DOWNLOAD_PROMPT: '0', npm_config_ignore_scripts: 'true',
    npm_config_update_notifier: 'false', npm_config_audit: 'false', npm_config_fund: 'false' };
}

function cli(kind) {
  const nodeShebang = path => {
    const bytes = Buffer.alloc(256); let descriptor;
    try { descriptor = openSync(path, 'r'); return /^#![^\r\n]*\bnode\b/u.test(bytes.subarray(0, readSync(descriptor, bytes, 0, bytes.length, 0)).toString('utf8')); }
    catch { return false; } finally { if (descriptor !== undefined) closeSync(descriptor); }
  };
  const valid = path => { try { return isAbsolute(path) && statSync(path).isFile() && (/\.(?:js|cjs|mjs)$/iu.test(path) || nodeShebang(path)); } catch { return false; } };
  const configured = process.env[`MAYURA_${kind.toUpperCase()}_CLI`];
  if (configured) { assert(valid(configured), `Configured ${kind} CLI must be an absolute local JavaScript entry point.`); return realpathSync(configured); }
  const directories = [...new Set([dirname(process.execPath), ...(process.env.PATH ?? process.env.Path ?? '').split(delimiter)
    .filter(Boolean).map(value => value.replace(/^"|"$/gu, ''))])];
  const suffixes = kind === 'npm' ? ['npm/bin/npm-cli.js'] : ['pnpm/bin/pnpm.cjs', 'corepack/dist/pnpm.js'];
  const candidates = suffixes.flatMap(suffix => directories.flatMap(directory => [join(directory, 'node_modules', suffix),
    resolve(directory, '..', 'lib', 'node_modules', suffix)]));
  for (const directory of directories) { try { const path = realpathSync(join(directory, kind)); if (valid(path)) candidates.push(path); } catch { /* Inspect the next path entry. */ } }
  const found = candidates.find(valid); assert(found, `Set MAYURA_${kind.toUpperCase()}_CLI to an existing local JavaScript entry point.`); return realpathSync(found);
}

async function run(args, cwd, timeout = 60_000) {
  try { return await exec(process.execPath, args, { cwd, env: environment(), timeout, windowsHide: true, maxBuffer: 8 * 1_048_576 }); }
  catch (error) { throw new Error(`Packed template command failed: ${args.slice(1, 3).join(' ')}\n${String(error.stdout ?? '')}\n${String(error.stderr ?? '')}`); }
}

function installedDirectory(name, parent) {
  const require = createRequire(join(parent, 'package.json'));
  const candidates = require.resolve.paths(name).map(path => join(path, name, 'package.json'));
  candidates.push(join(workspace, 'node_modules', '.pnpm', 'node_modules', name, 'package.json'));
  const found = candidates.find(existsSync);
  assert(found, `Qualified dependency is not installed: ${name}`);
  const directory = dirname(realpathSync(found)); assert(inside(resolve(workspace, '..', '..'), directory), `Dependency path is outside the local installation: ${name}`);
  return directory;
}

function requiredDependencies(manifest) {
  const result = new Set(Object.keys(manifest.dependencies ?? {}));
  for (const name of Object.keys(manifest.peerDependencies ?? {})) if (!manifest.peerDependenciesMeta?.[name]?.optional) result.add(name);
  return result;
}

const npm = cli('npm'); const pnpm = cli('pnpm');
const compilerPlatform = `@typescript/typescript-${process.platform}-${process.arch}`;
const artifactRoot = join(workspace, '.artifacts'); await mkdir(artifactRoot, { recursive: true });
const canonicalArtifacts = await realpath(artifactRoot); assert(inside(workspace, canonicalArtifacts));
const output = await mkdtemp(join(canonicalArtifacts, 'template-check-')); const tarballs = join(output, 'tarballs');
const cache = join(output, 'npm-cache'); await mkdir(tarballs); await mkdir(cache);
const packages = new Map();

for (const shortName of mayuraPackages) {
  const directory = join(workspace, 'packages', shortName); const manifest = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8'));
  assert.equal(manifest.name, `@mayura/${shortName}`); assert(existsSync(join(directory, 'dist')), `Build ${manifest.name} before template qualification.`);
  const destination = join(tarballs, `${shortName}.tgz`); await run([pnpm, 'pack', '--out', destination], directory);
  packages.set(manifest.name, { archive: pathToFileURL(destination).href, manifest });
}

const externalRoots = [
  ['zod', workspace], ['typescript', workspace], [compilerPlatform, join(workspace, 'node_modules', '.pnpm')],
  ['@types/node', workspace], ['undici-types', installedDirectory('@types/node', workspace)],
  ['better-sqlite3', join(workspace, 'packages', 'storage-sqlite')],
  ['node-addon-api', installedDirectory('better-sqlite3', join(workspace, 'packages', 'storage-sqlite'))],
  ['quickjs-emscripten-core', join(workspace, 'packages', 'adapter-code-quickjs')],
  ['@jitl/quickjs-wasmfile-release-sync', join(workspace, 'packages', 'adapter-code-quickjs')],
  ['@jitl/quickjs-ffi-types', installedDirectory('@jitl/quickjs-wasmfile-release-sync', join(workspace, 'packages', 'adapter-code-quickjs'))],
  ['hono', join(workspace, 'packages', 'server-node')], ['@hono/node-server', join(workspace, 'packages', 'server-node')],
];
for (const [name, parent] of externalRoots) {
  const directory = installedDirectory(name, parent); const manifest = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8'));
  assert.equal(manifest.name, name); for (const script of ['preinstall', 'install', 'postinstall']) assert(!manifest.scripts?.[script], `${name} has an unreviewed installation script.`);
  // pnpm materializes duplicate declaration files instead of encoding them as
  // hard links, which npm currently drops while extracting local archives on Windows.
  const destination = join(tarballs, `${name.replace(/[^A-Za-z0-9]/gu, '-')}-${manifest.version}.tgz`);
  await run([pnpm, 'pack', '--out', destination], directory);
  packages.set(name, { archive: pathToFileURL(destination).href, manifest });
}

const closure = roots => {
  const selected = new Set(); const visit = name => {
    if (selected.has(name)) return; const entry = packages.get(name); assert(entry, `Unpacked template dependency: ${name}`);
    selected.add(name); for (const dependency of requiredDependencies(entry.manifest)) visit(dependency);
  };
  roots.forEach(visit); return selected;
};

const reports = [];
for (const template of TEMPLATE_NAMES) {
  const directory = join(output, template); const plan = await planProject(template, directory);
  assert(plan.changes.every(change => change.operation === 'create')); await applyProjectPlan(plan);
  const project = await readProject(join(directory, 'mayura.project.json')); assert.equal(project.template, template);
  const manifestPath = join(directory, 'package.json'); const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  const roots = [...Object.keys(manifest.dependencies), ...Object.keys(manifest.devDependencies), compilerPlatform]; const allowed = closure(roots);
  manifest.dependencies = Object.fromEntries(Object.keys(manifest.dependencies).map(name => [name, packages.get(name).archive]));
  manifest.devDependencies = Object.fromEntries(Object.keys(manifest.devDependencies).map(name => [name, packages.get(name).archive]));
  manifest.devDependencies[compilerPlatform] = packages.get(compilerPlatform).archive;
  manifest.overrides = Object.fromEntries([...allowed].map(name => [name, packages.get(name).archive]));
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  const config = join(directory, 'empty.npmrc'); await writeFile(config, '');
  const installStart = performance.now();
  await run([npm, 'install', '--offline', '--ignore-scripts', '--omit=optional', '--no-audit', '--no-fund', '--userconfig', config, '--cache', cache], directory, 120_000);
  const installMs = performance.now() - installStart;
  const tree = JSON.parse((await run([npm, 'ls', '--all', '--json', '--offline', '--userconfig', config, '--cache', cache], directory)).stdout);
  const installed = new Set(); const collect = value => { for (const [name, child] of Object.entries(value.dependencies ?? {})) {
    // npm reports deliberately omitted platform/peer optionals as empty placeholders.
    if (typeof child.version !== 'string') continue;
    assert(allowed.has(name), `Unexpected ${template} dependency: ${name}`); assert.equal(child.version, packages.get(name).manifest.version);
    installed.add(name); collect(child);
  } };
  collect(tree); assert.deepEqual([...installed].sort(), [...allowed].sort());
  const canonicalProject = await realpath(directory);
  for (const name of installed) assert(inside(canonicalProject, await realpath(join(directory, 'node_modules', name))), `${template} dependency escaped its installation.`);
  const typecheckStart = performance.now(); const compiler = join(directory, 'node_modules', 'typescript', 'bin', 'tsc');
  const typecheck = await run([compiler, '--project', join(directory, 'tsconfig.json'), '--pretty', 'false'], directory, 30_000);
  assert.equal(typecheck.stderr, ''); const typecheckMs = performance.now() - typecheckStart;
  const executionStart = performance.now(); const execution = await run([join(directory, 'dist', 'index.js')], directory, 30_000);
  const executionMs = performance.now() - executionStart; const line = execution.stdout.trim().split(/\r?\n/u).at(-1);
  assert(line, `${template} emitted no result.`); JSON.parse(line);
  reports.push({ template, files: plan.changes.length, dependencies: installed.size, installMs: Math.round(installMs),
    typecheckMs: Math.round(typecheckMs), executionMs: Math.round(executionMs), outputBytes: Buffer.byteLength(execution.stdout) });
}

const report = { status: 'passed', qualification: 'isolated-packed-offline', packages: packages.size, templates: reports, output };
await writeFile(join(output, 'report.json'), `${JSON.stringify(report, null, 2)}\n`); console.log(JSON.stringify(report));
