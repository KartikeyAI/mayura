import { readFileSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, readdir, readFile, realpath, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { basename, isAbsolute, parse, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MayuraError, freezeJson, jsonValue, type JsonObject } from '@mayura/core';

export { approveWorkflow, cancelRun, cancelWorkflow, inspectHumanRequest, inspectHumanRequests, inspectRun, inspectServerHealth, inspectServerTools, inspectWorkflow, inspectWorkflows,
  holdWorkflowFleet, inspectWorkflowFleet, pauseWorkflow, releaseWorkflowFleet, respondHumanRequest, resumeWorkflow, signalWorkflow, sweepWorkflowFleet, waitForRun,
  type OperationalFleetHold, type OperationalFleetSweep, type OperationalFleetSweepOutcome,
  type OperationalClientOptions, type OperationalHealth, type OperationalHealthCheck, type OperationalHumanRequest,
  type OperationalHumanRequestPage, type OperationalRun, type OperationalRunReceipt, type OperationalTool, type OperationalToolPage,
  type OperationalWorkflow, type OperationalWorkflowFormat, type OperationalWorkflowNode, type OperationalWorkflowNodeKind,
  type OperationalWorkflowIndexEntry, type OperationalWorkflowIndexPage, type OperationalWorkflowStatus,
  type OperationalWorkflowStep, type OperationalWorkflowStepStatus } from './operations.js';

export const TEMPLATE_NAMES = Object.freeze([
  'typed-tool-runner', 'basic-agent', 'durable-approval', 'parallel-research',
  'native-memory', 'guarded-streaming-app', 'code-mode-workflow', 'capability-policy',
] as const);
export type TemplateName = typeof TEMPLATE_NAMES[number];

const descriptions: Readonly<Record<TemplateName, string>> = Object.freeze({
  'typed-tool-runner': 'Typed tool execution through the normal agent admission path.',
  'basic-agent': 'Credential-free structured agent with a deterministic model fixture.',
  'durable-approval': 'SQLite-backed workflow with exact human approval and restart.',
  'parallel-research': 'Two required child agents dispatched and joined in parallel.',
  'native-memory': 'Scoped native memory with provenance, correction and deletion.',
  'guarded-streaming-app': 'Authenticated local server, guarded output and browser client.',
  'code-mode-workflow': 'Approval-required durable Code Mode workflow using QuickJS.',
  'capability-policy': 'Explicit capability grant and denial behavior.',
});

const dependencies: Readonly<Record<TemplateName, readonly string[]>> = Object.freeze({
  'typed-tool-runner': ['@mayura/sdk', '@mayura/testing', 'zod'],
  'basic-agent': ['@mayura/sdk', '@mayura/testing', 'zod'],
  'durable-approval': ['@mayura/storage-sqlite', '@mayura/tools', '@mayura/workflows', 'zod'],
  'parallel-research': ['@mayura/sdk', '@mayura/testing', 'zod'],
  'native-memory': ['@mayura/memory', '@mayura/storage-sqlite'],
  'guarded-streaming-app': ['@mayura/client', '@mayura/sdk', '@mayura/server-node', '@mayura/testing'],
  'code-mode-workflow': ['@mayura/adapter-code-quickjs', '@mayura/code-mode', '@mayura/code-mode-workflows', '@mayura/core', '@mayura/storage-sqlite', '@mayura/tools', '@mayura/workflows'],
  'capability-policy': ['@mayura/sdk', '@mayura/testing', 'zod'],
});

/** Complete multi-file projects: offline by default, one environment switch to a real provider or PostgreSQL. */
export const STARTER_NAMES = Object.freeze(['approval-workflow', 'support-agent', 'research-team', 'event-automation'] as const);
export type StarterName = typeof STARTER_NAMES[number];

const starterDescriptions: Readonly<Record<StarterName, string>> = Object.freeze({
  'approval-workflow': 'Durable refund approvals: triage agent, human approval, separate server and worker, operator console and a reviewed v1 to v2 migration.',
  'support-agent': 'Customer support chat: a streaming agent with order tools scoped to the signed-in customer, per-customer native memory, PII redaction, a React chat UI and the operator console.',
  'research-team': 'Multi-agent research: a planner, parallel researchers over a source library and a writer as one durable workflow under a shared budget, with cited reports stored as content-addressed artifacts and optional OpenTelemetry traces.',
  'event-automation': 'Signed webhooks start durable workflows in which a triage agent acts through MCP tools under explicit capability grants; forged, stale and replayed deliveries are refused.',
});

const id = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/u;
const digest = (value: string): string => createHash('sha256').update(value, 'utf8').digest('hex');
const inside = (parent: string, child: string): boolean => { const path = relative(parent, child); return path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path); };
const templateRoot = fileURLToPath(new URL('../templates/', import.meta.url));
const starterRoot = fileURLToPath(new URL('../starters/', import.meta.url));
// Bounds for one starter: text files only, so a plan can always show what it writes.
const starterLimits = Object.freeze({ files: 256, fileBytes: 262_144, totalBytes: 4_194_304 });
// Build output, installs and local state never leave the repository copy of a starter.
const starterSkipped = new Set(['node_modules', 'dist', '.data', 'coverage']);

export interface ProjectToolRecord {
  readonly id: string; readonly version: string; readonly effects: 'none' | 'read' | 'write' | 'host'; readonly capabilities: readonly string[];
}
export interface ProjectDefinitionRecord {
  readonly kind: 'agent' | 'workflow'; readonly id: string; readonly version: string; readonly source: string;
}
export interface MayuraProject {
  /** The template or starter the project was created from. */
  readonly format: 'mayura.project.v1'; readonly name: string; readonly template: TemplateName | StarterName;
  readonly definitions: readonly ProjectDefinitionRecord[]; readonly tools: readonly ProjectToolRecord[];
}
export interface InitChange {
  readonly path: string; readonly operation: 'create' | 'replace' | 'unchanged';
  readonly beforeDigest?: string; readonly afterDigest: string; readonly diff?: string;
}
export interface InitPlan {
  readonly format: 'mayura.init-plan.v1'; readonly template: TemplateName; readonly directory: string;
  readonly digest: string; readonly changes: readonly InitChange[];
}
export interface StarterInitPlan {
  readonly format: 'mayura.init-plan.v1'; readonly starter: StarterName; readonly directory: string;
  readonly digest: string; readonly changes: readonly InitChange[];
}

interface PlanState { readonly files: ReadonlyMap<string, string>; readonly before: ReadonlyMap<string, string | undefined> }
const plans = new WeakMap<InitPlan | StarterInitPlan, PlanState>();

function projectName(directory: string): string {
  const name = directory.replaceAll('\\', '/').split('/').filter(Boolean).at(-1)?.toLowerCase().replace(/[^a-z0-9-]+/g, '-') ?? '';
  return /^[a-z0-9][a-z0-9-]{0,63}$/u.test(name) ? name : 'mayura-agent';
}

/** This CLI's own version: generated projects pin every Mayura package to exactly it. */
const cliVersion = (): string => (JSON.parse(readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8')) as { version: string }).version;

function packageManifest(name: string, template: TemplateName): string {
  const versions: Record<string, string> = {}; const mayura = cliVersion();
  for (const dependency of dependencies[template]) versions[dependency] = dependency === 'zod' ? '4.6.5' : mayura;
  return `${JSON.stringify({ name, version: '0.1.0', private: true, type: 'module', scripts: {
    build: 'tsc -p tsconfig.json', typecheck: 'tsc -p tsconfig.json --noEmit', start: 'node dist/index.js', test: 'node --test',
  }, dependencies: versions, devDependencies: { typescript: '7.0.2', '@types/node': '24.13.6' } }, null, 2)}\n`;
}

function projectManifest(name: string, template: TemplateName): string {
  const kind = ['durable-approval', 'code-mode-workflow'].includes(template) ? 'workflow' : 'agent';
  const value: MayuraProject = { format: 'mayura.project.v1', name, template, definitions: [{ kind: kind as 'agent' | 'workflow',
    id: `starter.${template}`, version: '1.0.0', source: 'src/index.ts' }], tools: [] };
  return `${JSON.stringify(value, null, 2)}\n`;
}

function diff(path: string, before: string, after: string): string {
  const oldLines = before.slice(0, 32_768).split(/\r?\n/u).slice(0, 200); const newLines = after.slice(0, 32_768).split(/\r?\n/u).slice(0, 200);
  return [`--- ${path}`, `+++ ${path}`, ...oldLines.map(line => `-${line}`), ...newLines.map(line => `+${line}`)].join('\n');
}

/**
 * The target with its nearest existing ancestor resolved to its real path. Links above the project (for example the
 * macOS system links /var and /tmp) resolve here, so the plan names the directory that will actually be written; a
 * target that is itself a link, or an existing non-directory, is refused.
 */
async function canonicalTarget(path: string): Promise<string> {
  const missing: string[] = []; let candidate = path;
  while (true) {
    let details;
    try { details = await lstat(candidate); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      const parent = resolve(candidate, '..');
      if (parent === candidate) throw new MayuraError('CONFLICT', 'Initializer could not establish a safe target ancestry.');
      missing.unshift(basename(candidate)); candidate = parent; continue;
    }
    if (candidate === path && details.isSymbolicLink()) throw new MayuraError('CONFLICT', 'Initializer target cannot be a link.');
    const real = await realpath(candidate);
    if (!(await stat(real)).isDirectory()) throw new MayuraError('CONFLICT', 'Initializer target cannot traverse a link or non-directory path.');
    return resolve(real, ...missing);
  }
}

async function assertSafeDirectory(path: string): Promise<void> {
  let candidate = path;
  while (true) {
    try {
      const details = await lstat(candidate);
      if (!details.isDirectory() || details.isSymbolicLink() || resolve(await realpath(candidate)) !== resolve(candidate)) {
        throw new MayuraError('CONFLICT', 'Initializer target cannot traverse a link or non-directory path.');
      }
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      const parent = resolve(candidate, '..');
      if (parent === candidate) throw new MayuraError('CONFLICT', 'Initializer could not establish a safe target ancestry.');
      candidate = parent;
    }
  }
}

async function existingFile(path: string): Promise<string | undefined> {
  try {
    const details = await lstat(path);
    if (!details.isFile() || details.isSymbolicLink() || details.size > 1_048_576) throw new MayuraError('CONFLICT', 'Initializer target contains an unsupported file type or size.');
    return await readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

/** Produces a complete, content-bound write plan without mutating the target. */
export async function planProject(template: TemplateName, directory: string): Promise<InitPlan> {
  if (!TEMPLATE_NAMES.includes(template) || !isAbsolute(directory) || resolve(directory) === parse(resolve(directory)).root) {
    throw new MayuraError('INVALID_CONFIG', 'Initializer requires a known template and a non-root absolute directory.');
  }
  const target = await canonicalTarget(resolve(directory)); const name = projectName(target);
  await assertSafeDirectory(target);
  const source = await readFile(resolve(templateRoot, `${template}.ts`), 'utf8');
  const readme = `# ${name}\n\n${descriptions[template]}\n\nRun \`npm install\`, \`npm run build\`, then \`npm start\`. Review all capabilities and external prerequisites in \`src/index.ts\` before use.\n`;
  const files = new Map<string, string>([
    ['package.json', packageManifest(name, template)], ['tsconfig.json', `${JSON.stringify({ compilerOptions: {
      target: 'ES2023', module: 'NodeNext', moduleResolution: 'NodeNext', lib: ['ES2023', 'DOM', 'DOM.Iterable'], strict: true,
      noUncheckedIndexedAccess: true, exactOptionalPropertyTypes: true, noUnusedLocals: true, noUnusedParameters: true,
      verbatimModuleSyntax: true, skipLibCheck: false, outDir: 'dist', rootDir: 'src', types: ['node'],
    }, include: ['src/**/*.ts'] }, null, 2)}\n`],
    ['mayura.project.json', projectManifest(name, template)], ['README.md', readme], ['src/index.ts', source],
  ]);
  const { changes, before } = await planChanges(target, files);
  const planDigest = digest(JSON.stringify({ template, directory: target, changes }));
  const plan = Object.freeze({ format: 'mayura.init-plan.v1' as const, template, directory: target, digest: planDigest, changes: Object.freeze(changes) });
  plans.set(plan, { files, before }); return plan;
}

/** Existing directories between the target and a planned file must be real directories, never links. */
async function assertPlainParents(target: string, relativePath: string): Promise<void> {
  const segments = relativePath.split('/').slice(0, -1);
  for (let index = 1; index <= segments.length; index++) {
    const path = resolve(target, ...segments.slice(0, index));
    let details; try { details = await lstat(path); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
    if (!details.isDirectory() || details.isSymbolicLink()) throw new MayuraError('CONFLICT', 'Initializer target directories cannot be links.');
  }
}

async function planChanges(target: string, files: ReadonlyMap<string, string>): Promise<{ changes: InitChange[]; before: Map<string, string | undefined> }> {
  const before = new Map<string, string | undefined>(); const changes: InitChange[] = [];
  for (const [relativePath, content] of files) {
    await assertPlainParents(target, relativePath);
    const prior = await existingFile(resolve(target, relativePath)); before.set(relativePath, prior);
    const operation = prior === undefined ? 'create' : prior === content ? 'unchanged' : 'replace';
    changes.push(Object.freeze({ path: relativePath, operation, ...(prior === undefined ? {} : { beforeDigest: digest(prior) }),
      afterDigest: digest(content), ...(operation === 'replace' ? { diff: diff(relativePath, prior!, content) } : {}) }));
  }
  return { changes, before };
}

// Starter files that npm would drop or rename when packing (.gitignore, .github) are stored with a `dot-` prefix.
const starterPath = (segments: readonly string[]): string => segments.map(segment => segment.startsWith('dot-') ? `.${segment.slice(4)}` : segment).join('/');

async function collectStarter(name: StarterName): Promise<Map<string, string>> {
  const root = resolve(starterRoot, name); const files = new Map<string, string>(); let total = 0;
  const walk = async (segments: readonly string[]): Promise<void> => {
    const entries = await readdir(resolve(root, ...segments), { withFileTypes: true });
    for (const entry of entries.sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0)) {
      if (starterSkipped.has(entry.name) || entry.name.startsWith('.') || entry.name.endsWith('.tsbuildinfo')) continue;
      if (!/^[A-Za-z0-9_][A-Za-z0-9._-]{0,99}$/u.test(entry.name)) throw new MayuraError('INTEGRITY_VIOLATION', 'Starter contains an unsupported file name.');
      const next = [...segments, entry.name];
      if (entry.isDirectory()) { await walk(next); continue; }
      const path = resolve(root, ...next); const details = await lstat(path);
      if (!details.isFile() || details.isSymbolicLink() || details.size > starterLimits.fileBytes) throw new MayuraError('INTEGRITY_VIOLATION', 'Starter contains an unsupported file type or size.');
      total += details.size;
      if (files.size >= starterLimits.files || total > starterLimits.totalBytes) throw new MayuraError('INTEGRITY_VIOLATION', 'Starter exceeds its file bounds.');
      let content: string;
      try { content = new TextDecoder('utf-8', { fatal: true }).decode(await readFile(path)); } catch { throw new MayuraError('INTEGRITY_VIOLATION', 'Starter files must be UTF-8 text.'); }
      files.set(starterPath(next), content);
    }
  };
  await walk([]); return files;
}

/** The repository copy links Mayura packages with `workspace:*`; a generated project pins this CLI's exact release. */
async function starterManifest(content: string, name: string): Promise<string> {
  const { version } = JSON.parse(await readFile(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8')) as { version: string };
  const manifest = JSON.parse(content) as Record<string, unknown>; manifest['name'] = name;
  for (const field of ['dependencies', 'devDependencies']) {
    const entries = manifest[field] as Record<string, string> | undefined;
    for (const [dependency, range] of Object.entries(entries ?? {})) {
      if (range === 'workspace:*' && dependency.startsWith('@mayura/')) entries![dependency] = version;
      else if (range.startsWith('workspace:')) throw new MayuraError('INTEGRITY_VIOLATION', 'Starter manifests may link only Mayura packages to the workspace.');
    }
  }
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

/** Produces a complete, content-bound write plan for a multi-file starter without mutating the target. */
export async function planStarter(starter: StarterName, directory: string): Promise<StarterInitPlan> {
  if (!STARTER_NAMES.includes(starter) || !isAbsolute(directory) || resolve(directory) === parse(resolve(directory)).root) {
    throw new MayuraError('INVALID_CONFIG', 'Initializer requires a known starter and a non-root absolute directory.');
  }
  const target = await canonicalTarget(resolve(directory)); const name = projectName(target);
  await assertSafeDirectory(target);
  const files = await collectStarter(starter);
  const manifest = files.get('package.json'); const project = files.get('mayura.project.json');
  if (manifest === undefined || project === undefined) throw new MayuraError('INTEGRITY_VIOLATION', 'Starter is missing its package or project manifest.');
  files.set('package.json', await starterManifest(manifest, name));
  const catalog = validateProject(JSON.parse(project)); if (catalog.template !== starter) throw new MayuraError('INTEGRITY_VIOLATION', 'Starter project manifest names another starter.');
  files.set('mayura.project.json', `${JSON.stringify({ ...catalog, name }, null, 2)}\n`);
  const { changes, before } = await planChanges(target, files);
  const planDigest = digest(JSON.stringify({ starter, directory: target, changes }));
  const plan = Object.freeze({ format: 'mayura.init-plan.v1' as const, starter, directory: target, digest: planDigest, changes: Object.freeze(changes) });
  plans.set(plan, { files, before }); return plan;
}

export interface ApplyInitOptions { readonly confirmation?: string }

/** Applies one genuine fresh plan. Replacements require its displayed digest as confirmation. */
export async function applyProjectPlan(plan: InitPlan | StarterInitPlan, options: ApplyInitOptions = {}): Promise<void> {
  const state = plans.get(plan); if (!state) throw new MayuraError('INVALID_CONFIG', 'Use a genuine initialization plan from this process.');
  plans.delete(plan);
  const replacements = plan.changes.filter(change => change.operation === 'replace');
  if (replacements.length > 0 && options.confirmation !== plan.digest) {
    throw new MayuraError('PERMISSION_DENIED', 'Replacing initialized files requires the displayed plan digest.');
  }
  await mkdir(plan.directory, { recursive: true }); const canonical = await realpath(plan.directory);
  if (canonical !== plan.directory && resolve(canonical) !== resolve(plan.directory)) throw new MayuraError('CONFLICT', 'Initializer target resolves through an unexpected path.');
  const root = await lstat(canonical); if (!root.isDirectory() || root.isSymbolicLink()) throw new MayuraError('CONFLICT', 'Initializer target directories cannot be links.');
  // Create each parent directory one level at a time, parents first, refusing any that is (or became) a link.
  const parents = new Set<string>();
  for (const change of plan.changes) { const segments = change.path.split('/'); for (let index = 1; index < segments.length; index++) parents.add(segments.slice(0, index).join('/')); }
  for (const parent of [...parents].sort((left, right) => left.split('/').length - right.split('/').length)) {
    const path = resolve(canonical, parent); if (!inside(canonical, path)) throw new MayuraError('INTEGRITY_VIOLATION', 'Initializer path escaped its target.');
    await mkdir(path).catch((error: NodeJS.ErrnoException) => { if (error.code !== 'EEXIST') throw error; });
    const details = await lstat(path); if (!details.isDirectory() || details.isSymbolicLink()) throw new MayuraError('CONFLICT', 'Initializer target directories cannot be links.');
  }
  // Complete the stale-plan check before the first write.
  for (const change of plan.changes) {
    const path = resolve(canonical, change.path); if (!inside(canonical, path)) throw new MayuraError('INTEGRITY_VIOLATION', 'Initializer path escaped its target.');
    const current = await existingFile(path); const expected = state.before.get(change.path);
    if (current !== expected) throw new MayuraError('CONFLICT', 'Initializer target changed after planning. Generate a new visible plan.');
  }
  const backups: Array<Readonly<{ path: string; backup?: string }>> = []; const temporary: string[] = [];
  try {
    for (const change of plan.changes) {
      if (change.operation === 'unchanged') continue;
      const path = resolve(canonical, change.path); const content = state.files.get(change.path)!;
      const stage = `${path}.mayura-stage-${randomUUID()}`; temporary.push(stage);
      await writeFile(stage, content, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
      if (change.operation === 'replace') {
        const backup = `${path}.mayura-backup-${randomUUID()}`; await rename(path, backup); backups.push({ path, backup });
      } else backups.push({ path });
      await rename(stage, path); temporary.splice(temporary.indexOf(stage), 1);
    }
  } catch (error) {
    for (const entry of backups.reverse()) {
      await unlink(entry.path).catch(() => undefined);
      if (entry.backup !== undefined) await rename(entry.backup, entry.path).catch(() => undefined);
    }
    for (const path of temporary) await unlink(path).catch(() => undefined);
    throw error;
  }
  for (const entry of backups) if (entry.backup !== undefined) await unlink(entry.backup);
}

function record(value: unknown): JsonObject {
  const snapshot = freezeJson(jsonValue(value, { maxBytes: 262_144, maxDepth: 16, maxNodes: 10_000 }));
  if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) throw new MayuraError('INVALID_CONFIG', 'Project configuration must be a bounded JSON object.');
  return snapshot;
}

/** Validates the non-executable project catalog used by inspect and future admin commands. */
export function validateProject(value: unknown): MayuraProject {
  const root = record(value); const keys = Object.keys(root).sort();
  if (JSON.stringify(keys) !== JSON.stringify(['definitions', 'format', 'name', 'template', 'tools']) || root['format'] !== 'mayura.project.v1'
    || typeof root['name'] !== 'string' || !/^[a-z0-9][a-z0-9-]{0,63}$/u.test(root['name'])
    || typeof root['template'] !== 'string' || !(TEMPLATE_NAMES.includes(root['template'] as TemplateName) || STARTER_NAMES.includes(root['template'] as StarterName))
    || !Array.isArray(root['definitions']) || root['definitions'].length > 256 || !Array.isArray(root['tools']) || root['tools'].length > 1_024) {
    throw new MayuraError('INVALID_CONFIG', 'Project configuration shape is invalid.');
  }
  const identities = new Set<string>();
  const definitions = root['definitions'].map(raw => {
    const item = record(raw); if (Object.keys(item).sort().join(',') !== 'id,kind,source,version' || !['agent', 'workflow'].includes(String(item['kind']))
      || typeof item['id'] !== 'string' || !id.test(item['id']) || typeof item['version'] !== 'string' || !id.test(item['version'])
      || typeof item['source'] !== 'string' || !/^src\/[A-Za-z0-9_./-]+\.ts$/u.test(item['source']) || item['source'].includes('..')) {
      throw new MayuraError('INVALID_CONFIG', 'Project definition record is invalid.');
    }
    const key = `${item['kind']}:${item['id']}:${item['version']}`; if (identities.has(key)) throw new MayuraError('CONFLICT', 'Project definition identity is duplicated.');
    identities.add(key); return item as unknown as ProjectDefinitionRecord;
  });
  const tools = root['tools'].map(raw => {
    const item = record(raw); if (Object.keys(item).sort().join(',') !== 'capabilities,effects,id,version' || typeof item['id'] !== 'string' || !id.test(item['id'])
      || typeof item['version'] !== 'string' || !id.test(item['version']) || !['none', 'read', 'write', 'host'].includes(String(item['effects']))
      || !Array.isArray(item['capabilities']) || item['capabilities'].length > 256
      || item['capabilities'].some(capability => typeof capability !== 'string' || !id.test(capability))) {
      throw new MayuraError('INVALID_CONFIG', 'Project tool record is invalid.');
    }
    return item as unknown as ProjectToolRecord;
  });
  return Object.freeze({ format: 'mayura.project.v1', name: root['name'] as string, template: root['template'] as TemplateName | StarterName,
    definitions: Object.freeze(definitions), tools: Object.freeze(tools) });
}

export async function readProject(path: string): Promise<MayuraProject> {
  if (!isAbsolute(path)) throw new MayuraError('INVALID_CONFIG', 'Project configuration path must be absolute.');
  let parsed: unknown; try {
    const details = await lstat(path);
    if (!details.isFile() || details.isSymbolicLink() || details.size > 262_144) throw new Error();
    parsed = JSON.parse(await readFile(path, 'utf8'));
  }
  catch { throw new MayuraError('INVALID_CONFIG', 'Project configuration is not readable bounded JSON.'); }
  return validateProject(parsed);
}

export function templates(): readonly Readonly<{ name: TemplateName; description: string; dependencies: readonly string[] }>[] {
  return Object.freeze(TEMPLATE_NAMES.map(name => Object.freeze({ name, description: descriptions[name], dependencies: dependencies[name] })));
}
export function starters(): readonly Readonly<{ name: StarterName; description: string }>[] {
  return Object.freeze(STARTER_NAMES.map(name => Object.freeze({ name, description: starterDescriptions[name] })));
}
export { defineMayuraApplication, loadApplication, migrateApplication, runWorkerApplication, serveApplication, type MayuraApplication, type MayuraLifecycleEvent,
  type MayuraServerHandle, type MayuraWorkerHandle } from './application.js';
