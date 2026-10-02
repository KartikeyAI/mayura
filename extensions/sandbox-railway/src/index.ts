import { MayuraError } from 'mayura';
import {
  SandboxError, sandboxScripts,
  type BackendExecResult, type ProviderSandboxSpec, type SandboxBackend, type SandboxEntry, type SandboxFailureReason, type SandboxProvider,
} from 'mayura/sandbox';

/** The part of a Railway sandbox this provider uses; one from `Sandbox.create` in `railway` is one. */
export interface RailwaySandboxLike {
  readonly id: string;
  readonly domains: readonly { readonly port: number; readonly domain: string }[];
  exec(command: string, options?: { readonly cwd?: string; readonly env?: Record<string, string>; readonly timeoutSec?: number }): PromiseLike<{ readonly exitCode: number | null }> & { kill(signal?: 'KILL' | 'TERM'): Promise<boolean> };
  readonly files: {
    read(path: string, options: { readonly format: 'bytes'; readonly length?: number }): Promise<Uint8Array>;
    write(path: string, data: Uint8Array | string): Promise<void>;
    list(path: string): Promise<readonly { readonly name: string; readonly size: number; readonly isDir: boolean; readonly modTime: string }[]>;
    stat(path: string): Promise<{ readonly size: number; readonly isDir: boolean }>;
    remove(path: string): Promise<void>;
  };
  destroy(): Promise<void>;
}

export interface RailwaySandboxOptions {
  /** A Railway API token, or a project token with `authType: 'project-token'`. Nothing is read from the environment. */
  readonly token: string;
  /** `bearer` (an account or team API token, the default) or `project-token`. */
  readonly authType?: 'bearer' | 'project-token';
  /** The Railway environment sandboxes are created in. */
  readonly environmentId: string;
  /** The region sandboxes run in; Railway's default otherwise. */
  readonly region?: string;
  /** The working directory, made when the sandbox starts; `/workspace` by default. */
  readonly workdir?: string;
  /** The longest lifetime; 24 hours by default. */
  readonly maxLifetimeMs?: number;
  /** For tests and proxies: the fetch to use. */
  readonly fetch?: typeof fetch;
  /** For tests: a stand-in for the SDK's `Sandbox`, whose `create` makes sandboxes. */
  readonly sandboxApi?: { create(options: Record<string, unknown>): Promise<RailwaySandboxLike> };
}

const randomHex = (bytes: number) => Array.from(crypto.getRandomValues(new Uint8Array(bytes)), byte => byte.toString(16).padStart(2, '0')).join('');
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
/**
 * Runs a command with its output in files, so only as much of it as is kept is ever read back. $1, $2: the stdout and
 * stderr files; $3: a file of standard input, or `-`; $4: the directory; the command follows.
 */
const execScript = 'exec >"$1" 2>"$2"; _mayura_in=$3; cd -- "$4" || exit; shift 4; if [ "$_mayura_in" = - ]; then exec "$@" </dev/null; fi; exec "$@" <"$_mayura_in"';

/** A Railway failure as a sandbox failure, without Railway's text. */
function failure(error: unknown): SandboxError | MayuraError {
  if (error instanceof MayuraError) return error;
  const name = (error as { constructor?: { name?: unknown } } | null)?.constructor?.name ?? (error as { name?: unknown } | null)?.name;
  const status = (error as { status?: unknown } | null)?.status;
  const byName: Readonly<Record<string, SandboxFailureReason>> = {
    RailwayAuthError: 'authentication', SandboxNotFoundError: 'gone', SandboxFailedError: 'rejected', SandboxTimeoutError: 'timeout',
    RailwayConnectionError: 'unavailable', ExecInterruptedError: 'gone', SandboxFilesError: 'rejected',
  };
  if (name === 'RailwayGraphQLError' && typeof status === 'number') {
    if (status === 401 || status === 403) return new SandboxError('authentication', status);
    if (status === 429) return new SandboxError('rate_limited', status);
    if (status >= 500 && status <= 599) return new SandboxError('unavailable', status);
    return new SandboxError('rejected', status >= 100 && status <= 599 ? status : undefined);
  }
  if (typeof name === 'string' && byName[name]) return new SandboxError(byName[name]!);
  return new SandboxError('unavailable');
}
const isNotFound = (error: unknown) => ((error as { constructor?: { name?: unknown } } | null)?.constructor?.name ?? (error as { name?: unknown } | null)?.name) === 'SandboxFileNotFoundError';

/**
 * Railway Sandboxes (railway.com): Linux VMs on demand, through Railway's TypeScript SDK (`railway`). Railway sandboxes
 * reach the internet, so they are created only with the network `'all'`, allowed and asked for. Give the result to
 * `createSandboxes` from `mayura/sandbox`.
 */
export function railwaySandboxes(options: RailwaySandboxOptions): SandboxProvider {
  if (!options || typeof options.token !== 'string' || !/^[!-~]{8,4096}$/u.test(options.token)) throw new MayuraError('INVALID_CONFIG', 'railwaySandboxes(): token must be a Railway token.');
  const authType = options.authType ?? 'bearer';
  if (authType !== 'bearer' && authType !== 'project-token') throw new MayuraError('INVALID_CONFIG', "railwaySandboxes(): authType is 'bearer' or 'project-token'.");
  if (typeof options.environmentId !== 'string' || !/^[A-Za-z0-9-]{1,64}$/u.test(options.environmentId)) throw new MayuraError('INVALID_CONFIG', 'railwaySandboxes(): environmentId must be a Railway environment id.');
  if (options.region !== undefined && (typeof options.region !== 'string' || !/^[a-z0-9-]{2,64}$/u.test(options.region))) throw new MayuraError('INVALID_CONFIG', 'railwaySandboxes(): region must be a Railway region.');
  const workdir = options.workdir ?? '/workspace';
  if (typeof workdir !== 'string' || !/^\/(?:[A-Za-z0-9._-]+\/)*[A-Za-z0-9._-]+$/u.test(workdir) || workdir.split('/').some(part => part === '.' || part === '..')) {
    throw new MayuraError('INVALID_CONFIG', 'railwaySandboxes(): workdir must be an absolute, normalized path.');
  }
  const maxLifetimeMs = options.maxLifetimeMs ?? 86_400_000;
  if (!Number.isSafeInteger(maxLifetimeMs) || maxLifetimeMs < 60_000 || maxLifetimeMs > 2_147_483_647) throw new MayuraError('INVALID_CONFIG', 'railwaySandboxes(): maxLifetimeMs is 1 minute to about 24 days.');
  if (options.fetch !== undefined && typeof options.fetch !== 'function') throw new MayuraError('INVALID_CONFIG', 'railwaySandboxes(): fetch must be a function.');
  type SandboxApi = { create(options: Record<string, unknown>): Promise<RailwaySandboxLike> };
  // The SDK is an optional peer, loaded when first needed.
  let loaded: Promise<SandboxApi> | undefined;
  const sandboxApi = (): Promise<SandboxApi> => options.sandboxApi ? Promise.resolve(options.sandboxApi) : (loaded ??= import('railway').then(
    module => module.Sandbox as unknown as SandboxApi,
    () => { loaded = undefined; throw new MayuraError('INVALID_CONFIG', "railwaySandboxes() needs Railway's SDK: npm install railway"); }));

  const create = async (spec: ProviderSandboxSpec, { signal }: { readonly signal: AbortSignal }): Promise<SandboxBackend> => {
    // railwaySandboxes declares only 'all', so createSandboxes asks for nothing else.
    if (spec.image !== undefined || spec.cpus !== undefined || spec.memoryMiB !== undefined) throw new MayuraError('INVALID_INPUT', 'Railway sandboxes take no image or resources here: use a Railway template.');
    const api = await sandboxApi();
    let sandbox: RailwaySandboxLike;
    try {
      sandbox = await api.create({
        token: options.token, authType, environmentId: options.environmentId, ...(options.fetch ? { fetch: options.fetch } : {}), ...(options.region ? { region: options.region } : {}),
        env: { ...spec.env },
        // Railway ends a sandbox idle this long, should a release never come; the lifetime itself is enforced by release.
        idleTimeoutMinutes: Math.min(120, Math.max(1, Math.ceil(spec.lifetimeMs / 60_000))),
        // Domains need the environment's private network; without ports a sandbox stays isolated from it.
        networkIsolation: spec.ports.length > 0 ? 'PRIVATE' : 'ISOLATED',
        ...(spec.ports.length > 0 ? { domains: spec.ports.map(port => ({ port })) } : {}),
      });
    } catch (error) { throw failure(error); }
    if (signal.aborted) { await sandbox.destroy().catch(() => undefined); throw new SandboxError('timeout'); }
    const release = async () => { try { await sandbox.destroy(); } catch (error) { throw failure(error); } };
    const run = async (argv: readonly string[], env?: Readonly<Record<string, string>>) => {
      try { return (await sandbox.exec(argv.map(quote).join(' '), env ? { env: { ...env } } : {})).exitCode; } catch (error) { throw failure(error); }
    };
    /** The start of a file: at most `max` bytes, and whether there was more. Undefined when there is none. */
    const head = async (path: string, max: number) => {
      try {
        const info = await sandbox.files.stat(path);
        if (info.isDir) throw new MayuraError('INVALID_INPUT', 'That path is not a file.');
        if (info.size === 0 || max === 0) return { data: new Uint8Array(0), size: info.size };
        return { data: await sandbox.files.read(path, { format: 'bytes', length: Math.min(info.size, max) }), size: info.size };
      } catch (error) { if (isNotFound(error)) return undefined; throw failure(error); }
    };

    try {
      if (await run(['mkdir', '-p', workdir]) !== 0) throw new SandboxError('rejected');
    } catch (error) {
      await release().catch(() => undefined);
      throw error;
    }

    return {
      id: sandbox.id,
      exec: async (command, execOptions): Promise<BackendExecResult> => {
        const tag = randomHex(12); const base = `/tmp/mayura-${tag}`;
        const stdin = execOptions.stdin?.byteLength ? execOptions.stdin : undefined;
        const output = async () => {
          const [out, err] = await Promise.all([head(`${base}.out`, execOptions.maxOutputBytes).catch(() => undefined), head(`${base}.err`, execOptions.maxOutputBytes).catch(() => undefined)]);
          return { stdout: out?.data ?? new Uint8Array(0), stderr: err?.data ?? new Uint8Array(0),
            truncated: (out?.size ?? 0) > execOptions.maxOutputBytes || (err?.size ?? 0) > execOptions.maxOutputBytes };
        };
        try {
          if (stdin) { try { await sandbox.files.write(`${base}.in`, stdin); } catch (error) { throw failure(error); } }
          const line = ['sh', '-c', execScript, 'mayura', `${base}.out`, `${base}.err`, stdin ? `${base}.in` : '-', execOptions.cwd, ...command].map(quote).join(' ');
          const handle = sandbox.exec(line, { env: { ...execOptions.env, [sandboxScripts.tagVariable]: tag } });
          let exitCode: number | null | undefined;
          // Ending the call ends the command: Railway kills its process group, and the tag finds anything that left it.
          await new Promise<void>((resolve, reject) => {
            const onAbort = () => {
              void Promise.allSettled([handle.kill('KILL'), run(['sh', '-c', sandboxScripts.kill, 'mayura', tag])]).finally(() => resolve());
            };
            if (execOptions.signal.aborted) { onAbort(); return; }
            execOptions.signal.addEventListener('abort', onAbort, { once: true });
            Promise.resolve(handle).then(result => { exitCode = result.exitCode; execOptions.signal.removeEventListener('abort', onAbort); resolve(); },
              error => { execOptions.signal.removeEventListener('abort', onAbort); reject(failure(error)); });
          });
          const result = await output();
          // A command stopped because the call ended has no exit code; Railway reports a signalled one as -1.
          return execOptions.signal.aborted || exitCode === undefined || exitCode === null ? result : { exitCode, ...result };
        } finally {
          void run(['rm', '-f', '--', `${base}.out`, `${base}.err`, `${base}.in`]).catch(() => undefined);
        }
      },
      readFile: async (path, { maxBytes }) => {
        const file = await head(path, maxBytes);
        if (!file) return undefined;
        if (file.size > maxBytes) throw new MayuraError('LIMIT_EXCEEDED', `The file is larger than ${maxBytes} bytes.`);
        return file.data;
      },
      writeFile: async (path, data) => {
        try {
          const info = await sandbox.files.stat(path).catch(error => { if (isNotFound(error)) return undefined; throw error; });
          if (info?.isDir) throw new MayuraError('INVALID_INPUT', 'A directory is at that path.');
          // Railway makes the missing parent directories.
          await sandbox.files.write(path, data);
        } catch (error) { throw failure(error); }
      },
      listFiles: async (path, { limit }) => {
        try {
          const info = await sandbox.files.stat(path);
          if (!info.isDir) throw new MayuraError('INVALID_INPUT', 'That path is not a directory.');
          const entries = await sandbox.files.list(path);
          return entries.slice(0, limit).map((entry): SandboxEntry => {
            const modified = Date.parse(entry.modTime);
            return { name: entry.name, type: entry.isDir ? 'directory' : 'file', size: entry.isDir ? 0 : entry.size, ...(Number.isFinite(modified) ? { modified } : {}) };
          });
        } catch (error) { if (isNotFound(error)) return undefined; throw failure(error); }
      },
      removeFile: async (path, { recursive }) => {
        if (recursive) {
          if (await run(['rm', '-rf', '--', path]) !== 0) throw new SandboxError('rejected');
          return;
        }
        try {
          const info = await sandbox.files.stat(path);
          // Railway removes only files and empty directories; say so plainly for one that is not empty.
          if (info.isDir && (await sandbox.files.list(path)).length > 0) throw new MayuraError('INVALID_INPUT', 'The directory is not empty; remove it with recursive.');
          await sandbox.files.remove(path);
        } catch (error) { if (isNotFound(error)) return; throw failure(error); }
      },
      url: async port => {
        const domain = sandbox.domains.find(item => item.port === port);
        if (!domain) throw new SandboxError('invalid_response');
        return `https://${domain.domain}/`;
      },
      release: () => release(),
    };
  };

  return Object.freeze({
    id: 'railway', workdir, maxLifetimeMs,
    // Railway sandboxes always have public egress: 'none' cannot be enforced.
    features: Object.freeze({ stdin: true, ports: true, desktop: false, network: Object.freeze(['all'] as const) }),
    create,
  });
}
