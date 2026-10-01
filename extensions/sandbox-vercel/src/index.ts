import { MayuraError } from 'mayura';
import {
  parseSandboxListing, SandboxError, sandboxHttpFailure, sandboxResponseFailure, sandboxScripts,
  type BackendExecResult, type ProviderSandboxSpec, type SandboxBackend, type SandboxProvider,
} from 'mayura/sandbox';

/** Vercel's managed runtimes; anything else given as a sandbox's `image` is a container image. */
export type VercelSandboxRuntime = 'node22' | 'node24' | 'node26' | 'python3.13';
const runtimes: readonly string[] = ['node22', 'node24', 'node26', 'python3.13'];

export interface VercelSandboxOptions {
  /** A Vercel access token, or the OIDC token of a Vercel deployment (`VERCEL_OIDC_TOKEN`). Nothing is read from the environment. */
  readonly token: string;
  /** The team that owns the sandboxes. */
  readonly teamId?: string;
  /** The project sandboxes belong to; needed with an access token. */
  readonly projectId?: string;
  /** The runtime sandboxes start with; `node24` by default. A sandbox's own `image` overrides it. */
  readonly runtime?: VercelSandboxRuntime;
  /** The region sandboxes run in, such as `iad1`; Vercel's choice by default. */
  readonly region?: string;
  /** The longest lifetime your plan allows; 45 minutes (Hobby) by default, up to 24 hours (Pro and Enterprise). */
  readonly maxLifetimeMs?: number;
  /** Vercel's API; `https://api.vercel.com` by default. */
  readonly apiUrl?: string;
  /** For tests and proxies: the fetch to use. */
  readonly fetch?: typeof fetch;
}

const encoder = new TextEncoder();
const randomHex = (bytes: number) => Array.from(crypto.getRandomValues(new Uint8Array(bytes)), byte => byte.toString(16).padStart(2, '0')).join('');
// Commands run through sh, so a missing program or directory is a failed command, as on every provider.
const execScript = 'cd -- "$1" || exit; shift; exec "$@"';

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

/** One tar header block. */
function tarHeader(name: string, size: number, type: '0' | 'x'): Uint8Array {
  const block = new Uint8Array(512);
  const put = (offset: number, length: number, text: string) => { block.set(encoder.encode(text).subarray(0, length), offset); };
  const octal = (value: number, length: number) => `${value.toString(8).padStart(length - 1, '0')}\u0000`;
  put(0, 100, name); put(100, 8, '0000644\u0000'); put(108, 8, '0000000\u0000'); put(116, 8, '0000000\u0000');
  put(124, 12, octal(size, 12)); put(136, 12, octal(Math.floor(Date.now() / 1_000), 12));
  put(148, 8, '        '); put(156, 1, type); put(257, 6, 'ustar\u0000'); put(263, 2, '00');
  const sum = block.reduce((total, byte) => total + byte, 0);
  put(148, 8, `${sum.toString(8).padStart(6, '0')}\u0000 `);
  return block;
}
/**
 * A tar archive of one file at `path` (relative to where it is extracted), with a PAX header carrying the exact path,
 * so long and non-ASCII paths survive.
 */
function tarOf(path: string, data: Uint8Array): Uint8Array {
  const record = (key: string, value: string) => {
    const body = ` ${key}=${value}\n`; const bodyBytes = encoder.encode(body).byteLength;
    let length = bodyBytes + 1;
    while (String(length).length + bodyBytes !== length) length = String(length).length + bodyBytes;
    return encoder.encode(`${length}${body}`);
  };
  const pax = record('path', path);
  const padded = (bytes: number) => Math.ceil(bytes / 512) * 512;
  const archive = new Uint8Array(512 + padded(pax.byteLength) + 512 + padded(data.byteLength) + 1_024);
  let offset = 0;
  archive.set(tarHeader('PaxHeader', pax.byteLength, 'x'), offset); offset += 512;
  archive.set(pax, offset); offset += padded(pax.byteLength);
  archive.set(tarHeader(path.length < 100 && /^[ -~]*$/u.test(path) ? path : 'mayura-file', data.byteLength, '0'), offset); offset += 512;
  archive.set(data, offset);
  return archive;
}
async function gzip(data: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await new Response(new Blob([data as Uint8Array<ArrayBuffer>]).stream().pipeThrough(new CompressionStream('gzip'))).arrayBuffer());
}

/**
 * Vercel Sandbox: Firecracker microVMs on Vercel, over Vercel's REST API with fetch and no dependencies. Give the result
 * to `createSandboxes` from `mayura/sandbox`.
 */
export function vercelSandboxes(options: VercelSandboxOptions): SandboxProvider {
  if (!options || typeof options.token !== 'string' || !/^[!-~]{8,4096}$/u.test(options.token)) throw new MayuraError('INVALID_CONFIG', 'vercelSandboxes(): token must be a Vercel access or OIDC token.');
  const token = options.token;
  for (const [name, value] of [['teamId', options.teamId], ['projectId', options.projectId], ['region', options.region]] as const) {
    if (value !== undefined && (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/u.test(value))) throw new MayuraError('INVALID_CONFIG', `vercelSandboxes(): ${name} must be a Vercel id.`);
  }
  const runtime = options.runtime ?? 'node24';
  if (!runtimes.includes(runtime)) throw new MayuraError('INVALID_CONFIG', `vercelSandboxes(): runtime is one of ${runtimes.join(', ')}.`);
  const maxLifetimeMs = options.maxLifetimeMs ?? 2_700_000;
  if (!Number.isSafeInteger(maxLifetimeMs) || maxLifetimeMs < 1_000 || maxLifetimeMs > 86_400_000) throw new MayuraError('INVALID_CONFIG', 'vercelSandboxes(): maxLifetimeMs is 1 s to 24 hours.');
  const apiUrl = (() => {
    try { const url = new URL(options.apiUrl ?? 'https://api.vercel.com'); if (url.protocol !== 'https:') throw new Error(); return url.origin; }
    catch { throw new MayuraError('INVALID_CONFIG', 'vercelSandboxes(): apiUrl must be an https URL.'); }
  })();
  if (options.fetch !== undefined && typeof options.fetch !== 'function') throw new MayuraError('INVALID_CONFIG', 'vercelSandboxes(): fetch must be a function.');
  const fetcher = options.fetch ?? globalThis.fetch;
  const url = (path: string, query: Record<string, string> = {}) => {
    const target = new URL(path, apiUrl);
    if (options.teamId) target.searchParams.set('teamId', options.teamId);
    for (const [name, value] of Object.entries(query)) target.searchParams.set(name, value);
    return target.href;
  };
  const headers = (extra: Record<string, string> = {}) => ({ authorization: `Bearer ${token}`, ...extra });

  const create = async (spec: ProviderSandboxSpec, { signal }: { readonly signal: AbortSignal }): Promise<SandboxBackend> => {
    if (spec.ports.length > 15 || spec.ports.some(port => port < 1_024)) throw new MayuraError('INVALID_INPUT', 'Vercel sandboxes serve at most 15 ports, each from 1024 to 65535.');
    if (Object.keys(spec.labels).length > 5) throw new MayuraError('INVALID_INPUT', 'Vercel sandboxes take at most 5 labels.');
    let vcpus: number | undefined = spec.cpus;
    if (vcpus === undefined && spec.memoryMiB !== undefined) vcpus = spec.memoryMiB / 2_048;
    if (vcpus !== undefined && (!Number.isSafeInteger(vcpus) || (vcpus !== 1 && vcpus % 2 !== 0) || vcpus > 64)) throw new MayuraError('INVALID_INPUT', 'Vercel sandboxes have 1 vCPU or an even number of them.');
    if (vcpus !== undefined && spec.memoryMiB !== undefined && spec.memoryMiB !== vcpus * 2_048) throw new MayuraError('INVALID_INPUT', 'Vercel sandboxes have 2,048 MiB of memory per vCPU.');
    if (spec.image !== undefined && (spec.image.length > 255)) throw new MayuraError('INVALID_INPUT', 'image is at most 255 characters.');
    const image = spec.image === undefined || runtimes.includes(spec.image) ? { runtime: spec.image ?? runtime } : { image: spec.image };
    const networkPolicy = spec.network === 'none' ? { mode: 'deny-all' } : spec.network === 'all' ? { mode: 'allow-all' } : { mode: 'custom', allowedDomains: spec.network.allow };
    const name = `mayura-${randomHex(12)}`;
    const response = await fetcher(url('/v2/sandboxes'), {
      method: 'POST', signal, headers: headers({ 'content-type': 'application/json' }),
      body: JSON.stringify({
        name, ...image, ...(options.projectId ? { projectId: options.projectId } : {}), ...(options.region ? { region: options.region } : {}),
        ...(vcpus !== undefined ? { resources: { vcpus, memory: vcpus * 2_048 } } : {}),
        timeout: spec.lifetimeMs, ports: spec.ports, env: spec.env, networkPolicy, persistent: false, tags: spec.labels,
      }),
    });
    // 404 here is a missing project, not a sandbox that ended.
    if (response.status === 404) { void response.body?.cancel().catch(() => undefined); throw new SandboxError('rejected', 404); }
    if (response.status !== 200 && response.status !== 201) throw sandboxResponseFailure(response);
    const created = await response.json().catch(() => undefined) as { session?: { id?: unknown }; routes?: unknown } | undefined;
    const session = created?.session?.id;
    if (typeof session !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/u.test(session)) throw new SandboxError('invalid_response');
    const routes = new Map<number, string>();
    for (const route of Array.isArray(created?.routes) ? created.routes as { port?: unknown; url?: unknown }[] : []) {
      if (typeof route?.port === 'number' && typeof route.url === 'string') routes.set(route.port, route.url);
    }
    const sessionPath = `/v2/sandboxes/sessions/${session}`;

    /** Runs a command and reads its NDJSON stream; resolves with its id as soon as it starts, and its end. */
    const command = async (argv: readonly string[], env: Readonly<Record<string, string>>, maxOutputBytes: number, callSignal: AbortSignal) => {
      const reply = await fetcher(url(`${sessionPath}/cmd`), { method: 'POST', signal: callSignal, headers: headers({ 'content-type': 'application/json' }),
        body: JSON.stringify({ command: argv[0], args: argv.slice(1), env, wait: true, logs: true }) });
      if (reply.status !== 200 || !reply.body) throw sandboxResponseFailure(reply);
      const stdout = new Collector(maxOutputBytes); const stderr = new Collector(maxOutputBytes);
      let started!: (id: string) => void; let failed!: (error: unknown) => void;
      const id = new Promise<string>((resolve, reject) => { started = resolve; failed = reject; });
      id.catch(() => undefined);
      const reader = reply.body.pipeThrough(new TextDecoderStream()).getReader();
      // Stopping the call stops reading, whether or not the fetch in use ends the body itself.
      const onStop = () => { void reader.cancel().catch(() => undefined); };
      if (callSignal.aborted) onStop(); else callSignal.addEventListener('abort', onStop, { once: true });
      const ended = (async (): Promise<{ exitCode?: number }> => {
        let pending = ''; let first = true;
        try {
          for (;;) {
            const { done, value } = await reader.read();
            // A stream that ends before the command finished has no exit code, which createSandboxes refuses.
            if (done) return {};
            pending += value;
            if (pending.length > 32 * 1_048_576) throw new SandboxError('invalid_response');
            let newline: number;
            while ((newline = pending.indexOf('\n')) >= 0) {
              const line = pending.slice(0, newline).trim(); pending = pending.slice(newline + 1);
              if (line === '') continue;
              let item: { command?: { id?: unknown; exitCode?: unknown }; stream?: unknown; data?: unknown };
              try { item = JSON.parse(line); } catch { throw new SandboxError('invalid_response'); }
              if (item.command) {
                if (first) { first = false; if (typeof item.command.id !== 'string') throw new SandboxError('invalid_response'); started(item.command.id); }
                if (typeof item.command.exitCode === 'number') return { exitCode: item.command.exitCode };
              } else if (item.stream === 'stdout' && typeof item.data === 'string') stdout.push(encoder.encode(item.data));
              else if (item.stream === 'stderr' && typeof item.data === 'string') stderr.push(encoder.encode(item.data));
              else if (item.stream === 'error') {
                const code = (item.data as { code?: unknown } | undefined)?.code;
                throw code === 'sandbox_stream_closed' ? new SandboxError('gone') : new SandboxError('rejected');
              }
            }
          }
        } catch (error) {
          failed(error); throw error;
        } finally { callSignal.removeEventListener('abort', onStop); void reader.cancel().catch(() => undefined); }
      })();
      return { id, ended, stdout, stderr };
    };
    /** Runs a command to its end, for the file scripts. */
    const run = async (argv: readonly string[], maxOutputBytes: number, callSignal: AbortSignal) => {
      const started = await command(argv, {}, maxOutputBytes, callSignal);
      const end = await started.ended;
      if (end.exitCode === undefined) throw new SandboxError(callSignal.aborted ? 'timeout' : 'invalid_response');
      return { exitCode: end.exitCode, stdout: started.stdout.bytes(), truncated: started.stdout.truncated };
    };
    const script = (body: string, args: readonly string[]) => ['/bin/sh', '-c', body, 'mayura', ...args];

    return {
      id: name,
      exec: async (argv, execOptions): Promise<BackendExecResult> => {
        const tag = randomHex(12);
        const stop = new AbortController();
        const started = await command(['/bin/sh', '-c', execScript, 'mayura', execOptions.cwd, ...argv], { ...execOptions.env, [sandboxScripts.tagVariable]: tag },
          execOptions.maxOutputBytes, stop.signal);
        // Ending the call ends the command: SIGKILL to it, and to every process carrying its tag, then the stream closes.
        const onAbort = () => {
          void (async () => {
            // Within the 10 s createSandboxes gives a provider to stop a command.
            const kill = AbortSignal.timeout(8_000);
            const id = await Promise.race([started.id, new Promise<undefined>(resolve => setTimeout(resolve, 3_000))]).catch(() => undefined);
            if (id !== undefined) {
              await fetcher(url(`${sessionPath}/cmd/${encodeURIComponent(id)}/kill`), { method: 'POST', signal: kill, headers: headers({ 'content-type': 'application/json' }),
                body: JSON.stringify({ signal: 9 }) }).then(reply => reply.body?.cancel(), () => undefined).catch(() => undefined);
            }
            await run(script(sandboxScripts.kill, [tag]), 4_096, kill).catch(() => undefined);
          })().finally(() => stop.abort());
        };
        if (execOptions.signal.aborted) onAbort(); else execOptions.signal.addEventListener('abort', onAbort, { once: true });
        const output = () => ({ stdout: started.stdout.bytes(), stderr: started.stderr.bytes(), truncated: started.stdout.truncated || started.stderr.truncated });
        try {
          const end = await started.ended;
          return execOptions.signal.aborted ? output() : { ...end, ...output() };
        } catch (error) {
          // A command stopped because the call ended has no exit code, and its stream ends early.
          if (execOptions.signal.aborted) return output();
          throw error;
        } finally { execOptions.signal.removeEventListener('abort', onAbort); }
      },
      readFile: async (path, { maxBytes, signal: callSignal }) => {
        const reply = await fetcher(url(`${sessionPath}/fs/read`), { method: 'POST', signal: callSignal, headers: headers({ 'content-type': 'application/json' }), body: JSON.stringify({ path }) });
        // 404: no such file; the session ending is 410.
        if (reply.status === 404) { void reply.body?.cancel().catch(() => undefined); return undefined; }
        if (reply.status === 400 || reply.status === 422) { void reply.body?.cancel().catch(() => undefined); throw new MayuraError('INVALID_INPUT', 'That path is not a file.'); }
        if (reply.status !== 200) throw sandboxResponseFailure(reply);
        const length = reply.headers.get('content-length');
        if (length !== null && /^\d+$/u.test(length) && Number(length) > maxBytes) { void reply.body?.cancel().catch(() => undefined); throw new MayuraError('LIMIT_EXCEEDED', `The file is larger than ${maxBytes} bytes.`); }
        if (!reply.body) return new Uint8Array(0);
        const collected = new Collector(maxBytes); const reader = reply.body.getReader();
        try {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            collected.push(value);
            if (collected.truncated) { await reader.cancel().catch(() => undefined); throw new MayuraError('LIMIT_EXCEEDED', `The file is larger than ${maxBytes} bytes.`); }
          }
        } finally { reader.releaseLock(); }
        return collected.bytes();
      },
      writeFile: async (path, data, { signal: callSignal }) => {
        // A tarball extracted at /, so the path is exact and its directories are made.
        const body = await gzip(tarOf(path.slice(1), data));
        const reply = await fetcher(url(`${sessionPath}/fs/write`), { method: 'POST', signal: callSignal,
          headers: headers({ 'content-type': 'application/gzip', 'x-cwd': '/' }), body: body as Uint8Array<ArrayBuffer> });
        void reply.body?.cancel().catch(() => undefined);
        if (reply.status === 400 || reply.status === 422) throw new MayuraError('INVALID_INPUT', 'That path cannot be written.');
        if (reply.status !== 200 && reply.status !== 204) throw sandboxHttpFailure(reply.status);
      },
      listFiles: async (path, { limit, signal: callSignal }) => {
        const result = await run(script(sandboxScripts.list, [path, String(limit)]), 64 * 1_048_576, callSignal);
        if (result.exitCode === 3) return undefined;
        if (result.exitCode === 4) throw new MayuraError('INVALID_INPUT', 'That path is not a directory.');
        if (result.exitCode !== 0 || result.truncated) throw new SandboxError('rejected');
        return parseSandboxListing(result.stdout);
      },
      removeFile: async (path, { recursive, signal: callSignal }) => {
        const result = await run(script(sandboxScripts.remove, [path, recursive ? '1' : '0']), 4_096, callSignal);
        if (result.exitCode === 7) throw new MayuraError('INVALID_INPUT', 'The directory is not empty; remove it with recursive.');
        if (result.exitCode !== 0) throw new SandboxError('rejected');
      },
      url: async port => {
        const route = routes.get(port);
        if (route === undefined) throw new SandboxError('invalid_response');
        return route;
      },
      release: async ({ signal: callSignal }) => {
        const stopped = await fetcher(url(`${sessionPath}/stop`), { method: 'POST', signal: callSignal, headers: headers() });
        void stopped.body?.cancel().catch(() => undefined);
        if (stopped.status !== 200 && stopped.status !== 404 && stopped.status !== 410) throw sandboxHttpFailure(stopped.status);
        const deleted = await fetcher(url(`/v2/sandboxes/${name}`, { ...(options.projectId ? { projectId: options.projectId } : {}), deleteOrphanSnapshots: 'true' }),
          { method: 'DELETE', signal: callSignal, headers: headers() });
        void deleted.body?.cancel().catch(() => undefined);
        if (deleted.status !== 200 && deleted.status !== 204 && deleted.status !== 404 && deleted.status !== 410) throw sandboxHttpFailure(deleted.status);
      },
    };
  };

  return Object.freeze({
    id: 'vercel', workdir: '/vercel/sandbox', maxLifetimeMs,
    // Vercel's API takes no standard input.
    features: Object.freeze({ stdin: false, ports: true, desktop: false, network: Object.freeze(['none', 'all', 'allowlist'] as const) }),
    create,
  });
}
