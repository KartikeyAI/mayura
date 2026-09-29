// Build the single published `mayura` package from the workspace packages.
//
// Each public workspace package is copied, as built, to lib/<name>/ (its dist, src and published assets, so source
// maps and the CLI's templates and starters keep their relative paths). Every import of `@mayura/<name>[/<sub>]` is
// rewritten to a relative path to the file that export names, so the result depends on no @mayura package. The
// package's `exports` map each workspace entry point to a subpath of `mayura`:
//   @mayura/sdk -> mayura (and mayura/sdk)   @mayura/workflows/lifecycle -> mayura/workflows/lifecycle
// Heavy third-party packages (native SQLite, PostgreSQL, QuickJS, React) become optional peers: install one only when
// you use the part that needs it.
//   node scripts/bundle-package.mjs <output directory>
import assert from 'node:assert/strict';
import { cp, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join, posix, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const workspace = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const root = JSON.parse(await readFile(join(workspace, 'package.json'), 'utf8'));
const policy = JSON.parse(await readFile(join(workspace, 'compatibility', 'api-stability.json'), 'utf8'));
const internal = new Set(policy.internalPackages);
/** Always installed with `mayura`: small, pure JavaScript. */
const required = new Set(['@clack/prompts', 'hono', '@hono/node-server', 'zod']);

/** The public workspace packages: short name, manifest and directory. */
export async function workspacePackages() {
  const found = [];
  for (const entry of (await readdir(join(workspace, 'packages'), { withFileTypes: true })).filter(item => item.isDirectory()).sort((a, b) => a.name.localeCompare(b.name))) {
    const path = join(workspace, 'packages', entry.name, 'package.json'); if (!existsSync(path)) continue;
    const manifest = JSON.parse(await readFile(path, 'utf8'));
    if (internal.has(manifest.name) || !manifest.name.startsWith('@mayura/')) continue;
    assert.equal(manifest.name, `@mayura/${entry.name}`, `${entry.name} must be named @mayura/${entry.name}.`);
    found.push({ name: entry.name, manifest, directory: join(workspace, 'packages', entry.name) });
  }
  return found;
}

/** `@mayura/<name>[/<sub>]` -> { name, key } where key is the export key ('.' or './<sub>'). */
function parseSpecifier(specifier) {
  const match = /^@mayura\/([a-z][a-z0-9-]*)(?:\/(.+))?$/u.exec(specifier); if (!match) return undefined;
  return { name: match[1], key: match[2] ? `./${match[2]}` : '.' };
}
const target = (value, condition) => typeof value === 'string' ? value : value?.[condition] ?? value?.default;

export async function bundle(output) {
  const packages = await workspacePackages(); const byName = new Map(packages.map(item => [item.name, item]));
  await mkdir(output, { recursive: true });
  const exportsMap = {}; const peers = {}; const dependencies = {};
  for (const { name, manifest, directory } of packages) {
    assert(existsSync(join(directory, 'dist')), `Build @mayura/${name} first (pnpm build).`);
    // What this package publishes: its dist, sources for maps, and any assets its `files` name (templates, starters, image).
    const roots = new Set(['dist', 'src', ...(manifest.files ?? []).map(pattern => String(pattern).split('/')[0]).filter(item => item && !item.includes('*'))]);
    const kept = path => { const parts = relative(directory, path).split(sep); return !parts.slice(1).some(part => ['node_modules', '.data', 'coverage', 'dist'].includes(part) || part.endsWith('.tsbuildinfo')); };
    for (const item of [...roots].sort()) if (!['README.md', 'LICENSE', 'NOTICE', 'package.json'].includes(item) && existsSync(join(directory, item))) {
      await cp(join(directory, item), join(output, 'lib', name, item), { recursive: true, filter: kept });
    }
    // Relative files keep ESM semantics and let the CLI read its own version, as in the workspace.
    await writeFile(join(output, 'lib', name, 'package.json'), `${JSON.stringify({ type: 'module', version: root.version, private: true }, null, 2)}\n`);
    for (const [key, value] of Object.entries(manifest.exports ?? {})) {
      const subpath = key === '.' ? `./${name}` : `./${name}/${key.slice(2)}`;
      exportsMap[subpath] = { types: `./lib/${name}/${target(value, 'types').replace(/^\.\//u, '')}`, import: `./lib/${name}/${target(value, 'import').replace(/^\.\//u, '')}` };
    }
    for (const [dependency, range] of Object.entries(manifest.dependencies ?? {})) {
      if (dependency.startsWith('@mayura/')) continue;
      (required.has(dependency) ? dependencies : peers)[dependency] = range;
    }
    for (const [dependency, range] of Object.entries(manifest.peerDependencies ?? {})) peers[dependency] = range;
  }
  // The workspace pins exact versions (what CI tests). A project installs optional peers itself and may already have
  // another compatible version, so the published peers accept the same major (0.x: the same minor) from that version.
  for (const [dependency, range] of Object.entries(peers)) if (/^\d+\.\d+\.\d+$/u.test(range)) peers[dependency] = `^${range}`;
  // Rewrite every @mayura/... specifier in JavaScript and declarations to a relative path.
  const rewrite = (file, text) => text.replace(/((?:from|import)\s*\(?\s*)(['"])(@mayura\/[^'"]+)\2/gu, (whole, prefix, quote, specifier) => {
    const parsed = parseSpecifier(specifier); assert(parsed, `Unexpected specifier ${specifier} in ${file}.`);
    const owner = byName.get(parsed.name); assert(owner, `${file} imports ${specifier}, which is not a public package.`);
    const value = owner.manifest.exports?.[parsed.key]; assert(value, `${file} imports ${specifier}, which @mayura/${parsed.name} does not export.`);
    const destination = join(output, 'lib', parsed.name, target(value, 'import'));
    let path = relative(dirname(file), destination).split(sep).join(posix.sep); if (!path.startsWith('.')) path = `./${path}`;
    return `${prefix}${quote}${path}${quote}`;
  });
  let rewritten = 0;
  const walk = async folder => {
    for (const entry of await readdir(folder, { withFileTypes: true })) {
      const path = join(folder, entry.name);
      if (entry.isDirectory()) { if (!['starters', 'templates', 'src'].includes(entry.name) || !path.includes(`${sep}lib${sep}cli${sep}`)) await walk(path); continue; }
      if (!/\.(?:js|d\.ts)$/u.test(entry.name) || !path.includes(`${sep}dist${sep}`)) continue;
      const text = await readFile(path, 'utf8'); const next = rewrite(path, text);
      if (next !== text) { await writeFile(path, next); rewritten += 1; }
      assert(!/(?:from|import)\s*\(?\s*['"]@mayura\//u.test(next), `${path} still imports an @mayura package.`);
    }
  };
  await walk(join(output, 'lib'));
  // Every subpath is also a real file at its own path, `<subpath>/index.js`, re-exporting the module in lib, and the
  // export map points there. Bundlers that resolve nested subpaths by path instead of through `exports`, such as
  // Vercel's Edge Functions, then find the same module, and file tracing ships the stub with what it imports.
  const stubs = new Set();
  for (const [key, value] of Object.entries(exportsMap)) {
    const folder = join(output, key.slice(2)); await mkdir(folder, { recursive: true });
    const from = file => { const path = relative(folder, join(output, file)).split(sep).join(posix.sep); return path.startsWith('.') ? path : `./${path}`; };
    await writeFile(join(folder, 'index.js'), `export * from '${from(value.import)}';\n`);
    await writeFile(join(folder, 'index.d.ts'), `export * from '${from(value.types).replace(/\.d\.ts$/u, '.js')}';\n`);
    exportsMap[key] = { types: value.types, import: `./${key.slice(2)}/index.js` };
    stubs.add(key.slice(2).split('/')[0]);
  }
  // `mayura` itself is the SDK, the usual starting point.
  exportsMap['.'] = { types: exportsMap['./sdk'].types, import: './sdk/index.js' }; exportsMap['./package.json'] = './package.json';
  const cli = packages.find(item => item.name === 'cli');
  const manifest = {
    name: 'mayura', version: root.version,
    description: 'A TypeScript framework for agents, typed tools and durable workflows.',
    keywords: ['agents', 'ai', 'llm', 'workflows', 'durable', 'typescript', 'tools'],
    author: root.author, license: 'Apache-2.0', repository: root.repository, homepage: root.homepage, bugs: root.bugs,
    type: 'module', sideEffects: false, engines: cli.manifest.engines,
    bin: { mayura: `./lib/cli/${cli.manifest.bin.mayura.replace(/^\.\//u, '')}` },
    exports: Object.fromEntries(Object.entries(exportsMap).sort(([a], [b]) => a === '.' ? -1 : b === '.' ? 1 : a.localeCompare(b))),
    files: ['lib', ...[...stubs].sort(), 'docs', 'llms.txt', 'llms-full.txt', 'README.md', 'LICENSE', 'NOTICE'],
    dependencies: Object.fromEntries(Object.entries(dependencies).sort()),
    peerDependencies: Object.fromEntries(Object.entries(peers).sort()),
    peerDependenciesMeta: Object.fromEntries(Object.keys(peers).sort().map(name => [name, { optional: true }])),
    publishConfig: { access: 'public', provenance: true },
  };
  await writeFile(join(output, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  for (const file of ['LICENSE', 'NOTICE']) await cp(join(workspace, file), join(output, file));
  await cp(join(workspace, 'README.md'), join(output, 'README.md'));
  // The documentation for this exact version, for people and for AI coding assistants reading node_modules.
  await cp(join(workspace, 'docs'), join(output, 'docs'), { recursive: true });
  const { llmsTxt, llmsFullTxt } = await import('./docs-index.mjs');
  await writeFile(join(output, 'llms.txt'), llmsTxt({ full: true })); await writeFile(join(output, 'llms-full.txt'), llmsFullTxt());
  return { output, packages: packages.length, entryPoints: Object.keys(exportsMap).length - 1, rewritten, dependencies: Object.keys(dependencies), peers: Object.keys(peers) };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const output = process.argv[2]; assert(output, 'Use: node scripts/bundle-package.mjs <output directory>');
  assert(!existsSync(output) || (await readdir(output)).length === 0, 'The output directory must be new or empty.');
  console.log(JSON.stringify(await bundle(resolve(output))));
}
