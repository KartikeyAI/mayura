import { spawn } from 'node:child_process';
import { MayuraError } from 'mayura';
import {
  parseSandboxListing, SandboxError, sandboxScripts,
  type BackendExecResult, type ProviderSandboxSpec, type SandboxBackend, type SandboxProvider,
} from 'mayura/sandbox';

export interface AppleContainerSandboxOptions {
  /** The image sandboxes run, such as `docker.io/library/alpine:3.22`. It must be on this Mac already: images are never pulled. */
  readonly image: string;
  /** The `container` command line, as program and arguments; `['container']` (on the PATH) by default. */
  readonly cli?: readonly string[];
  /**
   * A host-only network (`container network create --internal <name>`, made if missing) to put sandboxes created with
   * the network `'none'` on. Apple's `container` has no network that reaches nothing: a host-only one still reaches this
   * Mac. Without it, sandboxes are created only with the network `'all'`.
   */
  readonly hostOnlyNetwork?: string;
  /** The user commands run as, such as `1000:1000`; the image's by default. */
  readonly user?: string;
  /** The working directory, made when the sandbox starts; `/workspace` by default. */
  readonly workdir?: string;
  /** The CPUs a sandbox gets, and the most one may ask for; 2 by default. */
  readonly cpus?: number;
  /** The memory a sandbox gets, and the most one may ask for; 1,024 MiB by default. */
  readonly memoryMiB?: number;
  /** The longest lifetime; 24 hours by default. */
  readonly maxLifetimeMs?: number;
}

const randomHex = (bytes: number) => Array.from(crypto.getRandomValues(new Uint8Array(bytes)), byte => byte.toString(16).padStart(2, '0')).join('');
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
const stateDirectory = '/tmp/.mayura';
/**
 * Runs a command in its directory, with the sandbox's environment and its own from files (read and removed before it
 * starts, so neither is on a command line). $1: the directory; $2: the command's environment file, or `-`; the command
 * follows.
 */
const execScript = [
  'cd -- "$1" || exit',
  `[ ! -f ${stateDirectory}/env ] || . ${stateDirectory}/env`,
  'if [ "$2" != - ]; then _mayura_e=$(cat -- "$2"); rm -f -- "$2"; eval "$_mayura_e"; unset _mayura_e; fi',
  'shift 2',
  'exec "$@"',
].join('\n');
const writeScript = '[ ! -d "$1" ] || exit 4; mkdir -p -- "$(dirname -- "$1")" || exit; cat > "$1"';

interface Spawned { readonly exitCode?: number; readonly stdout: Uint8Array; readonly stderr: Uint8Array; readonly truncated: boolean }
/** Runs the CLI without a shell. Aborting `signal` kills it and settles with what it printed, without an exit code. */
function cli(command: readonly string[], args: readonly string[], options: { readonly stdin?: Uint8Array; readonly maxOutputBytes: number; readonly signal: AbortSignal }): Promise<Spawned> {
  return new Promise((resolve, reject) => {
    let child;
    try { child = spawn(command[0]!, [...command.slice(1), ...args], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, shell: false }); }
    catch { reject(new SandboxError('unavailable')); return; }
    const collect = () => { const chunks: Uint8Array[] = []; let kept = 0; let more = false;
      return { push: (chunk: Uint8Array) => { const room = options.maxOutputBytes - kept; if (chunk.byteLength > room) more = true; if (room > 0) { const part = chunk.byteLength > room ? chunk.subarray(0, room) : chunk; chunks.push(Uint8Array.from(part)); kept += part.byteLength; } },
        bytes: () => { const data = new Uint8Array(kept); let offset = 0; for (const chunk of chunks) { data.set(chunk, offset); offset += chunk.byteLength; } return data; }, get more() { return more; } }; };
    const out = collect(); const err = collect(); let stopped = false; let settled = false;
    const onAbort = () => { stopped = true; child.kill('SIGKILL'); };
    if (options.signal.aborted) onAbort(); else options.signal.addEventListener('abort', onAbort, { once: true });
    child.stdout.on('data', (chunk: Uint8Array) => out.push(chunk)); child.stderr.on('data', (chunk: Uint8Array) => err.push(chunk));
    child.on('error', error => {
      if (settled) return; settled = true; options.signal.removeEventListener('abort', onAbort);
      reject((error as { code?: unknown }).code === 'ENOENT' ? new MayuraError('INVALID_CONFIG', `The container command line was not found at ${command[0]}.`) : new SandboxError('unavailable'));
    });
    child.on('close', code => {
      if (settled) return; settled = true; options.signal.removeEventListener('abort', onAbort);
      resolve({ ...(stopped || code === null ? {} : { exitCode: code }), stdout: out.bytes(), stderr: err.bytes(), truncated: out.more || err.more });
    });
    child.stdin.on('error', () => undefined);
    child.stdin.end(options.stdin ?? new Uint8Array(0));
  });
}

/**
 * Sandboxes as containers of Apple's `container` (a lightweight VM per container) on this Mac: macOS 26 on Apple
 * silicon. Node only. Give the result to `createSandboxes` from `mayura/sandbox`.
 */
export function appleContainerSandboxes(options: AppleContainerSandboxOptions): SandboxProvider {
  const imagePattern = /^[A-Za-z0-9][A-Za-z0-9._/:@-]{0,511}$/u;
  if (!options || typeof options.image !== 'string' || !imagePattern.test(options.image)) throw new MayuraError('INVALID_CONFIG', 'appleContainerSandboxes(): image must be an image reference.');
  const command = options.cli ?? ['container'];
  if (!Array.isArray(command) || command.length === 0 || command.some(item => typeof item !== 'string' || item === '' || item.includes('\u0000'))) throw new MayuraError('INVALID_CONFIG', 'appleContainerSandboxes(): cli is the command line as program and arguments.');
  if (options.hostOnlyNetwork !== undefined && (typeof options.hostOnlyNetwork !== 'string' || !/^[a-z0-9][a-z0-9_-]{0,62}$/u.test(options.hostOnlyNetwork))) throw new MayuraError('INVALID_CONFIG', 'appleContainerSandboxes(): hostOnlyNetwork must be a network name.');
  if (options.user !== undefined && (typeof options.user !== 'string' || !/^[A-Za-z0-9_][A-Za-z0-9_.-]{0,31}(?::[A-Za-z0-9_][A-Za-z0-9_.-]{0,31})?$/u.test(options.user))) throw new MayuraError('INVALID_CONFIG', 'appleContainerSandboxes(): user is name or uid, with :group optionally.');
  const workdir = options.workdir ?? '/workspace';
  if (typeof workdir !== 'string' || !/^\/(?:[A-Za-z0-9._-]+\/)*[A-Za-z0-9._-]+$/u.test(workdir) || workdir.split('/').some(part => part === '.' || part === '..')) {
    throw new MayuraError('INVALID_CONFIG', 'appleContainerSandboxes(): workdir must be an absolute, normalized path.');
  }
  const maxCpus = options.cpus ?? 2;
  if (!Number.isSafeInteger(maxCpus) || maxCpus < 1 || maxCpus > 64) throw new MayuraError('INVALID_CONFIG', 'appleContainerSandboxes(): cpus is 1 to 64.');
  const maxMemoryMiB = options.memoryMiB ?? 1_024;
  if (!Number.isSafeInteger(maxMemoryMiB) || maxMemoryMiB < 64 || maxMemoryMiB > 1_048_576) throw new MayuraError('INVALID_CONFIG', 'appleContainerSandboxes(): memoryMiB is 64 to 1,048,576.');
  const maxLifetimeMs = options.maxLifetimeMs ?? 86_400_000;
  if (!Number.isSafeInteger(maxLifetimeMs) || maxLifetimeMs < 1_000 || maxLifetimeMs > 2_147_483_647) throw new MayuraError('INVALID_CONFIG', 'appleContainerSandboxes(): maxLifetimeMs is 1 s to about 24 days.');
  const run = (args: readonly string[], runOptions: { readonly stdin?: Uint8Array; readonly maxOutputBytes?: number; readonly signal: AbortSignal }) =>
    cli(command, args, { maxOutputBytes: runOptions.maxOutputBytes ?? 65_536, signal: runOptions.signal, ...(runOptions.stdin ? { stdin: runOptions.stdin } : {}) });
  let networkReady: Promise<void> | undefined;

  const create = async (spec: ProviderSandboxSpec, { signal }: { readonly signal: AbortSignal }): Promise<SandboxBackend> => {
    const image = spec.image ?? options.image;
    if (!imagePattern.test(image)) throw new MayuraError('INVALID_INPUT', 'image must be an image reference.');
    const cpus = spec.cpus ?? maxCpus; const memoryMiB = spec.memoryMiB ?? maxMemoryMiB;
    if (!Number.isSafeInteger(cpus) || cpus > maxCpus) throw new MayuraError('INVALID_INPUT', `An Apple container sandbox gets at most ${maxCpus} whole CPUs.`);
    if (memoryMiB > maxMemoryMiB) throw new MayuraError('INVALID_INPUT', `An Apple container sandbox gets at most ${maxMemoryMiB} MiB of memory.`);
    // Never pulled: an image that is not here is a mistake to report, not something to fetch.
    const inspected = await run(['image', 'inspect', image], { signal });
    if (inspected.exitCode !== 0) throw new MayuraError('INVALID_CONFIG', `The image ${image} is not on this Mac; pull it first (container image pull). Sandboxes never pull images.`);
    if (spec.network === 'none') {
      const network = options.hostOnlyNetwork!;
      networkReady ??= (async () => {
        if ((await run(['network', 'inspect', network], { signal })).exitCode === 0) return;
        if ((await run(['network', 'create', '--internal', network], { signal })).exitCode !== 0) throw new SandboxError('rejected');
      })().catch(error => { networkReady = undefined; throw error; });
      await networkReady;
    }
    const name = `mayura-sandbox-${randomHex(8)}`;
    const started = await run(['run', '--detach', '--rm', '--init', '--name', name, '--label', 'mayura.sandbox=true',
      ...Object.entries(spec.labels).flatMap(([key, value]) => ['--label', `${key}=${value}`]),
      '--cpus', String(cpus), '--memory', `${memoryMiB}M`, ...(spec.network === 'none' ? ['--network', options.hostOnlyNetwork!] : []),
      ...(options.user ? ['--user', options.user] : []),
      // The container ends itself when the lifetime is over (and is removed, with --rm); release ends it sooner.
      image, 'sleep', String(Math.ceil(spec.lifetimeMs / 1_000) + 5)], { signal });
    if (started.exitCode !== 0) throw new SandboxError(started.exitCode === undefined ? 'timeout' : 'rejected');
    const release = async (callSignal: AbortSignal) => {
      const removed = await run(['delete', '--force', name], { signal: callSignal });
      if (removed.exitCode !== 0 && !/not ?found|no such/iu.test(new TextDecoder().decode(removed.stderr))) throw new SandboxError(removed.exitCode === undefined ? 'timeout' : 'unavailable');
    };
    const exec = (argv: readonly string[], execOptions: { readonly stdin?: Uint8Array; readonly env?: Readonly<Record<string, string>>; readonly maxOutputBytes: number; readonly signal: AbortSignal }) =>
      run(['exec', ...(execOptions.stdin ? ['--interactive'] : []), ...Object.entries(execOptions.env ?? {}).flatMap(([key, value]) => ['--env', `${key}=${value}`]), name, ...argv],
        { maxOutputBytes: execOptions.maxOutputBytes, signal: execOptions.signal, ...(execOptions.stdin ? { stdin: execOptions.stdin } : {}) });
    const script = (body: string, args: readonly string[]) => ['sh', '-c', body, 'mayura', ...args];
    const fileCall = async (body: string, args: readonly string[], max: number, callSignal: AbortSignal, stdin?: Uint8Array) => {
      const result = await exec(script(body, args), { maxOutputBytes: max, signal: callSignal, ...(stdin ? { stdin } : {}) });
      if (result.exitCode === undefined) throw new SandboxError('timeout');
      return result;
    };
    const writeFile = async (path: string, data: Uint8Array, callSignal: AbortSignal) => {
      const result = await fileCall(writeScript, [path], 4_096, callSignal, data);
      if (result.exitCode === 4) throw new MayuraError('INVALID_INPUT', 'A directory is at that path.');
      if (result.exitCode !== 0) throw new SandboxError('rejected');
    };
    try {
      if ((await fileCall('mkdir -p -- "$1"', [workdir], 4_096, signal)).exitCode !== 0) throw new SandboxError('rejected');
      if (Object.keys(spec.env).length > 0) {
        await writeFile(`${stateDirectory}/env`, new TextEncoder().encode(Object.entries(spec.env).map(([key, value]) => `export ${key}=${quote(value)}\n`).join('')), signal);
      }
    } catch (error) {
      await release(AbortSignal.timeout(30_000)).catch(() => undefined);
      throw error;
    }

    return {
      id: name,
      exec: async (argv, execOptions): Promise<BackendExecResult> => {
        const tag = randomHex(12);
        let envFile = '-';
        if (Object.keys(execOptions.env).length > 0) {
          envFile = `${stateDirectory}/exec-${tag}.env`;
          await writeFile(envFile, new TextEncoder().encode(Object.entries(execOptions.env).map(([key, value]) => `export ${key}=${quote(value)}\n`).join('')), execOptions.signal);
        }
        const stop = new AbortController();
        // Ending the call ends the command: every process carrying its tag is killed, then the command line is.
        const onAbort = () => {
          void exec(script(sandboxScripts.kill, [tag]), { maxOutputBytes: 4_096, signal: AbortSignal.timeout(8_000) }).catch(() => undefined).finally(() => stop.abort());
        };
        if (execOptions.signal.aborted) onAbort(); else execOptions.signal.addEventListener('abort', onAbort, { once: true });
        try {
          const stdin = execOptions.stdin?.byteLength ? execOptions.stdin : undefined;
          const result = await exec(script(execScript, [execOptions.cwd, envFile, ...argv]),
            { env: { [sandboxScripts.tagVariable]: tag }, maxOutputBytes: execOptions.maxOutputBytes, signal: stop.signal, ...(stdin ? { stdin } : {}) });
          const output = { stdout: result.stdout, stderr: result.stderr, truncated: result.truncated };
          // A command stopped because the call ended has no exit code.
          return execOptions.signal.aborted || result.exitCode === undefined ? output : { exitCode: result.exitCode, ...output };
        } finally { execOptions.signal.removeEventListener('abort', onAbort); }
      },
      readFile: async (path, { maxBytes, signal: callSignal }) => {
        const result = await fileCall(sandboxScripts.read, [path, String(maxBytes)], maxBytes + 1, callSignal);
        if (result.exitCode === 3) return undefined;
        if (result.exitCode === 4) throw new MayuraError('INVALID_INPUT', 'That path is not a file.');
        if (result.exitCode === 6) throw new MayuraError('LIMIT_EXCEEDED', `The file is larger than ${maxBytes} bytes.`);
        if (result.exitCode !== 0) throw new SandboxError('rejected');
        return result.stdout;
      },
      writeFile: (path, data, { signal: callSignal }) => writeFile(path, data, callSignal),
      listFiles: async (path, { limit, signal: callSignal }) => {
        const result = await fileCall(sandboxScripts.list, [path, String(limit)], 64 * 1_048_576, callSignal);
        if (result.exitCode === 3) return undefined;
        if (result.exitCode === 4) throw new MayuraError('INVALID_INPUT', 'That path is not a directory.');
        if (result.exitCode !== 0 || result.truncated) throw new SandboxError('rejected');
        return parseSandboxListing(result.stdout);
      },
      removeFile: async (path, { recursive, signal: callSignal }) => {
        const result = await fileCall(sandboxScripts.remove, [path, recursive ? '1' : '0'], 4_096, callSignal);
        if (result.exitCode === 7) throw new MayuraError('INVALID_INPUT', 'The directory is not empty; remove it with recursive.');
        if (result.exitCode !== 0) throw new SandboxError('rejected');
      },
      release: ({ signal: callSignal }) => release(callSignal),
    };
  };

  return Object.freeze({
    id: 'apple-container', workdir, maxLifetimeMs,
    // 'none' only on a host-only network you name: Apple's container has no network that reaches nothing.
    features: Object.freeze({ stdin: true, ports: false, desktop: false, network: Object.freeze(options.hostOnlyNetwork ? ['none', 'all'] as const : ['all'] as const) }),
    create,
  });
}
