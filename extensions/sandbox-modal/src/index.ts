import { MayuraError } from 'mayura';
import {
  parseSandboxListing, SandboxError, sandboxScripts,
  type BackendExecResult, type ProviderSandboxSpec, type SandboxBackend, type SandboxFailureReason, type SandboxProvider,
} from 'mayura/sandbox';
import { ModalClient, type Sandbox as ModalSandbox, type SandboxCreateParams } from 'modal';

export interface ModalSandboxOptions {
  /** A Modal token id and secret (`modal token new`). Give these, or `client`. */
  readonly tokenId?: string;
  readonly tokenSecret?: string;
  /** The Modal environment; your default otherwise. */
  readonly environment?: string;
  /**
   * A `ModalClient` from `modal` you create and own, instead of a token. It is never closed here. (Typed by its shape,
   * so these types do not load Modal's.)
   */
  readonly client?: { readonly apps: object; readonly images: object; readonly sandboxes: object };
  /** The Modal App sandboxes belong to, created if missing; `mayura-sandboxes` by default. */
  readonly app?: string;
  /** The image sandboxes run, from a registry, such as `python:3.13-slim`. A sandbox's own `image` overrides it. */
  readonly image: string;
  /** The working directory, made when the sandbox starts; `/workspace` by default. */
  readonly workdir?: string;
  /** `gvisor` or `vm` (which can run Docker); Modal's choice by default. */
  readonly runtime?: 'gvisor' | 'vm';
  /** The regions sandboxes may run in, such as `['us-east-1']`. */
  readonly regions?: readonly string[];
  /** The longest lifetime; 24 hours by default, Modal's most. */
  readonly maxLifetimeMs?: number;
}

const randomHex = (bytes: number) => Array.from(crypto.getRandomValues(new Uint8Array(bytes)), byte => byte.toString(16).padStart(2, '0')).join('');
// Commands run through sh, so a missing program or directory is a failed command, as on every provider.
const execScript = 'cd -- "$1" || exit; shift; exec "$@"';
const writeScript = '[ ! -d "$1" ] || exit 4; mkdir -p -- "$(dirname -- "$1")" || exit; cat > "$1"';

/** Reads a stream to its end, keeping at most `max` bytes. */
async function collect(stream: ReadableStream<Uint8Array>, max: number, stop: AbortSignal): Promise<{ data: Uint8Array; more: boolean }> {
  const chunks: Uint8Array[] = []; let kept = 0; let more = false;
  const reader = stream.getReader();
  const onStop = () => { void reader.cancel().catch(() => undefined); };
  if (stop.aborted) onStop(); else stop.addEventListener('abort', onStop, { once: true });
  try {
    for (;;) {
      const { done, value } = await reader.read().catch(() => ({ done: true as const, value: undefined }));
      if (done) break;
      const room = max - kept;
      if (value.byteLength > room) more = true;
      if (room > 0) { const part = value.byteLength > room ? value.subarray(0, room) : value; chunks.push(part); kept += part.byteLength; }
    }
  } finally { stop.removeEventListener('abort', onStop); }
  const data = new Uint8Array(kept); let offset = 0;
  for (const chunk of chunks) { data.set(chunk, offset); offset += chunk.byteLength; }
  return { data, more };
}

/** A Modal failure as a sandbox failure, without Modal's text. */
function failure(error: unknown): SandboxError | MayuraError {
  if (error instanceof MayuraError) return error;
  const name = (error as { name?: unknown; constructor?: { name?: unknown } } | null)?.constructor?.name ?? (error as { name?: unknown } | null)?.name;
  const byName: Readonly<Record<string, SandboxFailureReason>> = {
    NotFoundError: 'gone', InvalidError: 'rejected', ConflictError: 'rejected', AlreadyExistsError: 'rejected', ResourceExhaustedError: 'quota',
    TimeoutError: 'timeout', SandboxTimeoutError: 'gone', InternalFailure: 'unavailable', ClientClosedError: 'unavailable',
  };
  if (typeof name === 'string' && byName[name]) return new SandboxError(byName[name]!);
  // gRPC status codes, as nice-grpc reports them.
  const byCode: Readonly<Record<number, SandboxFailureReason>> = { 3: 'rejected', 4: 'timeout', 5: 'gone', 7: 'authentication', 8: 'rate_limited', 14: 'unavailable', 16: 'authentication' };
  const code = (error as { code?: unknown } | null)?.code;
  if (typeof code === 'number' && byCode[code]) return new SandboxError(byCode[code]!);
  return new SandboxError('unavailable');
}

/**
 * Modal Sandboxes (modal.com): gVisor or VM sandboxes, through Modal's JavaScript SDK (`modal`). Runs on Node, Deno and
 * Bun. Give the result to `createSandboxes` from `mayura/sandbox`.
 */
export function modalSandboxes(options: ModalSandboxOptions): SandboxProvider {
  if (!options || typeof options !== 'object') throw new MayuraError('INVALID_CONFIG', 'modalSandboxes() needs options.');
  if (options.client === undefined) {
    if (typeof options.tokenId !== 'string' || !/^[!-~]{4,256}$/u.test(options.tokenId) || typeof options.tokenSecret !== 'string' || !/^[!-~]{4,256}$/u.test(options.tokenSecret)) {
      throw new MayuraError('INVALID_CONFIG', 'modalSandboxes(): give tokenId and tokenSecret, or a client.');
    }
  } else if (typeof options.client !== 'object' || !options.client.sandboxes) throw new MayuraError('INVALID_CONFIG', 'modalSandboxes(): client must be a ModalClient.');
  if (options.environment !== undefined && (typeof options.environment !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/u.test(options.environment))) throw new MayuraError('INVALID_CONFIG', 'modalSandboxes(): environment must be a Modal environment name.');
  const appName = options.app ?? 'mayura-sandboxes';
  if (typeof appName !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u.test(appName)) throw new MayuraError('INVALID_CONFIG', 'modalSandboxes(): app must be a Modal App name.');
  if (typeof options.image !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._/:@-]{0,511}$/u.test(options.image)) throw new MayuraError('INVALID_CONFIG', 'modalSandboxes(): image must be an image reference.');
  const workdir = options.workdir ?? '/workspace';
  if (typeof workdir !== 'string' || !/^\/(?:[A-Za-z0-9._-]+\/)*[A-Za-z0-9._-]+$/u.test(workdir) || workdir.split('/').some(part => part === '.' || part === '..')) {
    throw new MayuraError('INVALID_CONFIG', 'modalSandboxes(): workdir must be an absolute, normalized path.');
  }
  if (options.runtime !== undefined && options.runtime !== 'gvisor' && options.runtime !== 'vm') throw new MayuraError('INVALID_CONFIG', "modalSandboxes(): runtime is 'gvisor' or 'vm'.");
  if (options.regions !== undefined && (!Array.isArray(options.regions) || options.regions.some(region => typeof region !== 'string' || !/^[a-z0-9-]{2,32}$/u.test(region)))) throw new MayuraError('INVALID_CONFIG', 'modalSandboxes(): regions are Modal region names.');
  const maxLifetimeMs = options.maxLifetimeMs ?? 86_400_000;
  if (!Number.isSafeInteger(maxLifetimeMs) || maxLifetimeMs < 1_000 || maxLifetimeMs > 86_400_000) throw new MayuraError('INVALID_CONFIG', 'modalSandboxes(): maxLifetimeMs is 1 s to 24 hours.');
  let client = options.client as ModalClient | undefined;
  // Made on first use, from the token only: nothing else is read for it.
  const modal = () => (client ??= new ModalClient({ tokenId: options.tokenId!, tokenSecret: options.tokenSecret!, ...(options.environment ? { environment: options.environment } : {}) }));

  const create = async (spec: ProviderSandboxSpec, { signal }: { readonly signal: AbortSignal }): Promise<SandboxBackend> => {
    if (spec.image !== undefined && !/^[A-Za-z0-9][A-Za-z0-9._/:@-]{0,511}$/u.test(spec.image)) throw new MayuraError('INVALID_INPUT', 'image must be an image reference.');
    const network: Partial<SandboxCreateParams> = spec.network === 'none' ? { blockNetwork: true } : spec.network === 'all' ? {} : { outboundDomainAllowlist: [...spec.network.allow] };
    let sandbox: ModalSandbox;
    try {
      const app = await modal().apps.fromName(appName, { createIfMissing: true, ...(options.environment ? { environment: options.environment } : {}) });
      if (signal.aborted) throw new SandboxError('timeout');
      sandbox = await modal().sandboxes.create(app, modal().images.fromRegistry(spec.image ?? options.image), {
        // The lifetime is Modal's timeout, after which it ends the sandbox; its main process sleeps until then.
        timeoutMs: spec.lifetimeMs, env: { ...spec.env }, tags: { ...spec.labels }, name: `mayura-${randomHex(12)}`, ...network,
        ...(spec.ports.length > 0 ? { encryptedPorts: [...spec.ports] } : {}),
        ...(spec.cpus === undefined ? {} : { cpu: spec.cpus }), ...(spec.memoryMiB === undefined ? {} : { memoryMiB: spec.memoryMiB }),
        ...(options.runtime ? { runtime: options.runtime } : {}), ...(options.regions ? { regions: [...options.regions] } : {}),
      });
    } catch (error) { throw failure(error); }
    const release = async () => { try { await sandbox.terminate(); } catch (error) { throw failure(error); } };

    /** Runs a command, giving it `stdin`, and reads up to `max` bytes of each stream; stopping `stop` ends the reading. */
    const run = async (command: readonly string[], runOptions: { readonly env?: Readonly<Record<string, string>>; readonly stdin?: Uint8Array; readonly max: number; readonly stop: AbortSignal }) => {
      const process = await sandbox.exec([...command], { mode: 'binary', ...(runOptions.env ? { env: { ...runOptions.env } } : {}) });
      const out = collect(process.stdout as ReadableStream<Uint8Array>, runOptions.max, runOptions.stop);
      const err = collect(process.stderr as ReadableStream<Uint8Array>, runOptions.max, runOptions.stop);
      if (runOptions.stdin?.byteLength) await process.stdin.writeBytes(runOptions.stdin);
      await process.closeStdin();
      const exitCode = await Promise.race([process.wait(), new Promise<undefined>(resolve => {
        if (runOptions.stop.aborted) resolve(undefined); else runOptions.stop.addEventListener('abort', () => resolve(undefined), { once: true });
      })]);
      const [stdout, stderr] = await Promise.all([out, err]);
      return { exitCode, stdout: stdout.data, stderr: stderr.data, truncated: stdout.more || stderr.more };
    };
    const script = (body: string, args: readonly string[]) => ['sh', '-c', body, 'mayura', ...args];
    /** Runs one of the file scripts to its end. */
    const fileCall = async (body: string, args: readonly string[], max: number, signal: AbortSignal, stdin?: Uint8Array) => {
      try {
        const result = await run(script(body, args), { max, stop: signal, ...(stdin ? { stdin } : {}) });
        if (result.exitCode === undefined) throw new SandboxError('timeout');
        return result;
      } catch (error) { throw failure(error); }
    };

    try {
      const made = await fileCall('mkdir -p -- "$1"', [workdir], 4_096, signal);
      if (made.exitCode !== 0) throw new SandboxError('rejected');
    } catch (error) {
      await release().catch(() => undefined);
      throw error;
    }

    return {
      id: sandbox.sandboxId,
      exec: async (command, execOptions): Promise<BackendExecResult> => {
        const tag = randomHex(12);
        const stop = new AbortController();
        // Ending the call ends the command: every process carrying its tag is killed, then the streams close.
        const onAbort = () => {
          void run(script(sandboxScripts.kill, [tag]), { max: 4_096, stop: AbortSignal.timeout(8_000) }).catch(() => undefined).finally(() => stop.abort());
        };
        if (execOptions.signal.aborted) onAbort(); else execOptions.signal.addEventListener('abort', onAbort, { once: true });
        try {
          const result = await run(['sh', '-c', execScript, 'mayura', execOptions.cwd, ...command], {
            env: { ...execOptions.env, [sandboxScripts.tagVariable]: tag }, max: execOptions.maxOutputBytes, stop: stop.signal, ...(execOptions.stdin ? { stdin: execOptions.stdin } : {}) });
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
      url: async port => {
        try {
          const tunnel = (await sandbox.tunnels())[port];
          if (!tunnel) throw new SandboxError('invalid_response');
          return tunnel.url;
        } catch (error) { throw failure(error); }
      },
      release: () => release(),
    };
  };

  return Object.freeze({
    id: 'modal', workdir, maxLifetimeMs,
    features: Object.freeze({ stdin: true, ports: true, desktop: false, network: Object.freeze(['none', 'all', 'allowlist'] as const) }),
    create,
  });
}
