import { lstat, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { isAbsolute, parse, resolve, dirname } from 'node:path';
import { MayuraError } from '@mayura/core';
import { assertSafeDirectory, canonicalTarget, digest, planChanges, writePlannedFiles, type FileChange } from './files.js';

export interface UiComponent { readonly id: string; readonly version: string; readonly minimumMayura: string; readonly maximumMajor: number; readonly files: readonly string[]; readonly dependencies: readonly string[] }
export interface UiPlan { readonly format: 'mayura.ui-plan.v1'; readonly directory: string; readonly components: readonly string[]; readonly registryVersion: string; readonly mayuraVersion: string; readonly digest: string; readonly changes: readonly FileChange[] }
const root = fileURLToPath(new URL('../ui/', import.meta.url));
const states = new WeakMap<UiPlan, { files: Map<string,string>; before: Map<string,string | undefined> }>();
/** Bundled versioned source, never downloaded or executed as a registry installation hook. */
export async function uiComponents(): Promise<readonly UiComponent[]> {
  const data = JSON.parse(await readFile(resolve(root, 'registry.json'), 'utf8')) as { components: UiComponent[] };
  return Object.freeze(data.components.map(item => Object.freeze({ ...item, files: Object.freeze(item.files), dependencies: Object.freeze(item.dependencies) })));
}
async function installedVersion(directory: string): Promise<string> {
  for (let current = directory;; current = dirname(current)) {
    try { const data = JSON.parse(await readFile(resolve(current,'node_modules/mayura/package.json'),'utf8')); if (typeof data.version !== 'string') break; return data.version; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') break; }
    if (dirname(current) === current) break;
  }
  throw new MayuraError('INVALID_CONFIG', 'Install Mayura in the target project before adding UI components.');
}
/** Plan bounded copy-in files, without installing dependencies, changing package.json or overwriting user code. */
export async function planUiComponents(names: readonly string[], directory: string): Promise<UiPlan> {
  if (!isAbsolute(directory) || resolve(directory) === parse(resolve(directory)).root || !names.length || names.length > 16 || new Set(names).size !== names.length) throw new MayuraError('INVALID_CONFIG','Choose known unique UI components and a project directory.');
  const target = await canonicalTarget(resolve(directory)); await assertSafeDirectory(target);
  const registry = await uiComponents(); const selected = names.map(name => registry.find(item => item.id === name));
  if (selected.some(item => !item)) throw new MayuraError('INVALID_INPUT','Unknown UI component; run mayura add ui --list.');
  const mayuraVersion = await installedVersion(target); const version = /^(\d+)\.(\d+)\.(\d+)(?:-[A-Za-z0-9.-]+)?(?:\+[A-Za-z0-9.-]+)?$/u.exec(mayuraVersion);
  if (!version || selected.some(item => { const minimum = item!.minimumMayura.split('.').map(Number); return Number(version[1]) !== item!.maximumMajor
    || Number(version[1]) < minimum[0]! || Number(version[2]) < minimum[1]! || (Number(version[2]) === minimum[1] && Number(version[3]) < minimum[2]!); })) throw new MayuraError('INVALID_CONFIG','These components require Mayura 1.2 or a compatible release candidate.');
  const files = new Map<string,string>(); let bytes = 0;
  for (const item of selected) for (const name of item!.files) {
    if (!/^[a-z][a-z0-9-]*\.(?:tsx|css)$/u.test(name)) throw new MayuraError('INTEGRITY_VIOLATION','Unsafe UI registry file.');
    const path = resolve(root,name); const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink() || info.size > 65536 || (bytes += info.size) > 1048576) throw new MayuraError('INTEGRITY_VIOLATION','UI registry exceeds its bounds.');
    files.set(`src/components/mayura/${name}`,new TextDecoder('utf-8',{ fatal:true }).decode(await readFile(path)));
  }
  const { changes, before } = await planChanges(target,files); const components = Object.freeze([...names]); const registryVersion = '1.0.0';
  const plan = Object.freeze({ format:'mayura.ui-plan.v1' as const, directory:target, components, registryVersion, mayuraVersion,
    digest:digest(JSON.stringify({ directory:target,components,registryVersion,mayuraVersion,changes })),changes:Object.freeze(changes) });
  states.set(plan,{ files,before }); return plan;
}
/** Apply a genuine fresh plan. Existing files require its exact displayed digest; stale plans and links are refused. */
export async function applyUiPlan(plan: UiPlan, options: { readonly confirmation?: string } = {}): Promise<void> {
  const state = states.get(plan); if (!state) throw new MayuraError('INVALID_CONFIG','Use a genuine UI plan from this process.');
  states.delete(plan);
  if (plan.changes.some(change => change.operation === 'replace') && options.confirmation !== plan.digest) throw new MayuraError('PERMISSION_DENIED','Replacing UI source requires the displayed plan digest.');
  if (await installedVersion(plan.directory) !== plan.mayuraVersion) throw new MayuraError('CONFLICT','Installed Mayura changed after planning.');
  await writePlannedFiles(plan,state.files,state.before);
}
