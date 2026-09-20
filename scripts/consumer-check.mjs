import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { closeSync, existsSync, openSync, readSync, realpathSync, statSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises';
import { delimiter, dirname, isAbsolute, join, posix, relative, resolve, sep } from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { gunzipSync } from 'node:zlib';

const exec = promisify(execFile);
const workspace = await realpath(resolve(dirname(fileURLToPath(import.meta.url)), '..'));
const packageNames = ['core', 'tools', 'runtime', 'testing', 'sdk'];

function inside(parent, child) {
  const path = relative(parent, child);
  return path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path);
}

/** Run child tools without forwarding arbitrary application credentials or Node injection flags. */
function childEnvironment() {
  const allowed = new Set(['PATH', 'PATHEXT', 'SYSTEMROOT', 'WINDIR', 'TEMP', 'TMP', 'TMPDIR', 'HOME', 'USERPROFILE', 'LOCALAPPDATA', 'APPDATA', 'PROGRAMFILES', 'COREPACK_HOME']);
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => allowed.has(key.toUpperCase())));
  return {
    ...env,
    COREPACK_ENABLE_NETWORK: '0',
    COREPACK_ENABLE_DOWNLOAD_PROMPT: '0',
    npm_config_ignore_scripts: 'true',
    npm_config_update_notifier: 'false',
    npm_config_audit: 'false',
    npm_config_fund: 'false',
  };
}

/** Locate a local CLI JavaScript entry point; never invoke a shell or download a package manager. */
function cliPath(kind) {
  const configured = process.env[`MAYURA_${kind.toUpperCase()}_CLI`];
  if (configured) {
    assert(isAbsolute(configured) && existsSync(configured) && statSync(configured).isFile() && (/\.(?:js|cjs|mjs)$/i.test(configured) || nodeShebang(configured)), `MAYURA_${kind.toUpperCase()}_CLI must identify an existing absolute CLI JavaScript file.`);
    return realpathSync(configured);
  }
  const binaryDirectory = dirname(process.execPath);
  const suffixes = kind === 'npm'
    ? ['npm/bin/npm-cli.js']
    : ['pnpm/bin/pnpm.cjs', 'corepack/dist/pnpm.js'];
  const pathDirectories = [...new Set((process.env.PATH ?? process.env.Path ?? '').split(delimiter).filter(Boolean).map((value) => value.replace(/^"|"$/g, '')))];
  const invocation = process.env.npm_execpath;
  const invocationMatches = invocation && new RegExp(`(?:^|[\\\\/])${kind}(?:-cli)?\\.(?:js|cjs)$`, 'i').test(invocation);
  const candidates = [
    ...(invocationMatches ? [invocation] : []),
    ...suffixes.flatMap((suffix) => [
      join(binaryDirectory, 'node_modules', suffix),
      resolve(binaryDirectory, '..', 'lib', 'node_modules', suffix),
      ...pathDirectories.map((directory) => join(directory, 'node_modules', suffix)),
    ]),
  ];
  // Unix package managers and Homebrew commonly use symlinks outside Node's own prefix.
  // Resolve only Node shebang entry points; never execute a shell shim or parse .cmd text.
  for (const directory of pathDirectories) {
    try {
      const executable = join(directory, kind);
      if (!existsSync(executable)) continue;
      const target = realpathSync(executable);
      if (statSync(target).isFile() && nodeShebang(target)) candidates.push(target);
    } catch { /* An unreadable unrelated PATH entry does not prevent other local candidates. */ }
  }
  const found = candidates.find((candidate) => {
    try { return isAbsolute(candidate) && existsSync(candidate) && statSync(candidate).isFile(); }
    catch { return false; }
  });
  if (!found) throw new Error(`Cannot locate local ${kind} CLI. Set MAYURA_${kind.toUpperCase()}_CLI to its absolute JavaScript entry path.`);
  return realpathSync(found);
}

function nodeShebang(path) {
  const buffer = Buffer.alloc(256);
  let descriptor;
  try {
    descriptor = openSync(path, 'r');
    const length = readSync(descriptor, buffer, 0, buffer.length, 0);
    return /^#![^\r\n]*\bnode\b/.test(buffer.subarray(0, length).toString('utf8'));
  } catch { return false; }
  finally { if (descriptor !== undefined) closeSync(descriptor); }
}

async function runNode(arguments_, cwd, timeout = 30_000) {
  try {
    return await exec(process.execPath, arguments_, { cwd, env: childEnvironment(), timeout, maxBuffer: 8 * 1024 * 1024, windowsHide: true });
  } catch (error) {
    const output = typeof error === 'object' && error !== null && 'stdout' in error ? String(error.stdout) : '';
    const stderr = typeof error === 'object' && error !== null && 'stderr' in error ? String(error.stderr) : '';
    throw new Error(`Consumer validation command failed: ${arguments_.slice(1, 3).join(' ')}\n${output}\n${stderr}`);
  }
}

/** Inspect actual archive members without extracting paths or executing package lifecycle hooks. */
function inspectTarball(buffer) {
  const tar = gunzipSync(buffer, { maxOutputLength: 16 * 1024 * 1024 });
  const files = [];
  let cursor = 0;
  while (cursor + 512 <= tar.length) {
    const header = tar.subarray(cursor, cursor + 512);
    if (header.every((byte) => byte === 0)) break;
    const field = (start, length) => header.subarray(start, start + length).toString('utf8').replace(/\0.*$/s, '');
    const name = [field(345, 155), field(0, 100)].filter(Boolean).join('/');
    const size = Number.parseInt(field(124, 12).trim(), 8);
    assert(Number.isSafeInteger(size) && size >= 0, 'Archive member has an invalid size.');
    assert(cursor + 512 + size <= tar.length, 'Archive member exceeds archive size.');
    const type = field(156, 1);
    assert(type === '' || type === '0' || type === '5', 'Unexpected archive links or extended path records require review.');
    assert(name.startsWith('package/') && !name.includes('\\') && !name.split('/').includes('..'), 'Archive path is outside its package.');
    if (type !== '5') files.push({ path: name.slice('package/'.length), bytes: size, content: tar.subarray(cursor + 512, cursor + 512 + size) });
    cursor += 512 + Math.ceil(size / 512) * 512;
  }
  return files;
}

/** Require debugger and declaration maps to resolve wholly inside the shipped package. */
function inspectSourceMaps(files) {
  const byPath = new Map(files.map((file) => [file.path, file]));
  const referencedSources = new Set();
  let maps = 0;
  for (const file of files.filter((entry) => entry.path.startsWith('dist/') && (entry.path.endsWith('.js') || entry.path.endsWith('.d.ts')))) {
    const directives = [...file.content.toString('utf8').matchAll(/^\/\/# sourceMappingURL=([^\r\n]+)$/gm)];
    assert.equal(directives.length, 1, `Expected one source map directive in ${file.path}`);
    const mapReference = directives[0][1];
    assert(!mapReference.includes('\\') && !mapReference.includes(':') && !posix.isAbsolute(mapReference), 'Source map URL must be relative and local.');
    const mapPath = posix.normalize(posix.join(posix.dirname(file.path), mapReference));
    assert.equal(mapPath, `${file.path}.map`, 'Source map must be adjacent to its compiled file.');
    const mapped = byPath.get(mapPath);
    assert(mapped, `Missing packaged source map: ${mapPath}`);
    const map = JSON.parse(mapped.content.toString('utf8'));
    assert.equal(map.version, 3, 'Only standard version-three source maps are accepted.');
    assert.equal(map.file, posix.basename(file.path), 'Source map names a different compiled file.');
    assert.equal(map.sourceRoot ?? '', '', 'Source map roots must not depend on a build machine.');
    assert(Array.isArray(map.sources) && map.sources.length > 0, 'Source map must identify source files.');
    for (let index = 0; index < map.sources.length; index++) {
      const source = map.sources[index];
      assert(typeof source === 'string' && !source.includes('\\') && !source.includes(':') && !posix.isAbsolute(source), 'Source reference must remain local to its package.');
      const sourcePath = posix.normalize(posix.join(posix.dirname(mapPath), source));
      assert(/^src\/[A-Za-z0-9_./-]+\.ts$/.test(sourcePath) && !sourcePath.endsWith('.d.ts') && !sourcePath.split('/').includes('..'), `Unexpected source map target: ${sourcePath}`);
      const packagedSource = byPath.get(sourcePath);
      assert(packagedSource, `Source/declaration map target is missing from the package: ${sourcePath}`);
      referencedSources.add(sourcePath);
      if (file.path.endsWith('.js')) {
        assert(typeof map.sourcesContent?.[index] === 'string' && map.sourcesContent[index] === packagedSource.content.toString('utf8'), `Embedded debugger source differs from shipped TypeScript: ${sourcePath}. Rebuild before packaging.`);
      }
    }
    maps++;
  }
  for (const source of files.filter((file) => file.path.startsWith('src/'))) {
    assert(referencedSources.has(source.path), `Source not referenced by any compiled declaration/debugger map: ${source.path}`);
  }
  assert(maps > 0 && referencedSources.size > 0, 'No packaged debugger/declaration navigation evidence was found.');
  return { maps, sources: referencedSources.size };
}

const consumerTypes = `import { Budget, type Outcome, defineTool, invokeTool, type ToolOutput, createRuntime, defineAgent } from '@mayura/sdk';
import { scriptedModel } from '@mayura/testing';
import { z } from 'zod';

const tool = defineTool({
  id: 'math.add', version: '1.0.0', description: 'Add finite numbers.',
  input: z.object({ left: z.number(), right: z.number() }),
  output: z.object({ sum: z.number() }), effects: 'none', capabilities: [],
  execute: ({ left, right }) => ({ sum: left + right }),
});
const definition = defineAgent({
  id: 'calculator', version: '1.0.0', instructions: 'Use math.add.', tools: [tool],
  input: z.object({ request: z.string() }), output: z.object({ answer: z.number() }),
  model: scriptedModel([
    { type: 'tool_calls', calls: [{ id: 'add-1', toolId: 'math.add', input: { left: 2, right: 3 } }], usage: { costMicros: 0 } },
    { type: 'final', output: { answer: 5 }, usage: { costMicros: 0 } },
  ]),
});
const runtime = createRuntime({ profile: 'ephemeral', permissions: { allow: ['model:scripted', 'tool:math.add'] } });
const handle = runtime.submit(definition, { input: { request: '2 + 3' } });
const result = await handle.result();
const expectedResult: Outcome<{ answer: number }> = result;
void expectedResult;
if (result.status === 'succeeded') {
  const answer: number = result.output.answer;
  // @ts-expect-error Schema-inferred output is not a string.
  const invalidAnswer: string = result.output.answer;
  void answer; void invalidAnswer;
} else {
  const code: string = result.error.code;
  // @ts-expect-error Non-success does not expose unapproved output.
  void result.output;
  void code;
}
const expectedToolOutput: ToolOutput<typeof tool> = { sum: 5 };
void expectedToolOutput;
// @ts-expect-error Tool output shape remains inferred across published declarations.
const invalidToolOutput: ToolOutput<typeof tool> = { sum: 'wrong' };
void invalidToolOutput;
if (false) {
  // @ts-expect-error Submitted input follows the agent schema.
  runtime.submit(definition, { input: { request: 5 } });
  // @ts-expect-error Raw handler access is not part of a tool definition.
  tool.execute({ left: 1, right: 2 });
}
const transformed = defineTool({
  id: 'text.length', version: '1.0.0', description: 'Transform schema input.',
  input: z.string().transform((value) => value.length),
  output: z.number().transform((value) => ({ length: value })),
  effects: 'none', capabilities: [], execute: (length) => length,
});
const transformedResult = await invokeTool(transformed, 'test', {
  runId: 'run-1', callId: 'call-1', scope: { principalId: 'local', projectId: 'example' },
  signal: new AbortController().signal, permissions: { allow: ['tool:text.length'] }, budget: new Budget(0, 1),
});
if (transformedResult.status === 'succeeded') {
  const length: number = transformedResult.output.length;
  void length;
}
await runtime.close();
`;

const consumerRuntime = `import assert from 'node:assert/strict';
import { realpath } from 'node:fs/promises';
import { isAbsolute, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
const started = performance.now();
const [{ Budget }, { defineTool, invokeTool }, { createRuntime, defineAgent }, { scriptedModel }, { z }, sdk] = await Promise.all([
  import('@mayura/core'), import('@mayura/tools'), import('@mayura/runtime'), import('@mayura/testing'), import('zod'), import('@mayura/sdk'),
]);
assert.equal(sdk.defineTool, defineTool);
assert.equal(sdk.defineAgent, defineAgent);
assert.equal(sdk.createRuntime, createRuntime);
assert.equal(sdk.Budget, Budget);
const importMs = performance.now() - started;
const consumerRoot = await realpath(process.cwd());
for (const name of ['@mayura/core', '@mayura/tools', '@mayura/runtime', '@mayura/testing', '@mayura/sdk', 'zod']) {
  const resolved = await realpath(fileURLToPath(import.meta.resolve(name)));
  const local = relative(consumerRoot, resolved);
  assert(!isAbsolute(local) && !local.startsWith('..'), 'Consumer imported outside its clean installation.');
}
await assert.rejects(import('@mayura/tools/dist/index.js'), { code: 'ERR_PACKAGE_PATH_NOT_EXPORTED' });
await assert.rejects(import('@mayura/runtime/src/index.js'), { code: 'ERR_PACKAGE_PATH_NOT_EXPORTED' });
await assert.rejects(import('@mayura/sdk/src/index.js'), { code: 'ERR_PACKAGE_PATH_NOT_EXPORTED' });
let invocations = 0;
const tool = defineTool({
  id: 'math.add', version: '1.0.0', description: 'Add finite numbers.',
  input: z.object({ left: z.number(), right: z.number() }), output: z.object({ sum: z.number() }),
  effects: 'none', capabilities: [], execute: ({ left, right }) => { invocations++; return { sum: left + right }; },
});
const agent = defineAgent({
  id: 'calculator', version: '1.0.0', instructions: 'Use math.add.', tools: [tool],
  input: z.object({ request: z.string() }), output: z.object({ answer: z.number() }),
  model: scriptedModel([
    { type: 'tool_calls', calls: [{ id: 'add-1', toolId: 'math.add', input: { left: 2, right: 3 } }], usage: { costMicros: 0 } },
    (request) => {
      assert.deepEqual(request.messages.at(-1), { role: 'tool', callId: 'add-1', toolId: 'math.add', result: { sum: 5 } });
      return { type: 'final', output: { answer: 5 }, usage: { costMicros: 0 } };
    },
  ]),
});
const runtime = createRuntime({ profile: 'ephemeral', permissions: { allow: ['model:scripted', 'tool:math.add'] } });
const handle = runtime.submit(agent, { input: { request: '2 + 3' } });
assert.deepEqual(await handle.result(), { status: 'succeeded', output: { answer: 5 } });
const events = await Array.fromAsync(handle.observe());
assert.equal(events.at(-1).type, 'run.completed');
assert.equal(invocations, 1);
assert.equal('execute' in tool, false);
const denied = await invokeTool(tool, { left: 1, right: 2 }, {
  runId: 'denied', callId: 'call-2', scope: { principalId: 'local', projectId: 'example' },
  signal: new AbortController().signal, permissions: { allow: [] }, budget: new Budget(0, 1),
});
assert.equal(denied.status, 'blocked');
assert.equal(invocations, 1);
await runtime.close();
console.log(JSON.stringify({ status: 'passed', importMs, events: events.length, toolInvocations: invocations }));
`;

const consumerDebugger = `import assert from 'node:assert/strict';
import { Budget } from '@mayura/core';
let stack;
try { new Budget(-1, 1); } catch (error) { stack = error.stack; }
assert.equal(typeof stack, 'string');
assert.match(stack, /[/\\\\]@mayura[/\\\\]core[/\\\\]src[/\\\\]budget\\.ts:\\d+:\\d+/);
console.log(JSON.stringify({ status: 'passed', sourceMappedStack: true }));
`;

async function main() {
  const npm = cliPath('npm');
  const pnpm = cliPath('pnpm');
  const tsc = join(workspace, 'node_modules', 'typescript', 'bin', 'tsc');
  assert(existsSync(tsc), 'Install the workspace development dependencies before consumer validation.');
  const artifactRoot = join(workspace, '.artifacts');
  await mkdir(artifactRoot, { recursive: true });
  const resolvedArtifactRoot = await realpath(artifactRoot);
  assert(inside(workspace, resolvedArtifactRoot), 'Artifact directory must remain inside the canonical workspace.');
  const output = await mkdtemp(join(resolvedArtifactRoot, 'consumer-'));
  const tarballs = join(output, 'tarballs');
  const application = join(output, 'application');
  await mkdir(tarballs);
  await mkdir(application);
  const npmCache = join(output, 'npm-cache');
  const npmConfig = join(application, 'empty.npmrc');
  await writeFile(npmConfig, '');
  const dependencies = {};
  const reports = [];
  for (const shortName of packageNames) {
    const directory = join(workspace, 'packages', shortName);
    const manifest = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8'));
    assert(existsSync(join(directory, 'dist', 'index.js')), 'Build the workspace before packing consumer artifacts.');
    const destination = join(tarballs, `${shortName}.tgz`);
    await runNode([pnpm, 'pack', '--out', destination], directory);
    const bytes = await readFile(destination);
    const files = inspectTarball(bytes);
    assert(files.length > 1, 'Packed package must contain compiled exports.');
    for (const file of files) {
      assert(/^(?:package\.json|README(?:\.md)?|LICENSE(?:\.[^/]+)?|dist\/[A-Za-z0-9_./-]+\.(?:js|js\.map|d\.ts|d\.ts\.map)|src\/[A-Za-z0-9_./-]+\.ts)$/.test(file.path), `Unexpected distributed file: ${manifest.name}/${file.path}`);
      assert(!/(?:^|\/)(?:node_modules|test|tests|__tests__|\.git|\.env)(?:\/|\.|$)/.test(file.path) && !/\.(?:test|spec)\.ts$/.test(file.path), `Development/private path included: ${file.path}`);
      assert(!file.content.includes(Buffer.from('-----BEGIN PRIVATE KEY-----')), 'Private key marker found in package archive.');
    }
    const sourceMaps = inspectSourceMaps(files);
    const packedManifest = JSON.parse(files.find((file) => file.path === 'package.json').content.toString('utf8'));
    for (const [name, version] of Object.entries(packedManifest.dependencies ?? {})) {
      assert(packageNames.map((value) => `@mayura/${value}`).includes(name), `Unexpected mandatory base dependency: ${name}`);
      assert(!String(version).startsWith('workspace:'), 'Workspace protocol leaked into packed package.');
    }
    assert(!packedManifest.optionalDependencies && !packedManifest.peerDependencies, 'Base packages need explicit optional-dependency review.');
    assert(!packedManifest.scripts && !packedManifest.bin, 'Lifecycle scripts or executable binaries require distribution review.');
    assert(bytes.length <= 150 * 1024, `Base package compressed size budget exceeded: ${manifest.name}`);
    dependencies[manifest.name] = pathToFileURL(destination).href;
    reports.push({ name: manifest.name, version: manifest.version, tarballBytes: bytes.length, unpackedBytes: files.reduce((sum, file) => sum + file.bytes, 0), files: files.length, sourceMaps });
  }

  // Zod is a chosen consumer dependency, packed from the already-installed local validator.
  const zodDirectory = await realpath(join(workspace, 'node_modules', 'zod'));
  const zodArchive = join(tarballs, 'zod.tgz');
  await runNode([pnpm, 'pack', '--out', zodArchive], zodDirectory);
  dependencies.zod = pathToFileURL(zodArchive).href;
  await writeFile(join(application, 'package.json'), JSON.stringify({ name: 'mayura-packed-consumer', version: '1.0.0', private: true, type: 'module', dependencies }, null, 2));
  const installStarted = performance.now();
  await runNode([npm, 'install', '--offline', '--ignore-scripts', '--no-audit', '--no-fund', '--userconfig', npmConfig, '--cache', npmCache], application);
  const installMs = performance.now() - installStarted;
  const tree = JSON.parse((await runNode([npm, 'ls', '--all', '--json', '--offline', '--cache', npmCache, '--userconfig', npmConfig], application)).stdout);
  const installed = new Set();
  const collect = (node) => {
    for (const [name, child] of Object.entries(node.dependencies ?? {})) {
      assert(Object.hasOwn(dependencies, name), `Unexpected transitive runtime dependency: ${name}`);
      installed.add(name);
      collect(child);
    }
  };
  collect(tree);
  assert.equal(installed.size, packageNames.length + 1, 'The clean installation must contain exactly the declared Mayura packages and the chosen validator.');
  for (const name of Object.keys(dependencies)) {
    const location = await realpath(join(application, 'node_modules', name));
    assert(inside(await realpath(application), location), 'Package installation resolved to a workspace symlink.');
  }
  await writeFile(join(application, 'consumer.ts'), consumerTypes);
  await writeFile(join(application, 'consumer.mjs'), consumerRuntime);
  await writeFile(join(application, 'debugger.mjs'), consumerDebugger);
  await writeFile(join(application, 'tsconfig.json'), JSON.stringify({ compilerOptions: {
    target: 'ES2023', module: 'NodeNext', moduleResolution: 'NodeNext', lib: ['ES2023', 'DOM', 'DOM.Iterable'],
    strict: true, noUncheckedIndexedAccess: true, exactOptionalPropertyTypes: true, noUnusedLocals: true,
    noUnusedParameters: true, verbatimModuleSyntax: true, skipLibCheck: false, noEmit: true, types: [],
  }, include: ['consumer.ts'] }, null, 2));
  const typecheckStarted = performance.now();
  await runNode([tsc, '--project', join(application, 'tsconfig.json'), '--pretty', 'false'], application);
  const typecheckMs = performance.now() - typecheckStarted;
  const executionStarted = performance.now();
  const execution = JSON.parse((await runNode([join(application, 'consumer.mjs')], application)).stdout);
  const executionMs = performance.now() - executionStarted;
  const debuggerResult = JSON.parse((await runNode(['--enable-source-maps', join(application, 'debugger.mjs')], application)).stdout);
  assert.equal(debuggerResult.sourceMappedStack, true, 'The actual Node debugger stack did not resolve to shipped TypeScript.');
  const frameworkBytes = reports.reduce((sum, item) => sum + item.tarballBytes, 0);
  assert(frameworkBytes <= 512 * 1024, 'Combined compressed base package budget exceeded.');
  assert(reports.reduce((sum, item) => sum + item.unpackedBytes, 0) <= 2 * 1024 * 1024, 'Combined unpacked base package budget exceeded.');
  const result = {
    status: 'passed', node: process.version, platform: process.platform, architecture: process.arch,
    output, packages: reports, frameworkTarballBytes: frameworkBytes, installedPackageCount: installed.size,
    installMs, typecheckMs, executionMs, importMs: execution.importMs,
    checks: ['offline-local-tarballs', 'no-install-scripts', 'strict-public-types', 'negative-type-fixtures', 'esm-agent-execution', 'default-deny-tool', 'private-exports-denied', 'no-native-or-provider-dependencies', 'archive-file-allowlist', 'declaration-map-targets', 'debugger-map-source-integrity', 'node-source-mapped-stack'],
  };
  await writeFile(join(output, 'report.json'), `${JSON.stringify(result, null, 2)}\n`);
  console.log(JSON.stringify(result));
}

await main();
