import { spawn } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { lstat, readdir, readFile } from 'node:fs/promises';
import { delimiter, extname, isAbsolute, join, parse, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { MayuraError, freezeJson, jsonValue, type JsonObject, type JsonValue } from '@mayura/core';
import { assertSafeDirectory, canonicalTarget, digest, planChanges, writePlannedFiles, type FileChange } from './files.js';

/** The application being deployed, from `mayura.deploy.json` and `package.json`. */
export interface DeployProject {
  /** A DNS-safe name for services, jobs and secrets: lowercase letters, digits and hyphens. */
  readonly name: string;
  /** The compiled application module, relative to the project, such as `dist/app.js`. */
  readonly app: string;
  /** The image repository, such as `registry.example.com/acme/agents`; targets that push an image need it. */
  readonly image?: string;
  /** The server's HTTP port and the worker's probe port. */
  readonly port: number;
  readonly probePort: number;
  /** The names of the environment variables the application reads. Values are never part of a deployment plan. */
  readonly env: readonly string[];
}

/** One release: the tag images are built and pushed with. */
export interface DeployRelease {
  readonly tag: string;
  /** `image:tag`, when the project names an image. */
  readonly image?: string;
}

export interface DeployFilesContext<Settings> { readonly project: DeployProject; readonly settings: Settings }
export interface DeployPlanContext<Settings> extends DeployFilesContext<Settings> {
  readonly release: DeployRelease;
  /** Reads a project file, such as a manifest `deploy init` wrote; at most 1 MiB, never through a link. */
  readonly readFile: (path: string) => Promise<string>;
}

/** One command of a deployment, run without a shell. */
export interface DeployStep {
  readonly id: string;
  readonly description: string;
  /** One of the target's tools. */
  readonly tool: string;
  readonly args: readonly string[];
  /** Given to the tool's standard input, such as rendered manifests for `kubectl apply -f -`. */
  readonly stdin?: string;
}

/** Where a project can be deployed: the files it needs and the commands that deploy it. */
export interface DeployTarget<Settings = unknown> {
  readonly id: string;
  readonly description: string;
  /** The executables its steps run, by name, found on PATH: `docker`, `kubectl`, `flyctl`. No other program is run. */
  readonly tools: readonly string[];
  /** Validates its section of `mayura.deploy.json` (`targets.<id>`), which may be absent; defaults may use the project. */
  settings(value: JsonValue | undefined, project: DeployProject): Settings;
  /** The files `mayura deploy init` writes, by path relative to the project. */
  files(context: DeployFilesContext<Settings>): Readonly<Record<string, string>>;
  /** The commands of one release, in order. */
  plan(context: DeployPlanContext<Settings>): readonly DeployStep[] | Promise<readonly DeployStep[]>;
}

const targetId = /^[a-z][a-z0-9-]{0,39}$/u;
const stepId = /^[a-z][a-z0-9-]{0,63}$/u;
const toolName = /^[a-z][a-z0-9-]{0,39}$/u;
const envName = /^[A-Z_][A-Z0-9_]{0,127}$/u;
const imageRepository = /^(?=.{1,255}$)(?:[a-z0-9.-]+(?::\d{1,5})?\/)?[a-z0-9]+(?:[._-][a-z0-9]+)*(?:\/[a-z0-9]+(?:[._-][a-z0-9]+)*)*$/u;
const imageTag = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/u;
const modulePath = /^(?!\/)(?!.*(?:^|\/)\.\.?(?:\/|$))[A-Za-z0-9_][A-Za-z0-9_./-]{0,255}\.(?:js|mjs)$/u;
const filePath = /^(?!\/)(?!.*(?:^|\/)\.\.?(?:\/|$))[A-Za-z0-9_.][A-Za-z0-9_./-]{0,255}$/u;
const limits = Object.freeze({ steps: 64, args: 256, argBytes: 8_192, stdinBytes: 4_194_304, files: 64, fileBytes: 1_048_576 });

/** Checks a target's shape once, so the CLI can refuse a malformed package before it plans anything. */
export function defineDeployTarget<Settings>(target: DeployTarget<Settings>): DeployTarget<Settings> {
  if (!target || typeof target !== 'object' || typeof target.id !== 'string' || !targetId.test(target.id) || typeof target.description !== 'string'
    || !Array.isArray(target.tools) || target.tools.length === 0 || target.tools.length > 16 || target.tools.some(tool => typeof tool !== 'string' || !toolName.test(tool))
    || typeof target.settings !== 'function' || typeof target.files !== 'function' || typeof target.plan !== 'function') {
    throw new MayuraError('INVALID_CONFIG', 'A deploy target needs an id, a description, its tools and settings, files and plan functions.');
  }
  return Object.freeze({ ...target, tools: Object.freeze([...target.tools]) });
}

function object(value: JsonValue | undefined, what: string): JsonObject {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new MayuraError('INVALID_CONFIG', `${what} must be a JSON object.`);
  return value;
}
async function projectFile(directory: string, path: string): Promise<string | undefined> {
  if (!filePath.test(path)) throw new MayuraError('INVALID_CONFIG', 'Deployment files must be relative paths inside the project.');
  const absolute = resolve(directory, path);
  let details; try { details = await lstat(absolute); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
  if (!details.isFile() || details.isSymbolicLink() || details.size > limits.fileBytes) throw new MayuraError('CONFLICT', `${path} must be a regular file of at most 1 MiB.`);
  return readFile(absolute, 'utf8');
}
function json(text: string, what: string): JsonObject {
  let parsed: unknown; try { parsed = JSON.parse(text); } catch { throw new MayuraError('INVALID_CONFIG', `${what} is not valid JSON.`); }
  return object(freezeJson(jsonValue(parsed, { maxBytes: 262_144, maxDepth: 16, maxNodes: 10_000 })), what);
}
function dnsName(value: string): string {
  const name = value.replace(/^@[^/]+\//u, '').toLowerCase().replace(/[^a-z0-9-]+/gu, '-').replace(/^-+|-+$/gu, '').slice(0, 40).replace(/-+$/u, '');
  return /^[a-z][a-z0-9-]*$/u.test(name) ? name : 'mayura-app';
}
function port(value: JsonValue | undefined, fallback: number, what: string): number {
  if (value === undefined) return fallback;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1 || value > 65_535) throw new MayuraError('INVALID_CONFIG', `${what} must be a port number.`);
  return value;
}

/** The compiled module for `src/app.ts`: `dist/app.js` when `src` is the root directory, otherwise `dist/src/app.js`. */
async function defaultApp(directory: string): Promise<string> {
  const tsconfig = await projectFile(directory, 'tsconfig.json');
  let options: JsonObject = {};
  // Comment-free tsconfig files are the common case; anything else falls back to the starters' layout.
  try { if (tsconfig !== undefined) options = object(json(tsconfig, 'tsconfig.json')['compilerOptions'], 'compilerOptions'); } catch { options = {}; }
  const outDir = typeof options['outDir'] === 'string' ? options['outDir'].replace(/^\.\//u, '').replace(/\/+$/u, '') : 'dist';
  const rootDir = typeof options['rootDir'] === 'string' ? options['rootDir'].replace(/^\.\//u, '').replace(/\/+$/u, '') : '.';
  const app = rootDir === 'src' ? `${outDir}/app.js` : `${outDir}/src/app.js`;
  return modulePath.test(app) ? app : 'dist/app.js';
}

export interface DeployConfig { readonly project: DeployProject; readonly targets: Readonly<Record<string, JsonValue>>; readonly version?: string; readonly exists: boolean }

/** Reads `mayura.deploy.json` (optional) and `package.json` from a project directory. */
export async function readDeployConfig(directory: string): Promise<DeployConfig> {
  const manifestText = await projectFile(directory, 'package.json');
  const manifest = manifestText === undefined ? {} : json(manifestText, 'package.json');
  const configText = await projectFile(directory, 'mayura.deploy.json');
  const config = configText === undefined ? {} : json(configText, 'mayura.deploy.json');
  if (configText !== undefined && config['format'] !== 'mayura.deploy.v1') throw new MayuraError('INVALID_CONFIG', 'mayura.deploy.json must have "format": "mayura.deploy.v1".');
  const allowed = new Set(['format', 'name', 'app', 'image', 'port', 'probePort', 'env', 'targets']);
  if (Object.keys(config).some(key => !allowed.has(key))) throw new MayuraError('INVALID_CONFIG', `mayura.deploy.json allows only ${[...allowed].join(', ')}.`);
  const name = config['name'] ?? dnsName(typeof manifest['name'] === 'string' ? manifest['name'] : '');
  if (typeof name !== 'string' || !/^[a-z][a-z0-9-]{0,39}$/u.test(name) || name.endsWith('-')) throw new MayuraError('INVALID_CONFIG', 'The deploy name must be lowercase letters, digits and hyphens, starting with a letter, at most 40.');
  const app = config['app'] ?? await defaultApp(directory);
  if (typeof app !== 'string' || !modulePath.test(app)) throw new MayuraError('INVALID_CONFIG', 'The deploy app must be the compiled module\'s path inside the project, such as dist/app.js.');
  const image = config['image'];
  if (image !== undefined && (typeof image !== 'string' || !imageRepository.test(image))) throw new MayuraError('INVALID_CONFIG', 'The deploy image must be an image repository without a tag, such as registry.example.com/acme/agents.');
  const env = config['env'] ?? [];
  if (!Array.isArray(env) || env.length > 128 || env.some(item => typeof item !== 'string' || !envName.test(item)) || new Set(env).size !== env.length) {
    throw new MayuraError('INVALID_CONFIG', 'The deploy env must list distinct environment variable names, such as OPENAI_API_KEY.');
  }
  const targets = config['targets'] === undefined ? {} : object(config['targets'], 'targets');
  const project: DeployProject = Object.freeze({ name, app, ...(image === undefined ? {} : { image }), port: port(config['port'], 8080, 'port'),
    probePort: port(config['probePort'], 9090, 'probePort'), env: Object.freeze([...env as string[]]) });
  const version = typeof manifest['version'] === 'string' ? manifest['version'] : undefined;
  return Object.freeze({ project, targets, ...(version === undefined ? {} : { version }), exists: configText !== undefined });
}

/** The `mayura.deploy.json` that `deploy init` writes when the project has none. */
function configFile(project: DeployProject, targetIdValue: string): string {
  return `${JSON.stringify({ format: 'mayura.deploy.v1', name: project.name, app: project.app, ...(project.image === undefined ? { image: 'registry.example.com/your-team/' + project.name } : { image: project.image }),
    port: project.port, probePort: project.probePort, env: project.env, targets: { [targetIdValue]: {} } }, null, 2)}\n`;
}

async function directoryOf(value: string): Promise<string> {
  if (!isAbsolute(value) || resolve(value) === parse(resolve(value)).root) throw new MayuraError('INVALID_CONFIG', 'Deploy needs the project\'s absolute directory.');
  const directory = await canonicalTarget(resolve(value)); await assertSafeDirectory(directory); return directory;
}

export interface DeployFilesPlan {
  readonly format: 'mayura.deploy-files-plan.v1'; readonly target: string; readonly directory: string;
  readonly digest: string; readonly changes: readonly FileChange[];
}
interface FilesState { readonly files: ReadonlyMap<string, string>; readonly before: ReadonlyMap<string, string | undefined> }
const filePlans = new WeakMap<DeployFilesPlan, FilesState>();

/** Plans the files a target needs, without writing: each is created, kept or replaced (a replacement shows its diff). */
export async function planDeployFiles(target: DeployTarget, directory: string): Promise<DeployFilesPlan> {
  const checked = defineDeployTarget(target); const root = await directoryOf(directory);
  const config = await readDeployConfig(root); const settings = checked.settings(config.targets[checked.id], config.project);
  const produced = checked.files({ project: config.project, settings });
  const entries = Object.entries(produced ?? {});
  if (entries.length > limits.files || entries.some(([path, content]) => !filePath.test(path) || typeof content !== 'string' || content.length > limits.fileBytes)) {
    throw new MayuraError('INVALID_CONFIG', `Deploy target ${checked.id} produced files outside the bounds.`);
  }
  const files = new Map(entries);
  // A project without a deploy configuration gets one; an existing one is left as it is.
  if (!config.exists) files.set('mayura.deploy.json', configFile(config.project, checked.id));
  const { changes, before } = await planChanges(root, files);
  const plan: DeployFilesPlan = Object.freeze({ format: 'mayura.deploy-files-plan.v1', target: checked.id, directory: root,
    digest: digest(JSON.stringify({ target: checked.id, directory: root, changes })), changes: Object.freeze(changes) });
  filePlans.set(plan, { files, before }); return plan;
}

/** Writes one genuine, fresh file plan. Replacing an existing file requires the plan's displayed digest. */
export async function applyDeployFiles(plan: DeployFilesPlan, options: { readonly confirmation?: string } = {}): Promise<void> {
  const state = filePlans.get(plan); if (!state) throw new MayuraError('INVALID_CONFIG', 'Use a genuine deploy files plan from this process.');
  filePlans.delete(plan);
  if (plan.changes.some(change => change.operation === 'replace') && options.confirmation !== plan.digest) {
    throw new MayuraError('PERMISSION_DENIED', 'Replacing existing files requires the displayed plan digest.');
  }
  await writePlannedFiles(plan, state.files, state.before);
}

export interface DeployPlan {
  readonly format: 'mayura.deploy-plan.v1'; readonly target: string; readonly directory: string;
  readonly release: DeployRelease; readonly steps: readonly DeployStep[]; readonly digest: string;
}
const runPlans = new WeakMap<DeployPlan, readonly string[]>();

/** Plans one release: the commands, in order, with everything they are given. Nothing runs. */
export async function planDeploy(target: DeployTarget, directory: string, options: { readonly tag?: string } = {}): Promise<DeployPlan> {
  const checked = defineDeployTarget(target); const root = await directoryOf(directory);
  const config = await readDeployConfig(root); const settings = checked.settings(config.targets[checked.id], config.project);
  const tag = options.tag ?? config.version;
  if (typeof tag !== 'string') throw new MayuraError('INVALID_CONFIG', 'A release needs a tag: pass --tag, or give package.json a version.');
  if (!imageTag.test(tag)) throw new MayuraError('INVALID_CONFIG', 'A release tag is an image tag: letters, digits, ".", "_" and "-", at most 128, not starting with "." or "-".');
  const release: DeployRelease = Object.freeze({ tag, ...(config.project.image === undefined ? {} : { image: `${config.project.image}:${tag}` }) });
  const read = async (path: string): Promise<string> => {
    const content = await projectFile(root, path);
    if (content === undefined) throw new MayuraError('NOT_FOUND', `${path} is missing: run mayura deploy init --target ${checked.id} first.`);
    return content;
  };
  const produced = await checked.plan({ project: config.project, settings, release, readFile: read });
  if (!Array.isArray(produced) || produced.length === 0 || produced.length > limits.steps) throw new MayuraError('INVALID_CONFIG', `Deploy target ${checked.id} planned no steps or too many.`);
  const ids = new Set<string>(); const steps: DeployStep[] = [];
  for (const step of produced) {
    if (!step || typeof step !== 'object' || typeof step.id !== 'string' || !stepId.test(step.id) || ids.has(step.id) || typeof step.description !== 'string'
      || typeof step.tool !== 'string' || !checked.tools.includes(step.tool) || !Array.isArray(step.args) || step.args.length > limits.args
      || step.args.some((arg: unknown) => typeof arg !== 'string' || arg.length > limits.argBytes || arg.includes('\0'))
      || (step.stdin !== undefined && (typeof step.stdin !== 'string' || step.stdin.length > limits.stdinBytes))) {
      throw new MayuraError('INVALID_CONFIG', `Deploy target ${checked.id} planned a step outside its tools or bounds.`);
    }
    ids.add(step.id);
    steps.push(Object.freeze({ id: step.id, description: step.description, tool: step.tool, args: Object.freeze([...step.args]), ...(step.stdin === undefined ? {} : { stdin: step.stdin }) }));
  }
  const plan: DeployPlan = Object.freeze({ format: 'mayura.deploy-plan.v1', target: checked.id, directory: root, release, steps: Object.freeze(steps),
    digest: digest(JSON.stringify({ target: checked.id, directory: root, release, steps })) });
  runPlans.set(plan, checked.tools); return plan;
}

/** Runs one step: the tool with its arguments, without a shell, in the project directory. Resolves with its exit code. */
export type DeployRunner = (step: DeployStep, context: { readonly directory: string; readonly signal: AbortSignal }) => Promise<{ readonly exitCode: number }>;

export interface DeployStepResult { readonly id: string; readonly status: 'succeeded' | 'failed' | 'cancelled' | 'skipped'; readonly exitCode?: number }
export interface DeployResult { readonly status: 'succeeded' | 'failed' | 'cancelled'; readonly target: string; readonly release: DeployRelease; readonly steps: readonly DeployStepResult[] }

/** Characters cmd.exe interprets even inside double quotes, or that end a quoted argument. */
const cmdUnsafe = /["%!^&|<>()\r\n]|\\$/u;

/**
 * How to start a tool. Elsewhere than Windows, by name. On Windows, the tool is found on PATH with PATHEXT: an `.exe`
 * starts directly, and a `.cmd` or `.bat` (gcloud, az, and CLIs installed with npm) starts through cmd.exe, each
 * argument quoted, and only when no argument holds a character cmd.exe would interpret; such an argument is refused
 * rather than escaped.
 */
function launch(tool: string, args: readonly string[]): { readonly file: string; readonly args: readonly string[]; readonly verbatim: boolean } {
  if (process.platform !== 'win32' || /[\\/]/u.test(tool)) return { file: tool, args, verbatim: false };
  const extensions = (process.env['PATHEXT'] ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean);
  for (const folder of (process.env['PATH'] ?? '').split(delimiter).filter(Boolean)) {
    for (const extension of extensions) {
      const candidate = join(folder, `${tool}${extension.toLowerCase()}`);
      let file = false; try { file = existsSync(candidate) && statSync(candidate).isFile(); } catch { file = false; }
      if (!file) continue;
      if (!/^\.(?:cmd|bat)$/iu.test(extname(candidate))) return { file: candidate, args, verbatim: false };
      if (cmdUnsafe.test(candidate) || args.some(arg => cmdUnsafe.test(arg))) {
        throw new MayuraError('INVALID_INPUT', `${tool} is a Windows script, which runs through cmd.exe; an argument holds a character cmd.exe would interpret (" % ! ^ & | < > ( ) or a trailing backslash).`);
      }
      const line = [candidate, ...args].map(part => `"${part}"`).join(' ');
      return { file: process.env['ComSpec'] ?? 'cmd.exe', args: ['/d', '/s', '/c', `"${line}"`], verbatim: true };
    }
  }
  return { file: tool, args, verbatim: false };
}

/**
 * The default runner: starts the tool found on PATH with the arguments as given, without a shell (on Windows, a
 * `.cmd` tool through cmd.exe with quoted, checked arguments), in the project directory. Its output goes to standard
 * error, so standard output stays the CLI's own result; `stdin` is written to the tool and closed. Cancelling stops the
 * tool, and on Windows everything it started.
 */
export const spawnDeployStep: DeployRunner = (step, { directory, signal }) => new Promise((resolvePromise, reject) => {
  let command: ReturnType<typeof launch>;
  try { command = launch(step.tool, step.args); } catch (error) { reject(error); return; }
  const child = spawn(command.file, [...command.args], { cwd: directory, shell: false, windowsHide: true, windowsVerbatimArguments: command.verbatim,
    stdio: [step.stdin === undefined ? 'ignore' : 'pipe', 2, 2] });
  let killer: ReturnType<typeof setTimeout> | undefined;
  const stop = (): void => {
    if (process.platform === 'win32' && child.pid !== undefined) { spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], { windowsHide: true, stdio: 'ignore' }).on('error', () => child.kill()); return; }
    child.kill('SIGTERM'); killer = setTimeout(() => child.kill('SIGKILL'), 10_000); killer.unref?.();
  };
  signal.addEventListener('abort', stop, { once: true });
  child.once('error', error => { signal.removeEventListener('abort', stop); if (killer) clearTimeout(killer);
    reject((error as NodeJS.ErrnoException).code === 'ENOENT' ? new MayuraError('NOT_FOUND', `${step.tool} was not found on PATH.`) : new MayuraError('TOOL_FAILED', `${step.tool} could not be started.`)); });
  child.once('close', code => { signal.removeEventListener('abort', stop); if (killer) clearTimeout(killer); resolvePromise({ exitCode: code ?? 1 }); });
  if (step.stdin !== undefined) { child.stdin!.on('error', () => undefined); child.stdin!.end(step.stdin, 'utf8'); }
});

/**
 * Runs a genuine plan from this process, step by step, after confirmation with its digest: every run is
 * outward-facing, so there is no unconfirmed mode. Stops at the first failure; cancelling stops the running step and
 * skips the rest.
 */
export async function runDeployPlan(plan: DeployPlan, options: { readonly confirmation: string; readonly runner?: DeployRunner; readonly signal?: AbortSignal;
  readonly onStep?: (event: { readonly id: string; readonly description: string; readonly status: 'started' | DeployStepResult['status'] }) => void }): Promise<DeployResult> {
  const tools = runPlans.get(plan); if (!tools) throw new MayuraError('INVALID_CONFIG', 'Use a genuine deploy plan from this process.');
  if (options?.confirmation !== plan.digest) throw new MayuraError('PERMISSION_DENIED', 'Running a deployment requires the displayed plan digest.');
  runPlans.delete(plan);
  const runner = options.runner ?? spawnDeployStep; const signal = options.signal ?? new AbortController().signal;
  const results: DeployStepResult[] = []; let status: DeployResult['status'] = 'succeeded';
  for (const step of plan.steps) {
    if (status !== 'succeeded') { results.push({ id: step.id, status: 'skipped' }); options.onStep?.({ id: step.id, description: step.description, status: 'skipped' }); continue; }
    if (signal.aborted) { status = 'cancelled'; results.push({ id: step.id, status: 'cancelled' }); options.onStep?.({ id: step.id, description: step.description, status: 'cancelled' }); continue; }
    if (!tools.includes(step.tool)) throw new MayuraError('INTEGRITY_VIOLATION', 'A deploy step names a tool outside its target.');
    options.onStep?.({ id: step.id, description: step.description, status: 'started' });
    const { exitCode } = await runner(step, { directory: plan.directory, signal });
    const outcome = signal.aborted ? 'cancelled' : exitCode === 0 ? 'succeeded' : 'failed';
    results.push({ id: step.id, status: outcome, exitCode }); options.onStep?.({ id: step.id, description: step.description, status: outcome });
    if (outcome !== 'succeeded') status = outcome;
  }
  return Object.freeze({ status, target: plan.target, release: plan.release, steps: Object.freeze(results) });
}

/** The ESM entry of an installed package, found the way Node finds it: `node_modules` here and in each parent. */
async function installedEntry(directory: string, name: string): Promise<string | undefined> {
  for (let current = directory; ; current = resolve(current, '..')) {
    const root = join(current, 'node_modules', ...name.split('/')); const manifestPath = join(root, 'package.json');
    let manifestText: string | undefined;
    try { manifestText = await readFile(manifestPath, 'utf8'); } catch { manifestText = undefined; }
    if (manifestText !== undefined) {
      const manifest = json(manifestText, `${name}/package.json`); const exported = manifest['exports'];
      const main = exported && typeof exported === 'object' && !Array.isArray(exported) ? (exported as JsonObject)['.'] : undefined;
      const target = typeof main === 'string' ? main : main && typeof main === 'object' && !Array.isArray(main) ? (main as JsonObject)['import'] ?? (main as JsonObject)['default'] : undefined;
      if (typeof target !== 'string' || !target.startsWith('./') || target.includes('..')) throw new MayuraError('INVALID_CONFIG', `${name} has no ESM entry point.`);
      return join(root, target);
    }
    if (resolve(current, '..') === current) return undefined;
  }
}

/**
 * The target named `id`: a built-in one, or the `@mayurajs/deploy-<id>` package installed in the project (its default
 * export). Packages are loaded from the project's own dependencies, never fetched.
 */
export async function resolveDeployTarget(id: string, directory: string, builtIn: Readonly<Record<string, DeployTarget>>): Promise<DeployTarget> {
  if (typeof id !== 'string' || !targetId.test(id)) throw new MayuraError('INVALID_CONFIG', 'A deploy target is a lowercase name, such as kubernetes or fly.');
  if (Object.hasOwn(builtIn, id)) return builtIn[id]!;
  const name = `@mayurajs/deploy-${id}`; const entry = await installedEntry(await directoryOf(directory), name);
  if (entry === undefined) throw new MayuraError('NOT_FOUND', `Deploy target ${id} is not built in; install ${name} in the project.`);
  const loaded = await import(pathToFileURL(entry).href) as { readonly default?: unknown };
  const target = defineDeployTarget(loaded.default as DeployTarget);
  if (target.id !== id) throw new MayuraError('INVALID_CONFIG', `${name} exports the deploy target ${target.id}, not ${id}.`);
  return target;
}

/** The targets a project can use, without loading any package: the built-in ones and each installed `@mayurajs/deploy-*`. */
export async function listDeployTargets(directory: string, builtIn: Readonly<Record<string, DeployTarget>>): Promise<readonly { readonly id: string; readonly source: string; readonly description?: string }[]> {
  const found = new Map<string, { readonly id: string; readonly source: string; readonly description?: string }>();
  for (const target of Object.values(builtIn)) found.set(target.id, { id: target.id, source: 'built in', description: target.description });
  for (let current = await directoryOf(directory); ; current = resolve(current, '..')) {
    let names: string[] = [];
    try { names = await readdir(join(current, 'node_modules', '@mayurajs')); } catch { names = []; }
    for (const name of names.sort()) {
      const id = name.startsWith('deploy-') ? name.slice('deploy-'.length) : '';
      if (targetId.test(id) && !found.has(id)) found.set(id, { id, source: `@mayurajs/${name}` });
    }
    if (resolve(current, '..') === current) break;
  }
  return Object.freeze([...found.values()]);
}
