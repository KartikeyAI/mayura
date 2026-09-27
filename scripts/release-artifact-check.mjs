import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, realpathSync } from 'node:fs';
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { gunzipSync } from 'node:zlib';

const exec = promisify(execFile);
const workspace = realpathSync(resolve(dirname(fileURLToPath(import.meta.url)), '..'));
// Internal packages (test harnesses, the console source embedded in @mayura/server) are never packed or published.
const internalPackages = new Set(JSON.parse(await readFile(join(workspace, 'compatibility', 'api-stability.json'), 'utf8')).internalPackages);
// The release version is the workspace version; scripts/version.mjs keeps every package in step with it.
const root = JSON.parse(await readFile(join(workspace, 'package.json'), 'utf8')); const version = root.version;
assert(typeof root.repository?.url === 'string' && root.homepage && root.bugs?.url, 'The root package.json must name the repository, homepage and issue tracker.');

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

const reports = [];
for (const directory of (await readdir(join(workspace, 'packages'), { withFileTypes: true })).filter(entry => entry.isDirectory()).sort((a, b) => a.name.localeCompare(b.name))) {
  const source = join(workspace, 'packages', directory.name);
  const manifestPath = join(source, 'package.json');
  if (!existsSync(manifestPath)) continue;
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  if (internalPackages.has(manifest.name)) continue;
  assert(manifest.private === true && manifest.version === version && manifest.name === `@mayura/${directory.name}`, 'Source package identity is not release-safe.');
  const staging = join(stagingRoot, directory.name);
  await mkdir(staging);
  // Copy what `files` publishes (npm pack applies the patterns); installs, build output and local state inside a
  // published folder (such as the CLI's starters) stay behind.
  const roots = new Set(['dist', 'src', 'image', 'templates', ...(manifest.files ?? []).map(pattern => String(pattern).split('/')[0]).filter(name => name && !name.includes('*'))]);
  const kept = path => { const parts = relative(source, path).split(sep); return !parts.slice(1).some(part => ['node_modules', '.data', 'coverage', 'dist'].includes(part) || part.endsWith('.tsbuildinfo')); };
  for (const name of [...roots].sort()) if (!['README.md', 'LICENSE', 'NOTICE', 'package.json'].includes(name) && existsSync(join(source, name))) {
    await cp(join(source, name), join(staging, name), { recursive: true, errorOnExist: true, filter: kept });
  }
  if (existsSync(join(source, 'README.md'))) await cp(join(source, 'README.md'), join(staging, 'README.md'), { errorOnExist: true });
  const dependencies = Object.fromEntries(Object.entries(manifest.dependencies ?? {}).map(([name, range]) => [name, String(range).startsWith('workspace:') ? version : range]));
  const releaseManifest = { ...manifest, private: undefined, license: 'Apache-2.0', dependencies,
    repository: { ...root.repository, directory: `packages/${directory.name}` }, homepage: root.homepage, bugs: root.bugs,
    files: [...new Set([...(manifest.files ?? []), 'LICENSE', 'NOTICE'])],
    publishConfig: { ...(manifest.publishConfig ?? {}), access: 'public', provenance: true } };
  delete releaseManifest.private;
  await writeFile(join(staging, 'package.json'), `${JSON.stringify(releaseManifest, null, 2)}\n`);
  await writeFile(join(staging, 'LICENSE'), license);
  await writeFile(join(staging, 'NOTICE'), notice);
  const { stdout } = await exec(process.execPath, [npmCli(), 'pack', staging, '--pack-destination', tarballs, '--ignore-scripts', '--json'], {
    cwd: workspace, timeout: 60_000, maxBuffer: 8 * 1024 * 1024, windowsHide: true,
    env: { PATH: process.env.PATH ?? '', SYSTEMROOT: process.env.SYSTEMROOT ?? '', HOME: process.env.HOME ?? '', USERPROFILE: process.env.USERPROFILE ?? '',
      npm_config_cache: npmCache, npm_config_ignore_scripts: 'true', npm_config_audit: 'false', npm_config_fund: 'false', npm_config_update_notifier: 'false' },
  });
  const packed = JSON.parse(stdout);
  assert(Array.isArray(packed) && packed.length === 1 && typeof packed[0]?.filename === 'string');
  const archivePath = join(tarballs, packed[0].filename);
  const bytes = await readFile(archivePath);
  const files = archiveFiles(bytes);
  assert(files.get('LICENSE')?.equals(license) && files.get('NOTICE')?.equals(notice), `${manifest.name} omitted exact legal notices.`);
  const packedManifest = JSON.parse(files.get('package.json').toString('utf8'));
  assert(packedManifest.name === manifest.name && packedManifest.version === version && packedManifest.license === 'Apache-2.0');
  assert(packedManifest.private === undefined && packedManifest.publishConfig?.access === 'public' && packedManifest.publishConfig?.provenance === true);
  assert.equal(packedManifest.repository?.url, root.repository.url, `${manifest.name} must name the repository for provenance.`);
  if (manifest.name === '@mayura/cli') assert([...files.keys()].some(path => path.startsWith('starters/research-team/src/')), 'The CLI archive is missing its starters.');
  assert(!Object.values(packedManifest.dependencies ?? {}).some(range => String(range).startsWith('workspace:')));
  if (manifest.name === '@mayura/client-react') assert.deepEqual(packedManifest.peerDependencies, { react: '>=18.3.0 <20' }, 'React peer contract changed.');
  else assert(!packedManifest.peerDependencies, `${manifest.name} gained an unreviewed peer dependency.`);
  assert(!packedManifest.scripts, `${manifest.name} gained release-time lifecycle behavior.`);
  if (manifest.name === '@mayura/cli') assert.deepEqual(packedManifest.bin, { mayura: './dist/bin.js' }, 'CLI executable mapping changed.');
  else assert(!packedManifest.bin, `${manifest.name} gained release-time executable behavior.`);
  for (const [path, content] of files) {
    // A starter's own tests are part of the project `mayura init` creates, so the CLI ships them.
    const starterTest = manifest.name === '@mayura/cli' && /^starters\/[a-z][a-z0-9-]*\/test\//u.test(path);
    assert(starterTest || !/(?:^|\/)(?:node_modules|test|tests|__tests__|\.git|\.env)(?:\/|\.|$)/.test(path), `Development/private content in ${manifest.name}: ${path}`);
    assert(!content.includes(Buffer.from('-----BEGIN PRIVATE KEY-----')), `Private key marker in ${manifest.name}: ${path}`);
  }
  reports.push({ name: manifest.name, version, filename: packed[0].filename, sha256: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length, files: files.size });
}
assert(reports.length >= 20, 'Release package inventory is unexpectedly incomplete.');
const { stdout: commit } = await exec('git', ['-c', `safe.directory=${workspace.replaceAll('\\', '/')}`, 'rev-parse', 'HEAD'], { cwd: workspace, windowsHide: true });
const report = { format: 1, status: 'passed', version, sourceCommit: commit.trim(), license: 'Apache-2.0', noticeSha256: createHash('sha256').update(notice).digest('hex'), packages: reports };
await writeFile(join(output, 'release-manifest.json'), `${JSON.stringify(report, null, 2)}\n`);
await rm(stagingRoot, { recursive: true, force: true });
console.log(JSON.stringify({ status: 'passed', output, packages: reports.length, sourceCommit: report.sourceCommit }));
