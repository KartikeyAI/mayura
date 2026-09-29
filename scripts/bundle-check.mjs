// Qualify the single `mayura` package as users get it: bundle, pack, install offline into a fresh project (with and
// without the optional peers), import every entry point, type-check a strict consumer, and run the `mayura` command.
//   node scripts/bundle-check.mjs
import assert from 'node:assert/strict';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { bundle } from './bundle-package.mjs';
import { compilerPlatform, createPacker, run, workspace } from './local-packages.mjs';
import { workDirectory } from './work-directory.mjs';

const artifacts = join(workspace, '.artifacts'); await mkdir(artifacts, { recursive: true });
const output = await workDirectory(join(artifacts, 'bundle-check-')); const tarballs = join(output, 'tarballs'); await mkdir(tarballs);
const staged = join(output, 'mayura'); const summary = await bundle(staged);
const { npm, packages, packClosure } = createPacker({ output, tarballs });
const packed = JSON.parse((await run([npm, 'pack', staged, '--ignore-scripts', '--offline', '--pack-destination', tarballs, '--json'], workspace)).stdout);
const archive = join(tarballs, packed[0].filename); const manifest = JSON.parse(await readFile(join(staged, 'package.json'), 'utf8'));
// Third-party packages come from the local installation, resolved from the workspace packages that use them.
const resolveFrom = name => { for (const directory of ['cli', 'server-node', 'storage-postgres', 'storage-sqlite', 'adapter-code-quickjs', 'client-react']) {
  const path = join(workspace, 'packages', directory); if (existsSync(join(path, 'node_modules', name))) return path; } return join(workspace, 'packages', 'cli'); };

async function project(label, withPeers) {
  const directory = join(output, label); await mkdir(directory);
  const roots = [...Object.keys(manifest.dependencies), ...(withPeers ? Object.keys(manifest.peerDependencies) : [])];
  const closure = await packClosure(roots.map(name => [name, resolveFrom(name)]));
  const typescript = await packClosure([['typescript', workspace], [compilerPlatform, join(workspace, 'node_modules', '.pnpm')], ['@types/node', workspace], ...(withPeers ? [['@types/react', join(workspace, 'packages', 'client-react')]] : [])]);
  const overrides = Object.fromEntries([...closure, ...typescript].map(name => [name, packages.get(name).archive]));
  const dependencies = { mayura: pathToFileURL(archive).href, ...(withPeers ? Object.fromEntries(Object.keys(manifest.peerDependencies).map(name => [name, packages.get(name).archive])) : {}) };
  await writeFile(join(directory, 'package.json'), JSON.stringify({ name: `bundle-${label}`, private: true, type: 'module', dependencies,
    devDependencies: Object.fromEntries([...typescript].filter(name => ['typescript', compilerPlatform, '@types/node', '@types/react'].includes(name)).map(name => [name, packages.get(name).archive])), overrides }, null, 2));
  const config = join(directory, 'empty.npmrc'); await writeFile(config, '');
  await run([npm, 'install', '--offline', '--ignore-scripts', '--no-audit', '--no-fund', '--userconfig', config, '--cache', join(output, 'npm-cache')], directory, { timeout: 600_000 });
  return directory;
}

// 1. Without optional peers: `npm i mayura` alone. Everything that does not need a peer loads, and the CLI runs.
const light = await project('light', false);
const needsPeer = new Set(['./storage', './storage-sqlite', './storage-postgres', './adapter-code-quickjs', './adapter-code-docker', './client-react', './client-react/components']);
const subpaths = Object.keys(manifest.exports).filter(key => key !== './package.json');
const probe = async (directory, keys) => {
  const script = join(directory, 'probe.mjs');
  await writeFile(script, `const results = {};\nfor (const key of ${JSON.stringify(keys)}) {\n  const specifier = key === '.' ? 'mayura' : 'mayura' + key.slice(1);\n  try { const module = await import(specifier); results[key] = Object.keys(module).length; } catch (error) { results[key] = 'ERROR ' + (error.code ?? error.message); }\n}\nconsole.log(JSON.stringify(results));\n`);
  return JSON.parse((await run([script], directory)).stdout);
};
const lightResults = await probe(light, subpaths.filter(key => !needsPeer.has(key)));
for (const [key, value] of Object.entries(lightResults)) assert(typeof value === 'number' && value > 0, `mayura${key.slice(1)} did not load without peers: ${value}`);
// Bundlers that resolve nested subpaths by path (Vercel's Edge Functions) must find the same module there.
for (const key of subpaths.filter(key => key !== '.')) {
  const stub = join(light, 'node_modules', 'mayura', key.slice(2), 'index.js');
  assert(existsSync(stub), `mayura${key.slice(1)} has no file at its own path.`);
  assert.equal(manifest.exports[key].import, `${key}/index.js`, `mayura${key.slice(1)} must export the file at its own path.`);
}
const missing = await probe(light, ['./storage-sqlite']);
assert.match(String(missing['./storage-sqlite']), /ERR_MODULE_NOT_FOUND/u, 'storage-sqlite should need its optional peer.');
const bin = join(light, 'node_modules', 'mayura', manifest.bin.mayura);
assert.match((await run([bin, '--help'], light)).stdout, /mayura <command>/u);
assert.equal((await run([bin, '--version'], light)).stdout.trim(), manifest.version, 'mayura --version must print the package version.');
const starters = JSON.parse((await run([bin, 'starters'], light)).stdout);
assert.equal(starters.starters.length, 5);
const plan = JSON.parse((await run([bin, 'init', '--starter', 'research-team', '--directory', join(light, 'research')], light)).stdout);
assert(plan.plan.changes.some(change => change.path === 'src/workflow.ts'), 'The CLI in the bundle must find its starters.');

// 2. With every optional peer: every entry point loads, and a strict consumer type-checks against the declarations.
const full = await project('full', true);
const fullResults = await probe(full, subpaths);
for (const [key, value] of Object.entries(fullResults)) assert(typeof value === 'number' && value > 0, `mayura${key.slice(1)} did not load: ${value}`);
await writeFile(join(full, 'consumer.ts'), `${subpaths.map((key, index) => `import * as entry${index} from '${key === '.' ? 'mayura' : `mayura${key.slice(1)}`}';`).join('\n')}
import { defineAgent, createRuntime } from 'mayura';
import { defineWorkflowLifecycle, fanOut } from 'mayura/workflows/lifecycle';
export const entries = [${subpaths.map((_, index) => `entry${index}`).join(', ')}];
export const used = [defineAgent, createRuntime, defineWorkflowLifecycle, fanOut];
`);
await writeFile(join(full, 'tsconfig.json'), JSON.stringify({ compilerOptions: { target: 'ES2023', module: 'NodeNext', moduleResolution: 'NodeNext', lib: ['ES2023', 'DOM', 'DOM.Iterable'],
  strict: true, noUncheckedIndexedAccess: true, exactOptionalPropertyTypes: true, verbatimModuleSyntax: true, skipLibCheck: false, noEmit: true, types: ['node'], jsx: 'react-jsx' },
  include: ['consumer.ts'] }, null, 2));
await run([join(full, 'node_modules', 'typescript', 'bin', 'tsc'), '-p', join(full, 'tsconfig.json'), '--pretty', 'false'], full, { timeout: 300_000 });

// 3. Every @mayurajs extension, installed offline next to this bundle as its peer: it loads, and a strict consumer
// type-checks against its declarations and mayura's.
const { extensions } = await import('./extensions.mjs');
const extensionResults = {};
for (const extension of extensions()) {
  const name = `@mayurajs/${extension.name}`;
  const directory = join(output, `extension-${extension.name}`); await mkdir(directory);
  const closure = await packClosure([[name, workspace]]);
  const typescript = await packClosure([['typescript', workspace], [compilerPlatform, join(workspace, 'node_modules', '.pnpm')], ['@types/node', workspace]]);
  const overrides = Object.fromEntries([...closure, ...typescript].filter(entry => entry !== 'mayura' && entry !== name).map(entry => [entry, packages.get(entry).archive]));
  await writeFile(join(directory, 'package.json'), JSON.stringify({ name: `extension-${extension.name}`, private: true, type: 'module',
    dependencies: { mayura: pathToFileURL(archive).href, [name]: packages.get(name).archive },
    devDependencies: Object.fromEntries([...typescript].filter(entry => ['typescript', compilerPlatform, '@types/node'].includes(entry)).map(entry => [entry, packages.get(entry).archive])), overrides }, null, 2));
  const config = join(directory, 'empty.npmrc'); await writeFile(config, '');
  await run([npm, 'install', '--offline', '--ignore-scripts', '--no-audit', '--no-fund', '--userconfig', config, '--cache', join(output, 'npm-cache')], directory, { timeout: 600_000 });
  await writeFile(join(directory, 'probe.mjs'), `const module = await import(${JSON.stringify(name)}); console.log(JSON.stringify(Object.keys(module).length));\n`);
  const exported = JSON.parse((await run([join(directory, 'probe.mjs')], directory)).stdout);
  assert(exported > 0, `${name} did not load next to the bundle.`);
  await writeFile(join(directory, 'consumer.ts'), `import * as extension from '${name}';\nimport { createModels } from 'mayura';\nexport const used = [extension, createModels];\n`);
  await writeFile(join(directory, 'tsconfig.json'), JSON.stringify({ compilerOptions: { target: 'ES2023', module: 'NodeNext', moduleResolution: 'NodeNext', lib: ['ES2023', 'DOM', 'DOM.Iterable'],
    strict: true, exactOptionalPropertyTypes: true, verbatimModuleSyntax: true, skipLibCheck: false, noEmit: true, types: ['node'] }, include: ['consumer.ts'] }, null, 2));
  await run([join(directory, 'node_modules', 'typescript', 'bin', 'tsc'), '-p', join(directory, 'tsconfig.json'), '--pretty', 'false'], directory, { timeout: 300_000 });
  extensionResults[name] = exported;
}

const files = (await readdir(join(staged, 'lib'))).length;
console.log(JSON.stringify({ status: 'passed', package: `${manifest.name}@${manifest.version}`, tarballBytes: packed[0].size, unpackedBytes: packed[0].unpackedSize,
  archiveFiles: packed[0].entryCount, packagesBundled: files, entryPoints: subpaths.length, withoutPeers: Object.keys(lightResults).length, rewritten: summary.rewritten, extensions: extensionResults, output }));
