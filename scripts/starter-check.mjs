// Qualifies every starter twice.
//   1. In the workspace: build it, run its own tests, and build its web UI if it has one.
//   2. As a user gets it: `mayura init --starter` into a fresh directory, install offline from packed archives of the
//      workspace's exact packages (no registry), build, run its tests, then boot `migrate`, `serve` and `worker` and
//      probe them.
//      A command-line starter (a `bin`, no application module) runs its command offline instead.
// Web UI toolchains (Vite, Tailwind) are verified in step 1 only; step 2 installs the server's dependencies.
//   node scripts/starter-check.mjs [--only <starter>] [--skip-packed]
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes, createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';
import { compilerPlatform, createPacker, environment, inside, installedDirectory, run, workspace } from './local-packages.mjs';
import { applyProjectPlan, planStarter, readProject, STARTER_NAMES } from '../packages/cli/dist/index.js';

const argument = name => { const index = process.argv.indexOf(name); return index < 0 ? undefined : process.argv[index + 1]; };
const only = argument('--only'); const skipPacked = process.argv.includes('--skip-packed');
const selected = STARTER_NAMES.filter(name => !only || name === only); assert(selected.length > 0, `Unknown starter: ${only}`);
// Development tools a packed install keeps; every other devDependency belongs to a web UI and is checked in step 1.
const packedDevelopment = new Set(['typescript', '@types/node']);

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
  const artifacts = join(workspace, '.artifacts'); await mkdir(artifacts, { recursive: true });
  const output = await mkdtemp(join(await realpath(artifacts), 'starter-check-')); const tarballs = join(output, 'tarballs'); const cache = join(output, 'npm-cache');
  await mkdir(tarballs); await mkdir(cache);
  const { npm, packages, packClosure } = createPacker({ output, tarballs });

  for (const report of reports) {
    const { starter } = report; const directory = join(output, starter); const started = performance.now();
    const plan = await planStarter(starter, directory); assert(plan.changes.every(change => change.operation === 'create')); await applyProjectPlan(plan);
    assert.equal((await readProject(join(directory, 'mayura.project.json'))).template, starter);
    // The published package (`mayura`, bundled) must ship every file the initializer copies from the repository copy.
    // AGENTS.md and CLAUDE.md are written by the initializer itself, unless a starter brings its own.
    const published = await packClosure([['mayura', join(workspace, 'packages', 'cli')]]).then(() => packages.get('mayura'));
    const prefix = `lib/cli/starters/${starter}/`;
    const shipped = new Set(archivePaths(await readFile(fileURLToPath(published.archive))).filter(path => path.startsWith(prefix))
      .map(path => path.slice(prefix.length).split('/').map(part => part.startsWith('dot-') ? `.${part.slice(4)}` : part).join('/')));
    const generated = ['AGENTS.md', 'CLAUDE.md'].filter(path => !shipped.has(path));
    assert.deepEqual(generated.filter(path => !plan.changes.some(change => change.path === path)), [], `${starter} is missing its guidance for coding assistants.`);
    assert.deepEqual([...shipped].sort(), plan.changes.map(change => change.path).filter(path => !generated.includes(path)).sort(), `mayura does not ship exactly the ${starter} files.`);
    const manifestPath = join(directory, 'package.json'); const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    const cliVersion = JSON.parse(await readFile(join(workspace, 'packages', 'cli', 'package.json'), 'utf8')).version;
    assert.equal(manifest.dependencies.mayura, cliVersion, `${starter} must pin mayura to the CLI's version.`);
    for (const field of ['dependencies', 'devDependencies']) for (const name of Object.keys(manifest[field] ?? {})) assert(!name.startsWith('@mayura/'), `${starter} still depends on ${name}.`);
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

/** File paths in a packed npm archive (ustar), relative to its `package/` root. */
function archivePaths(bytes) {
  const tar = gunzipSync(bytes); const paths = [];
  for (let offset = 0; offset + 512 <= tar.length;) {
    const header = tar.subarray(offset, offset + 512); if (header.every(byte => byte === 0)) break;
    const text = (start, length) => header.subarray(start, start + length).toString('utf8').replace(/\u0000.*$/su, '');
    const name = [text(345, 155), text(0, 100)].filter(Boolean).join('/'); const size = Number.parseInt(text(124, 12).trim() || '0', 8);
    if (header[156] === 48 || header[156] === 0) paths.push(name.replace(/^package\//u, ''));
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  return paths;
}

/**
 * A command-line starter (a `bin` and no application module) has nothing to serve: run its command the way a person
 * would, offline, and check that it answers and says what it can do.
 */
async function bootCommand(starter, directory, manifest) {
  const [name, entry] = Object.entries(manifest.bin)[0]; const command = join(directory, entry);
  const help = await run([command, '--help'], directory);
  assert.match(help.stdout, new RegExp(`Usage: ${name}`, 'u'), `${starter} --help did not describe the command.`);
  const answered = JSON.parse((await run([command, '--json', 'list', 'files'], directory, { env: { ASSISTANT_ROOT: directory } })).stdout);
  assert.equal(answered.status, 'succeeded', `${starter} did not answer a request offline.`);
  return { command: name, request: answered.status };
}

/** Boot the application the way production does: migrate, then serve and worker as separate processes. */
async function boot(starter, directory) {
  const manifest = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8'));
  if (manifest.bin && !existsSync(join(directory, 'dist', 'src', 'app.js'))) return bootCommand(starter, directory, manifest);
  const bin = join(directory, 'node_modules', 'mayura', 'lib', 'cli', 'dist', 'bin.js'); const app = join(directory, 'dist', 'src', 'app.js');
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
    // The worker reports ready once it holds (or has confirmed another replica holds) leadership, a moment after it starts.
    let ready = 0; for (let attempt = 0; attempt < 60 && ready !== 200; attempt++) { if (attempt) await new Promise(resolve => setTimeout(resolve, 250)); ready = (await fetch(`http://127.0.0.1:${probe}/readyz`)).status; }
    assert.equal(ready, 200, `${starter} worker did not become ready within 15 s.`);
    return { migrate: migrated, agents: listed.length, worker: 'ready' };
  } finally {
    for (const child of processes) { child.removeAllListeners('exit'); child.kill(); }
  }
}

const report = { status: 'passed', starters: reports, ...(reports.output ? { output: reports.output } : {}) };
console.log(JSON.stringify(report));
