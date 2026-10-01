import { MayuraError } from 'mayura';
import {
  parseSandboxListing, SandboxError, sandboxHttpFailure, sandboxResponseFailure, sandboxScripts,
  type BackendExecResult, type ProviderSandboxSpec, type SandboxBackend, type SandboxProvider,
} from 'mayura/sandbox';

export interface CloudflareSandboxOptions {
  /** The URL of your sandbox bridge Worker, such as `https://sandbox-bridge.example.workers.dev`. */
  readonly bridgeUrl: string;
  /** The bridge's `SANDBOX_API_KEY`. Nothing is read from the environment. */
  readonly apiKey: string;
  /** The longest lifetime; 24 hours by default. */
  readonly maxLifetimeMs?: number;
  /** For tests and proxies: the fetch to use. */
  readonly fetch?: typeof fetch;
}

const workdir = '/workspace';
const randomHex = (bytes: number) => Array.from(crypto.getRandomValues(new Uint8Array(bytes)), byte => byte.toString(16).padStart(2, '0')).join('');
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
function fromBase64(text: string): Uint8Array {
  const binary = atob(text); const data = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) data[index] = binary.charCodeAt(index);
  return data;
}
/**
 * Runs a command in its directory, with its environment from a file (read and removed first: the bridge takes none) and
 * its standard input from a file. $1: the directory; $2: the environment file, or `-`; $3: the input file, or `-`; the
 * command follows.
 */
const execScript = [
  'cd -- "$1" || exit',
  'if [ "$2" != - ]; then _mayura_e=$(cat -- "$2"); rm -f -- "$2"; eval "$_mayura_e"; unset _mayura_e; fi',
  '_mayura_in=$3; shift 3',
  'if [ "$_mayura_in" = - ]; then exec "$@" </dev/null; fi',
  'exec "$@" <"$_mayura_in"',
].join('\n');
/** Moves a staged upload into place, making its directories. $1: the upload; $2: the path. Exit 4: a directory is there. */
const placeScript = '[ ! -d "$2" ] || { rm -f -- "$1"; exit 4; }; mkdir -p -- "$(dirname -- "$2")" && mv -f -- "$1" "$2"';

/** Keeps a stream's bytes up to a bound, noting what it drops. */
class Collector {
  private readonly chunks: Uint8Array[] = []; private kept = 0; truncated = false;
  constructor(private readonly max: number) {}
  push(chunk: Uint8Array): void {
    const room = this.max - this.kept;
    if (chunk.byteLength > room) this.truncated = true;
    if (room <= 0) return;
    const part = chunk.byteLength > room ? chunk.subarray(0, room) : chunk;
    this.chunks.push(part); this.kept += part.byteLength;
  }
  bytes(): Uint8Array {
    const data = new Uint8Array(this.kept); let offset = 0;
    for (const chunk of this.chunks) { data.set(chunk, offset); offset += chunk.byteLength; }
    return data;
  }
}

/**
 * Cloudflare Sandboxes (containers driven by Durable Objects), through the sandbox bridge: Cloudflare's reference Worker
 * that exposes the Sandbox SDK over HTTP, deployed in your account. Over fetch with no dependencies, from any runtime.
 * Cloudflare sandboxes reach the internet, so they are created only with the network `'all'`, allowed and asked for.
 * Give the result to `createSandboxes` from `mayura/sandbox`.
 */
export function cloudflareSandboxes(options: CloudflareSandboxOptions): SandboxProvider {
  if (!options || typeof options.apiKey !== 'string' || !/^[!-~]{8,4096}$/u.test(options.apiKey)) throw new MayuraError('INVALID_CONFIG', 'cloudflareSandboxes(): apiKey must be the bridge\'s SANDBOX_API_KEY.');
  const bridge = (() => {
    try { const url = new URL(options.bridgeUrl); if (url.protocol !== 'https:' && url.hostname !== '127.0.0.1' && url.hostname !== 'localhost') throw new Error(); return url.origin + url.pathname.replace(/\/$/u, ''); }
    catch { throw new MayuraError('INVALID_CONFIG', 'cloudflareSandboxes(): bridgeUrl must be the https URL of your sandbox bridge Worker.'); }
  })();
  const maxLifetimeMs = options.maxLifetimeMs ?? 86_400_000;
  if (!Number.isSafeInteger(maxLifetimeMs) || maxLifetimeMs < 1_000 || maxLifetimeMs > 2_147_483_647) throw new MayuraError('INVALID_CONFIG', 'cloudflareSandboxes(): maxLifetimeMs is 1 s to about 24 days.');
  if (options.fetch !== undefined && typeof options.fetch !== 'function') throw new MayuraError('INVALID_CONFIG', 'cloudflareSandboxes(): fetch must be a function.');
  const fetcher = options.fetch ?? globalThis.fetch;
  const headers = (extra: Record<string, string> = {}) => ({ authorization: `Bearer ${options.apiKey}`, ...extra });

  const create = async (spec: ProviderSandboxSpec, { signal }: { readonly signal: AbortSignal }): Promise<SandboxBackend> => {
    // cloudflareSandboxes declares only 'all', so createSandboxes asks for nothing else.
    if (spec.image !== undefined || spec.cpus !== undefined || spec.memoryMiB !== undefined) throw new MayuraError('INVALID_INPUT', 'The bridge\'s image and instance type are set where it is deployed.');
    const created = await fetcher(`${bridge}/v1/sandbox`, { method: 'POST', signal, headers: headers() });
    if (created.status === 404) { void created.body?.cancel().catch(() => undefined); throw new SandboxError('rejected', 404); }
    if (!created.ok) throw sandboxResponseFailure(created);
    const id = (await created.json().catch(() => undefined) as { id?: unknown } | undefined)?.id;
    if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/u.test(id)) throw new SandboxError('invalid_response');
    const base = `${bridge}/v1/sandbox/${id}`;
    const release = async (callSignal: AbortSignal) => {
      const reply = await fetcher(base, { method: 'DELETE', signal: callSignal, headers: headers() });
      void reply.body?.cancel().catch(() => undefined);
      if (!reply.ok) throw sandboxHttpFailure(reply.status);
    };

    /** Runs a command through the bridge's exec and reads its event stream; stopping `stop` ends the reading. */
    const run = async (argv: readonly string[], max: number, stop: AbortSignal, cwd = workdir) => {
      const reply = await fetcher(`${base}/exec`, { method: 'POST', signal: stop, headers: headers({ 'content-type': 'application/json' }), body: JSON.stringify({ argv, cwd }) });
      if (!reply.ok || !reply.body) throw sandboxResponseFailure(reply);
      const stdout = new Collector(max); const stderr = new Collector(max);
      const reader = reply.body.pipeThrough(new TextDecoderStream()).getReader();
      const onStop = () => { void reader.cancel().catch(() => undefined); };
      if (stop.aborted) onStop(); else stop.addEventListener('abort', onStop, { once: true });
      let exitCode: number | undefined; let pending = '';
      try {
        events: for (;;) {
          const { done, value } = await reader.read().catch(() => ({ done: true as const, value: undefined }));
          if (done) break;
          pending += value.replaceAll('\r\n', '\n');
          let boundary: number;
          while ((boundary = pending.indexOf('\n\n')) >= 0) {
            const frame = pending.slice(0, boundary); pending = pending.slice(boundary + 2);
            let event = 'message'; const data: string[] = [];
            for (const line of frame.split('\n')) {
              if (line.startsWith('event:')) event = line.slice(6).trim();
              else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /u, ''));
            }
            const payload = data.join('\n');
            if (event === 'stdout') stdout.push(fromBase64(payload));
            else if (event === 'stderr') stderr.push(fromBase64(payload));
            else if (event === 'exit') {
              // createSandboxes checks the exit code is an integer.
              exitCode = (JSON.parse(payload) as { exit_code?: number }).exit_code; break events;
            } else if (event === 'error') throw new SandboxError('rejected');
          }
          if (pending.length > 16 * 1_048_576) throw new SandboxError('invalid_response');
        }
      } catch (error) { if (error instanceof MayuraError) throw error; throw new SandboxError('invalid_response'); }
      finally { stop.removeEventListener('abort', onStop); void reader.cancel().catch(() => undefined); }
      return { exitCode, stdout: stdout.bytes(), stderr: stderr.bytes(), truncated: stdout.truncated || stderr.truncated };
    };
    const script = (body: string, args: readonly string[]) => ['sh', '-c', body, 'mayura', ...args];
    const fileCall = async (body: string, args: readonly string[], max: number, callSignal: AbortSignal) => {
      const result = await run(script(body, args), max, callSignal);
      if (result.exitCode === undefined) throw new SandboxError(callSignal.aborted ? 'timeout' : 'invalid_response');
      return result;
    };
    /** Uploads bytes under /workspace, where the bridge writes files, then moves them into place. */
    const place = async (path: string, data: Uint8Array, callSignal: AbortSignal) => {
      const staged = `.mayura-upload-${randomHex(12)}`;
      const reply = await fetcher(`${base}/file/${staged}`, { method: 'PUT', signal: callSignal, headers: headers({ 'content-type': 'application/octet-stream' }), body: data as Uint8Array<ArrayBuffer> });
      void reply.body?.cancel().catch(() => undefined);
      if (!reply.ok) throw sandboxHttpFailure(reply.status);
      const moved = await fileCall(placeScript, [`${workdir}/${staged}`, path], 4_096, callSignal);
      if (moved.exitCode === 4) throw new MayuraError('INVALID_INPUT', 'A directory is at that path.');
      if (moved.exitCode !== 0) throw new SandboxError('rejected');
    };

    try {
      // The bridge starts the container on first use: wait for a command to run in it.
      const ready = await fileCall('true', [], 4_096, signal);
      if (ready.exitCode !== 0) throw new SandboxError('rejected');
    } catch (error) {
      await release(AbortSignal.timeout(30_000)).catch(() => undefined);
      throw error;
    }

    return {
      id,
      exec: async (command, execOptions): Promise<BackendExecResult> => {
        const tag = randomHex(12); const temp = `/tmp/mayura-${tag}`;
        const stdin = execOptions.stdin?.byteLength ? execOptions.stdin : undefined;
        const env = { ...spec.env, ...execOptions.env, [sandboxScripts.tagVariable]: tag };
        const stop = new AbortController();
        // Ending the call ends the command: every process carrying its tag is killed, then the stream closes.
        const onAbort = () => {
          void run(script(sandboxScripts.kill, [tag]), 4_096, AbortSignal.timeout(8_000)).catch(() => undefined).finally(() => stop.abort());
        };
        if (execOptions.signal.aborted) onAbort(); else execOptions.signal.addEventListener('abort', onAbort, { once: true });
        try {
          await place(`${temp}.env`, new TextEncoder().encode(Object.entries(env).map(([name, value]) => `export ${name}=${quote(value)}\n`).join('')), execOptions.signal);
          if (stdin) await place(`${temp}.in`, stdin, execOptions.signal);
          const result = await run(script(execScript, [execOptions.cwd, `${temp}.env`, stdin ? `${temp}.in` : '-', ...command]), execOptions.maxOutputBytes, stop.signal);
          const output = { stdout: result.stdout, stderr: result.stderr, truncated: result.truncated };
          // A command stopped because the call ended has no exit code.
          return execOptions.signal.aborted || result.exitCode === undefined ? output : { exitCode: result.exitCode, ...output };
        } catch (error) {
          if (execOptions.signal.aborted) return { stdout: new Uint8Array(0), stderr: new Uint8Array(0) };
          throw error;
        } finally {
          execOptions.signal.removeEventListener('abort', onAbort);
          void run(['rm', '-f', '--', `${temp}.env`, `${temp}.in`], 4_096, AbortSignal.timeout(30_000)).catch(() => undefined);
        }
      },
      readFile: async (path, { maxBytes, signal: callSignal }) => {
        // Read through a command, which reaches any path and streams bytes exactly.
        const result = await fileCall(sandboxScripts.read, [path, String(maxBytes)], maxBytes + 1, callSignal);
        if (result.exitCode === 3) return undefined;
        if (result.exitCode === 4) throw new MayuraError('INVALID_INPUT', 'That path is not a file.');
        if (result.exitCode === 6) throw new MayuraError('LIMIT_EXCEEDED', `The file is larger than ${maxBytes} bytes.`);
        if (result.exitCode !== 0) throw new SandboxError('rejected');
        return result.stdout;
      },
      writeFile: (path, data, { signal: callSignal }) => place(path, data, callSignal),
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
    id: 'cloudflare', workdir, maxLifetimeMs,
    // Sandbox containers reach the internet unless the bridge's Worker blocks it, which the bridge does not tell.
    features: Object.freeze({ stdin: true, ports: false, desktop: false, network: Object.freeze(['all'] as const) }),
    create,
  });
}
