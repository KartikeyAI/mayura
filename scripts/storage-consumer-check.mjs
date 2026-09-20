import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { closeSync, existsSync, openSync, readSync, realpathSync, statSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { delimiter, dirname, isAbsolute, join, posix, relative, resolve, sep } from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { gunzipSync } from 'node:zlib';
import { assertConsumerTypeFiles } from './consumer-type-isolation.mjs';

const exec = promisify(execFile);
const workspace = await realpath(resolve(dirname(fileURLToPath(import.meta.url)), '..'));
for (const name of ['storage-sql', 'storage-sqlite', 'storage-postgres']) {
  assert(existsSync(join(workspace, 'packages', name, 'package.json')), `Missing selected storage package: @mayura/${name}`);
}

const mayura = {
  core: [], 'storage-contracts': ['@mayura/core'], 'storage-sql': ['@mayura/core', '@mayura/storage-contracts'],
  'storage-sqlite': ['@mayura/storage-contracts', '@mayura/storage-sql', 'better-sqlite3'],
  'storage-postgres': ['@mayura/storage-contracts', '@mayura/storage-sql', 'pg'],
  storage: ['@mayura/storage-contracts', '@mayura/storage-postgres', '@mayura/storage-sqlite'],
};
// Existing resolved versions only. Changes require an explicit dependency-qualification review.
const external = {
  'better-sqlite3': ['13.0.3', ['node-addon-api']], 'node-addon-api': ['8.9.2', []],
  pg: ['8.23.0', ['pg-connection-string', 'pg-pool', 'pg-protocol', 'pg-types', 'pgpass']],
  'pg-connection-string': ['2.14.0', []], 'pg-pool': ['3.14.0', []], 'pg-protocol': ['1.16.0', []],
  'pg-types': ['2.2.0', ['pg-int8', 'postgres-array', 'postgres-bytea', 'postgres-date', 'postgres-interval']],
  'pg-int8': ['1.0.1', []], 'postgres-array': ['2.0.0', []], 'postgres-bytea': ['1.0.1', []],
  'postgres-date': ['1.0.7', []], 'postgres-interval': ['1.2.0', ['xtend']], xtend: ['4.0.2', []],
  pgpass: ['1.0.5', ['split2']], split2: ['4.2.0', []], 'pg-cloudflare': ['1.4.0', []],
};
const postgresPackages = Object.keys(external).filter(name => name !== 'better-sqlite3' && name !== 'node-addon-api');
function inside(parent, child) { const value = relative(parent, child); return value !== '..' && !value.startsWith(`..${sep}`) && !isAbsolute(value); }
function environment() {
  const allowed = new Set(['PATH', 'PATHEXT', 'SYSTEMROOT', 'WINDIR', 'TEMP', 'TMP', 'TMPDIR', 'HOME', 'USERPROFILE', 'LOCALAPPDATA', 'APPDATA', 'PROGRAMFILES', 'COREPACK_HOME']);
  return { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => allowed.has(key.toUpperCase()))),
    COREPACK_ENABLE_NETWORK: '0', COREPACK_ENABLE_DOWNLOAD_PROMPT: '0', npm_config_ignore_scripts: 'true',
    npm_config_update_notifier: 'false', npm_config_audit: 'false', npm_config_fund: 'false' };
}
function cli(kind) {
  const nodeShebang = path => {
    const bytes = Buffer.alloc(256); let fd;
    try { fd = openSync(path, 'r'); return /^#![^\r\n]*\bnode\b/.test(bytes.subarray(0, readSync(fd, bytes, 0, bytes.length, 0)).toString('utf8')); }
    catch { return false; } finally { if (fd !== undefined) closeSync(fd); }
  };
  const valid = path => { try { return isAbsolute(path) && statSync(path).isFile() && (/\.(?:js|cjs|mjs)$/i.test(path) || nodeShebang(path)); } catch { return false; } };
  const configured = process.env[`MAYURA_${kind.toUpperCase()}_CLI`];
  if (configured) { assert(valid(configured), 'Configured package-manager CLI must be an absolute local Node entry point.'); return realpathSync(configured); }
  const directories = [...new Set([dirname(process.execPath), ...(process.env.PATH ?? process.env.Path ?? '').split(delimiter).filter(Boolean).map(value => value.replace(/^"|"$/g, ''))])];
  const suffixes = kind === 'npm' ? ['npm/bin/npm-cli.js'] : ['pnpm/bin/pnpm.cjs', 'corepack/dist/pnpm.js'];
  const candidates = suffixes.flatMap(suffix => directories.flatMap(directory => [join(directory, 'node_modules', suffix), resolve(directory, '..', 'lib', 'node_modules', suffix)]));
  for (const directory of directories) { try { const path = realpathSync(join(directory, kind)); if (valid(path)) candidates.push(path); } catch { /* Other PATH entries may contain a local CLI. */ } }
  const found = candidates.find(valid); assert(found, `Set MAYURA_${kind.toUpperCase()}_CLI to an existing local JavaScript entry point.`); return realpathSync(found);
}
async function run(args, cwd, { timeout = 30_000, env = {}, diagnostics = true } = {}) {
  try { return await exec(process.execPath, args, { cwd, env: { ...environment(), ...env }, timeout, maxBuffer: 8 * 1_048_576, windowsHide: true }); }
  catch (error) {
    // Database fixture diagnostics are deliberately never copied into a report or error message.
    const safeStage = String(error.stderr ?? '').match(/^Packed storage consumer failed at [a-z-]+; database and driver diagnostics withheld\.$/m)?.[0];
    throw new Error(`Storage consumer command failed.${diagnostics ? `\n${String(error.stdout ?? '')}\n${String(error.stderr ?? '')}` : ` ${safeStage ?? 'Protected fixture diagnostics were withheld.'}`}`);
  }
}
/** Inspect tar members without extracting paths, links or running lifecycle hooks. */
function archive(bytes) {
  const tar = gunzipSync(bytes, { maxOutputLength: 128 * 1_048_576 }); const files = new Map(); let offset = 0;
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512); if (header.every(byte => byte === 0)) break;
    const field = (start, length) => header.subarray(start, start + length).toString('utf8').replace(/\0.*$/s, '');
    const name = [field(345, 155), field(0, 100)].filter(Boolean).join('/'); const size = Number.parseInt(field(124, 12).trim(), 8);
    assert(Number.isSafeInteger(size) && size >= 0 && offset + 512 + size <= tar.length, 'Invalid archive length.');
    assert(['', '0', '5'].includes(field(156, 1)) && name.startsWith('package/') && !name.includes('\\') && !name.split('/').includes('..'), 'Unreviewed archive member.');
    if (field(156, 1) !== '5') { const path = name.slice(8); assert(!files.has(path)); files.set(path, tar.subarray(offset + 512, offset + 512 + size)); }
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  return files;
}
function inspectMayura(name, files) {
  const manifest = JSON.parse(files.get('package.json').toString('utf8'));
  assert.equal(manifest.name, `@mayura/${name}`); assert.deepEqual(Object.keys(manifest.dependencies ?? {}).sort(), [...mayura[name]].sort());
  assert(!manifest.optionalDependencies && !manifest.peerDependencies && !manifest.scripts && !manifest.bin, 'Mayura package gained an unreviewed installation behavior.');
  for (const [dependency, version] of Object.entries(manifest.dependencies ?? {})) {
    assert(!version.startsWith('workspace:'), 'Unresolved workspace protocol in archive.');
    assert.equal(version, dependency.startsWith('@mayura/') ? manifest.version : external[dependency]?.[0], 'Archive dependency must retain the exact qualified version.');
  }
  assert.deepEqual(Object.keys(manifest.exports ?? {}).sort(), name === 'core' ? ['.', './host'] : name === 'storage-sql' ? ['./host'] : ['.'], 'Public export set changed.');
  let maps = 0;
  for (const [path, bytes] of files) {
    assert(/^(?:package\.json|README(?:\.md)?|LICENSE(?:\.[^/]+)?|dist\/[A-Za-z0-9_./-]+\.(?:js|js\.map|d\.ts|d\.ts\.map)|src\/[A-Za-z0-9_./-]+\.ts)$/.test(path), `Unreviewed Mayura archive file: ${path}`);
    assert(!/\.(?:test|spec)\.ts$/.test(path) && !bytes.includes(Buffer.from('-----BEGIN PRIVATE KEY-----')), 'Private development content in archive.');
    if (name === 'storage') assert(/^(?:package\.json|README(?:\.md)?|LICENSE(?:\.[^/]+)?|src\/index\.ts|dist\/index\.(?:js|js\.map|d\.ts|d\.ts\.map))$/.test(path), 'Compatibility facade must ship only its index barrel, maps and documentation.');
    if (!path.startsWith('dist/') || !/\.(?:js|d\.ts)$/.test(path)) continue;
    const refs = [...bytes.toString('utf8').matchAll(/^\/\/# sourceMappingURL=([^\r\n]+)$/gm)]; assert.equal(refs.length, 1);
    const reference = refs[0][1]; assert(!reference.includes(':') && !reference.includes('\\') && !posix.isAbsolute(reference));
    const mapPath = posix.normalize(posix.join(posix.dirname(path), reference)); assert.equal(mapPath, `${path}.map`);
    const map = JSON.parse(files.get(mapPath).toString('utf8')); assert.equal(map.version, 3); assert.equal(map.sourceRoot ?? '', ''); assert.equal(map.file, posix.basename(path));
    assert(Array.isArray(map.sources) && map.sources.length);
    for (const [index, source] of map.sources.entries()) {
      assert(typeof source === 'string' && !source.includes(':') && !source.includes('\\') && !posix.isAbsolute(source));
      const target = posix.normalize(posix.join(posix.dirname(mapPath), source));
      assert(/^src\/[A-Za-z0-9_./-]+\.ts$/.test(target) && files.has(target), 'Map target is not a shipped local source.');
      if (path.endsWith('.js')) assert.equal(map.sourcesContent?.[index], files.get(target).toString('utf8'), 'Stale emitted JavaScript must be rebuilt.');
    }
    maps++;
  }
  assert(maps); return { manifest, maps };
}
function installedDirectory(name, parent) {
  const require = createRequire(join(parent, 'package.json'));
  const candidates = require.resolve.paths(name).map(path => join(path, name, 'package.json'));
  const found = candidates.find(existsSync); assert(found, `Qualified dependency is not installed: ${name}`);
  const directory = dirname(realpathSync(found)); assert(inside(workspace, directory), 'Dependency resolution escaped the workspace.'); return directory;
}

async function main() {
  const npm = cli('npm'); const pnpm = cli('pnpm'); const tsc = join(workspace, 'node_modules', 'typescript', 'bin', 'tsc');
  const artifactRoot = join(workspace, '.artifacts'); await mkdir(artifactRoot, { recursive: true });
  assert(inside(workspace, await realpath(artifactRoot)));
  const output = await mkdtemp(join(artifactRoot, 'storage-consumer-')); const tarballs = join(output, 'tarballs'); await mkdir(tarballs);
  const packages = new Map(); const reports = [];
  for (const name of Object.keys(mayura)) {
    const directory = join(workspace, 'packages', name); const entry = name === 'storage-sql' ? 'host' : 'index';
    assert(existsSync(join(directory, 'dist', `${entry}.js`)), `Build @mayura/${name} before packing.`);
    const destination = join(tarballs, `${name}.tgz`); await run([pnpm, 'pack', '--out', destination], directory);
    const bytes = await readFile(destination); const files = archive(bytes); const { manifest, maps } = inspectMayura(name, files);
    packages.set(manifest.name, { manifest, archive: pathToFileURL(destination).href });
    reports.push({ name: manifest.name, version: manifest.version, tarballBytes: bytes.length, files: files.size, maps });
  }
  const packDependency = async (name, parent) => {
    const directory = installedDirectory(name, parent); const original = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8'));
    assert(external[name], `Unreviewed dependency: ${name}`); assert.equal(original.name, name); assert.equal(original.version, external[name][0]);
    if (packages.has(name)) { assert.equal(packages.get(name).manifest.version, original.version); return; }
    assert.deepEqual(Object.keys(original.dependencies ?? {}).sort(), [...external[name][1]].sort());
    assert.deepEqual(original.optionalDependencies ?? {}, name === 'pg' ? { 'pg-cloudflare': '^1.4.0' } : {});
    assert.deepEqual(original.peerDependencies ?? {}, name === 'pg' ? { 'pg-native': '>=3.0.1' } : name === 'pg-pool' ? { pg: '>=8.0' } : {});
    assert.deepEqual(original.peerDependenciesMeta ?? {}, name === 'pg' ? { 'pg-native': { optional: true } } : {});
    for (const key of ['preinstall', 'install', 'postinstall', 'prepare', 'prepack', 'postpack']) assert(!original.scripts?.[key], 'Unreviewed lifecycle script.');
    const destination = join(tarballs, `${name}.tgz`); await run([pnpm, 'pack', '--out', destination], directory);
    const bytes = await readFile(destination); const files = archive(bytes); const manifest = JSON.parse(files.get('package.json').toString('utf8'));
    assert.deepEqual(manifest, original, 'Third-party manifests must not be rewritten for the test.');
    const licenses = [...files.keys()].filter(path => /(?:^|\/)(?:licen[cs]e|notice|copying)(?:[.-][^/]*)?$/i.test(path));
    // These exact installed releases embed complete MIT notices in README, without LICENSE.
    if (name === 'pg-types' || name === 'pgpass') {
      const notice = files.get('README.md')?.toString('utf8');
      assert(notice && /## license/i.test(notice) && notice.includes(name === 'pg-types' ? 'Copyright (c) 2014 Brian M. Carlson' : 'Copyright (c) 2013-2016 Hannes Hörl')
        && notice.includes('Permission is hereby granted, free of charge') && notice.includes('THE SOFTWARE IS PROVIDED "AS IS"'));
      licenses.push('README.md');
    }
    assert(licenses.length > 0, `Third-party archive omitted its license: ${name}`);
    for (const path of licenses) assert.deepEqual(files.get(path), await readFile(join(directory, path)), 'Third-party license changed during packing.');
    const natives = [...files.keys()].filter(path => path.endsWith('.node'));
    if (name === 'better-sqlite3') {
      assert.equal(natives.length, 8); assert.equal(manifest.gypfile, false);
      for (const path of natives) {
        assert(/^prebuilds\/(?:linux|linuxmusl|darwin|win32)-(?:x64|arm64)\.node$/.test(path));
        assert.deepEqual(files.get(path), await readFile(join(directory, path)), 'Native prebuild changed during packing.');
      }
    } else assert.equal(natives.length, 0, 'Native code escaped the SQLite driver boundary.');
    packages.set(name, { manifest, archive: pathToFileURL(destination).href });
    reports.push({ name, version: manifest.version, license: manifest.license, tarballBytes: bytes.length, files: files.size, licenses, nativePrebuildCount: natives.length });
    for (const dependency of [...Object.keys(manifest.dependencies ?? {}), ...Object.keys(manifest.optionalDependencies ?? {})]) await packDependency(dependency, directory);
  };
  await packDependency('better-sqlite3', join(workspace, 'packages', 'storage-sqlite'));
  await packDependency('pg', join(workspace, 'packages', 'storage-postgres'));
  const closure = roots => {
    const selected = new Set(); const visit = name => {
      if (selected.has(name)) return; selected.add(name); const pkg = packages.get(name); assert(pkg, `Unqualified closure member: ${name}`);
      for (const dependency of [...Object.keys(pkg.manifest.dependencies ?? {}), ...Object.keys(pkg.manifest.optionalDependencies ?? {})]) visit(dependency);
      for (const dependency of Object.keys(pkg.manifest.peerDependencies ?? {})) if (!pkg.manifest.peerDependenciesMeta?.[dependency]?.optional) visit(dependency);
    }; roots.forEach(visit); return selected;
  };
  const base = ['@mayura/core', '@mayura/storage-contracts', '@mayura/storage-sql'];
  const profiles = [];
  for (const [profile, roots, expected] of [
    ['sqlite', ['@mayura/storage-sqlite'], [...base, '@mayura/storage-sqlite', 'better-sqlite3', 'node-addon-api']],
    ['postgres', ['@mayura/storage-postgres'], [...base, '@mayura/storage-postgres', ...postgresPackages]],
    ['compat', ['@mayura/storage'], [...base, '@mayura/storage', '@mayura/storage-sqlite', '@mayura/storage-postgres', ...Object.keys(external)]],
  ]) {
    const allowed = closure(roots); assert.deepEqual([...allowed].sort(), [...expected].sort());
    const application = join(output, profile); await mkdir(application); const config = join(application, 'empty.npmrc'); await writeFile(config, '');
    const pgpass = join(application, 'empty.pgpass'); await writeFile(pgpass, '', { mode: 0o600 });
    await writeFile(join(application, 'package.json'), JSON.stringify({ name: `mayura-storage-${profile}-consumer`, version: '1.0.0', private: true, type: 'module',
      dependencies: Object.fromEntries(roots.map(name => [name, packages.get(name).archive])), overrides: Object.fromEntries([...allowed].map(name => [name, packages.get(name).archive])) }, null, 2));
    const cache = join(output, `${profile}-npm-cache`); const installStart = performance.now();
    await run([npm, 'install', '--offline', '--ignore-scripts', '--include=optional', '--no-audit', '--no-fund', '--userconfig', config, '--cache', cache], application);
    const installMs = performance.now() - installStart;
    const tree = JSON.parse((await run([npm, 'ls', '--all', '--json', '--offline', '--userconfig', config, '--cache', cache], application)).stdout);
    const installed = new Set(); const collect = value => {
      for (const [name, child] of Object.entries(value.dependencies ?? {})) {
        // npm reports absent optional peers as empty objects. They must not be installed.
        if (name === 'pg-native' && Object.keys(child).length === 0) continue;
        assert(allowed.has(name), `Unexpected installed dependency: ${name}`); assert.equal(child.version, packages.get(name).manifest.version);
        installed.add(name); collect(child);
      }
    }; collect(tree); assert.deepEqual([...installed].sort(), [...allowed].sort());
    const root = await realpath(application);
    for (const name of installed) assert(inside(root, await realpath(join(application, 'node_modules', name))), 'Consumer contains an ancestor/workspace symlink.');
    for (const name of ['@types/node', '@types/pg', '@types/better-sqlite3', 'pg-native']) assert(!existsSync(join(application, 'node_modules', name)));
    for (const name of ['consumer.mjs', 'isolation.mjs']) await writeFile(join(application, name), await readFile(join(workspace, 'consumer-tests', 'storage', name)));
    await writeFile(join(application, 'consumer.ts'), await readFile(join(workspace, 'consumer-tests', 'storage', `${profile}.test.ts`)));
    await writeFile(join(application, 'tsconfig.json'), JSON.stringify({ compilerOptions: {
      target: 'ES2023', module: 'NodeNext', moduleResolution: 'NodeNext', lib: ['ES2023', 'DOM', 'DOM.Iterable'],
      strict: true, noUncheckedIndexedAccess: true, exactOptionalPropertyTypes: true, noUnusedLocals: true, noUnusedParameters: true,
      verbatimModuleSyntax: true, skipLibCheck: false, noEmit: true, types: [], noUncheckedSideEffectImports: true,
    }, include: ['consumer.ts'] }, null, 2));
    const compiled = await run([tsc, '--project', join(application, 'tsconfig.json'), '--pretty', 'false', '--listFiles'], application);
    const checkedTypeScriptFiles = assertConsumerTypeFiles({ output: compiled.stdout, application, compilerPath: tsc });
    // Explicitly supplied disposable database only; no ambient PG* settings/application credentials.
    const suppliedPostgres = profile !== 'sqlite' ? process.env.MAYURA_TEST_POSTGRES_URL : undefined;
    const execution = JSON.parse((await run(['--import', pathToFileURL(join(application, 'isolation.mjs')).href, join(application, 'consumer.mjs')], application,
      { timeout: 45_000, diagnostics: false, env: { MAYURA_STORAGE_PROFILE: profile, PGPASSFILE: pgpass,
        ...(suppliedPostgres ? { MAYURA_TEST_POSTGRES_URL: suppliedPostgres } : {}) } })).stdout);
    assert.equal(execution.status, 'passed');
    let nativeLoads = [];
    if (profile !== 'postgres') {
      nativeLoads = (await readFile(join(application, 'native-loads.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
      assert(nativeLoads.length >= 2, 'Native SQLite close/reopen must load the installed prebuild in actual worker owners.');
      for (const load of nativeLoads) {
        assert.equal(load.isMainThread, false); assert(load.threadId > 0); assert(load.path.startsWith('node_modules/better-sqlite3/prebuilds/'));
        const binary = await realpath(join(application, load.path)); assert(inside(root, binary));
        assert.equal(load.sha256, createHash('sha256').update(await readFile(binary)).digest('hex'));
      }
    } else assert(!existsSync(join(application, 'native-loads.jsonl')), 'PostgreSQL-only profile loaded native code.');
    assert.equal(execution.postgres.status, suppliedPostgres ? 'passed' : profile === 'sqlite' ? 'not-selected' : 'skipped');
    profiles.push({ name: profile, installedPackageCount: installed.size, installedPackages: [...installed].sort(), installMs, checkedTypeScriptFiles, execution, nativeLoads });
  }
  const result = { status: 'passed', node: process.version, platform: process.platform, architecture: process.arch, output, packages: reports, profiles,
    checks: ['actual-offline-tarballs', 'empty-caches', 'lifecycle-scripts-disabled', 'exact-selected-closures', 'pg-cloudflare-accounted', 'no-pg-native',
      'unchanged-third-party-manifests-licenses-prebuilds', 'self-contained-source-maps', 'no-reducer-copy-in-compatibility', 'strict-negative-public-types-without-driver-typings',
      'private-exports-denied', 'no-ancestor-module-or-type-fallback', 'empty-fixture-pgpass', 'sqlite-worker-native-load', 'aggregate-cas-events', 'scheduler-receipt-completion',
      'scheduled-workflow-completion-wait', 'selected-and-compatibility-reopen', 'explicit-postgres-pass-or-skip'] };
  await writeFile(join(output, 'report.json'), `${JSON.stringify(result, null, 2)}\n`); console.log(JSON.stringify(result));
}

await main();
