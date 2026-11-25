// Exercise the public registry through the official shadcn CLI in an isolated React consumer.
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { copyFile, mkdir, readFile, readdir, realpath, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { compilerPlatform, createPacker, inside, run, workspace } from './local-packages.mjs';
import { writeUiRegistry } from './ui-registry.mjs';
import { workDirectory } from './work-directory.mjs';

const shadcnVersion = '4.23.0';
const registry = 'https://registry.npmjs.org/';
const publicRegistry = 'https://mayurajs.com/r';
const tooling = join(workspace, '.artifacts', `ui-shadcn-tooling-${shadcnVersion}`);
const reactPackages = ['react', 'react-dom'];
const compilerPackages = ['typescript', compilerPlatform, '@types/react'];
const uiDirectory = 'src/features/design-system';
const originals = ['package.json', 'package-lock.json', 'src/global.css'];
const fixture = name => join(workspace, 'consumer-tests', name);
const installedUi = filename => `./${uiDirectory}/mayura/${filename}`;

async function install(packer, cwd, output, offline = false) {
  const userconfig = join(output, 'user.npmrc');
  const globalconfig = join(output, 'global.npmrc');
  await Promise.all([writeFile(userconfig, ''), writeFile(globalconfig, '')]);
  await run([packer.npm, 'install', '--ignore-scripts', '--no-audit', '--no-fund', '--userconfig', userconfig,
    '--globalconfig', globalconfig, '--registry', registry, '--fetch-retries=0', '--fetch-timeout=30000',
    offline ? '--offline' : '--prefer-offline'], cwd, { timeout: 180_000 });
}

/** Fetch the versioned test tooling and the CLI's shared neutral palette in a separate setup step. */
async function prepareTools() {
  await mkdir(tooling, { recursive: true });
  await writeFile(join(tooling, 'package.json'), JSON.stringify({ private: true, dependencies: { shadcn: shadcnVersion } }));
  await install(createPacker({ output: tooling, tarballs: tooling }), tooling, tooling);
  const response = await fetch('https://ui.shadcn.com/r/colors/neutral.json', { signal: AbortSignal.timeout(30_000) });
  assert(response.ok, `Unable to fetch shadcn's neutral palette (HTTP ${response.status}).`);
  await writeFile(join(tooling, 'neutral.json'), JSON.stringify(await response.json()));
  console.log(`Prepared shadcn ${shadcnVersion} for the offline registry smoke check.`);
}

/** Serve the cached palette and, in the offline check, the staged registry items. */
async function serveRegistry(directory) {
  const entries = directory ? (await readdir(directory)).filter(file => file.endsWith('.json')) : [];
  const files = new Map(await Promise.all(entries
    .map(async file => [`/r/${file}`, await readFile(join(directory, file))])));
  files.set('/r/colors/neutral.json', await readFile(join(tooling, 'neutral.json')));
  const requests = new Set();
  const server = createServer((request, response) => {
    const body = request.method === 'GET' && files.get(request.url);
    if (!body) { response.writeHead(404).end(); return; }
    requests.add(request.url);
    response.writeHead(200, { 'Content-Type': 'application/json' }).end(body);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return { server, requests, url: `http://127.0.0.1:${server.address().port}/r` };
}

/** Compare the deployed catalog and items to the local build before letting the CLI install them. */
async function verifyPublicRegistry(directory, items) {
  const parse = (text) => JSON.parse(text, (_key, value) => typeof value === 'string' ? value.replaceAll('\r\n', '\n') : value);
  await Promise.all(['registry', ...items].map(async item => {
    const file = `${item}.json`;
    const response = await fetch(`${publicRegistry}/${file}`, { redirect: 'error', signal: AbortSignal.timeout(30_000) });
    assert(response.ok, `Public registry item ${file} returned HTTP ${response.status}.`);
    assert.match(response.headers.get('content-type') ?? '', /^application\/json(?:\s*;|$)/iu, `${file} must be served as JSON.`);
    const expected = parse(await readFile(join(directory, file), 'utf8'));
    assert(isDeepStrictEqual(parse(await response.text()), expected), `Public registry item ${file} differs from the current build.`);
  }));
}

async function verifyPlainReact(app, fullKit) {
  // Reuse the plain React wire and hydration test with local source imports in place of package exports.
  const components = fullKit
    ? `import { Composer, UiRoot, ThreadHistory, RunActivity } from '${installedUi('index.js')}';`
    : `import { Composer } from '${installedUi('composer.js')}';
import { UiRoot } from '${installedUi('ui-root.js')}';
import { ThreadHistory } from '${installedUi('thread-history.js')}';
import { RunActivity } from '${installedUi('run-activity.js')}';`;
  const appSource = (await readFile(fixture('ui-standalone-app.tsx'), 'utf8'))
    .replace("import { Composer, UiRoot } from '@mayurajs/ui';", components)
    .replace("from '@mayurajs/ui/ag-ui'", `from '${installedUi('ag-ui.js')}'`)
    .replace('<h1>Plain React chat</h1>', `<h1>Plain React chat</h1>
      <ThreadHistory threads={[]} activeId={null} error={null} loading={false} locked={false} onOpen={() => {}} onRefresh={() => {}} />
      <RunActivity items={[]} status="complete" streamingLabel="Working" />`);
  const probe = (await readFile(fixture('ui-standalone-probe.mjs'), 'utf8'))
    .replace("new URL(import.meta.resolve('@mayurajs/ui/styles.css'))", `new URL('${installedUi('styles.css')}', import.meta.url)`)
    .replace("await assert.rejects(import('mayura'), { code: 'ERR_MODULE_NOT_FOUND' });", "$&\nawait assert.rejects(import('@mayurajs/ui'), { code: 'ERR_MODULE_NOT_FOUND' });")
    .replace('assert.match(html, /Plain React chat/u);', '$&\nassert.match(html, /Thread history/u);\nassert.match(html, /Run activity/u);');
  await Promise.all([
    writeFile(join(app, 'app.tsx'), appSource),
    writeFile(join(app, 'styles.ts'), `import '${installedUi('styles.css')}';\n`),
    writeFile(join(app, 'probe.mjs'), probe),
    copyFile(fixture('module-isolation.mjs'), join(app, 'module-isolation.mjs')),
  ]);

  const types = await run([join(app, 'node_modules', 'typescript', 'bin', 'tsc'), '-p', 'tsconfig.json', '--pretty', 'false', '--listFiles'], app);
  for (const file of types.stdout.split(/\r?\n/u).filter(Boolean)) {
    assert(inside(app, await realpath(file)), `TypeScript resolved an external declaration: ${file}`);
  }
  const jsdom = createRequire(import.meta.url).resolve('jsdom');
  assert(inside(workspace, jsdom), 'Resolve the DOM test harness from the workspace installation.');
  const { stdout } = await run([join(app, 'probe.mjs'), pathToFileURL(jsdom).href], app);
  return JSON.parse(stdout);
}

async function createApp(packer, output, closure) {
  const temporary = await realpath(tmpdir());
  assert(!inside(workspace, temporary), 'The shadcn check needs a temporary directory outside the workspace.');
  const app = await workDirectory(join(temporary, 'mayura-ui-shadcn-'));
  assert(inside(temporary, await realpath(app)), 'The app must stay in the system temporary directory.');
  await mkdir(join(app, 'src'));
  const archives = names => Object.fromEntries(names.map(name => [name, packer.packages.get(name).archive]));
  await Promise.all([
    writeFile(join(app, 'package.json'), JSON.stringify({ name: 'plain-react-shadcn-consumer', private: true, type: 'module',
      dependencies: archives(reactPackages), devDependencies: archives([...compilerPackages, 'tailwindcss']), overrides: archives([...closure]) })),
    writeFile(join(app, 'src', 'global.css'), '@import "tailwindcss";\n\nbody { margin: 0; }\n'),
    writeFile(join(app, 'tsconfig.json'), JSON.stringify({ compilerOptions: {
      target: 'ES2023', module: 'NodeNext', lib: ['ES2023', 'DOM', 'DOM.Iterable'], paths: { '@/*': ['./src/*'] },
      strict: true, exactOptionalPropertyTypes: true, noUncheckedIndexedAccess: true, noUncheckedSideEffectImports: true,
      verbatimModuleSyntax: true, allowArbitraryExtensions: true, skipLibCheck: false, jsx: 'react-jsx', types: [],
      rootDir: '.', outDir: 'build',
    }, include: ['app.tsx', 'styles.ts', 'src/**/*.ts', 'src/**/*.tsx'] })),
  ]);
  await install(packer, app, output, true);
  return app;
}

async function checkInstall(app, shadcnEntry, { itemBase, cliBase }, items) {
  const baseline = await Promise.all(originals.map(file => readFile(join(app, file))));
  await writeFile(join(app, 'components.json'), JSON.stringify({
    $schema: 'https://ui.shadcn.com/schema.json', style: 'new-york', rsc: false, tsx: true,
    tailwind: { config: '', css: 'src/global.css', baseColor: 'neutral', cssVariables: true, prefix: '' },
    aliases: { components: '@/components', ui: '@/features/design-system', utils: '@/lib/utils', lib: '@/lib', hooks: '@/hooks' },
    registries: { '@mayura': `${itemBase}/{name}.json` },
  }));
  await run([shadcnEntry, 'add', ...items, '--yes'], app, { env: { CI: '1', REGISTRY_URL: cliBase,
    npm_config_offline: 'true', npm_config_userconfig: join(tooling, 'user.npmrc'), npm_config_globalconfig: join(tooling, 'global.npmrc') } });
  assert.deepEqual(await Promise.all(originals.map(file => readFile(join(app, file)))), baseline,
    'The registry must preserve the consumer manifest, lockfile and global CSS.');
}

async function checkShadcn(live) {
  const shadcnRoot = join(tooling, 'node_modules', 'shadcn');
  const shadcn = JSON.parse(await readFile(join(shadcnRoot, 'package.json'), 'utf8').catch(error => {
    if (error.code !== 'ENOENT') throw error;
    throw new Error('Prepare the pinned CLI first with `node scripts/ui-shadcn-check.mjs --prepare`.', { cause: error });
  }));
  assert.equal(shadcn.version, shadcnVersion);
  const shadcnEntry = join(shadcnRoot, shadcn.bin);

  const output = await workDirectory(join(workspace, '.artifacts', 'ui-shadcn-pack-'));
  const tarballs = join(output, 'tarballs');
  const published = join(output, 'registry');
  await mkdir(tarballs);
  const packer = createPacker({ output, tarballs });
  const uiExtension = join(workspace, 'extensions', 'ui');
  const css = await readFile(join(uiExtension, 'dist', 'styles.css'), 'utf8');
  const closure = await packer.packClosure([
    ['react-dom', workspace], ['typescript', workspace], ['@types/react', workspace],
    [compilerPlatform, join(workspace, 'node_modules', '.pnpm')], ['tailwindcss', uiExtension],
  ]);
  assert(!closure.has('mayura') && !closure.has('@mayurajs/ui'), 'The React test dependencies must exclude both Mayura packages.');
  const { items } = await writeUiRegistry(published, css);
  if (live) await verifyPublicRegistry(published, items);
  const local = await serveRegistry(live ? undefined : published);
  const endpoints = { itemBase: live ? publicRegistry : local.url, cliBase: local.url };
  try {
    const partial = await createApp(packer, output, closure);
    await checkInstall(partial, shadcnEntry, endpoints, ['@mayura/composer', '@mayura/thread-history', '@mayura/ag-ui']);
    await checkInstall(partial, shadcnEntry, endpoints, [`${endpoints.itemBase}/run-activity.json`]);
    const individual = await verifyPlainReact(partial, false);
    await checkInstall(partial, shadcnEntry, endpoints, ['@mayura/reply', '@mayura/artifacts', '@mayura/approvals']);
    const kit = await createApp(packer, output, closure);
    await checkInstall(kit, shadcnEntry, endpoints, ['@mayura/ui']);
    const fullKit = await verifyPlainReact(kit, true);
    if (!live) for (const item of items) {
      assert(local.requests.has(`/r/${item}.json`), `The official CLI must request the ${item} registry item.`);
    }
    const installed = await readdir(join(partial, uiDirectory, 'mayura'));
    for (const file of installed) {
      assert.deepEqual(await readFile(join(partial, uiDirectory, 'mayura', file)), await readFile(join(kit, uiDirectory, 'mayura', file)),
        `${file} must match whether installed individually or with the full kit.`);
    }
    return { shadcn: shadcnVersion, registry: live ? publicRegistry : 'loopback', registryItems: items,
      uiPackageInstalled: false, individual, fullKit };
  } finally {
    await new Promise((resolve, reject) => local.server.close(error => error ? reject(error) : resolve()));
  }
}

const [mode, ...unexpected] = process.argv.slice(2);
assert(unexpected.length === 0 && [undefined, '--prepare', '--live'].includes(mode),
  'Usage: node scripts/ui-shadcn-check.mjs [--prepare | --live]');
if (mode === '--prepare') await prepareTools();
else console.log(JSON.stringify({ status: 'passed', ...await checkShadcn(mode === '--live') }));
