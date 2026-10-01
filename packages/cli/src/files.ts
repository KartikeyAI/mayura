import { randomUUID, createHash } from 'node:crypto';
import { lstat, mkdir, readFile, realpath, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { basename, isAbsolute, relative, resolve, sep } from 'node:path';
import { MayuraError } from '@mayura/core';

// Content-bound project file plans, shared by `mayura init` and `mayura deploy init`: plan without writing, then write
// exactly the plan, refusing links, stale targets and paths that escape the project.

export interface FileChange {
  readonly path: string; readonly operation: 'create' | 'replace' | 'unchanged';
  readonly beforeDigest?: string; readonly afterDigest: string; readonly diff?: string;
}

export const digest = (value: string): string => createHash('sha256').update(value, 'utf8').digest('hex');
export const inside = (parent: string, child: string): boolean => { const path = relative(parent, child); return path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path); };

function diff(path: string, before: string, after: string): string {
  const oldLines = before.slice(0, 32_768).split(/\r?\n/u).slice(0, 200); const newLines = after.slice(0, 32_768).split(/\r?\n/u).slice(0, 200);
  return [`--- ${path}`, `+++ ${path}`, ...oldLines.map(line => `-${line}`), ...newLines.map(line => `+${line}`)].join('\n');
}

/**
 * The target with its nearest existing ancestor resolved to its real path. Links above the project (for example the
 * macOS system links /var and /tmp) resolve here, so the plan names the directory that will actually be written; a
 * target that is itself a link, or an existing non-directory, is refused.
 */
export async function canonicalTarget(path: string): Promise<string> {
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

export async function assertSafeDirectory(path: string): Promise<void> {
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

/** Existing directories between the target and a planned file must be real directories, never links. */
async function assertPlainParents(target: string, relativePath: string): Promise<void> {
  const segments = relativePath.split('/').slice(0, -1);
  for (let index = 1; index <= segments.length; index++) {
    const path = resolve(target, ...segments.slice(0, index));
    let details; try { details = await lstat(path); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
    if (!details.isDirectory() || details.isSymbolicLink()) throw new MayuraError('CONFLICT', 'Initializer target directories cannot be links.');
  }
}

export async function planChanges(target: string, files: ReadonlyMap<string, string>): Promise<{ changes: FileChange[]; before: Map<string, string | undefined> }> {
  const before = new Map<string, string | undefined>(); const changes: FileChange[] = [];
  for (const [relativePath, content] of files) {
    await assertPlainParents(target, relativePath);
    const prior = await existingFile(resolve(target, relativePath)); before.set(relativePath, prior);
    const operation = prior === undefined ? 'create' : prior === content ? 'unchanged' : 'replace';
    changes.push(Object.freeze({ path: relativePath, operation, ...(prior === undefined ? {} : { beforeDigest: digest(prior) }),
      afterDigest: digest(content), ...(operation === 'replace' ? { diff: diff(relativePath, prior!, content) } : {}) }));
  }
  return { changes, before };
}

/** Writes a planned set of files, all or none: each is staged, then renamed into place; replaced files are restored on failure. */
export async function writePlannedFiles(plan: { readonly directory: string; readonly changes: readonly FileChange[] },
  files: ReadonlyMap<string, string>, before: ReadonlyMap<string, string | undefined>): Promise<void> {
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
    const current = await existingFile(path); const expected = before.get(change.path);
    if (current !== expected) throw new MayuraError('CONFLICT', 'Initializer target changed after planning. Generate a new visible plan.');
  }
  const backups: Array<Readonly<{ path: string; backup?: string }>> = []; const temporary: string[] = [];
  try {
    for (const change of plan.changes) {
      if (change.operation === 'unchanged') continue;
      const path = resolve(canonical, change.path); const content = files.get(change.path)!;
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
