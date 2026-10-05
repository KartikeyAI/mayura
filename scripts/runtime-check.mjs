// Runs scripts/runtime-probe.mjs on every supported JavaScript runtime and compares each result with Node's:
//   node      the reference
//   bun, deno the executables on PATH, or MAYURA_BUN / MAYURA_DENO
//   workerd   Cloudflare's runtime, strict: an old compatibility date and no nodejs_compat, so no Node APIs at all
//   edge      Vercel's Edge Functions VM (@edge-runtime/vm): web APIs only
// A runtime whose executable is missing is skipped, unless it is listed with --require. Run `pnpm build` first.
//   node scripts/runtime-check.mjs [--require bun,deno,workerd,edge]
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { rolldown } from 'rolldown';

const workspace = join(import.meta.dirname, '..');
const probeFile = join(import.meta.dirname, 'runtime-probe.mjs');
const probeUrl = pathToFileURL(probeFile).href;
const marker = 'MAYURA_PROBE ';
const requireIndex = process.argv.indexOf('--require');
const required = new Set(requireIndex > 0 ? process.argv[requireIndex + 1].split(',') : []);

/** One ESM or IIFE file with every import inlined, resolved the way edge bundlers do. */
async function bundle(entry, format) {
  const build = await rolldown({ input: entry, platform: 'browser', logLevel: 'silent', cwd: workspace,
    resolve: { conditionNames: ['edge-light', 'workerd', 'worker', 'browser', 'import', 'default'] } });
  const { output } = await build.generate({ format, codeSplitting: false });
  await build.close();
  return output[0].code;
}

const parse = (text, runtime) => {
  const line = text.split('\n').find(candidate => candidate.includes(marker));
  if (!line) throw new Error(`${runtime} printed no result:\n${text.slice(-2_000)}`);
  return JSON.parse(line.slice(line.indexOf(marker) + marker.length));
};
const run = (command, args, options = {}) => spawnSync(command, args, { cwd: workspace, encoding: 'utf8', timeout: 180_000, maxBuffer: 64 * 1024 * 1024, ...options });

const runtimes = {
  async bun(directory) {
    const bun = process.env['MAYURA_BUN'] ?? 'bun';
    const main = join(directory, 'bun.mjs');
    await writeFile(main, `import { probe } from ${JSON.stringify(probeUrl)};\nconsole.log(${JSON.stringify(marker)} + JSON.stringify(await probe()));\n`);
    const result = run(bun, [main]);
    if (result.error?.code === 'ENOENT') return undefined;
    return parse(`${result.stdout}\n${result.stderr}`, 'Bun');
  },
  async deno(directory) {
    const deno = process.env['MAYURA_DENO'] ?? 'deno';
    const main = join(directory, 'deno.mjs');
    await writeFile(main, `import { probe } from ${JSON.stringify(probeUrl)};\nconsole.log(${JSON.stringify(marker)} + JSON.stringify(await probe()));\n`);
    // The entry is outside the workspace, so Deno would not look for its package.json: resolve bare imports (the
    // probe's mayura/...) through the workspace's node_modules, as Node does.
    const result = run(deno, ['run', '--node-modules-dir=manual', '--allow-read', '--allow-env', '--no-prompt', main]);
    if (result.error?.code === 'ENOENT') return undefined;
    return parse(`${result.stdout}\n${result.stderr}`, 'Deno');
  },
  async workerd(directory) {
    const entry = join(directory, 'worker-entry.mjs');
    await writeFile(entry, `import { probe } from ${JSON.stringify(probeFile.replaceAll('\\', '/'))};\nexport default { async test() { console.log(${JSON.stringify(marker)} + JSON.stringify(await probe())); } };\n`);
    await writeFile(join(directory, 'worker.js'), await bundle(entry, 'esm'));
    await writeFile(join(directory, 'config.capnp'), [
      'using Workerd = import "/workerd/workerd.capnp";',
      'const config :Workerd.Config = ( services = [ (name = "probe", worker = .probe) ] );',
      // An old compatibility date without nodejs_compat: no node: modules, no Buffer, no process.
      'const probe :Workerd.Worker = ( modules = [ (name = "worker.js", esModule = embed "worker.js") ], compatibilityDate = "2024-09-01" );',
    ].join('\n'));
    const result = run(process.execPath, [join(workspace, 'node_modules', 'workerd', 'bin', 'workerd'), 'test', '--verbose', join(directory, 'config.capnp')]);
    return parse(`${result.stdout}\n${result.stderr}`, 'workerd');
  },
  async edge(directory) {
    const entry = join(directory, 'edge-entry.mjs');
    await writeFile(entry, `import { probe } from ${JSON.stringify(probeFile.replaceAll('\\', '/'))};\nglobalThis.__mayuraProbe = probe;\n`);
    const { EdgeVM } = await import('@edge-runtime/vm');
    const vm = new EdgeVM();
    vm.evaluate(await bundle(entry, 'iife'));
    for (const name of ['Buffer', 'process', 'require']) if (vm.evaluate(`typeof ${name}`) !== 'undefined') throw new Error(`The edge VM defines ${name}.`);
    return JSON.parse(JSON.stringify(await vm.evaluate('globalThis.__mayuraProbe()')));
  },
};

const { probe } = await import(probeUrl);
const reference = await probe();
const failures = [];
const report = (runtime, results) => {
  for (const [name, result] of Object.entries(results)) {
    const expected = reference[name];
    if (!result.ok) failures.push(`${runtime}: ${name}: ${result.error}${result.stack?.length ? ` @ ${result.stack.join(' | ')}` : ''}`);
    else if (runtime !== 'node' && !isDeepStrictEqual(result.detail, expected?.detail)) failures.push(`${runtime}: ${name} gave ${JSON.stringify(result.detail)}, Node gave ${JSON.stringify(expected?.detail)}`);
  }
  const missing = Object.keys(reference).filter(name => !(name in results));
  if (missing.length) failures.push(`${runtime}: no result for ${missing.join(', ')}`);
  console.log(`${runtime}: ${Object.values(results).filter(result => result.ok).length}/${Object.keys(reference).length} checks passed`);
};
report('node', reference);

const directory = await mkdtemp(join(tmpdir(), 'mayura-runtimes-'));
try {
  for (const [runtime, check] of Object.entries(runtimes)) {
    let results;
    try { results = await check(directory); }
    catch (error) { failures.push(`${runtime}: ${error.message}`); console.log(`${runtime}: failed to run`); continue; }
    if (results === undefined) {
      if (required.has(runtime)) failures.push(`${runtime}: not installed`);
      console.log(`${runtime}: skipped, not installed`);
      continue;
    }
    report(runtime, results);
  }
} finally { await rm(directory, { recursive: true, force: true }); }

if (failures.length > 0) { console.error(`\n${failures.join('\n')}`); process.exit(1); }
