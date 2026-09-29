// Public API report: every exported symbol of every package entry point, with its kind and a digest of its
// declaration text, read from the emitted `.d.ts` files. `compatibility/api-report.json` is the reviewed baseline.
//   node scripts/api-report.mjs            fail if the surface differs from the baseline (CI)
//   node scripts/api-report.mjs --update   rewrite the baseline after an intended, reviewed change
// The emitted declarations are compiler-formatted: top-level statements start at column 0, and bodies are indented.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const workspace = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const policy = JSON.parse(await readFile(join(workspace, 'compatibility', 'api-stability.json'), 'utf8'));
const packageDirectories = new Map();
// The packages bundled into mayura, and the @mayurajs extensions published beside it.
for (const folder of ['packages', 'extensions']) {
  if (!existsSync(join(workspace, folder))) continue;
  for (const directory of await readdir(join(workspace, folder))) {
    if (!existsSync(join(workspace, folder, directory, 'package.json'))) continue;
    const manifest = JSON.parse(await readFile(join(workspace, folder, directory, 'package.json'), 'utf8'));
    packageDirectories.set(manifest.name, { directory: join(workspace, folder, directory), manifest });
  }
}

const parsed = new Map();
const declaration = /^(export\s+)?(declare\s+)?(abstract\s+)?(function|class|interface|type|const|let|var|enum|namespace)\s+([A-Za-z_$][\w$]*)/;
async function parse(file) {
  if (parsed.has(file)) return parsed.get(file);
  const text = await readFile(file, 'utf8');
  const lines = text.split(/\r?\n/).filter(line => !line.startsWith('//# sourceMappingURL'));
  const chunks = []; let current = [];
  for (const line of lines) {
    const topLevel = line.length > 0 && !/^\s/.test(line) && !/^[}\])]/.test(line);
    if (topLevel && current.length > 0) { chunks.push(current.join('\n')); current = []; }
    if (line.trim()) current.push(line);
  }
  if (current.length > 0) chunks.push(current.join('\n'));
  const result = { declarations: new Map(), named: [], stars: [], imports: new Map() };
  for (const chunk of chunks) {
    const flat = chunk.replace(/\/\*\*[\s\S]*?\*\//g, '').replace(/\s+/g, ' ').trim();
    if (!flat) continue;
    const match = declaration.exec(flat);
    if (match) {
      const kind = { let: 'const', var: 'const' }[match[4]] ?? match[4]; const name = match[5];
      const previous = result.declarations.get(name);
      result.declarations.set(name, { kind: previous?.kind === 'function' || !previous ? kind : previous.kind, text: `${previous ? `${previous.text}\n` : ''}${flat}`, exported: Boolean(match[1]) || previous?.exported === true });
      continue;
    }
    const imported = /^import (?:type )?\{([^}]*)\} from ['"](.+)['"];?$/.exec(flat);
    if (imported) {
      for (const part of imported[1].split(',').map(item => item.trim()).filter(Boolean)) {
        const [name, alias] = part.replace(/^type\s+/, '').split(/\s+as\s+/); result.imports.set((alias ?? name).trim(), { name: name.trim(), from: imported[2] });
      }
      continue;
    }
    const star = /^export \* from ['"](.+)['"];?$/.exec(flat);
    if (star) { result.stars.push(star[1]); continue; }
    const named = /^export (?:type )?\{([^}]*)\}(?: from ['"](.+)['"])?;?$/.exec(flat);
    if (named) {
      const names = named[1].split(',').map(part => part.trim()).filter(Boolean).map(part => {
        const [local, exported] = part.replace(/^type\s+/, '').split(/\s+as\s+/); return [local.trim(), (exported ?? local).trim()];
      });
      result.named.push({ names, from: named[2] });
    }
  }
  parsed.set(file, result); return result;
}
function target(from, specifier) {
  if (specifier.startsWith('.')) return resolve(dirname(from), specifier.replace(/\.js$/, '.d.ts'));
  const [scope, name, ...rest] = specifier.split('/');
  const entry = packageDirectories.get(`${scope}/${name}`); assert(entry, `Unknown package ${specifier}`);
  const exported = entry.manifest.exports[rest.length ? `./${rest.join('/')}` : '.'];
  return join(entry.directory, exported.types);
}
/** A third-party package re-exported as public API (`z` from `zod`), as `name@major`: only a new major changes it. */
async function externalPackage(file, specifier) {
  for (let directory = dirname(file); ; directory = dirname(directory)) {
    const manifest = join(directory, 'node_modules', specifier, 'package.json');
    if (existsSync(manifest)) return `${specifier}@${JSON.parse(await readFile(manifest, 'utf8')).version.split('.')[0]}`;
    assert(dirname(directory) !== directory, `Cannot find ${specifier}, re-exported by ${file}.`);
  }
}
async function exportsOf(file, seen = new Set()) {
  if (seen.has(file)) return new Map(); seen.add(file);
  assert(existsSync(file), `Missing declaration file ${file}; run pnpm build.`);
  const module = await parse(file); const result = new Map();
  for (const [name, value] of module.declarations) if (value.exported) result.set(name, value);
  for (const { names, from } of module.named) {
    if (from && !from.startsWith('.') && !from.startsWith('@mayura/')) {
      const external = await externalPackage(file, from);
      for (const [local, exported] of names) result.set(exported, { kind: 'external', text: `${external}#${local}` });
      continue;
    }
    const source = from ? await exportsOf(target(file, from), new Set(seen)) : undefined;
    for (const [local, exported] of names) {
      const through = !source && !module.declarations.has(local) ? module.imports.get(local) : undefined;
      const value = source ? source.get(local) : through ? (await exportsOf(target(file, through.from), new Set(seen))).get(through.name) : module.declarations.get(local);
      result.set(exported, value ?? { kind: 'unresolved', text: `${from ?? ''}#${local}` });
    }
  }
  for (const from of module.stars) for (const [name, value] of await exportsOf(target(file, from), new Set(seen))) if (!result.has(name)) result.set(name, value);
  return result;
}

const report = {};
for (const [name, { directory, manifest }] of [...packageDirectories].sort(([a], [b]) => a.localeCompare(b))) {
  if (policy.internalPackages.includes(name)) continue;
  for (const [path, entry] of Object.entries(manifest.exports ?? {})) {
    assert(typeof entry === 'object' && typeof entry.types === 'string', `${name}${path.slice(1)} has no types entry.`);
    const symbols = await exportsOf(join(directory, entry.types));
    report[path === '.' ? name : `${name}${path.slice(1)}`] = Object.fromEntries([...symbols].sort(([a], [b]) => a.localeCompare(b)).map(([symbol, value]) =>
      [symbol, { kind: value.kind, declaration: createHash('sha256').update(value.text).digest('hex').slice(0, 16) }]));
  }
}
const unresolved = Object.entries(report).flatMap(([entry, symbols]) => Object.entries(symbols).filter(([, value]) => value.kind === 'unresolved').map(([symbol]) => `${entry}#${symbol}`));
assert.deepEqual(unresolved, [], 'Some exported symbols could not be resolved to a declaration.');
const path = join(workspace, 'compatibility', 'api-report.json');
const count = Object.values(report).reduce((sum, value) => sum + Object.keys(value).length, 0);
if (process.argv.includes('--update')) {
  await writeFile(path, `${JSON.stringify({ format: 1, entryPoints: report }, null, 2)}\n`);
  console.log(JSON.stringify({ status: 'updated', entryPoints: Object.keys(report).length, symbols: count }));
} else {
  const baseline = JSON.parse(await readFile(path, 'utf8')); const changes = [];
  for (const name of new Set([...Object.keys(baseline.entryPoints), ...Object.keys(report)])) {
    const before = baseline.entryPoints[name] ?? {}; const after = report[name] ?? {};
    for (const symbol of new Set([...Object.keys(before), ...Object.keys(after)])) {
      if (!before[symbol]) changes.push({ entryPoint: name, symbol, change: 'added' });
      else if (!after[symbol]) changes.push({ entryPoint: name, symbol, change: 'removed' });
      else if (before[symbol].kind !== after[symbol].kind || before[symbol].declaration !== after[symbol].declaration) changes.push({ entryPoint: name, symbol, change: 'changed' });
    }
  }
  if (changes.length > 0) {
    console.error(JSON.stringify({ status: 'changed', changes }, null, 2));
    console.error('Removals and changes to stable entry points need a major version (or a documented deprecation); additions need a minor version. After review, run: node scripts/api-report.mjs --update');
    process.exit(1);
  }
  console.log(JSON.stringify({ status: 'unchanged', entryPoints: Object.keys(report).length, symbols: count }));
}
