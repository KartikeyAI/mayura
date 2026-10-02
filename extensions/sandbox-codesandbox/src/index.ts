import { MayuraError } from 'mayura';
import {
  parseSandboxListing, SandboxError, sandboxScripts,
  type BackendExecResult, type ProviderSandboxSpec, type SandboxBackend, type SandboxProvider,
} from 'mayura/sandbox';

/** The part of a connected sandbox client this provider uses; one from `sandbox.connect()` in `@codesandbox/sdk` is one. */
export interface CodeSandboxClientLike {
  readonly commands: {
    run(command: string, options?: { readonly env?: Record<string, string> }): Promise<string>;
    runBackground(command: string, options?: { readonly env?: Record<string, string> }): Promise<{ waitUntilComplete(): Promise<string>; kill(): Promise<void> }>;
  };
  readonly fs: {
    readFile(path: string): Promise<Uint8Array>;
    writeFile(path: string, content: Uint8Array, options?: { readonly create?: boolean; readonly overwrite?: boolean }): Promise<void>;
    mkdir(path: string, recursive?: boolean): Promise<void>;
    readdir(path: string): Promise<readonly { readonly name: string }[]>;
    stat(path: string): Promise<{ readonly type: 'file' | 'directory'; readonly size: number }>;
    remove(path: string, recursive?: boolean): Promise<void>;
  };
  dispose(): void;
}
/** The part of a `CodeSandbox` from `@codesandbox/sdk` this provider uses. */
export interface CodeSandboxSdkLike {
  readonly sandboxes: {
    create(options: Record<string, unknown>): Promise<{ readonly id: string; connect(): Promise<CodeSandboxClientLike> }>;
    delete(sandboxId: string): Promise<void>;
  };
  readonly hosts: {
    createToken(sandboxId: string, options: { expiresAt: Date }): Promise<{ readonly sandboxId: string; readonly token: string }>;
    getUrl(token: { readonly sandboxId: string; readonly token: string }, port: number): string;
  };
}

export interface CodeSandboxSandboxOptions {
  /** A CodeSandbox API key (`CSB_API_KEY`). Give it, or `sdk`. Nothing is read from the environment. */
  readonly apiKey?: string;
  /** A `CodeSandbox` from `@codesandbox/sdk` you create and own, instead of `apiKey`. */
  readonly sdk?: CodeSandboxSdkLike;
  /** The sandbox new ones fork from; CodeSandbox's universal template by default. A sandbox's own `image` overrides it. */
  readonly template?: string;
  /** The VM size, such as `Nano` or `Small`; your workspace's default otherwise. */
  readonly vmTier?: 'Pico' | 'Nano' | 'Micro' | 'Small' | 'Medium' | 'Large' | 'XLarge';
  /** The working directory; `/project/sandbox` by default. */
  readonly workdir?: string;
  /** The longest lifetime; 24 hours by default. */
  readonly maxLifetimeMs?: number;
}

/**
 * The SDK, loaded by name: its type files do not resolve under NodeNext, so this package types it by shape instead and
 * keeps its types out of yours.
 */
async function loadSdk(): Promise<{ readonly CodeSandbox: new (apiKey: string) => CodeSandboxSdkLike; readonly VMTier: Readonly<Record<string, unknown>> }> {
  const specifier = '@codesandbox/sdk';
  try { return await import(specifier) as { readonly CodeSandbox: new (apiKey: string) => CodeSandboxSdkLike; readonly VMTier: Readonly<Record<string, unknown>> }; }
  catch { throw new MayuraError('INVALID_CONFIG', 'codeSandboxSandboxes() with an apiKey needs the CodeSandbox SDK: npm install @codesandbox/sdk'); }
}
const tierNames = ['Pico', 'Nano', 'Micro', 'Small', 'Medium', 'Large', 'XLarge'] as const;
const randomHex = (bytes: number) => Array.from(crypto.getRandomValues(new Uint8Array(bytes)), byte => byte.toString(16).padStart(2, '0')).join('');
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
const line = (argv: readonly string[]) => argv.map(quote).join(' ');
/**
 * Runs a command with its output in files: CodeSandbox runs commands in a terminal, which joins and changes their
 * output. $1, $2: the stdout and stderr files; $3: a file of standard input, or `-`; $4: the directory; the command
 * follows.
 */
const execScript = 'exec >"$1" 2>"$2"; _mayura_in=$3; cd -- "$4" || exit; shift 4; if [ "$_mayura_in" = - ]; then exec "$@" </dev/null; fi; exec "$@" <"$_mayura_in"';

/** The exit code of a finished command: 0, or what CodeSandbox's CommandError carries. */
async function exitCodeOf(done: Promise<unknown>): Promise<number> {
  try { await done; return 0; } catch (error) {
    const code = (error as { exitCode?: unknown } | null)?.exitCode;
    if (Number.isSafeInteger(code)) return code as number;
    throw failure(error);
  }
}
/** A CodeSandbox failure as a sandbox failure, without its text. */
function failure(error: unknown): SandboxError | MayuraError {
  if (error instanceof MayuraError) return error;
  const status = (error as { status?: unknown; response?: { status?: unknown } } | null)?.status ?? (error as { response?: { status?: unknown } } | null)?.response?.status;
  if (typeof status === 'number' && status >= 100 && status <= 599) {
    if (status === 401 || status === 403) return new SandboxError('authentication', status);
    if (status === 404) return new SandboxError('gone', status);
    if (status === 402) return new SandboxError('quota', status);
    if (status === 429) return new SandboxError('rate_limited', status);
    if (status >= 500) return new SandboxError('unavailable', status);
    return new SandboxError('rejected', status);
  }
  return new SandboxError('unavailable');
}

/**
 * CodeSandbox (Together) sandboxes: Firecracker microVMs, private and forked from a template, through the CodeSandbox
 * SDK. CodeSandbox VMs reach the internet, so sandboxes are created only with the network `'all'`, allowed and asked
 * for. Give the result to `createSandboxes` from `mayura/sandbox`.
 */
export function codeSandboxSandboxes(options: CodeSandboxSandboxOptions): SandboxProvider {
  if (!options || typeof options !== 'object') throw new MayuraError('INVALID_CONFIG', 'codeSandboxSandboxes() needs options.');
  if (options.sdk === undefined && (typeof options.apiKey !== 'string' || !/^[!-~]{8,4096}$/u.test(options.apiKey))) throw new MayuraError('INVALID_CONFIG', 'codeSandboxSandboxes(): give apiKey, or an sdk.');
  if (options.sdk !== undefined && (typeof options.sdk !== 'object' || !options.sdk.sandboxes || !options.sdk.hosts)) throw new MayuraError('INVALID_CONFIG', 'codeSandboxSandboxes(): sdk must be a CodeSandbox.');
  if (options.template !== undefined && (typeof options.template !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/u.test(options.template))) throw new MayuraError('INVALID_CONFIG', 'codeSandboxSandboxes(): template must be a sandbox id.');
  if (options.vmTier !== undefined && !(tierNames as readonly string[]).includes(options.vmTier)) throw new MayuraError('INVALID_CONFIG', `codeSandboxSandboxes(): vmTier is one of ${tierNames.join(', ')}.`);
  const workdir = options.workdir ?? '/project/sandbox';
  if (typeof workdir !== 'string' || !/^\/(?:[A-Za-z0-9._-]+\/)*[A-Za-z0-9._-]+$/u.test(workdir) || workdir.split('/').some(part => part === '.' || part === '..')) {
    throw new MayuraError('INVALID_CONFIG', 'codeSandboxSandboxes(): workdir must be an absolute, normalized path.');
  }
  const maxLifetimeMs = options.maxLifetimeMs ?? 86_400_000;
  if (!Number.isSafeInteger(maxLifetimeMs) || maxLifetimeMs < 60_000 || maxLifetimeMs > 2_147_483_647) throw new MayuraError('INVALID_CONFIG', 'codeSandboxSandboxes(): maxLifetimeMs is 1 minute to about 24 days.');
  let sdk = options.sdk;
  let tiers: Readonly<Record<string, unknown>> | undefined;
  const connect = async (): Promise<CodeSandboxSdkLike> => {
    if (sdk) return sdk;
    const module = await loadSdk();
    tiers = module.VMTier;
    return (sdk = new module.CodeSandbox(options.apiKey!));
  };

  const create = async (spec: ProviderSandboxSpec, { signal }: { readonly signal: AbortSignal }): Promise<SandboxBackend> => {
    // codeSandboxSandboxes declares only 'all', so createSandboxes asks for nothing else.
    if (spec.cpus !== undefined || spec.memoryMiB !== undefined) throw new MayuraError('INVALID_INPUT', 'CodeSandbox sets CPU and memory by VM tier: choose one in vmTier.');
    if (spec.image !== undefined && !/^[A-Za-z0-9_-]{1,64}$/u.test(spec.image)) throw new MayuraError('INVALID_INPUT', 'image must be a CodeSandbox template id.');
    if (Object.keys(spec.labels).length > 10) throw new MayuraError('INVALID_INPUT', 'CodeSandbox takes at most 10 labels.');
    let sandbox: { readonly id: string; connect(): Promise<CodeSandboxClientLike> };
    let client: CodeSandboxClientLike | undefined;
    try {
      const codesandbox = await connect();
      sandbox = await codesandbox.sandboxes.create({
        ...(spec.image ?? options.template ? { id: spec.image ?? options.template } : {}),
        // Private: CodeSandbox makes new sandboxes public otherwise.
        privacy: 'private', title: `mayura-${randomHex(8)}`, tags: Object.entries(spec.labels).map(([key, value]) => `${key}:${value}`),
        // The SDK's own tier when it was loaded here; the name for an SDK you gave.
        ...(options.vmTier ? { vmTier: tiers?.[options.vmTier] ?? options.vmTier } : {}),
        // CodeSandbox hibernates a sandbox idle this long, should a release never come; release deletes it at its lifetime.
        hibernationTimeoutSeconds: Math.min(86_400, Math.max(60, Math.ceil(spec.lifetimeMs / 1_000))),
      });
    } catch (error) { throw failure(error); }
    const release = async () => { client?.dispose(); try { await (await connect()).sandboxes.delete(sandbox.id); } catch (error) { throw failure(error); } };
    try {
      if (signal.aborted) throw new SandboxError('timeout');
      client = await sandbox.connect();
      await client.fs.mkdir(workdir, true);
    } catch (error) {
      await release().catch(() => undefined);
      throw failure(error);
    }
    const expiresAt = new Date(Date.now() + spec.lifetimeMs);
    /** Runs a helper command to its end; its exit code. */
    const run = async (argv: readonly string[]) => exitCodeOf(client.commands.run(line(argv), { env: { ...spec.env } }));
    /** Whether a path exists, asked of the shell (the file API's errors do not say). */
    const exists = async (path: string) => (await run(['sh', '-c', '[ -e "$1" ] || [ -L "$1" ]', 'mayura', path])) === 0;
    /** A path's type and size, or undefined when there is none. */
    const stat = async (path: string) => {
      try { return await client.fs.stat(path); } catch (error) {
        if (!await exists(path)) return undefined;
        throw failure(error);
      }
    };
    /** The start of a file: at most `max` bytes, and its size. */
    const head = async (path: string, max: number) => {
      const info = await stat(path);
      if (!info || info.type !== 'file') return undefined;
      if (info.size <= max) return { data: await client.fs.readFile(path), size: info.size };
      const part = `${path}.head`;
      if (await run(['sh', '-c', 'head -c "$2" -- "$1" > "$3"', 'mayura', path, String(max), part]) !== 0) throw new SandboxError('rejected');
      try { return { data: await client.fs.readFile(part), size: info.size }; } finally { void client.fs.remove(part).catch(() => undefined); }
    };

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
          if (stdin) { try { await client.fs.writeFile(`${base}.in`, stdin, { create: true, overwrite: true }); } catch (error) { throw failure(error); } }
          const started = await client.commands.runBackground(line(['sh', '-c', execScript, 'mayura', `${base}.out`, `${base}.err`, stdin ? `${base}.in` : '-', execOptions.cwd, ...command]),
            { env: { ...spec.env, ...execOptions.env, [sandboxScripts.tagVariable]: tag } }).catch(error => { throw failure(error); });
          let exitCode: number | undefined;
          await new Promise<void>((resolve, reject) => {
            // Ending the call ends the command: CodeSandbox kills its shell, and the tag finds what it started.
            const onAbort = () => { void Promise.allSettled([started.kill(), run(['sh', '-c', sandboxScripts.kill, 'mayura', tag])]).finally(() => resolve()); };
            if (execOptions.signal.aborted) { onAbort(); return; }
            execOptions.signal.addEventListener('abort', onAbort, { once: true });
            exitCodeOf(started.waitUntilComplete()).then(code => { exitCode = code; execOptions.signal.removeEventListener('abort', onAbort); resolve(); },
              error => { execOptions.signal.removeEventListener('abort', onAbort); reject(error); });
          });
          const result = await output();
          // A command stopped because the call ended has no exit code.
          return execOptions.signal.aborted || exitCode === undefined ? result : { exitCode, ...result };
        } finally {
          void run(['rm', '-f', '--', `${base}.out`, `${base}.err`, `${base}.in`]).catch(() => undefined);
        }
      },
      readFile: async (path, { maxBytes }) => {
        const info = await stat(path).catch(error => { throw failure(error); });
        if (!info) return undefined;
        if (info.type !== 'file') throw new MayuraError('INVALID_INPUT', 'That path is not a file.');
        if (info.size > maxBytes) throw new MayuraError('LIMIT_EXCEEDED', `The file is larger than ${maxBytes} bytes.`);
        try { return await client.fs.readFile(path); } catch (error) { throw failure(error); }
      },
      writeFile: async (path, data) => {
        const info = await stat(path).catch(error => { throw failure(error); });
        if (info?.type === 'directory') throw new MayuraError('INVALID_INPUT', 'A directory is at that path.');
        try {
          const parent = path.slice(0, path.lastIndexOf('/'));
          if (parent) await client.fs.mkdir(parent, true);
          await client.fs.writeFile(path, data, { create: true, overwrite: true });
        } catch (error) { throw failure(error); }
      },
      listFiles: async (path, { limit }) => {
        // Sizes and times come from one listing in the sandbox, read back as a file.
        // In a hidden directory of its own, so a listing of /tmp does not show it.
        const listing = `/tmp/.mayura-lists/${randomHex(8)}`;
        const code = await run(['sh', '-c', `mkdir -p /tmp/.mayura-lists && { ${sandboxScripts.list}
} > "$3"`, 'mayura', path, String(limit), listing]);
        try {
          if (code === 3) return undefined;
          if (code === 4) throw new MayuraError('INVALID_INPUT', 'That path is not a directory.');
          if (code !== 0) throw new SandboxError('rejected');
          return parseSandboxListing(await client.fs.readFile(listing));
        } finally { void client.fs.remove(listing).catch(() => undefined); }
      },
      removeFile: async (path, { recursive }) => {
        const info = await stat(path).catch(error => { throw failure(error); });
        if (!info) return;
        if (!recursive && info.type === 'directory' && (await client.fs.readdir(path)).length > 0) throw new MayuraError('INVALID_INPUT', 'The directory is not empty; remove it with recursive.');
        try { await client.fs.remove(path, recursive); } catch (error) { throw failure(error); }
      },
      url: async port => {
        // A private sandbox's port is reached with a host token, valid while the sandbox lives.
        try { const codesandbox = await connect(); return codesandbox.hosts.getUrl(await codesandbox.hosts.createToken(sandbox.id, { expiresAt }), port); }
        catch (error) { throw failure(error); }
      },
      release: () => release(),
    };
  };

  return Object.freeze({
    id: 'codesandbox', workdir, maxLifetimeMs,
    // CodeSandbox VMs reach the internet, with no egress controls here: 'none' cannot be enforced.
    features: Object.freeze({ stdin: true, ports: true, desktop: false, network: Object.freeze(['all'] as const) }),
    create,
  });
}
