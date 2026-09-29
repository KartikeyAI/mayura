// The @mayurajs/* packages in extensions/: published to npm separately from `mayura`, in lockstep with it (the same
// version), with `mayura` as a peer. Each is a private workspace package; stageExtension() turns one into the package
// that is published.
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const workspace = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const extensionsRoot = join(workspace, 'extensions');

/**
 * The third-party dependencies each extension may have, by extension. Vendor SDKs are exactly what a release must
 * review, so a new one fails the release checks until it is listed here.
 */
export const reviewedDependencies = {
  'provider-anthropic': ['@anthropic-ai/sdk'],
  'provider-openai': ['openai'],
};

/** Every extension: its folder name, directory and source manifest. */
export function extensions() {
  if (!existsSync(extensionsRoot)) return [];
  return readdirSync(extensionsRoot, { withFileTypes: true })
    .filter(entry => entry.isDirectory() && existsSync(join(extensionsRoot, entry.name, 'package.json')))
    .map(entry => ({ name: entry.name, directory: join(extensionsRoot, entry.name), manifest: JSON.parse(readFileSync(join(extensionsRoot, entry.name, 'package.json'), 'utf8')) }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** Checks a source manifest: private, at the release version, named after its folder, with `mayura` only as a peer. */
export function checkSource({ name, manifest }, version) {
  assert.equal(manifest.name, `@mayurajs/${name}`, `extensions/${name} must be named @mayurajs/${name}.`);
  assert.equal(manifest.private, true, `extensions/${name} must stay private in the workspace; staging publishes it.`);
  assert.equal(manifest.version, version, `extensions/${name} is at ${manifest.version}, not ${version}.`);
  assert.equal(manifest.peerDependencies?.mayura, 'workspace:^', `extensions/${name} must have mayura as its peer (workspace:^).`);
  assert.deepEqual(Object.keys(manifest.devDependencies ?? {}), ['mayura'], `extensions/${name} may only have mayura as a development dependency.`);
  const dependencies = Object.keys(manifest.dependencies ?? {}).sort();
  assert.deepEqual(dependencies, [...(reviewedDependencies[name] ?? [])].sort(), `extensions/${name} has unreviewed dependencies; list them in scripts/extensions.mjs.`);
  for (const [dependency, range] of Object.entries(manifest.dependencies ?? {})) {
    assert(/^\d+\.\d+\.\d+$/u.test(range), `extensions/${name} must pin ${dependency} to one exact version.`);
    assert(!dependency.startsWith('@mayura/') && dependency !== 'mayura', `extensions/${name} must not depend on ${dependency}.`);
  }
}

/** Every JavaScript and declaration file under a folder. */
function sources(folder) {
  return readdirSync(folder, { withFileTypes: true }).flatMap(entry => entry.isDirectory()
    ? sources(join(folder, entry.name)) : /\.(?:js|d\.ts)$/u.test(entry.name) ? [join(folder, entry.name)] : []);
}

/**
 * Writes the publishable package for one extension into `output`: its built `dist`, sources for source maps, README,
 * the repository's LICENSE and NOTICE, and a manifest with the release's metadata. Run `pnpm build` first.
 */
export async function stageExtension(extension, output, version) {
  const { name, directory, manifest } = extension;
  const root = JSON.parse(await readFile(join(workspace, 'package.json'), 'utf8'));
  checkSource(extension, version);
  assert(existsSync(join(directory, 'dist')), `Build extensions/${name} first (pnpm build).`);
  for (const file of sources(join(directory, 'dist'))) {
    const text = readFileSync(file, 'utf8');
    assert(!/(?:from|import)\s*\(?\s*['"]@mayura\//u.test(text), `extensions/${name} imports an internal @mayura package: ${file}`);
  }
  await mkdir(output, { recursive: true });
  await cp(join(directory, 'dist'), join(output, 'dist'), { recursive: true });
  await cp(join(directory, 'src'), join(output, 'src'), { recursive: true });
  for (const file of ['LICENSE', 'NOTICE']) await cp(join(workspace, file), join(output, file));
  if (existsSync(join(directory, 'README.md'))) await cp(join(directory, 'README.md'), join(output, 'README.md'));
  const published = {
    name: manifest.name, version, description: manifest.description, keywords: manifest.keywords,
    author: root.author, license: 'Apache-2.0',
    repository: { ...root.repository, directory: `extensions/${name}` }, homepage: root.homepage, bugs: root.bugs,
    type: 'module', sideEffects: manifest.sideEffects ?? false, engines: manifest.engines, exports: manifest.exports,
    files: ['dist', 'src/**/*.ts', 'README.md', 'LICENSE', 'NOTICE'],
    dependencies: manifest.dependencies ?? {},
    // Lockstep: an extension works with the mayura it was released with and later minors of the same major.
    peerDependencies: { mayura: `^${version}` },
    publishConfig: { access: 'public', provenance: true },
  };
  await writeFile(join(output, 'package.json'), `${JSON.stringify(published, null, 2)}\n`);
  return published;
}
