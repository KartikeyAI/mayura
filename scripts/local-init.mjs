// Create a Mayura project from this workspace, before Mayura is published: the same `mayura init`, then the
// project's dependencies are wired to packed copies of this workspace's packages (and the third-party packages they
// use, taken from the local installation) and installed offline. Nothing is downloaded.
//
//   pnpm local:init                                              choose interactively (in a terminal)
//   pnpm local:init --starter research-team --directory ../my-app
//   pnpm local:init --template basic-agent --directory ../my-agent
//
// The packed packages are kept in the project's .mayura-local/ folder, so `npm install` keeps working there offline.
// Rebuild (`pnpm build`) and create a new project to pick up later workspace changes.
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { appendFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { compilerPlatform, createPacker, run, workspace } from './local-packages.mjs';

const argument = name => { const index = process.argv.indexOf(name); return index < 0 ? undefined : process.argv[index + 1]; };
// pnpm runs scripts from the workspace root; resolve paths from where the command was typed.
const origin = process.env.INIT_CWD && isAbsolute(process.env.INIT_CWD) ? process.env.INIT_CWD : process.cwd();
process.chdir(origin);
const localFolder = '.mayura-local';
// Installed here once, packed as installed, and never run again in the new project.
const allowScripts = ['better-sqlite3', 'esbuild'];

async function build() {
  await run([join(workspace, 'node_modules', 'typescript', 'bin', 'tsc'), '--build'], workspace, { timeout: 600_000 });
}

/** Wire `directory`'s package.json to packed local packages and install offline. Returns a one-line summary. */
async function installLocal(directory, source) {
  const manifestPath = join(directory, 'package.json'); const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  const packagesDirectory = join(directory, localFolder, 'packages'); await rm(join(directory, localFolder), { recursive: true, force: true });
  await mkdir(packagesDirectory, { recursive: true });
  const scratch = await mkdtemp(join(tmpdir(), 'mayura-local-'));
  try {
    const { npm, packages, packClosure } = createPacker({ output: scratch, tarballs: packagesDirectory, allowScripts });
    const dependencies = Object.keys(manifest.dependencies ?? {}); const development = Object.keys(manifest.devDependencies ?? {});
    const typescript = development.includes('typescript');
    const closure = await packClosure([...dependencies, ...development].map(name => [name, source])
      .concat(typescript ? [[compilerPlatform, join(workspace, 'node_modules', '.pnpm')]] : []), { optional: true });
    const local = name => `file:./${relative(directory, fileURLToPath(packages.get(name).archive)).replaceAll('\\', '/')}`;
    manifest.dependencies = Object.fromEntries(dependencies.map(name => [name, local(name)]));
    manifest.devDependencies = Object.fromEntries([...development, ...(typescript ? [compilerPlatform] : [])].map(name => [name, local(name)]));
    manifest.overrides = Object.fromEntries([...closure].sort().map(name => [name, local(name)]));
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    const gitignore = join(directory, '.gitignore');
    if (!existsSync(gitignore) || !(await readFile(gitignore, 'utf8')).split(/\r?\n/u).includes(`${localFolder}/`)) await appendFile(gitignore, `${localFolder}/\n`);
    const config = join(scratch, 'empty.npmrc'); await writeFile(config, '');
    await run([npm, 'install', '--offline', '--ignore-scripts', '--no-audit', '--no-fund', '--userconfig', config, '--cache', join(scratch, 'npm-cache')], directory, { timeout: 600_000 });
    return `Installed ${closure.size} packages from this workspace, offline`;
  } finally { await rm(scratch, { recursive: true, force: true }); }
}

const sourceFor = (kind, name) => kind === 'starter' ? join(workspace, 'packages', 'cli', 'starters', name) : workspace;

const starter = argument('--starter'); const template = argument('--template'); const target = argument('--directory');
const interactive = starter === undefined && template === undefined && target === undefined;
if (interactive) assert(process.stdin.isTTY && process.stdout.isTTY, 'Run pnpm local:init in a terminal, or pass --starter <name> (or --template <name>) and --directory <dir>.');
else assert((starter === undefined) !== (template === undefined) && target, 'Pass exactly one of --starter <name> or --template <name>, and --directory <dir>.');

console.log('Building the workspace…'); await build();
const { applyProjectPlan, planProject, planStarter, STARTER_NAMES } = await import('../packages/cli/dist/index.js');
const { colourEnabled, nextSteps, paint } = await import('../packages/cli/dist/output.js');
const p = paint(colourEnabled(process.stdout));
const kindOf = name => STARTER_NAMES.includes(name) ? 'starter' : 'template';

if (interactive) {
  const { initWizard } = await import('../packages/cli/dist/interactive.js');
  const result = await initWizard(p, {}, { label: 'Installing packages from this workspace (offline)', installs: true,
    run: async directory => { const { template: name } = JSON.parse(await readFile(join(directory, 'mayura.project.json'), 'utf8'));
      return installLocal(directory, sourceFor(kindOf(name), name)); } });
  if (result.status !== 'succeeded') process.exitCode = 1;
} else {
  const kind = starter !== undefined ? 'starter' : 'template'; const name = starter ?? template; const directory = resolve(target);
  const plan = kind === 'starter' ? await planStarter(name, directory) : await planProject(name, directory);
  assert(plan.changes.every(change => change.operation === 'create'), `${directory} already has some of these files; choose a new directory.`);
  await applyProjectPlan(plan); console.log(`Created ${plan.changes.length} files in ${directory}`);
  console.log('Installing packages from this workspace (offline)…');
  console.log(await installLocal(directory, sourceFor(kind, name)));
  const inner = relative(origin, directory); const shown = !inner ? '.' : inner.startsWith('..') ? directory : inner;
  const steps = nextSteps(kind, shown).filter(step => step !== 'npm install');
  console.log(`\n${p.bold('Next steps')}\n${steps.map(step => `  ${p.cyan(step)}`).join('\n')}`);
}
