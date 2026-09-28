// How the local adapter starts its worker process. Internal: not part of the package's exports.
import { existsSync, realpathSync } from 'node:fs';
import { dirname, join, parse as parsePath, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const adjacentWorker = fileURLToPath(new URL('./worker.js', import.meta.url));
export const workerPath = existsSync(adjacentWorker) ? adjacentWorker : fileURLToPath(new URL('../dist/worker.js', import.meta.url));
const MIB = 1_024 * 1_024;
const permissionFlag = process.allowedNodeEnvironmentFlags.has('--permission') ? '--permission' : '--experimental-permission';

/** Outermost `node_modules` directory above a path, or undefined when the path is not inside one. */
function outermostNodeModules(path: string): string | undefined {
  const root = parsePath(path).root;
  const parts = path.slice(root.length).split(sep);
  const index = parts.indexOf('node_modules');
  return index < 0 ? undefined : root + parts.slice(0, index + 1).join(sep);
}

/** Nearest directory at or above `start` that holds a package.json. */
function packageRoot(start: string): string {
  for (let directory = start; ; directory = dirname(directory)) {
    if (existsSync(join(directory, 'package.json')) || dirname(directory) === directory) return directory;
  }
}

let readRoots: readonly string[] | null | undefined;
/**
 * The only paths the worker process may read: the worker's own package and the installed packages it imports.
 * `null` means the QuickJS packages cannot be resolved, so the adapter reports itself unavailable.
 */
export function workerReadRoots(): readonly string[] | null {
  if (readRoots !== undefined) return readRoots;
  try {
    const worker = realpathSync(workerPath);
    const roots = new Set<string>([packageRoot(dirname(worker))]);
    const outer = outermostNodeModules(worker); if (outer) roots.add(outer);
    for (const specifier of ['quickjs-emscripten-core', '@jitl/quickjs-wasmfile-release-sync']) {
      const resolved = realpathSync(fileURLToPath(import.meta.resolve(specifier)));
      roots.add(outermostNodeModules(resolved) ?? packageRoot(dirname(resolved)));
    }
    readRoots = Object.freeze([...roots]);
  } catch { readRoots = null; }
  return readRoots;
}

export interface WorkerCommand {
  readonly command: string;
  readonly args: readonly string[];
  readonly options: { readonly cwd: string; readonly env: Readonly<Record<string, string>>; readonly windowsHide: true };
}

/**
 * The worker runs under the Node.js permission model: it may read only the roots above, and cannot write files,
 * start processes or worker threads, load native addons, use WASI or open the inspector. Code generation from
 * strings is disabled, the environment is empty, and its own JavaScript heap is bounded by the data it must hold.
 * The QuickJS heap is WebAssembly memory, bounded separately inside the worker.
 */
export function workerCommand(limits: { readonly maxInputBytes: number; readonly maxOutputBytes: number; readonly maxToolInputBytes: number }): WorkerCommand | undefined {
  const roots = workerReadRoots();
  if (!roots) return undefined;
  const heapMiB = 128 + Math.ceil((8 * (limits.maxInputBytes + limits.maxOutputBytes + limits.maxToolInputBytes)) / MIB);
  return Object.freeze({
    command: process.execPath,
    args: Object.freeze([permissionFlag, ...roots.map(root => `--allow-fs-read=${root}`), '--disallow-code-generation-from-strings',
      `--max-old-space-size=${heapMiB}`, workerPath]),
    options: Object.freeze({ cwd: dirname(workerPath), env: Object.freeze({}), windowsHide: true as const }),
  });
}
