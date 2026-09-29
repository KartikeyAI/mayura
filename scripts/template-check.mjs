import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { closeSync, existsSync, openSync, readSync, realpathSync, statSync } from 'node:fs';
import { mkdir, readFile, readdir, realpath, rename, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { delimiter, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { applyProjectPlan, planProject, readProject, TEMPLATE_NAMES } from '../packages/cli/dist/index.js';
import { compilerPlatform, createPacker } from './local-packages.mjs';
import { workDirectory } from './work-directory.mjs';

const exec = promisify(execFile);
const workspace = await realpath(resolve(dirname(fileURLToPath(import.meta.url)), '..'));

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


async function run(args, cwd, timeout = 60_000) {
  try { return await exec(process.execPath, args, { cwd, env: environment(), timeout, windowsHide: true, maxBuffer: 8 * 1_048_576 }); }
  catch (error) { throw new Error(`Packed template command failed: ${args.slice(1, 3).join(' ')}\n${String(error.stdout ?? '')}\n${String(error.stderr ?? '')}`); }
}



const artifactRoot = join(workspace, '.artifacts'); await mkdir(artifactRoot, { recursive: true });
const canonicalArtifacts = await realpath(artifactRoot); assert(inside(workspace, canonicalArtifacts));
const output = await workDirectory(join(canonicalArtifacts, 'template-check-')); const tarballs = join(output, 'tarballs');
const cache = join(output, 'npm-cache'); await mkdir(tarballs); await mkdir(cache);
// `mayura` is the published bundle; third-party packages come from the local installation (scripts/local-packages.mjs).
const { npm, packages, packClosure } = createPacker({ output, tarballs });
const parents = { 'better-sqlite3': join(workspace, 'packages', 'storage-sqlite'), 'quickjs-emscripten-core': join(workspace, 'packages', 'adapter-code-quickjs'),
  '@jitl/quickjs-wasmfile-release-sync': join(workspace, 'packages', 'adapter-code-quickjs'), [compilerPlatform]: join(workspace, 'node_modules', '.pnpm') };

const reports = [];
for (const template of TEMPLATE_NAMES) {
  const directory = join(output, template); const plan = await planProject(template, directory);
  assert(plan.changes.every(change => change.operation === 'create')); await applyProjectPlan(plan);
  const project = await readProject(join(directory, 'mayura.project.json')); assert.equal(project.template, template);
  const manifestPath = join(directory, 'package.json'); const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  const roots = [...Object.keys(manifest.dependencies), ...Object.keys(manifest.devDependencies), compilerPlatform];
  const allowed = await packClosure(roots.map(name => [name, parents[name] ?? workspace]));
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
