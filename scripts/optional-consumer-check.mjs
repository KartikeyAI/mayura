import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { closeSync, existsSync, openSync, readSync, realpathSync, statSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises';
import { builtinModules } from 'node:module';
import { delimiter, dirname, isAbsolute, join, posix, relative, resolve, sep } from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { runInNewContext } from 'node:vm';
import { gunzipSync } from 'node:zlib';
import { assertConsumerTypeFiles } from './consumer-type-isolation.mjs';

const exec = promisify(execFile);
const workspace = await realpath(resolve(dirname(fileURLToPath(import.meta.url)), '..'));
const names = ['core', 'cli', 'helpers', 'tools', 'runtime', 'testing', 'sdk', 'server', 'server-node', 'client', 'observability', 'exporter-otlp', 'storage-contracts', 'workflows', 'guardrails', 'workstream', 'code-mode', 'code-mode-workflows', 'adapter-code-quickjs', 'adapter-code-docker', 'artifacts', 'provider-openai', 'provider-anthropic', 'memory', 'memory-remote'];
const expectedDependencies = {
  core: [], cli: ['@mayura/core'], helpers: ['@mayura/core'], tools: ['@mayura/core'], runtime: ['@mayura/core', '@mayura/tools'], testing: ['@mayura/core'],
  sdk: ['@mayura/core', '@mayura/runtime', '@mayura/tools'], server: ['@mayura/core', '@mayura/runtime'],
  'server-node': ['@hono/node-server', '@mayura/server', 'hono'], client: [], observability: ['@mayura/core'],
  'exporter-otlp': ['@mayura/core', '@mayura/observability'],
  'storage-contracts': ['@mayura/core'], workflows: ['@mayura/core', '@mayura/runtime', '@mayura/storage-contracts', '@mayura/tools'],
  guardrails: ['@mayura/core'],
  workstream: ['@mayura/core', '@mayura/storage-contracts'],
  'code-mode': ['@mayura/core', '@mayura/tools'],
  'code-mode-workflows': ['@mayura/code-mode', '@mayura/core', '@mayura/storage-contracts', '@mayura/tools', '@mayura/workflows'],
  'adapter-code-quickjs': ['@jitl/quickjs-wasmfile-release-sync', '@mayura/code-mode', 'quickjs-emscripten-core'],
  'adapter-code-docker': ['@mayura/adapter-code-quickjs', '@mayura/code-mode'],
  artifacts: ['@mayura/core'],
  'provider-openai': ['@mayura/core'],
  'provider-anthropic': ['@mayura/core'],
  memory: ['@mayura/core', '@mayura/storage-contracts'],
  'memory-remote': ['@mayura/core', '@mayura/memory'],
};

function inside(parent, child) { const path = relative(parent, child); return path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path); }
function environment() {
  const allowed = new Set(['PATH', 'PATHEXT', 'SYSTEMROOT', 'WINDIR', 'TEMP', 'TMP', 'TMPDIR', 'HOME', 'USERPROFILE', 'LOCALAPPDATA', 'APPDATA', 'PROGRAMFILES', 'COREPACK_HOME']);
  return { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => allowed.has(key.toUpperCase()))),
    COREPACK_ENABLE_NETWORK: '0', COREPACK_ENABLE_DOWNLOAD_PROMPT: '0', npm_config_ignore_scripts: 'true',
    npm_config_update_notifier: 'false', npm_config_audit: 'false', npm_config_fund: 'false',
  };
}
function cli(kind) {
  const configured = process.env[`MAYURA_${kind.toUpperCase()}_CLI`];
  const nodeShebang = path => {
    const buffer = Buffer.alloc(256); let descriptor;
    try { descriptor = openSync(path, 'r'); return /^#![^\r\n]*\bnode\b/.test(buffer.subarray(0, readSync(descriptor, buffer, 0, buffer.length, 0)).toString('utf8')); }
    catch { return false; }
    finally { if (descriptor !== undefined) closeSync(descriptor); }
  };
  const valid = path => {
    try { return isAbsolute(path) && existsSync(path) && statSync(path).isFile()
      && (/\.(?:js|cjs|mjs)$/i.test(path) || nodeShebang(path)); }
    catch { return false; }
  };
  if (configured) { assert(valid(configured), `MAYURA_${kind.toUpperCase()}_CLI must name an existing absolute JavaScript CLI.`); return realpathSync(configured); }
  const directories = [...new Set([dirname(process.execPath), ...(process.env.PATH ?? process.env.Path ?? '').split(delimiter).filter(Boolean).map(value => value.replace(/^"|"$/g, ''))])];
  const suffixes = kind === 'npm' ? ['npm/bin/npm-cli.js'] : ['pnpm/bin/pnpm.cjs', 'corepack/dist/pnpm.js'];
  const candidates = suffixes.flatMap(suffix => directories.flatMap(directory => [join(directory, 'node_modules', suffix), resolve(directory, '..', 'lib', 'node_modules', suffix)]));
  const invocation = process.env.npm_execpath;
  if (invocation && new RegExp(`(?:^|[\\/])${kind}(?:-cli)?\\.(?:js|cjs)$`, 'i').test(invocation)) candidates.unshift(invocation);
  for (const directory of directories) {
    try { const executable = realpathSync(join(directory, kind)); if (valid(executable)) candidates.push(executable); } catch { /* Inspect another installed CLI candidate. */ }
  }
  const found = candidates.find(valid); assert(found, `Set MAYURA_${kind.toUpperCase()}_CLI to a local JavaScript entry point.`); return realpathSync(found);
}
async function run(args, cwd, timeout = 30_000) {
  try { return await exec(process.execPath, args, { cwd, env: environment(), timeout, maxBuffer: 8 * 1024 * 1024, windowsHide: true }); }
  catch (error) { throw new Error(`Optional consumer command failed: ${args.slice(1, 3).join(' ')}\n${String(error.stdout ?? '')}\n${String(error.stderr ?? '')}`); }
}

/** Read bounded archive members without extracting links, paths or executing lifecycle hooks. */
function archive(bytes) {
  const tar = gunzipSync(bytes, { maxOutputLength: 64 * 1024 * 1024 }); const files = new Map(); const links = []; const names = new Set(); let cursor = 0;
  while (cursor + 512 <= tar.length) {
    const header = tar.subarray(cursor, cursor + 512); if (header.every(byte => byte === 0)) break;
    const field = (start, length) => header.subarray(start, start + length).toString('utf8').replace(/\0.*$/s, '');
    const name = [field(345, 155), field(0, 100)].filter(Boolean).join('/'); const size = Number.parseInt(field(124, 12).trim(), 8); const type = field(156, 1);
    assert(Number.isSafeInteger(size) && size >= 0 && cursor + 512 + size <= tar.length, 'Invalid archive size.');
    assert(['', '0', '1', '5'].includes(type) && name.startsWith('package/') && !name.includes('\\') && !name.split('/').includes('..'), 'Unreviewed archive member.');
    if (type === '1') {
      const link = field(157, 100); assert(size === 0 && link.startsWith('package/') && !link.includes('\\') && !link.split('/').includes('..'), 'Unsafe archive hard link.');
      const path = name.slice(8); assert(!names.has(path), 'Duplicate archive member.'); names.add(path); links.push([path, link.slice(8)]);
    } else if (type !== '5') { const path = name.slice(8); assert(!names.has(path), 'Duplicate archive member.'); names.add(path); files.set(path, tar.subarray(cursor + 512, cursor + 512 + size)); }
    cursor += 512 + Math.ceil(size / 512) * 512;
  }
  while (links.length > 0) {
    let resolved = 0;
    for (let index = links.length - 1; index >= 0; index--) {
      const [path, target] = links[index]; const content = files.get(target);
      if (content === undefined) continue;
      files.set(path, content); links.splice(index, 1); resolved += 1;
    }
    assert(resolved > 0, 'Archive hard link target is unavailable or cyclic.');
  }
  return files;
}
function inspectMayura(shortName, files) {
  const manifest = JSON.parse(files.get('package.json').toString('utf8'));
  assert.equal(manifest.name, `@mayura/${shortName}`);
  assert.deepEqual(Object.keys(manifest.dependencies ?? {}).sort(), expectedDependencies[shortName], 'Optional package dependency closure changed; review it explicitly.');
  assert(!manifest.optionalDependencies && !manifest.peerDependencies && !manifest.scripts, 'Mayura distribution needs explicit optional/lifecycle review.');
  if (shortName === 'cli') assert.deepEqual(manifest.bin, { mayura: './dist/bin.js' }); else assert(!manifest.bin, 'Unreviewed package executable.');
  for (const version of Object.values(manifest.dependencies ?? {})) assert(!String(version).startsWith('workspace:'), 'Workspace protocol leaked into archive.');
  let maps = 0;
  for (const [path, bytes] of files) {
    assert(/^(?:package\.json|README(?:\.md)?|LICENSE(?:\.[^/]+)?|image\/Dockerfile|templates\/[A-Za-z0-9_-]+\.ts|dist\/[A-Za-z0-9_./-]+\.(?:js|js\.map|d\.ts|d\.ts\.map)|src\/[A-Za-z0-9_./-]+\.ts)$/.test(path), `Unreviewed Mayura file: ${path}`);
    assert(!/\.(?:test|spec)\.ts$/.test(path) && !bytes.includes(Buffer.from('-----BEGIN PRIVATE KEY-----')), 'Private/development content in archive.');
    if (!path.startsWith('dist/') || !/\.(?:js|d\.ts)$/.test(path)) continue;
    const directives = [...bytes.toString('utf8').matchAll(/^\/\/# sourceMappingURL=([^\r\n]+)$/gm)];
    assert.equal(directives.length, 1); const reference = directives[0][1];
    assert(!reference.includes(':') && !reference.includes('\\') && !posix.isAbsolute(reference));
    const mapPath = posix.normalize(posix.join(posix.dirname(path), reference)); assert.equal(mapPath, `${path}.map`);
    const map = JSON.parse(files.get(mapPath).toString('utf8')); assert.equal(map.version, 3); assert.equal(map.sourceRoot ?? '', ''); assert.equal(map.file, posix.basename(path));
    assert(Array.isArray(map.sources) && map.sources.length > 0);
    for (const [index, source] of map.sources.entries()) {
      assert(typeof source === 'string' && !source.includes(':') && !source.includes('\\') && !posix.isAbsolute(source));
      const target = posix.normalize(posix.join(posix.dirname(mapPath), source));
      assert(/^src\/[A-Za-z0-9_./-]+\.ts$/.test(target) && !target.split('/').includes('..') && files.has(target), 'Map target escaped shipped sources.');
      if (path.endsWith('.js')) assert.equal(map.sourcesContent?.[index], files.get(target).toString('utf8'), 'Rebuild stale JavaScript before packing.');
    }
    maps++;
  }
  assert(maps > 0); return { manifest, maps };
}

async function main() {
  const npm = cli('npm'); const pnpm = cli('pnpm'); const tsc = join(workspace, 'node_modules', 'typescript', 'bin', 'tsc');
  assert(existsSync(tsc), 'Install/build the workspace first.');
  const artifactRoot = join(workspace, '.artifacts'); await mkdir(artifactRoot, { recursive: true });
  const canonicalRoot = await realpath(artifactRoot); assert(inside(workspace, canonicalRoot), 'Artifacts must remain in the canonical workspace.');
  const output = await mkdtemp(join(canonicalRoot, 'optional-consumer-')); const tarballs = join(output, 'tarballs'); await mkdir(tarballs);
  const packages = new Map(); const reports = [];
  for (const shortName of names) {
    const directory = join(workspace, 'packages', shortName); assert(existsSync(join(directory, 'dist', 'index.js')), 'Build all optional packages first.');
    const destination = join(tarballs, `${shortName}.tgz`); await run([pnpm, 'pack', '--out', destination], directory);
    const bytes = await readFile(destination); const files = archive(bytes); const { manifest, maps } = inspectMayura(shortName, files);
    packages.set(manifest.name, { archive: pathToFileURL(destination).href, manifest });
    reports.push({ name: manifest.name, version: manifest.version, tarballBytes: bytes.length, files: files.size, maps });
  }
  const host = packages.get('@mayura/server-node').manifest;
  for (const name of ['hono', '@hono/node-server']) {
    const directory = await realpath(join(workspace, 'packages', 'server-node', 'node_modules', name));
    const original = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8'));
    assert.equal(host.dependencies[name], original.version, 'Host dependency must be pinned to the packed installed version.');
    const destination = join(tarballs, `${name.replace(/[^A-Za-z0-9]/g, '-')}.tgz`); await run([pnpm, 'pack', '--out', destination], directory);
    const bytes = await readFile(destination); const files = archive(bytes); const manifest = JSON.parse(files.get('package.json').toString('utf8'));
    assert.equal(manifest.name, name); assert.equal(manifest.version, original.version);
    assert.deepEqual(manifest.dependencies ?? {}, {}); assert.deepEqual(manifest.optionalDependencies ?? {}, {});
    assert.deepEqual(manifest.peerDependencies ?? {}, name === '@hono/node-server' ? { hono: '^4' } : {});
    packages.set(name, { archive: pathToFileURL(destination).href, manifest });
    reports.push({ name, version: manifest.version, tarballBytes: bytes.length, files: files.size });
  }
  const quickjsVariant = await realpath(join(workspace, 'packages', 'adapter-code-quickjs', 'node_modules', '@jitl', 'quickjs-wasmfile-release-sync'));
  const quickjsDirectories = new Map([
    ['@jitl/quickjs-ffi-types', await realpath(join(dirname(quickjsVariant), 'quickjs-ffi-types'))],
    ['@jitl/quickjs-wasmfile-release-sync', quickjsVariant],
    ['quickjs-emscripten-core', await realpath(join(workspace, 'packages', 'adapter-code-quickjs', 'node_modules', 'quickjs-emscripten-core'))],
  ]);
  for (const [name, directory] of quickjsDirectories) {
    const original = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8'));
    assert.equal(original.version, '0.32.0'); assert.equal(original.license, 'MIT');
    for (const script of ['preinstall', 'install', 'postinstall']) assert.equal(original.scripts?.[script], undefined, `${name} has an unreviewed installation script.`);
    const packed = JSON.parse((await run([npm, 'pack', '--ignore-scripts', '--pack-destination', tarballs, '--json'], directory)).stdout);
    assert.equal(packed.length, 1); const destination = join(tarballs, packed[0].filename);
    const bytes = await readFile(destination); const files = archive(bytes); const manifest = JSON.parse(files.get('package.json').toString('utf8'));
    assert.equal(manifest.name, name); assert.equal(manifest.version, original.version); assert.equal(manifest.license, 'MIT');
    packages.set(name, { archive: pathToFileURL(destination).href, manifest });
    reports.push({ name, version: manifest.version, tarballBytes: bytes.length, files: files.size });
  }
  const closure = roots => {
    const result = new Set(); const visit = name => {
      if (result.has(name)) return; result.add(name); const pkg = packages.get(name); assert(pkg, `Unqualified dependency: ${name}`);
      for (const dependency of Object.keys(pkg.manifest.dependencies ?? {})) visit(dependency);
      for (const dependency of Object.keys(pkg.manifest.peerDependencies ?? {})) visit(dependency);
    };
    roots.forEach(visit); return result;
  };
  assert.deepEqual([...closure(['@mayura/sdk'])].sort(), ['@mayura/core', '@mayura/runtime', '@mayura/sdk', '@mayura/tools']);
  assert.deepEqual([...closure(['@mayura/sdk', '@mayura/guardrails', '@mayura/observability'])].sort(),
    ['@mayura/core', '@mayura/guardrails', '@mayura/observability', '@mayura/runtime', '@mayura/sdk', '@mayura/tools']);
  const profiles = [];
  for (const [name, roots, fixture] of [
    ['browser', ['@mayura/client'], 'optional-browser.test.ts'],
    ['cli', ['@mayura/cli'], 'optional-cli.test.ts'],
    ['helpers', ['@mayura/helpers'], 'optional-helpers.test.ts'],
    ['node', ['@mayura/server-node', '@mayura/client', '@mayura/observability', '@mayura/sdk', '@mayura/testing', '@mayura/artifacts'], 'optional-node.test.ts'],
    ['workflows', ['@mayura/workflows'], 'optional-workflows.test.ts'],
    ['managed', ['@mayura/sdk', '@mayura/guardrails', '@mayura/observability'], 'managed/consumer.test.ts'],
    ['otlp', ['@mayura/exporter-otlp'], 'optional-otlp.test.ts'],
    ['executions', ['@mayura/workstream'], 'optional-executions.test.ts'],
    ['humans', ['@mayura/workstream'], 'optional-humans.test.ts'],
    ['timers', ['@mayura/workstream'], 'optional-timers.test.ts'],
    ['graphs', ['@mayura/workflows'], 'optional-graphs.test.ts'],
    ['budgets', ['@mayura/storage-contracts'], 'optional-budgets.test.ts'],
    ['code-mode', ['@mayura/code-mode'], 'optional-code-mode.test.ts'],
    ['code-mode-workflows', ['@mayura/code-mode-workflows'], 'optional-code-mode-workflows.test.ts'],
    ['code-mode-quickjs', ['@mayura/adapter-code-quickjs', '@mayura/code-mode', '@mayura/core', '@mayura/tools'], 'optional-code-mode-quickjs.test.ts'],
    ['code-mode-docker', ['@mayura/adapter-code-docker'], 'optional-code-mode-docker.test.ts'],
    ['artifacts', ['@mayura/artifacts'], 'optional-artifacts.test.ts'],
    ['providers', ['@mayura/provider-openai', '@mayura/provider-anthropic'], 'optional-providers.test.ts'],
    ['remote-memory', ['@mayura/memory-remote'], 'optional-remote-memory.test.ts'],
  ]) {
    const application = join(output, name); await mkdir(application); const npmConfig = join(application, 'empty.npmrc'); await writeFile(npmConfig, '');
    const allowed = closure(roots); const dependencies = Object.fromEntries(roots.map(name => [name, packages.get(name).archive]));
    const overrides = Object.fromEntries([...allowed].map(name => [name, packages.get(name).archive]));
    await writeFile(join(application, 'package.json'), JSON.stringify({ name: `mayura-optional-${name}-consumer`, version: '1.0.0', private: true, type: 'module', dependencies, overrides }, null, 2));
    const cache = join(output, `${name}-npm-cache`); const installStart = performance.now();
    await run([npm, 'install', '--offline', '--ignore-scripts', '--no-audit', '--no-fund', '--userconfig', npmConfig, '--cache', cache], application);
    const installMs = performance.now() - installStart;
    const tree = JSON.parse((await run([npm, 'ls', '--all', '--json', '--offline', '--userconfig', npmConfig, '--cache', cache], application)).stdout);
    const installed = new Set(); const collect = tree => { for (const [name, child] of Object.entries(tree.dependencies ?? {})) { assert(allowed.has(name), `Unexpected installed dependency: ${name}`); installed.add(name); collect(child); } }; collect(tree);
    assert.deepEqual([...installed].sort(), [...allowed].sort());
    const root = await realpath(application);
    for (const name of installed) assert(inside(root, await realpath(join(application, 'node_modules', name))), 'Installed package is a workspace symlink.');
    await writeFile(join(application, 'consumer.ts'), await readFile(join(workspace, 'consumer-tests', fixture)));
    await writeFile(join(application, 'tsconfig.json'), JSON.stringify({ compilerOptions: {
      target: 'ES2023', module: 'NodeNext', moduleResolution: 'NodeNext', lib: ['ES2023', 'DOM', 'DOM.Iterable'],
      strict: true, noUncheckedIndexedAccess: true, exactOptionalPropertyTypes: true, noUnusedLocals: true,
      noUnusedParameters: true, verbatimModuleSyntax: true, skipLibCheck: false, noEmit: true, types: [],
    }, include: ['consumer.ts'] }, null, 2));
    const types = await run([tsc, '--project', join(application, 'tsconfig.json'), '--pretty', 'false', '--listFiles'], application);
    const typeFileCount = assertConsumerTypeFiles({ output: types.stdout, application, compilerPath: tsc });
    if (name !== 'browser') {
      await writeFile(join(application, 'consumer.mjs'), await readFile(join(workspace, 'consumer-tests', fixture.replace(/\.ts$/, '.mjs'))));
      await writeFile(join(application, 'isolation.mjs'), await readFile(join(workspace, 'consumer-tests', 'optional-isolation.test.mjs')));
      const execution = JSON.parse((await run(['--import', pathToFileURL(join(application, 'isolation.mjs')).href, join(application, 'consumer.mjs')], application)).stdout);
      if (name === 'node') { assert.equal(execution.batchOutputReferences, true); assert.equal(execution.externalConsumerMatrix, true); assert.equal(execution.http.humanTransport, true); }
      if (name === 'helpers') {
        assert.equal(execution.secretReferenceOnly, true); assert.equal(execution.retrySafety, true);
        assert.equal(execution.budgetAccounting, true); assert.equal(execution.redactedLogging, true); assert.equal(execution.credentialStore, true);
      }
      if (name === 'cli') {
        assert.equal(execution.eightTemplates, true); assert.equal(execution.planFirst, true);
        assert.equal(execution.catalogValidated, true); assert.equal(execution.noOverwrite, true); assert.equal(execution.authenticatedOperations, true); assert.equal(execution.authenticatedHuman, true);
      }
      if (name === 'graphs') {
        assert.equal(execution.finiteCoordinator, true);
        assert.equal(execution.unknownDefinitionSkipped, true);
        assert.equal(execution.interruptedRetryCursor, true);
      }
      if (name === 'workflows') { assert.equal(execution.verifierRouter, true); assert.equal(execution.lifecycleManifest, true); assert.equal(execution.lifecycleRuntime, true); assert.equal(execution.lifecycleFleet, true); assert.equal(execution.lifecycleHumanTransport, true); assert.equal(execution.sagaManifest, true); assert.equal(execution.sagaRuntime, true); assert.equal(execution.loopManifest, true); assert.equal(execution.loopRuntime, true); }
      if (name === 'managed') { assert.equal(execution.wholeOutputBarrier, true); assert.equal(execution.structuredDisclosure, true); }
      if (name === 'otlp') {
        assert.equal(execution.explicitDestination, true); assert.equal(execution.noConstructionNetwork, true);
        assert.equal(execution.metadataOnly, true); assert.equal(execution.partialAccounting, true);
        assert.equal(execution.traces, true); assert.equal(execution.metrics, true);
      }
      if (name === 'budgets') {
        assert.equal(execution.driverFree, true); assert.equal(execution.forgedAccountingRejected, true);
        assert.equal(execution.executesEffects, false);
      }
      if (name === 'humans') {
        assert.equal(execution.driverFree, true); assert.equal(execution.restartSafe, true);
        assert.equal(execution.typedResponse, true); assert.equal(execution.authorizationCalls, 1);
      }
      if (name === 'timers') {
        assert.equal(execution.driverFree, true); assert.equal(execution.restartSafe, true);
        assert.equal(execution.firesOnce, true);
      }
      if (name === 'code-mode') {
        assert.equal(execution.noHostFallback, true); assert.equal(execution.mediatedToolCall, true);
        assert.equal(execution.usageReported, true);
        assert.equal(execution.sandboxDependencyCount, 0);
      }
      if (name === 'code-mode-workflows') {
        assert.equal(execution.mandatoryApproval, true); assert.equal(execution.programDigestPinned, true);
        assert.equal(execution.durableAuditRequired, true); assert.equal(execution.auditScopePinned, true);
        assert.equal(execution.driverFreeDefinition, true);
      }
      if (name === 'code-mode-quickjs') {
        assert.equal(execution.childProcess, true); assert.equal(execution.nodeGlobalsAbsent, true);
        assert.equal(execution.mediatedToolCall, true); assert.equal(execution.usageReported, true); assert.equal(execution.cpuInterrupted, true);
      }
      if (name === 'code-mode-docker') {
        assert.equal(execution.immutableImageRequired, true); assert.equal(execution.provenanceRequired, true);
        assert.equal(execution.signedPromotionRequired, true); assert.equal(execution.sarifIssuanceRequired, true);
        assert.equal(execution.noDockerDependency, true);
      }
      if (name === 'artifacts') {
        assert.equal(execution.scoped, true); assert.equal(execution.integrityVerified, true);
        assert.equal(execution.safeAttachment, true); assert.equal(execution.artifactAudit, true);
        assert.equal(execution.retentionPlan, true); assert.equal(execution.stagedDiscard, true);
        assert.equal(execution.backupRestore, true);
        assert.equal(execution.noArthDependency, true);
      }
      if (name === 'providers') {
        assert.equal(execution.fixedHostedDestination, true); assert.equal(execution.loopbackLocalDestination, true);
        assert.equal(execution.explicitCredentials, true); assert.equal(execution.structuredOutput, true);
      }
      if (name === 'remote-memory') {
        assert.equal(execution.canonicalRehydration, true); assert.equal(execution.noResurrection, true);
        assert.equal(execution.opaqueNamespace, true); assert.equal(execution.threeAdapters, true);
      }
      assert.equal(execution.status, 'passed'); profiles.push({ name, installedPackageCount: installed.size, installMs, typeFileCount, execution });
    } else {
      const { build } = await import('vite'); const included = new Set();
      const builtins = new Set(builtinModules.flatMap(name => [name, `node:${name}`]));
      const built = await build({ configFile: false, root: application, logLevel: 'silent', plugins: [{
        name: 'mayura-browser-import-boundary',
        resolveId(source) { assert(!builtins.has(source) && !source.startsWith('node:'), 'Browser package requested a Node builtin.'); },
        moduleParsed(info) { assert(!info.id.startsWith('\0') && inside(root, info.id), `Browser module escaped installed consumer: ${info.id}`); included.add(info.id); },
      }], build: { write: false, minify: false, sourcemap: false, lib: { entry: join(application, 'consumer.ts'), formats: ['iife'], name: 'OptionalBrowserConsumer' } } });
      const chunks = (Array.isArray(built) ? built.flatMap(value => value.output) : built.output).filter(chunk => chunk.type === 'chunk');
      assert.equal(chunks.length, 1); assert.equal(chunks[0].imports.length, 0); assert.equal(chunks[0].dynamicImports.length, 0);
      assert(included.size >= 2 && [...included].some(path => path.replaceAll('\\', '/').includes('/node_modules/@mayura/client/')), 'Bundler did not include the installed client.');
      const code = chunks[0].code; assert(!code.includes('__vite-browser-external'), 'Browser bundle contains a Node compatibility shim.');
      const context = { TextEncoder, TextDecoder, URL, AbortController, setTimeout, clearTimeout };
      runInNewContext(code, context, { timeout: 1_000 });
      const fetcher = async (_url, options) => { assert.equal(options.credentials, 'omit'); assert.equal(options.redirect, 'error'); return new Response('{"agents":[]}', { headers: { 'Content-Type': 'application/json' } }); };
      assert.equal(await context.OptionalBrowserConsumer.verifyBrowserClient(fetcher), 0);
      await writeFile(join(application, 'browser-bundle.js'), code);
      profiles.push({ name, installedPackageCount: installed.size, installMs, typeFileCount, browserBundleBytes: Buffer.byteLength(code), includedModuleCount: included.size, noNodeGlobalsSmoke: true });
    }
  }
  const result = { status: 'passed', node: process.version, platform: process.platform, architecture: process.arch, output, packages: reports, profiles,
    checks: ['offline-tarball-installs', 'no-install-scripts', 'strict-public-types', 'negative-type-fixtures', 'isolated-public-imports', 'no-ancestor-module-fallback', 'browser-only-dependency-graph', 'browser-target-bundle', 'no-node-globals-smoke', 'loopback-http-sse-roundtrip', 'operational-health-and-tool-catalog', 'authenticated-human-request-client', 'authenticated-operational-cli', 'local-observer-terminal-evidence', 'typed-batch-output-references', 'arth-free-parallel-child-policy-artifact-matrix', 'ephemeral-workflow-fork-join', 'workflow-required-child-tool', 'no-workflow-sql-drivers', 'managed-shared-definition-identity', 'managed-single-permit-budget', 'managed-observer-four-model-calls', 'mediated-control-hooks', 'hook-action-evidence', 'explicit-trusted-host-entries', 'no-managed-provider-native-dependencies', 'private-exports-denied', 'unchanged-base-sdk-closure', 'archive-map-integrity'],
  };
  result.checks.push('driver-free-execution-wait-subpath', 'execution-wait-custom-adapter', 'execution-wait-negative-types');
  result.checks.push('driver-free-human-request-subpath', 'restart-safe-human-response', 'human-request-negative-types');
  result.checks.push('driver-free-timer-subpath', 'restart-safe-timer-sweep', 'timer-negative-types');
  result.checks.push('no-ancestor-declaration-fallback');
  result.checks.push('driver-free-workflow-graph-subpath', 'format3-negative-types', 'finite-graph-wait-custom-adapter');
  result.checks.push('driver-free-workflow-lifecycle-subpath', 'format5-negative-types', 'format5-data-only-manifest', 'format5-custom-adapter-runtime', 'format5-durable-fleet-index', 'format5-authenticated-human-transport-binding');
  result.checks.push('driver-free-workflow-saga-subpath', 'format1-saga-negative-types', 'format1-saga-data-only-manifest', 'format1-saga-custom-adapter-runtime');
  result.checks.push('driver-free-workflow-loop-subpath', 'format1-loop-negative-types', 'format1-loop-data-only-manifest', 'format1-loop-custom-adapter-runtime');
  result.checks.push('finite-graph-discovery-custom-adapter', 'discovery-optional-capability-types', 'terminal-owner-cursor-progress');
  result.checks.push('registered-graph-coordinator-custom-adapter', 'coordinator-interrupted-page-retry-cursor', 'coordinator-negative-types');
  result.checks.push('driver-free-durable-budget-contracts', 'budget-immutable-boundary', 'budget-negative-types');
  result.checks.push('provider-neutral-code-mode', 'code-mode-no-host-fallback', 'code-mode-mediated-tool-call', 'code-mode-usage-reporting', 'code-mode-negative-types');
  result.checks.push('durable-code-mode-definition', 'code-phase-mandatory-approval', 'code-phase-program-digest-pinning', 'code-phase-usage-audit-v2');
  result.checks.push('packed-quickjs-child-adapter', 'quickjs-node-globals-absent', 'quickjs-mediated-tool-call', 'quickjs-cpu-interrupt');
  result.checks.push('packed-docker-outer-adapter', 'docker-cli-not-bundled', 'docker-immutable-image-configuration');
  result.checks.push('packed-local-artifact-adapter', 'artifact-scope-separation', 'artifact-safe-attachment',
    'artifact-integrity-audit', 'artifact-retention-dry-run', 'artifact-staged-discard', 'artifact-backup-restore');
  result.checks.push('packed-otlp-http-json-exporter', 'otlp-no-construction-network', 'otlp-metadata-only', 'otlp-partial-accounting', 'otlp-traces', 'otlp-metrics');
  result.checks.push('packed-helper-battery', 'helper-explicit-retry-safety', 'helper-budget-accounting', 'helper-redacted-logging');
  result.checks.push('provider-neutral-credential-store', 'credential-use-scope-zeroing', 'credential-retained-callback-admission');
  result.checks.push('packed-cli', 'cli-plan-first-init', 'cli-eight-starters', 'cli-no-unconfirmed-overwrite');
  result.checks.push('cli-human-list-inspect-respond', 'cli-human-response-file-boundary');
  result.checks.push('packed-model-providers', 'anthropic-fixed-destination', 'openai-compatible-loopback-only', 'provider-explicit-credentials');
  result.checks.push('packed-remote-memory', 'remote-memory-canonical-rehydration', 'remote-memory-no-resurrection', 'remote-memory-opaque-scope');
  await writeFile(join(output, 'report.json'), `${JSON.stringify(result, null, 2)}\n`); console.log(JSON.stringify(result));
}

await main();
