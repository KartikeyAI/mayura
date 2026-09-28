// `mayura dev`: build the project, run it, and rebuild and restart when a source file changes. It loads `.env` for
// the child processes without printing any value; real environment variables win over the file.
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync, watch, type FSWatcher } from 'node:fs';
import { delimiter, join, relative, sep } from 'node:path';
import { parseEnv } from 'node:util';
import { MayuraError } from '@mayura/core';
import type { Paint } from './output.js';

export interface DevOptions {
  readonly directory: string;
  /** The CLI entry used to run `migrate`, `serve` and `worker` for an application without a dev entry. */
  readonly bin: string;
  readonly entry?: string; readonly app?: string; readonly watch: boolean;
  readonly signal: AbortSignal; readonly p: Paint; readonly print: (line: string) => void;
}

/** Paths that change because the project runs or builds, not because someone edited it. */
const ignored = /(^|[\\/])(node_modules|dist|\.data|\.git|\.mayura-local|coverage)([\\/]|$)|\.(sqlite(-shm|-wal)?|tsbuildinfo|log)$/u;

/** Modification time and size of every file a person might edit, to tell real edits from other file-system events. */
function snapshot(directory: string, limit = 50_000): Map<string, string> {
  const files = new Map<string, string>(); const pending = [''];
  while (pending.length > 0 && files.size < limit) {
    const folder = pending.pop()!;
    let entries: import('node:fs').Dirent[]; try { entries = readdirSync(join(directory, folder), { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      const path = folder ? join(folder, entry.name) : entry.name; if (ignored.test(path)) continue;
      if (entry.isDirectory()) pending.push(path); else if (entry.isFile()) files.set(path, stamp(join(directory, path)) ?? '');
    }
  }
  return files;
}
const stamp = (path: string): string | undefined => { try { const details = statSync(path); return `${details.mtimeMs}:${details.size}`; } catch { return undefined; } };

/** `.env` in the project, parsed; returns names only for display. Values are passed to children, never printed. */
export function dotEnv(directory: string): { readonly values: Record<string, string>; readonly names: readonly string[] } {
  const file = join(directory, '.env'); if (!existsSync(file)) return { values: {}, names: [] };
  let values: Record<string, string>;
  try { values = parseEnv(readFileSync(file, 'utf8')) as Record<string, string>; }
  catch { throw new MayuraError('INVALID_CONFIG', 'The project .env file could not be read.'); }
  return { values, names: Object.keys(values).sort() };
}

export async function runDev(options: DevOptions): Promise<{ readonly status: 'stopped' }> {
  const { directory, p, print, signal } = options;
  const manifestPath = join(directory, 'package.json');
  if (!existsSync(manifestPath)) throw new MayuraError('INVALID_CONFIG', 'Run mayura dev in a project directory (one with a package.json).');
  let manifest: { name?: unknown; scripts?: Record<string, unknown> };
  try { manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as typeof manifest; } catch { throw new MayuraError('INVALID_CONFIG', 'The project package.json is not valid JSON.'); }
  const script = manifest.scripts?.['build'];
  const buildCommand = typeof script === 'string' ? script : existsSync(join(directory, 'tsconfig.json')) ? 'tsc -p tsconfig.json' : undefined;
  // Read .env again for every build and start, so editing it takes effect on the next restart. Real environment
  // variables win over the file, as with `node --env-file`.
  let loaded = '';
  const environmentNow = (): NodeJS.ProcessEnv => {
    const file = dotEnv(directory); const names = file.names.join(', ');
    if (names !== loaded) { loaded = names; if (names) print(p.dim(`  loaded .env: ${names}`)); }
    const env: NodeJS.ProcessEnv = { ...file.values, ...process.env,
      PATH: [join(directory, 'node_modules', '.bin'), process.env['PATH'] ?? process.env['Path'] ?? ''].join(delimiter) };
    if (process.platform === 'win32') delete env['Path'];
    return env;
  };

  print(`${p.bold('mayura dev')} ${p.dim(typeof manifest.name === 'string' ? manifest.name : '')}`);

  const build = async (): Promise<boolean> => {
    if (!buildCommand) return true;
    const started = Date.now(); let output = '';
    const child = spawn(buildCommand, { cwd: directory, env: environmentNow(), shell: true, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.on('data', chunk => { output += String(chunk); }); child.stderr.on('data', chunk => { output += String(chunk); });
    const code = await new Promise<number | null>(resolve => { child.on('close', resolve); child.on('error', () => resolve(1)); });
    if (code === 0) { print(`${p.green('✔')} built ${p.dim(`in ${((Date.now() - started) / 1_000).toFixed(1)}s`)}`); return true; }
    print(`${p.red('✖ build failed')} ${p.dim(`(${buildCommand})`)}`); print(output.trimEnd().split(/\r?\n/u).slice(-40).join('\n'));
    return false;
  };

  let children: ChildProcess[] = []; let env: NodeJS.ProcessEnv = {};
  const launch = (args: readonly string[]): ChildProcess => spawn(process.execPath, args, { cwd: directory, env, stdio: 'inherit', windowsHide: true });
  const start = async (): Promise<void> => {
    env = environmentNow();
    const entry = options.entry ?? (existsSync(join(directory, 'dist', 'src', 'dev.js')) ? 'dist/src/dev.js' : undefined);
    if (entry) { print(p.green(`● running ${entry}`)); children = [launch([entry])]; return; }
    const app = options.app ?? 'dist/src/app.js';
    if (!existsSync(join(directory, app))) {
      // A template is one program: run dist/index.js after each build.
      if (options.app === undefined && existsSync(join(directory, 'dist', 'index.js'))) { print(p.green('● running dist/index.js')); children = [launch(['dist/index.js'])]; return; }
      print(p.red(`✖ Nothing to run: add dist/src/dev.js (or dist/index.js), or pass --app <module> or --entry <file>.`)); return;
    }
    // An application without a dev entry runs as in production: migrate once, then a server and a worker.
    const migrate = launch([options.bin, 'migrate', '--app', app]);
    const migrated = await new Promise<number | null>(resolve => migrate.on('close', resolve));
    if (migrated !== 0) { print(p.red('✖ migrate failed; fix it and save a file to try again.')); return; }
    print(p.green(`● running ${app}: server and worker`));
    children = [launch([options.bin, 'serve', '--app', app]), launch([options.bin, 'worker', '--app', app])];
  };
  /**
   * Stop the running children. For a restart, ask them to stop (gracefully where the platform can; Windows ends the
   * process). On Ctrl+C the terminal has already interrupted them, and a second interrupt would skip their drain, so
   * only wait. Either way a child that has not exited after ten seconds is killed.
   */
  const stop = async (interrupt: boolean): Promise<void> => {
    const running = children.filter(child => child.exitCode === null && child.signalCode === null); children = [];
    await Promise.all(running.map(child => new Promise<void>(resolve => {
      const timer = setTimeout(() => { child.kill('SIGKILL'); }, 10_000);
      child.once('close', () => { clearTimeout(timer); resolve(); });
      if (interrupt) child.kill(process.platform === 'win32' ? undefined : 'SIGINT');
    })));
  };

  if (await build()) await start();
  if (!options.watch) {
    await Promise.all(children.map(child => new Promise(resolve => child.once('close', resolve))));
    return { status: 'stopped' };
  }

  print(p.dim('  watching for changes · Ctrl+C to stop'));
  let timer: ReturnType<typeof setTimeout> | undefined; let busy = Promise.resolve(); const changed = new Set<string>();
  // Windows also reports reads (last-access times) as changes, and the build reads every source file; act only when a
  // file's modification time or size moved, or it appeared or went away.
  const seen = snapshot(directory);
  const onChange = (path: string): void => {
    if (ignored.test(path)) return;
    const now = stamp(join(directory, path)); if (now === seen.get(path) || (now === undefined && !seen.has(path))) return;
    if (now === undefined) seen.delete(path); else seen.set(path, now);
    changed.add(path); clearTimeout(timer);
    timer = setTimeout(() => {
      const files = [...changed].map(item => item.split(sep).join('/')); changed.clear();
      busy = busy.then(async () => {
        if (signal.aborted) return;
        print(`${p.yellow('~')} ${files.slice(0, 3).join(', ')}${files.length > 3 ? p.dim(` and ${files.length - 3} more`) : ''} changed`);
        // A failed build leaves the last good version running.
        if (await build()) { await stop(true); if (!signal.aborted) await start(); }
      });
    }, 200);
  };
  let watcher: FSWatcher;
  try { watcher = watch(directory, { recursive: true }, (_event, file) => { if (file) onChange(relative(directory, join(directory, String(file)))); }); }
  catch { throw new MayuraError('UNSUPPORTED_PROFILE', 'This platform cannot watch the project directory; run with --no-watch.'); }
  await new Promise<void>(resolve => { if (signal.aborted) resolve(); else signal.addEventListener('abort', () => resolve(), { once: true }); });
  watcher.close(); clearTimeout(timer); await busy; await stop(false);
  return { status: 'stopped' };
}
