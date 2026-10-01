import type { Readable, Writable } from 'node:stream';
import { MayuraError } from 'mayura';
import {
  parseSandboxListing, SandboxError, sandboxScripts,
  type BackendExecResult, type ProviderSandboxSpec, type SandboxBackend, type SandboxProvider,
} from 'mayura/sandbox';
import { ApiClient, ApiClientInMemoryContextProvider } from '@northflank/js-client';

/** The part of an exec session this provider uses; one from `ApiClient#exec.execServiceSession` is one. */
export interface NorthflankExecLike {
  readonly stdOut: Readable;
  readonly stdErr: Readable;
  readonly stdIn: Writable;
  waitForCommandResult(): Promise<{ readonly exitCode: number }>;
}
/** The part of an `ApiClient` from `@northflank/js-client` this provider uses. */
export interface NorthflankClientLike {
  readonly create: { readonly service: { deployment(request: { parameters: Record<string, string>; data: Record<string, unknown> }): Promise<{ readonly data: { readonly id: string } }> } };
  readonly delete: { service(request: { parameters: Record<string, string> }): Promise<unknown> };
  readonly exec: { execServiceSession(parameters: Record<string, string>, data: { command: string[] }): Promise<NorthflankExecLike> };
}

export interface NorthflankSandboxOptions {
  /** A Northflank API token. Give it, or `client`. Nothing is read from the environment. */
  readonly token?: string;
  /** An `ApiClient` you create and own, instead of `token`. */
  readonly client?: NorthflankClientLike;
  /** The project sandboxes are services in. */
  readonly projectId: string;
  /** The team that owns the project, for a team token. */
  readonly teamId?: string;
  /** The image sandboxes run, such as `ubuntu:24.04`. A sandbox's own `image` overrides it. */
  readonly image: string;
  /** The deployment plan, which sets CPU and memory; `nf-compute-20` by default. */
  readonly deploymentPlan?: string;
  /** The working directory, made when the sandbox starts; `/workspace` by default. */
  readonly workdir?: string;
  /** The longest lifetime; 24 hours by default. */
  readonly maxLifetimeMs?: number;
}

const randomHex = (bytes: number) => Array.from(crypto.getRandomValues(new Uint8Array(bytes)), byte => byte.toString(16).padStart(2, '0')).join('');
// Commands run through sh in their directory, with their environment set by env (Northflank's exec takes none).
const execScript = 'cd -- "$1" || exit; shift; exec env "$@"';
const writeScript = '[ ! -d "$1" ] || exit 4; mkdir -p -- "$(dirname -- "$1")" || exit; cat > "$1"';
function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(new SandboxError('timeout')); return; }
    const onAbort = () => { clearTimeout(timer); reject(new SandboxError('timeout')); };
    const timer = setTimeout(() => { signal.removeEventListener('abort', onAbort); resolve(); }, ms);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

/** Reads a Node stream to its end, keeping at most `max` bytes; stopping `stop` ends the reading. */
function collect(stream: Readable, max: number, stop: AbortSignal): Promise<{ data: Uint8Array; more: boolean }> {
  return new Promise(resolve => {
    const chunks: Uint8Array[] = []; let kept = 0; let more = false; let done = false;
    const finish = () => {
      if (done) return; done = true; stop.removeEventListener('abort', finish);
      const data = new Uint8Array(kept); let offset = 0;
      for (const chunk of chunks) { data.set(chunk, offset); offset += chunk.byteLength; }
      resolve({ data, more });
    };
    stream.on('data', (chunk: Uint8Array | string) => {
      const bytes = typeof chunk === 'string' ? new TextEncoder().encode(chunk) : chunk;
      const room = max - kept;
      if (bytes.byteLength > room) more = true;
      if (room > 0) { const part = bytes.byteLength > room ? bytes.subarray(0, room) : bytes; chunks.push(Uint8Array.from(part)); kept += part.byteLength; }
    });
    stream.on('end', finish); stream.on('close', finish); stream.on('error', finish);
    if (stop.aborted) finish(); else stop.addEventListener('abort', finish, { once: true });
  });
}

/** A Northflank failure as a sandbox failure, without Northflank's text. */
function failure(error: unknown): SandboxError | MayuraError {
  if (error instanceof MayuraError) return error;
  const status = (error as { status?: unknown } | null)?.status;
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
 * Northflank sandboxes (northflank.com): a microVM service per sandbox, through Northflank's JavaScript client. Node
 * only. Northflank services reach the internet, so sandboxes are created only with the network `'all'`, allowed and
 * asked for. Give the result to `createSandboxes` from `mayura/sandbox`.
 */
export function northflankSandboxes(options: NorthflankSandboxOptions): SandboxProvider {
  if (!options || typeof options !== 'object') throw new MayuraError('INVALID_CONFIG', 'northflankSandboxes() needs options.');
  if (options.client === undefined && (typeof options.token !== 'string' || !/^[!-~]{8,8192}$/u.test(options.token))) throw new MayuraError('INVALID_CONFIG', 'northflankSandboxes(): give token, or a client.');
  if (options.client !== undefined && (typeof options.client !== 'object' || !options.client.exec || !options.client.create)) throw new MayuraError('INVALID_CONFIG', 'northflankSandboxes(): client must be an ApiClient.');
  for (const [name, value] of [['projectId', options.projectId], ['teamId', options.teamId], ['deploymentPlan', options.deploymentPlan]] as const) {
    if ((value !== undefined || name === 'projectId') && (typeof value !== 'string' || !/^[a-z0-9][a-z0-9-]{0,63}$/u.test(value))) throw new MayuraError('INVALID_CONFIG', `northflankSandboxes(): ${name} must be a Northflank id.`);
  }
  if (typeof options.image !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._/:@-]{0,511}$/u.test(options.image)) throw new MayuraError('INVALID_CONFIG', 'northflankSandboxes(): image must be an image reference.');
  const workdir = options.workdir ?? '/workspace';
  if (typeof workdir !== 'string' || !/^\/(?:[A-Za-z0-9._-]+\/)*[A-Za-z0-9._-]+$/u.test(workdir) || workdir.split('/').some(part => part === '.' || part === '..')) {
    throw new MayuraError('INVALID_CONFIG', 'northflankSandboxes(): workdir must be an absolute, normalized path.');
  }
  const maxLifetimeMs = options.maxLifetimeMs ?? 86_400_000;
  if (!Number.isSafeInteger(maxLifetimeMs) || maxLifetimeMs < 60_000 || maxLifetimeMs > 2_147_483_647) throw new MayuraError('INVALID_CONFIG', 'northflankSandboxes(): maxLifetimeMs is 1 minute to about 24 days.');
  let client = options.client;
  const northflank = (): NorthflankClientLike => {
    if (client) return client;
    const contexts = new ApiClientInMemoryContextProvider();
    contexts.addContext({ name: 'mayura', token: options.token! });
    client = new ApiClient(contexts, { throwErrorOnHttpErrorCode: true }) as unknown as NorthflankClientLike;
    return client;
  };
  const project = { projectId: options.projectId, ...(options.teamId ? { teamId: options.teamId } : {}) };

  const create = async (spec: ProviderSandboxSpec, { signal }: { readonly signal: AbortSignal }): Promise<SandboxBackend> => {
    // northflankSandboxes declares only 'all', so createSandboxes asks for nothing else.
    if (spec.cpus !== undefined || spec.memoryMiB !== undefined) throw new MayuraError('INVALID_INPUT', 'Northflank sets CPU and memory by deployment plan: choose one in deploymentPlan.');
    if (spec.image !== undefined && !/^[A-Za-z0-9][A-Za-z0-9._/:@-]{0,511}$/u.test(spec.image)) throw new MayuraError('INVALID_INPUT', 'image must be an image reference.');
    let serviceId: string;
    try {
      const created = await northflank().create.service.deployment({ parameters: project, data: {
        name: `mayura-${randomHex(8)}`, tags: Object.entries(spec.labels).map(([key, value]) => `${key}-${value}`.replace(/[^a-z0-9-]/gu, '-').slice(0, 39)),
        billing: { deploymentPlan: options.deploymentPlan ?? 'nf-compute-20' },
        deployment: {
          instances: 1, external: { imagePath: spec.image ?? options.image },
          // The service only sleeps; commands run in it through exec. Mayura ends it with its lifetime.
          docker: { configType: 'customEntrypointCustomCommand', customEntrypoint: '/bin/sh', customCommand: "-c 'sleep infinity'" },
        },
        runtimeEnvironment: { ...spec.env },
      } });
      serviceId = created.data.id;
    } catch (error) { throw failure(error); }
    if (typeof serviceId !== 'string' || !/^[a-z0-9][a-z0-9-]{0,63}$/u.test(serviceId)) throw new SandboxError('invalid_response');
    const service = { ...project, serviceId };
    const release = async () => { try { await northflank().delete.service({ parameters: service }); } catch (error) { throw failure(error); } };

    /** Runs a command, giving it `stdin`, and reads up to `max` bytes of each stream; stopping `stop` ends the reading. */
    const run = async (command: readonly string[], runOptions: { readonly stdin?: Uint8Array; readonly max: number; readonly stop: AbortSignal }) => {
      const session = await northflank().exec.execServiceSession(service, { command: [...command] });
      const out = collect(session.stdOut, runOptions.max, runOptions.stop);
      const err = collect(session.stdErr, runOptions.max, runOptions.stop);
      if (runOptions.stdin?.byteLength) session.stdIn.write(runOptions.stdin);
      session.stdIn.end();
      const exitCode = await Promise.race([session.waitForCommandResult().then(result => result.exitCode), new Promise<undefined>(resolve => {
        if (runOptions.stop.aborted) resolve(undefined); else runOptions.stop.addEventListener('abort', () => resolve(undefined), { once: true });
      })]);
      const [stdout, stderr] = await Promise.all([out, err]);
      return { exitCode, stdout: stdout.data, stderr: stderr.data, truncated: stdout.more || stderr.more };
    };
    const script = (body: string, args: readonly string[]) => ['sh', '-c', body, 'mayura', ...args];
    const fileCall = async (body: string, args: readonly string[], max: number, callSignal: AbortSignal, stdin?: Uint8Array) => {
      try {
        const result = await run(script(body, args), { max, stop: callSignal, ...(stdin ? { stdin } : {}) });
        if (result.exitCode === undefined) throw new SandboxError('timeout');
        return result;
      } catch (error) { throw failure(error); }
    };

    try {
      // Ready when a command runs in it; then make the working directory.
      for (let delay = 1_000; ; delay = Math.min(delay * 1.5, 5_000)) {
        const made = await fileCall('mkdir -p -- "$1"', [workdir], 4_096, signal).catch(error => {
          if (error instanceof SandboxError && error.reason === 'timeout') throw error;
          return undefined;
        });
        if (made?.exitCode === 0) break;
        if (made !== undefined) throw new SandboxError('rejected');
        await sleep(delay, signal);
      }
    } catch (error) {
      await release().catch(() => undefined);
      throw error;
    }

    return {
      id: serviceId,
      exec: async (command, execOptions): Promise<BackendExecResult> => {
        const tag = randomHex(12);
        const stop = new AbortController();
        // Ending the call ends the command: every process carrying its tag is killed, then the streams close.
        const onAbort = () => {
          void run(script(sandboxScripts.kill, [tag]), { max: 4_096, stop: AbortSignal.timeout(8_000) }).catch(() => undefined).finally(() => stop.abort());
        };
        if (execOptions.signal.aborted) onAbort(); else execOptions.signal.addEventListener('abort', onAbort, { once: true });
        try {
          const assignments = Object.entries({ ...execOptions.env, [sandboxScripts.tagVariable]: tag }).map(([name, value]) => `${name}=${value}`);
          const result = await run(['sh', '-c', execScript, 'mayura', execOptions.cwd, ...assignments, ...command],
            { max: execOptions.maxOutputBytes, stop: stop.signal, ...(execOptions.stdin ? { stdin: execOptions.stdin } : {}) });
          const output = { stdout: result.stdout, stderr: result.stderr, truncated: result.truncated };
          // A command stopped because the call ended has no exit code.
          return execOptions.signal.aborted || result.exitCode === undefined ? output : { exitCode: result.exitCode, ...output };
        } catch (error) {
          if (execOptions.signal.aborted) return { stdout: new Uint8Array(0), stderr: new Uint8Array(0) };
          throw failure(error);
        } finally { execOptions.signal.removeEventListener('abort', onAbort); }
      },
      readFile: async (path, { maxBytes, signal: callSignal }) => {
        const result = await fileCall(sandboxScripts.read, [path, String(maxBytes)], maxBytes + 1, callSignal);
        if (result.exitCode === 3) return undefined;
        if (result.exitCode === 4) throw new MayuraError('INVALID_INPUT', 'That path is not a file.');
        if (result.exitCode === 6 || result.stdout.byteLength > maxBytes) throw new MayuraError('LIMIT_EXCEEDED', `The file is larger than ${maxBytes} bytes.`);
        if (result.exitCode !== 0) throw new SandboxError('rejected');
        return result.stdout;
      },
      writeFile: async (path, data, { signal: callSignal }) => {
        const result = await fileCall(writeScript, [path], 4_096, callSignal, data);
        if (result.exitCode === 4) throw new MayuraError('INVALID_INPUT', 'A directory is at that path.');
        if (result.exitCode !== 0) throw new SandboxError('rejected');
      },
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
      release: () => release(),
    };
  };

  return Object.freeze({
    id: 'northflank', workdir, maxLifetimeMs,
    // Northflank services reach the internet, with no egress controls here: 'none' cannot be enforced.
    features: Object.freeze({ stdin: true, ports: false, desktop: false, network: Object.freeze(['all'] as const) }),
    create,
  });
}
