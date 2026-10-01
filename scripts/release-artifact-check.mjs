import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, realpathSync } from 'node:fs';
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { gunzipSync } from 'node:zlib';
import { bundle } from './bundle-package.mjs';
import { extensions, reviewedDependencies, stageExtension } from './extensions.mjs';

const exec = promisify(execFile);
const workspace = realpathSync(resolve(dirname(fileURLToPath(import.meta.url)), '..'));
// Internal packages (test harnesses, the console source embedded in @mayura/server) are never packed or published.
const internalPackages = new Set(JSON.parse(await readFile(join(workspace, 'compatibility', 'api-stability.json'), 'utf8')).internalPackages);
// The release version is the workspace version; scripts/version.mjs keeps every package in step with it.
const root = JSON.parse(await readFile(join(workspace, 'package.json'), 'utf8')); const version = root.version;
assert(typeof root.repository?.url === 'string' && root.homepage && root.bugs?.url, 'The root package.json must name the repository, homepage and issue tracker.');
assert(typeof root.author?.name === 'string' && root.author.name && typeof root.author.email === 'string', 'The root package.json must name the author.');

function npmCli() {
  const configured = process.env.MAYURA_NPM_CLI;
  const candidates = [configured, resolve(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    resolve(dirname(process.execPath), '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js')].filter(Boolean);
  const selected = candidates.find(candidate => isAbsolute(candidate) && existsSync(candidate));
  assert(selected, 'Set MAYURA_NPM_CLI to the absolute npm-cli.js path.');
  return realpathSync(selected);
}

function archiveFiles(bytes) {
  const tar = gunzipSync(bytes, { maxOutputLength: 128 * 1024 * 1024 });
  const files = new Map();
  let cursor = 0;
  while (cursor + 512 <= tar.length) {
    const header = tar.subarray(cursor, cursor + 512);
    if (header.every(byte => byte === 0)) break;
    const field = (start, length) => header.subarray(start, start + length).toString('utf8').replace(/\0.*$/s, '');
    const name = [field(345, 155), field(0, 100)].filter(Boolean).join('/');
    const size = Number.parseInt(field(124, 12).trim(), 8);
    const type = field(156, 1);
    assert(Number.isSafeInteger(size) && size >= 0 && cursor + 512 + size <= tar.length, 'Invalid release archive size.');
    assert((type === '' || type === '0' || type === '5') && name.startsWith('package/') && !name.includes('\\') && !name.split('/').includes('..'), 'Unsafe release archive member.');
    if (type !== '5') files.set(name.slice('package/'.length), tar.subarray(cursor + 512, cursor + 512 + size));
    cursor += 512 + Math.ceil(size / 512) * 512;
  }
  return files;
}

const artifactRoot = join(workspace, '.artifacts');
await mkdir(artifactRoot, { recursive: true });
const output = await mkdtemp(join(artifactRoot, 'release-'));
const tarballs = join(output, 'tarballs');
const stagingRoot = join(output, 'staging');
const npmCache = join(output, 'npm-cache');
await mkdir(tarballs);
await mkdir(stagingRoot);
await mkdir(npmCache);
const license = await readFile(join(workspace, 'LICENSE'));
const notice = await readFile(join(workspace, 'NOTICE'));
assert(license.includes(Buffer.from('Apache License')) && license.includes(Buffer.from('END OF TERMS AND CONDITIONS')), 'Root Apache-2.0 text is incomplete.');
assert(notice.includes(Buffer.from('Copyright 2026 The Mayura Authors')), 'Root attribution notice is incomplete.');

// One published package, `mayura`, bundled from every public workspace package (scripts/bundle-package.mjs).
const staging = join(stagingRoot, 'mayura'); const bundled = await bundle(staging);
const workspacePackages = (await readdir(join(workspace, 'packages'), { withFileTypes: true })).filter(entry => entry.isDirectory()
  && existsSync(join(workspace, 'packages', entry.name, 'package.json'))).map(entry => entry.name);
for (const name of workspacePackages) {
  const manifest = JSON.parse(await readFile(join(workspace, 'packages', name, 'package.json'), 'utf8'));
  if (internalPackages.has(manifest.name)) continue;
  assert(manifest.private === true && manifest.version === version && manifest.name === `@mayura/${name}`, `Source package identity is not release-safe: ${name}.`);
}
const { stdout } = await exec(process.execPath, [npmCli(), 'pack', staging, '--pack-destination', tarballs, '--ignore-scripts', '--json'], {
  cwd: workspace, timeout: 120_000, maxBuffer: 16 * 1024 * 1024, windowsHide: true,
  env: { PATH: process.env.PATH ?? '', SYSTEMROOT: process.env.SYSTEMROOT ?? '', HOME: process.env.HOME ?? '', USERPROFILE: process.env.USERPROFILE ?? '',
    npm_config_cache: npmCache, npm_config_ignore_scripts: 'true', npm_config_audit: 'false', npm_config_fund: 'false', npm_config_update_notifier: 'false' },
});
const packed = JSON.parse(stdout);
assert(Array.isArray(packed) && packed.length === 1 && typeof packed[0]?.filename === 'string');
const archivePath = join(tarballs, packed[0].filename);
const bytes = await readFile(archivePath);
const files = archiveFiles(bytes);
assert(files.get('LICENSE')?.equals(license) && files.get('NOTICE')?.equals(notice), 'mayura omitted exact legal notices.');
const packedManifest = JSON.parse(files.get('package.json').toString('utf8'));
assert(packedManifest.name === 'mayura' && packedManifest.version === version && packedManifest.license === 'Apache-2.0');
assert(packedManifest.private === undefined && packedManifest.publishConfig?.access === 'public' && packedManifest.publishConfig?.provenance === true);
assert.equal(packedManifest.repository?.url, root.repository.url, 'mayura must name the repository for provenance.');
assert.deepEqual(packedManifest.author, root.author, 'mayura must name its author.');
assert(!packedManifest.scripts, 'mayura gained release-time lifecycle behavior.');
assert.deepEqual(packedManifest.bin, { mayura: './lib/cli/dist/bin.js' }, 'CLI executable mapping changed.');
for (const [name, range] of Object.entries({ ...packedManifest.dependencies, ...packedManifest.peerDependencies })) {
  assert(!name.startsWith('@mayura/') && !String(range).startsWith('workspace:'), `mayura depends on ${name}@${range}.`);
}
assert.deepEqual(Object.keys(packedManifest.dependencies).sort(), ['@clack/prompts', '@hono/node-server', 'hono', 'zod'], 'mayura gained an unreviewed required dependency.');
assert.deepEqual(Object.keys(packedManifest.peerDependencies).sort(), ['@jitl/quickjs-wasmfile-release-sync', '@opentelemetry/api', 'better-sqlite3', 'pg', 'quickjs-emscripten-core', 'react'],
  'mayura gained an unreviewed peer dependency.');
assert(Object.values(packedManifest.peerDependenciesMeta).every(meta => meta.optional === true), 'Every peer of mayura must be optional.');
assert.equal(packedManifest.peerDependencies.react, '>=18.3.0 <20', 'React peer contract changed.');
// A project may already have another compatible version of an optional peer; an exact pin would make npm refuse it.
for (const [name, range] of Object.entries(packedManifest.peerDependencies)) assert(!/^\d/u.test(range), `mayura pins its optional peer ${name} to one exact version.`);
assert(Object.keys(packedManifest.exports).length >= 40 && packedManifest.exports['.'] && packedManifest.exports['./workflows/lifecycle'], 'mayura entry points are incomplete.');
assert([...files.keys()].some(path => path.startsWith('lib/cli/starters/research-team/src/')), 'The CLI is missing its starters.');
for (const path of ['docs/README.md', 'docs/quickstart.md', 'llms.txt', 'llms-full.txt']) assert(files.has(path), `mayura is missing its documentation: ${path}`);
for (const [path, content] of files) {
  // A starter's own tests are part of the project `mayura init` creates, so the CLI ships them.
  const starterTest = /^lib\/cli\/starters\/[a-z][a-z0-9-]*\/test\//u.test(path);
  assert(starterTest || !/(?:^|\/)(?:node_modules|test|tests|__tests__|\.git|\.env)(?:\/|\.|$)/.test(path), `Development/private content in mayura: ${path}`);
  assert(!content.includes(Buffer.from('-----BEGIN PRIVATE KEY-----')), `Private key marker in mayura: ${path}`);
  if (/^lib\/[^/]+\/dist\/.*\.(?:js|d\.ts)$/u.test(path)) assert(!/(?:from|import)\s*\(?\s*['"]@mayura\//u.test(content.toString('utf8')), `${path} still imports an @mayura package.`);
}
const reports = [{ name: 'mayura', version, filename: packed[0].filename, sha256: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length, files: files.size,
  bundled: bundled.packages, entryPoints: bundled.entryPoints }];
// Every @mayurajs extension: staged, packed and checked like mayura, and published after it (publish order follows
// the manifest).
for (const extension of extensions()) {
  const staged = join(stagingRoot, extension.name); await stageExtension(extension, staged, version);
  const { stdout: extensionPack } = await exec(process.execPath, [npmCli(), 'pack', staged, '--pack-destination', tarballs, '--ignore-scripts', '--json'], {
    cwd: workspace, timeout: 120_000, maxBuffer: 16 * 1024 * 1024, windowsHide: true,
    env: { PATH: process.env.PATH ?? '', SYSTEMROOT: process.env.SYSTEMROOT ?? '', HOME: process.env.HOME ?? '', USERPROFILE: process.env.USERPROFILE ?? '',
      npm_config_cache: npmCache, npm_config_ignore_scripts: 'true', npm_config_audit: 'false', npm_config_fund: 'false', npm_config_update_notifier: 'false' },
  });
  const [entry] = JSON.parse(extensionPack); assert(typeof entry?.filename === 'string');
  const extensionBytes = await readFile(join(tarballs, entry.filename)); const extensionFiles = archiveFiles(extensionBytes);
  const name = `@mayurajs/${extension.name}`; const published = JSON.parse(extensionFiles.get('package.json').toString('utf8'));
  assert(extensionFiles.get('LICENSE')?.equals(license) && extensionFiles.get('NOTICE')?.equals(notice), `${name} omitted exact legal notices.`);
  assert(published.name === name && published.version === version && published.license === 'Apache-2.0' && published.private === undefined, `${name} identity is not release-safe.`);
  assert(published.publishConfig?.access === 'public' && published.publishConfig?.provenance === true, `${name} must publish publicly with provenance.`);
  assert(published.repository?.url === root.repository.url && published.repository?.directory === `extensions/${extension.name}`, `${name} must name its repository directory for provenance.`);
  assert.deepEqual(published.author, root.author, `${name} must name its author.`);
  assert(!published.scripts && !published.devDependencies, `${name} gained lifecycle scripts or development dependencies.`);
  assert.deepEqual(published.peerDependencies, { mayura: `^${version}` }, `${name} must have exactly mayura as its peer, at this release.`);
  assert.deepEqual(Object.keys(published.dependencies).sort(), [...(reviewedDependencies[extension.name] ?? [])].sort(), `${name} gained an unreviewed dependency.`);
  for (const [dependency, range] of Object.entries(published.dependencies)) {
    if (dependency.startsWith('@mayurajs/')) assert.equal(range, version, `${name} must depend on ${dependency} at exactly this release.`);
  }
  for (const [path, content] of extensionFiles) {
    assert(!/(?:^|\/)(?:node_modules|test|tests|__tests__|\.git|\.env)(?:\/|\.|$)/.test(path), `Development/private content in ${name}: ${path}`);
    assert(!content.includes(Buffer.from('-----BEGIN PRIVATE KEY-----')), `Private key marker in ${name}: ${path}`);
    if (/^dist\/.*\.(?:js|d\.ts)$/u.test(path)) assert(!/(?:from|import)\s*\(?\s*['"]@mayura\//u.test(content.toString('utf8')), `${path} in ${name} imports an internal @mayura package.`);
  }
  reports.push({ name, version, filename: entry.filename, sha256: createHash('sha256').update(extensionBytes).digest('hex'), bytes: extensionBytes.length, files: extensionFiles.size });
}
const { stdout: commit } = await exec('git', ['-c', `safe.directory=${workspace.replaceAll('\\', '/')}`, 'rev-parse', 'HEAD'], { cwd: workspace, windowsHide: true });
const report = { format: 1, status: 'passed', version, sourceCommit: commit.trim(), license: 'Apache-2.0', noticeSha256: createHash('sha256').update(notice).digest('hex'), packages: reports };
await writeFile(join(output, 'release-manifest.json'), `${JSON.stringify(report, null, 2)}\n`);
await rm(stagingRoot, { recursive: true, force: true });
console.log(JSON.stringify({ status: 'passed', output, packages: reports.length, sourceCommit: report.sourceCommit }));
