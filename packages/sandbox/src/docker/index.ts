import { MayuraError } from '@mayura/core';
import { SandboxError, type BackendExecResult, type ProviderSandboxSpec, type SandboxBackend, type SandboxEntry, type SandboxProvider } from '../contracts.js';
import { sandboxPath } from '../sandboxes.js';
import { dockerApi, dockerSocketPath } from './api.js';
import { dockerCli } from './cli.js';
import type { DockerEngine } from './engine.js';
import { environmentScript, execScript, killScript, listScript, readScript, removeScript, stateDirectory, writeScript } from './scripts.js';

export interface DockerSandboxOptions {
  /**
   * The image sandboxes run, such as `alpine:3.22` or `node:24-slim`. It must be on this machine already: images are
   * never pulled. It needs a POSIX shell, `sleep` and the usual tools (from BusyBox or coreutils).
   */
  readonly image: string;
  /** `'cli'` (the default) runs the docker CLI; `'api'` talks to the Docker Engine API on its local socket. */
  readonly engine?: 'cli' | 'api';
  /** The docker CLI; `docker` on the PATH by default. */
  readonly docker?: string;
  /** For the API: the local socket, as `unix:///var/run/docker.sock` or `npipe:////./pipe/docker_engine`; `DOCKER_HOST` or the platform's usual sockets otherwise. */
  readonly host?: string;
  /** The user commands run as, as numeric `uid:gid`; `1000:1000` by default. Never root unless you say `0:0`. */
  readonly user?: string;
  /** The working directory, a fresh in-memory file system per sandbox; `/workspace` by default. */
  readonly workdir?: string;
  /** The size of the working directory; 1,024 MiB by default. It counts toward the sandbox's memory. */
  readonly workspaceMiB?: number;
  /** The size of `/tmp`; 256 MiB by default. */
  readonly tmpMiB?: number;
  /** The CPUs a sandbox gets, and the most one may ask for; 1 by default. */
  readonly cpus?: number;
  /** The memory a sandbox gets, and the most one may ask for; 1,024 MiB by default. Swap is off. */
  readonly memoryMiB?: number;
  /** The most processes a sandbox may run at once; 256 by default. */
  readonly pids?: number;
  /** Keep the image's file system read-only, so only the working directory and /tmp can be written; true by default. */
  readonly readOnlyRoot?: boolean;
  /** The longest a sandbox may live; 24 hours by default. */
  readonly maxLifetimeMs?: number;
}

const imagePattern = /^[A-Za-z0-9][A-Za-z0-9._/:@-]{0,511}$/u;
const randomHex = (bytes: number) => Array.from(crypto.getRandomValues(new Uint8Array(bytes)), byte => byte.toString(16).padStart(2, '0')).join('');
const decoder = new TextDecoder();

function whole(value: number | undefined, name: string, fallback: number, min: number, max: number): number {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result < min || result > max) throw new MayuraError('INVALID_CONFIG', `dockerSandboxes(): ${name} must be a whole number from ${min} to ${max}.`);
  return result;
}

/** `DOCKER_HOST`, or the platform's usual sockets: Docker Desktop's and Docker Engine's on Windows. */
function defaultSockets(): readonly string[] {
  const configured = process.env['DOCKER_HOST'];
  if (configured) return [dockerSocketPath(configured)];
  return process.platform === 'win32' ? ['\\\\.\\pipe\\dockerDesktopLinuxEngine', '\\\\.\\pipe\\docker_engine'] : ['/var/run/docker.sock'];
}

/**
 * Sandboxes as Docker containers on this machine, locked down: no network unless allowed, every capability dropped,
 * no privilege escalation, a non-root user, a read-only image with an in-memory working directory, and bounded CPU,
 * memory and processes. Give the result to `createSandboxes`. Node only.
 */
export function dockerSandboxes(options: DockerSandboxOptions): SandboxProvider {
  if (!options || typeof options.image !== 'string' || !imagePattern.test(options.image)) throw new MayuraError('INVALID_CONFIG', 'dockerSandboxes(): image must be an image reference, such as alpine:3.22.');
  const image = options.image;
  if (options.engine !== undefined && options.engine !== 'cli' && options.engine !== 'api') throw new MayuraError('INVALID_CONFIG', "dockerSandboxes(): engine is 'cli' or 'api'.");
  if (options.docker !== undefined && (typeof options.docker !== 'string' || options.docker === '' || options.docker.includes('\u0000'))) throw new MayuraError('INVALID_CONFIG', 'dockerSandboxes(): docker must be the path of the docker CLI.');
  const engine: DockerEngine = options.engine === 'api' ? dockerApi(options.host === undefined ? defaultSockets() : [dockerSocketPath(options.host)]) : dockerCli(options.docker ?? 'docker');
  const user = options.user ?? '1000:1000';
  const ids = /^(\d{1,9}):(\d{1,9})$/u.exec(user);
  if (!ids) throw new MayuraError('INVALID_CONFIG', 'dockerSandboxes(): user must be numeric uid:gid, such as 1000:1000.');
  const workdir = options.workdir ?? '/workspace';
  if (typeof workdir !== 'string' || sandboxPath(workdir, '/') !== workdir || workdir === '/' || workdir === '/tmp' || !/^[A-Za-z0-9._/-]+$/u.test(workdir)) {
    throw new MayuraError('INVALID_CONFIG', 'dockerSandboxes(): workdir must be an absolute, normalized path of letters, digits and . _ / -, other than / and /tmp.');
  }
  const workspaceMiB = whole(options.workspaceMiB, 'workspaceMiB', 1_024, 1, 1_048_576);
  const tmpMiB = whole(options.tmpMiB, 'tmpMiB', 256, 1, 1_048_576);
  const maxMemoryMiB = whole(options.memoryMiB, 'memoryMiB', 1_024, 16, 4_194_304);
  const pids = whole(options.pids, 'pids', 256, 8, 1_000_000);
  const maxCpus = options.cpus ?? 1;
  if (typeof maxCpus !== 'number' || !Number.isFinite(maxCpus) || maxCpus <= 0 || maxCpus > 256) throw new MayuraError('INVALID_CONFIG', 'dockerSandboxes(): cpus is a number from above 0 to 256.');
  if (options.readOnlyRoot !== undefined && typeof options.readOnlyRoot !== 'boolean') throw new MayuraError('INVALID_CONFIG', 'dockerSandboxes(): readOnlyRoot must be a boolean.');
  const maxLifetimeMs = whole(options.maxLifetimeMs, 'maxLifetimeMs', 86_400_000, 1_000, 2_147_483_647);
  let imageChecked = false;

  const create = async (spec: ProviderSandboxSpec, { signal }: { readonly signal: AbortSignal }): Promise<SandboxBackend> => {
    if (spec.network !== 'none' && spec.network !== 'all') throw new MayuraError('INVALID_INPUT', 'Docker sandboxes cannot limit the network to domains.');
    if (spec.ports.length > 0 && spec.network === 'none') throw new MayuraError('INVALID_INPUT', "Docker sandboxes serve ports only with the network 'all'.");
    if (spec.image !== undefined && (!imagePattern.test(spec.image))) throw new MayuraError('INVALID_INPUT', 'image must be an image reference, such as alpine:3.22.');
    const cpus = spec.cpus ?? maxCpus; const memoryMiB = spec.memoryMiB ?? maxMemoryMiB;
    if (cpus > maxCpus) throw new MayuraError('INVALID_INPUT', `A Docker sandbox gets at most ${maxCpus} CPUs.`);
    if (memoryMiB > maxMemoryMiB) throw new MayuraError('INVALID_INPUT', `A Docker sandbox gets at most ${maxMemoryMiB} MiB of memory.`);
    const chosen = spec.image ?? image;
    if (chosen !== image || !imageChecked) {
      if (!await engine.hasImage(chosen, signal)) throw new MayuraError('INVALID_CONFIG', `The image ${chosen} is not on this machine; pull it first. Sandboxes never pull images.`);
      if (chosen === image) imageChecked = true;
    }
    const name = `mayura-sandbox-${randomHex(8)}`;
    const container = await engine.run({
      name, image: chosen, user, workdir, readOnlyRoot: options.readOnlyRoot ?? true, pids, memoryMiB, cpus,
      network: spec.network === 'all' ? 'bridge' : 'none', ports: spec.ports,
      tmpfs: {
        [workdir]: `rw,exec,nosuid,nodev,size=${workspaceMiB}m,uid=${ids[1]},gid=${ids[2]},mode=0700`,
        '/tmp': `rw,exec,nosuid,nodev,size=${tmpMiB}m,mode=1777`,
      },
      env: { HOME: workdir }, labels: { 'mayura.sandbox': 'true', ...spec.labels },
      // The container ends itself when the lifetime is over (and is removed, with --rm); release ends it sooner.
      command: ['sleep', String(Math.ceil(spec.lifetimeMs / 1_000) + 5)],
    }, signal);

    const run = (command: readonly string[], runOptions: { readonly stdin?: Uint8Array; readonly maxOutputBytes: number; readonly signal: AbortSignal; readonly env?: Readonly<Record<string, string>> }) =>
      engine.exec(container, command, { env: runOptions.env ?? {}, maxOutputBytes: runOptions.maxOutputBytes, signal: runOptions.signal, ...(runOptions.stdin?.byteLength ? { stdin: runOptions.stdin } : {}) });
    const script = (body: string, args: readonly string[]) => ['sh', '-c', body, 'mayura', ...args];
    /** Runs one of the file scripts; a stopped call is the provider not answering in time. */
    const fileCall = async (body: string, args: readonly string[], callOptions: { readonly stdin?: Uint8Array; readonly maxOutputBytes: number; readonly signal: AbortSignal }) => {
      const result = await run(script(body, args), callOptions);
      if (result.exitCode === undefined) throw new SandboxError('timeout');
      return result;
    };
    const writeFile = async (path: string, data: Uint8Array, signal: AbortSignal) => {
      const result = await fileCall(writeScript, [path, String(data.byteLength)], { stdin: data, maxOutputBytes: 4_096, signal });
      if (result.exitCode === 4) throw new MayuraError('INVALID_INPUT', 'A directory is at that path.');
      if (result.exitCode !== 0) throw new SandboxError('rejected');
    };

    try {
      if (Object.keys(spec.env).length > 0) await writeFile(`${stateDirectory}/env`, new TextEncoder().encode(environmentScript(spec.env)), signal);
    } catch (error) {
      await engine.remove(container, AbortSignal.timeout(30_000)).catch(() => undefined);
      throw error;
    }

    return {
      id: name,
      exec: async (command, execOptions): Promise<BackendExecResult> => {
        const tag = randomHex(12);
        let envFile = '-';
        if (Object.keys(execOptions.env).length > 0) {
          envFile = `${stateDirectory}/exec-${tag}.env`;
          await writeFile(envFile, new TextEncoder().encode(environmentScript(execOptions.env)), execOptions.signal);
        }
        const stop = new AbortController();
        // Ending the call ends the command: every process carrying its tag is killed, then the attached streams close.
        const onAbort = () => {
          void run(script(killScript, [tag]), { maxOutputBytes: 4_096, signal: AbortSignal.timeout(15_000) }).catch(() => undefined).finally(() => stop.abort());
        };
        if (execOptions.signal.aborted) onAbort(); else execOptions.signal.addEventListener('abort', onAbort, { once: true });
        try {
          const stdin = execOptions.stdin?.byteLength ? execOptions.stdin : undefined;
          const result = await run(script(execScript, [stdin ? String(stdin.byteLength) : '-', execOptions.cwd, envFile, ...command]),
            { env: { MAYURA_SANDBOX_EXEC: tag }, maxOutputBytes: execOptions.maxOutputBytes, signal: stop.signal, ...(stdin ? { stdin } : {}) });
          // A command killed because the call ended has no exit code of its own.
          if (execOptions.signal.aborted || result.exitCode === undefined) return { stdout: result.stdout, stderr: result.stderr, truncated: result.truncated };
          return { exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr, truncated: result.truncated };
        } finally { execOptions.signal.removeEventListener('abort', onAbort); }
      },
      readFile: async (path, { maxBytes, signal: callSignal }) => {
        const result = await fileCall(readScript, [path, String(maxBytes)], { maxOutputBytes: maxBytes + 1, signal: callSignal });
        if (result.exitCode === 3) return undefined;
        if (result.exitCode === 4) throw new MayuraError('INVALID_INPUT', 'That path is not a file.');
        if (result.exitCode === 6 || result.stdout.byteLength > maxBytes) throw new MayuraError('LIMIT_EXCEEDED', `The file is larger than ${maxBytes} bytes.`);
        if (result.exitCode !== 0) throw new SandboxError('rejected');
        return result.stdout;
      },
      writeFile: (path, data, { signal: callSignal }) => writeFile(path, data, callSignal),
      listFiles: async (path, { limit, signal: callSignal }) => {
        const result = await fileCall(listScript, [path, String(limit)], { maxOutputBytes: 64 * 1_048_576, signal: callSignal });
        if (result.exitCode === 3) return undefined;
        if (result.exitCode === 4) throw new MayuraError('INVALID_INPUT', 'That path is not a directory.');
        if (result.exitCode !== 0 || result.truncated) throw new SandboxError('rejected');
        const fields = decoder.decode(result.stdout).split('\u0000'); fields.pop();
        if (fields.length % 4 !== 0) throw new SandboxError('invalid_response');
        const entries: SandboxEntry[] = [];
        for (let index = 0; index < fields.length; index += 4) {
          const [type, size, modified, entryName] = fields.slice(index, index + 4) as [string, string, string, string];
          // Names with control characters cannot be listed safely, so they are left out.
          if (/[\u0000-\u001f\u007f]/u.test(entryName) || !/^\d{1,16}$/u.test(size) || !/^\d{1,16}$/u.test(modified)) continue;
          entries.push({ name: entryName, type: type === 'f' ? 'file' : type === 'd' ? 'directory' : 'other', size: type === 'd' ? 0 : Number(size), modified: Number(modified) * 1_000 });
        }
        return entries;
      },
      removeFile: async (path, { recursive, signal: callSignal }) => {
        const result = await fileCall(removeScript, [path, recursive ? '1' : '0'], { maxOutputBytes: 4_096, signal: callSignal });
        if (result.exitCode === 7) throw new MayuraError('INVALID_INPUT', 'The directory is not empty; remove it with recursive.');
        if (result.exitCode !== 0) throw new SandboxError('rejected');
      },
      url: async (port, { signal: callSignal }) => {
        const hostPort = await engine.hostPort(container, port, callSignal);
        if (hostPort === undefined) throw new SandboxError('rejected');
        return `http://127.0.0.1:${hostPort}/`;
      },
      release: ({ signal: callSignal }) => engine.remove(container, callSignal),
    };
  };

  return Object.freeze({
    id: 'docker', workdir, maxLifetimeMs,
    features: Object.freeze({ stdin: true, ports: true, desktop: false, network: Object.freeze(['none', 'all'] as const) }),
    create,
  });
}
