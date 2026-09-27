// Qualifies every starter twice.
//   1. In the workspace: build it, run its own tests, and build its web UI if it has one.
//   2. As a user gets it: `mayura init --starter` into a fresh directory, install offline from packed archives of the
//      workspace's exact packages (no registry), build, run its tests, then boot `migrate`, `serve` and `worker` and
//      probe them.
// Web UI toolchains (Vite, Tailwind) are verified in step 1 only; step 2 installs the server's dependencies.
//   node scripts/starter-check.mjs [--only <starter>] [--skip-packed]
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { randomBytes, createHash } from 'node:crypto';
import { closeSync, existsSync, openSync, readSync, realpathSync, statSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, realpath, rename, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { createRequire } from 'node:module';
import { delimiter, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { applyProjectPlan, planStarter, readProject, STARTER_NAMES } from '../packages/cli/dist/index.js';

const exec = promisify(execFile);
const workspace = await realpath(resolve(dirname(fileURLToPath(import.meta.url)), '..'));
const argument = name => { const index = process.argv.indexOf(name); return index < 0 ? undefined : process.argv[index + 1]; };
const only = argument('--only'); const skipPacked = process.argv.includes('--skip-packed');
const selected = STARTER_NAMES.filter(name => !only || name === only); assert(selected.length > 0, `Unknown starter: ${only}`);
const compilerPlatform = `@typescript/typescript-${process.platform}-${process.arch}`;
// Development tools a packed install keeps; every other devDependency belongs to a web UI and is checked in step 1.
const packedDevelopment = new Set(['typescript', '@types/node']);

const inside = (parent, child) => { const value = relative(parent, child); return value !== '..' && !value.startsWith(`..${sep}`) && !isAbsolute(value); };
function environment(extra = {}) {
  const allowed = new Set(['PATH', 'PATHEXT', 'SYSTEMROOT', 'WINDIR', 'TEMP', 'TMP', 'TMPDIR', 'HOME', 'USERPROFILE', 'LOCALAPPDATA', 'APPDATA', 'PROGRAMFILES', 'COREPACK_HOME']);
  return { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => allowed.has(key.toUpperCase()))),
    COREPACK_ENABLE_NETWORK: '0', COREPACK_ENABLE_DOWNLOAD_PROMPT: '0', npm_config_ignore_scripts: 'true',
    npm_config_update_notifier: 'false', npm_config_audit: 'false', npm_config_fund: 'false', ...extra };
}
async function run(args, cwd, { timeout = 120_000, env } = {}) {
  try { return await exec(process.execPath, args, { cwd, env: environment(env), timeout, windowsHide: true, maxBuffer: 16 * 1_048_576 }); }
  catch (error) { throw new Error(`Starter command failed in ${relative(workspace, cwd) || '.'}: ${args.slice(0, 3).map(value => relative(workspace, value) || value).join(' ')}\n${String(error.stdout ?? '').slice(-6_000)}\n${String(error.stderr ?? '').slice(-6_000)}`); }
}
function cli(kind) {
  const shebang = path => { const bytes = Buffer.alloc(256); let descriptor;
    try { descriptor = openSync(path, 'r'); return /^#![^\r\n]*\bnode\b/u.test(bytes.subarray(0, readSync(descriptor, bytes, 0, bytes.length, 0)).toString('utf8')); }
    catch { return false; } finally { if (descriptor !== undefined) closeSync(descriptor); } };
  const valid = path => { try { return isAbsolute(path) && statSync(path).isFile() && (/\.(?:js|cjs|mjs)$/iu.test(path) || shebang(path)); } catch { return false; } };
  const configured = process.env[`MAYURA_${kind.toUpperCase()}_CLI`];
  if (configured) { assert(valid(configured), `Configured ${kind} CLI must be an absolute local JavaScript entry point.`); return realpathSync(configured); }
  const directories = [...new Set([dirname(process.execPath), ...(process.env.PATH ?? process.env.Path ?? '').split(delimiter).filter(Boolean).map(value => value.replace(/^"|"$/gu, ''))])];
  const suffixes = kind === 'npm' ? ['npm/bin/npm-cli.js'] : ['pnpm/bin/pnpm.cjs', 'corepack/dist/pnpm.js'];
  const candidates = suffixes.flatMap(suffix => directories.flatMap(directory => [join(directory, 'node_modules', suffix), resolve(directory, '..', 'lib', 'node_modules', suffix)]));
  for (const directory of directories) { try { const path = realpathSync(join(directory, kind)); if (valid(path)) candidates.push(path); } catch { /* next */ } }
  const found = candidates.find(valid); assert(found, `Set MAYURA_${kind.toUpperCase()}_CLI to an existing local JavaScript entry point.`); return realpathSync(found);
}
/** The installed directory of `name` as Node resolves it from `parent` (a pnpm-linked package). */
function installedDirectory(name, parent) {
  const require = createRequire(join(parent, 'package.json'));
  const candidates = require.resolve.paths(name).map(path => join(path, name, 'package.json'));
  candidates.push(join(workspace, 'node_modules', '.pnpm', 'node_modules', name, 'package.json'));
  const found = candidates.find(existsSync); assert(found, `Dependency is not installed: ${name} (from ${relative(workspace, parent)})`);
  const directory = dirname(realpathSync(found)); assert(inside(resolve(workspace, '..', '..'), directory), `Dependency path is outside the local installation: ${name}`);
  return directory;
}
const freePort = () => new Promise((resolvePort, reject) => { const server = createServer(); server.once('error', reject);
  server.listen(0, '127.0.0.1', () => { const { port } = server.address(); server.close(() => resolvePort(port)); }); });

// ---- Step 1: in the workspace -----------------------------------------------------------------------------------------
const reports = [];
for (const starter of selected) {
  const directory = join(workspace, 'packages', 'cli', 'starters', starter); const started = performance.now();
  const compiler = join(workspace, 'node_modules', 'typescript', 'bin', 'tsc');
  await run([compiler, '-p', join(directory, 'tsconfig.json'), '--pretty', 'false'], directory);
  const tests = await run(['--test', '--test-reporter=dot', 'dist/test/*.test.js'], directory, { timeout: 300_000 });
  let web = null;
  if (existsSync(join(directory, 'web', 'tsconfig.json'))) {
    await run([compiler, '-p', join(directory, 'web', 'tsconfig.json'), '--pretty', 'false'], directory);
    await run([join(installedDirectory('vite', directory), 'bin', 'vite.js'), 'build', 'web', '--logLevel', 'warn'], directory, { timeout: 300_000 });
    web = 'built';
  }
  reports.push({ starter, workspace: { tests: tests.stdout.trim().split(/\r?\n/u).at(-1) ?? '', web, ms: Math.round(performance.now() - started) } });
}

if (!skipPacked) {
  // ---- Step 2: packed and offline ------------------------------------------------------------------------------------
  const npm = cli('npm'); const pnpm = cli('pnpm');
  const artifacts = join(workspace, '.artifacts'); await mkdir(artifacts, { recursive: true });
  const output = await mkdtemp(join(await realpath(artifacts), 'starter-check-')); const tarballs = join(output, 'tarballs'); const cache = join(output, 'npm-cache');
  await mkdir(tarballs); await mkdir(cache);
  const packages = new Map(); // name -> { archive, manifest }

  const packDirectory = async (name, directory) => {
    if (packages.has(name)) return packages.get(name);
    const manifest = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8')); assert.equal(manifest.name, name);
    const destination = join(tarballs, `${name.replace(/[^A-Za-z0-9]/gu, '-')}-${manifest.version}.tgz`);
    if (!name.startsWith('@mayura/')) for (const script of ['preinstall', 'install', 'postinstall']) {
      // better-sqlite3 is built once in the workspace (pnpm onlyBuiltDependencies) and packed with its binary.
      assert(!manifest.scripts?.[script] || name === 'better-sqlite3', `${name} has an unreviewed installation script.`);
    }
    if (name === compilerPlatform && process.platform !== 'win32') {
      // pnpm pack writes every file as 0644, which strips the native compiler's execute bit on Linux and macOS; npm pack
      // keeps file modes. Everything else is packed by pnpm, as the template check does.
      const staging = await mkdtemp(join(output, 'npm-pack-'));
      await run([npm, 'pack', directory, '--ignore-scripts', '--offline', '--pack-destination', staging], workspace);
      const [archive] = await readdir(staging); assert(archive?.endsWith('.tgz')); await rename(join(staging, archive), destination);
    } else await run([pnpm, 'pack', '--out', destination], directory);
    const entry = { archive: pathToFileURL(destination).href, manifest, directory }; packages.set(name, entry); return entry;
  };
  const workspacePackage = name => join(workspace, 'packages', name.slice('@mayura/'.length));
  /** Pack `name` (resolved from `parent`) and everything it needs at run time; returns the closure of names. */
  const packClosure = async (roots) => {
    const closure = new Set(); const queue = roots.map(([name, parent]) => ({ name, parent }));
    while (queue.length) {
      const { name, parent } = queue.shift(); if (closure.has(name)) continue; closure.add(name);
      const directory = name.startsWith('@mayura/') ? workspacePackage(name) : installedDirectory(name, parent);
      if (name.startsWith('@mayura/')) assert(existsSync(join(directory, 'dist')), `Build ${name} before starter qualification.`);
      const { manifest } = await packDirectory(name, directory);
      const required = new Set(Object.keys(manifest.dependencies ?? {}));
      for (const peer of Object.keys(manifest.peerDependencies ?? {})) if (!manifest.peerDependenciesMeta?.[peer]?.optional) required.add(peer);
      for (const dependency of required) queue.push({ name: dependency, parent: directory });
    }
    return closure;
  };

  for (const report of reports) {
    const { starter } = report; const directory = join(output, starter); const started = performance.now();
    const plan = await planStarter(starter, directory); assert(plan.changes.every(change => change.operation === 'create')); await applyProjectPlan(plan);
    assert.equal((await readProject(join(directory, 'mayura.project.json'))).template, starter);
    const manifestPath = join(directory, 'package.json'); const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    const cliVersion = JSON.parse(await readFile(join(workspace, 'packages', 'cli', 'package.json'), 'utf8')).version;
    for (const [name, range] of Object.entries(manifest.dependencies)) if (name.startsWith('@mayura/')) assert.equal(range, cliVersion, `${starter} pins ${name} to ${range}.`);
    const source = join(workspace, 'packages', 'cli', 'starters', starter);
    const development = Object.keys(manifest.devDependencies ?? {}).filter(name => packedDevelopment.has(name));
    const allowed = await packClosure([...Object.keys(manifest.dependencies), ...development].map(name => [name, source]).concat([[compilerPlatform, join(workspace, 'node_modules', '.pnpm')]]));
    manifest.dependencies = Object.fromEntries(Object.keys(manifest.dependencies).map(name => [name, packages.get(name).archive]));
    manifest.devDependencies = Object.fromEntries([...development, compilerPlatform].map(name => [name, packages.get(name).archive]));
    manifest.overrides = Object.fromEntries([...allowed].map(name => [name, packages.get(name).archive]));
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    const config = join(directory, 'empty.npmrc'); await writeFile(config, '');
    await run([npm, 'install', '--offline', '--ignore-scripts', '--omit=optional', '--no-audit', '--no-fund', '--userconfig', config, '--cache', cache], directory, { timeout: 300_000 });
    const tree = JSON.parse((await run([npm, 'ls', '--all', '--json', '--offline', '--userconfig', config, '--cache', cache], directory)).stdout);
    const installed = new Set(); const collect = value => { for (const [name, child] of Object.entries(value.dependencies ?? {})) {
      if (typeof child.version !== 'string') continue; // deliberately omitted optional placeholders
      assert(allowed.has(name), `Unexpected ${starter} dependency: ${name}`); assert.equal(child.version, packages.get(name).manifest.version);
      installed.add(name); collect(child); } };
    collect(tree); assert.deepEqual([...installed].sort(), [...allowed].sort());
    const project = await realpath(directory);
    for (const name of installed) assert(inside(project, await realpath(join(directory, 'node_modules', name))), `${starter} dependency escaped its installation.`);

    await run([join(directory, 'node_modules', 'typescript', 'bin', 'tsc'), '-p', join(directory, 'tsconfig.json'), '--pretty', 'false'], directory);
    const tests = await run(['--test', '--test-reporter=dot', 'dist/test/*.test.js'], directory, { timeout: 300_000 });
    report.packed = { dependencies: installed.size, tests: tests.stdout.trim().split(/\r?\n/u).at(-1) ?? '', boot: await boot(starter, directory), ms: Math.round(performance.now() - started) };
  }
  reports.output = output;
}

/** Boot the application the way production does: migrate, then serve and worker as separate processes. */
async function boot(starter, directory) {
  const bin = join(directory, 'node_modules', '@mayura', 'cli', 'dist', 'bin.js'); const app = join(directory, 'dist', 'src', 'app.js');
  const token = randomBytes(32).toString('hex'); const port = await freePort(); const probe = await freePort();
  const env = { MAYURA_ENV: 'development', PORT: String(port), MAYURA_SQLITE_PATH: join(directory, '.data', 'boot.sqlite'),
    MAYURA_OPERATOR_TOKEN_SHA256: createHash('sha256').update(token).digest('hex') };
  const migrated = JSON.parse((await run([bin, 'migrate', '--app', app], directory, { env })).stdout);
  const processes = [];
  const start = (args, ready) => new Promise((resolveStart, reject) => {
    const child = spawn(process.execPath, [bin, ...args, '--app', app, ...(args[0] === 'worker' ? ['--probe-port', String(probe)] : [])],
      { cwd: directory, env: environment(env), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    processes.push(child); let output = '';
    const timer = setTimeout(() => reject(new Error(`${starter} ${args[0]} did not start:\n${output.slice(-4_000)}`)), 60_000);
    const inspect = chunk => { output += chunk; if (output.includes(ready)) { clearTimeout(timer); resolveStart(); } };
    child.stdout.on('data', inspect); child.stderr.on('data', chunk => { output += chunk; });
    child.once('exit', code => { clearTimeout(timer); reject(new Error(`${starter} ${args[0]} exited with ${code}:\n${output.slice(-4_000)}`)); });
  });
  try {
    await start(['serve'], '"event":"serving"'); await start(['worker'], '"event":"worker-started"');
    const agents = await fetch(`http://127.0.0.1:${port}/v1/agents`, { headers: { authorization: `Bearer ${token}` } });
    assert.equal(agents.status, 200, `${starter} did not list its agents for the operator.`);
    const listed = (await agents.json()).agents.map(agent => agent.id);
    const declared = (await readProject(join(directory, 'mayura.project.json'))).definitions.filter(item => item.kind === 'agent').map(item => item.id);
    assert.deepEqual([...new Set(listed)].sort(), [...new Set(declared)].sort(), `${starter} serves different agents than it declares.`);
    const ready = await fetch(`http://127.0.0.1:${probe}/readyz`); assert.equal(ready.status, 200, `${starter} worker is not ready.`);
    return { migrate: migrated, agents: listed.length, worker: 'ready' };
  } finally {
    for (const child of processes) { child.removeAllListeners('exit'); child.kill(); }
  }
}

const report = { status: 'passed', starters: reports, ...(reports.output ? { output: reports.output } : {}) };
console.log(JSON.stringify(report));
