// Which entry points of `mayura` run on web-standard runtimes (Cloudflare Workers, Vercel Edge Functions, Deno and
// Bun)? Bundles every entry point of the workspace facade the way an edge bundler does (browser platform, the
// edge-light and worker conditions) and fails when one outside NODE_ONLY reaches a Node built-in module or the global
// Buffer or process. Run `pnpm build` first.
//   node scripts/edge-check.mjs            check
//   node scripts/edge-check.mjs --report   print what every entry point reaches
import { readFile } from 'node:fs/promises';
import { builtinModules } from 'node:module';
import { join, relative } from 'node:path';
import { rolldown } from 'rolldown';

const workspace = join(import.meta.dirname, '..');
const facade = join(workspace, 'packages', 'mayura');

/** Entry points that need Node: the filesystem, child processes, native modules, TCP sockets or the terminal. */
export const NODE_ONLY = new Map([
  ['./adapter-code-docker', 'runs Docker as a child process'],
  ['./adapter-code-quickjs', 'runs QuickJS in a worker thread'],
  ['./artifacts', 'the local artifact store writes to the filesystem'],
  ['./cli', 'the command line'],
  ['./server-node', 'the Node HTTP server'],
  ['./skills', 'loads skills from the filesystem'],
  ['./storage', 'SQLite through a native module'],
  ['./storage-sqlite', 'SQLite through a native module'],
  ['./storage-postgres', 'the pg driver needs TCP sockets; use ./storage-postgres/driver at the edge'],
  ['./terminal', 'the terminal'],
]);

const builtins = new Set(builtinModules.flatMap(name => [name, `node:${name}`]));
const globalUse = [
  ['Buffer', /(?<![.\w$])Buffer\s*\.\s*(?:from|alloc|allocUnsafe|byteLength|concat|isBuffer)\b/u],
  ['process', /(?<![.\w$'"`])process\s*\.\s*(?:env|stdout|stderr|stdin|cwd|argv|exit|nextTick|on|platform)\b/u],
];

async function reach(entry) {
  const reached = new Map();
  const bundle = await rolldown({
    input: join(facade, manifest.exports[entry].import), platform: 'browser', logLevel: 'silent',
    resolve: { conditionNames: ['edge-light', 'worker', 'browser', 'import', 'default'] },
    plugins: [{ name: 'node-builtins', resolveId(source, importer) {
      if (!builtins.has(source)) return null;
      const from = importer ? relative(workspace, importer).replaceAll('\\', '/') : '(entry)';
      if (!reached.has(source.replace(/^node:/u, ''))) reached.set(source.replace(/^node:/u, ''), from);
      return { id: source, external: true };
    } }],
  });
  const { output } = await bundle.generate({ format: 'esm', codeSplitting: false, minify: true });
  await bundle.close();
  const code = output.filter(chunk => chunk.type === 'chunk').map(chunk => chunk.code).join('\n');
  for (const [name, pattern] of globalUse) if (pattern.test(code)) reached.set(`global ${name}`, code.match(pattern)[0]);
  return reached;
}

const manifest = JSON.parse(await readFile(join(facade, 'package.json'), 'utf8'));
const entries = Object.keys(manifest.exports).filter(key => key !== './package.json');
const report = process.argv.includes('--report');
const failures = [];
for (const entry of entries) {
  const reached = await reach(entry);
  const nodeOnly = NODE_ONLY.has(entry);
  if (report) console.log(`${nodeOnly ? 'node' : 'edge'} ${entry}${reached.size ? `: ${[...reached].map(([name, from]) => `${name} (${from})`).join(', ')}` : ''}`);
  if (!nodeOnly && reached.size > 0) failures.push(`${entry} reaches ${[...reached].map(([name, from]) => `${name} via ${from}`).join('; ')}`);
}
for (const entry of NODE_ONLY.keys()) if (!entries.includes(entry)) failures.push(`NODE_ONLY lists ${entry}, which is not an entry point`);
if (failures.length > 0) { console.error(`Entry points that must run at the edge use Node-only APIs:\n  ${failures.join('\n  ')}`); process.exit(1); }
console.log(`${entries.length - NODE_ONLY.size} entry points are edge-compatible; ${NODE_ONLY.size} are Node-only.`);
