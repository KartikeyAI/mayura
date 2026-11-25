// Install the staged UI tarball into an isolated plain React app and exercise the wire hook.
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { copyFile, mkdir, realpath, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { compilerPlatform, createPacker, inside, run, workspace } from './local-packages.mjs';
import { workDirectory } from './work-directory.mjs';

const name = '@mayurajs/ui';
const appPackages = [name, 'react', 'react-dom'];
const compilerPackages = ['typescript', compilerPlatform, '@types/react'];

export async function checkStandaloneUi(packer, output) {
  const { npm, packages, packClosure } = packer;
  const closure = await packClosure([
    [name, workspace], ['react-dom', workspace], ['typescript', workspace], ['@types/react', workspace],
    [compilerPlatform, join(workspace, 'node_modules', '.pnpm')],
  ]);
  const ui = packages.get(name);
  assert.equal(ui.manifest.peerDependenciesMeta?.mayura?.optional, true, 'Published UI must make Mayura optional.');
  assert(!closure.has('mayura'), 'Standalone UI unexpectedly packed the Mayura framework.');

  // Runtime and declaration resolution both start outside the workspace. In-repo installs could
  // accidentally import Mayura through an ancestor node_modules directory and hide regressions.
  const temporary = await realpath(tmpdir());
  assert(!inside(workspace, temporary), 'The standalone UI check needs a system temporary directory outside the workspace.');
  const app = await workDirectory(join(temporary, 'mayura-ui-standalone-'));
  assert(inside(temporary, await realpath(app)), 'The standalone app must stay in the system temporary directory.');
  const archives = names => Object.fromEntries(names.map(dependency => [dependency, packages.get(dependency).archive]));
  await writeFile(join(app, 'package.json'), JSON.stringify({ name: 'plain-react-ui-consumer', private: true, type: 'module',
    dependencies: archives(appPackages), devDependencies: archives(compilerPackages), overrides: archives([...closure]) }, null, 2));
  const config = join(app, 'empty.npmrc'); await writeFile(config, '');
  await run([npm, 'install', '--offline', '--ignore-scripts', '--no-audit', '--no-fund', '--userconfig', config,
    '--cache', join(output, 'npm-cache')], app, { timeout: 180_000 });
  for (const dependency of appPackages) {
    assert(inside(app, await realpath(join(app, 'node_modules', dependency))), `${dependency} must come from the isolated install.`);
  }
  assert(!existsSync(join(app, 'node_modules', 'mayura')), 'npm installed the optional Mayura peer.');

  const fixtures = join(workspace, 'consumer-tests');
  await copyFile(join(fixtures, 'ui-standalone-app.tsx'), join(app, 'app.tsx'));
  await copyFile(join(fixtures, 'ui-standalone-probe.mjs'), join(app, 'probe.mjs'));
  await copyFile(join(fixtures, 'module-isolation.mjs'), join(app, 'module-isolation.mjs'));
  await writeFile(join(app, 'styles.ts'), "import '@mayurajs/ui/styles.css';\n");
  await writeFile(join(app, 'tsconfig.json'), JSON.stringify({ compilerOptions: {
    target: 'ES2023', module: 'NodeNext', lib: ['ES2023', 'DOM', 'DOM.Iterable'],
    strict: true, exactOptionalPropertyTypes: true, noUncheckedIndexedAccess: true, noUncheckedSideEffectImports: true,
    verbatimModuleSyntax: true, skipLibCheck: false, jsx: 'react-jsx', types: [], outDir: 'build',
  }, include: ['app.tsx', 'styles.ts'] }, null, 2));
  const types = await run([join(app, 'node_modules', 'typescript', 'bin', 'tsc'), '-p', 'tsconfig.json', '--pretty', 'false', '--listFiles'], app);
  for (const file of types.stdout.split(/\r?\n/u).filter(Boolean)) {
    assert(inside(app, await realpath(file)), `TypeScript resolved an external declaration: ${file}`);
  }

  // jsdom is the test harness from this workspace, independent of the app's installed dependencies.
  const jsdom = createRequire(import.meta.url).resolve('jsdom');
  assert(inside(workspace, jsdom), 'Resolve the DOM test harness from the workspace installation.');
  const { stdout } = await run([join(app, 'probe.mjs'), pathToFileURL(jsdom).href], app);
  return { name, version: ui.manifest.version, ...JSON.parse(stdout) };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const artifacts = join(workspace, '.artifacts'); await mkdir(artifacts, { recursive: true });
  const output = await workDirectory(join(artifacts, 'ui-standalone-pack-'));
  const tarballs = join(output, 'tarballs'); await mkdir(tarballs);
  console.log(JSON.stringify({ status: 'passed', ...await checkStandaloneUi(createPacker({ output, tarballs }), output) }));
}
