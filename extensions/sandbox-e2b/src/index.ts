import { MayuraError } from 'mayura';
import {
  SandboxError, sandboxHttpFailure, sandboxResponseFailure, sandboxScripts,
  type BackendExecResult, type ProviderSandboxSpec, type SandboxBackend, type SandboxEntry, type SandboxProvider,
} from 'mayura/sandbox';

export interface E2bSandboxOptions {
  /** An E2B API key. Nothing is read from the environment. */
  readonly apiKey: string;
  /** The template sandboxes start from; `base` by default. A sandbox's own `image` overrides it. */
  readonly template?: string;
  /** The working directory; the template user's home, `/home/user`, by default. */
  readonly workdir?: string;
  /** The longest lifetime your plan allows; 1 hour (Hobby) by default, up to 24 hours (Pro). */
  readonly maxLifetimeMs?: number;
  /** E2B's control API; `https://api.e2b.app` by default. */
  readonly apiUrl?: string;
  /** The domain sandboxes are served on; `e2b.app` by default. */
  readonly domain?: string;
  /** For tests and proxies: the fetch to use. */
  readonly fetch?: typeof fetch;
}

const envdPort = 49983;
const encoder = new TextEncoder();
const decoder = new TextDecoder();
const randomHex = (bytes: number) => Array.from(crypto.getRandomValues(new Uint8Array(bytes)), byte => byte.toString(16).padStart(2, '0')).join('');
const toBase64 = (data: Uint8Array) => { let binary = ''; for (let offset = 0; offset < data.byteLength; offset += 0x8000) binary += String.fromCharCode(...data.subarray(offset, offset + 0x8000)); return btoa(binary); };
function fromBase64(text: unknown): Uint8Array {
  if (typeof text !== 'string' || !/^[A-Za-z0-9+/_-]*={0,2}$/u.test(text)) throw new SandboxError('invalid_response');
  const binary = atob(text.replaceAll('-', '+').replaceAll('_', '/')); const data = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) data[index] = binary.charCodeAt(index);
  return data;
}

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

// Commands run through sh, so a missing program or directory is a failed command, as on every provider.
// $1: the directory; then the command.
const execScript = 'cd -- "$1" || exit; shift; exec "$@"';
const signals: Readonly<Record<string, number>> = { hangup: 1, interrupt: 2, quit: 3, aborted: 6, killed: 9, 'segmentation fault': 11, 'broken pipe': 13, terminated: 15 };

/** A Connect error's code, from an end-of-stream message or a unary error body. */
function connectFailure(code: unknown, httpStatus?: number): SandboxError {
  switch (code) {
    case 'unauthenticated': case 'permission_denied': return new SandboxError('authentication', httpStatus);
    case 'resource_exhausted': return new SandboxError('rate_limited', httpStatus);
    case 'unavailable': return new SandboxError('unavailable', httpStatus);
    case 'deadline_exceeded': case 'canceled': return new SandboxError('timeout', httpStatus);
    default: return new SandboxError('rejected', httpStatus);
  }
}

/**
 * E2B sandboxes (e2b.dev): Firecracker microVMs started from a template, over E2B's HTTP APIs with fetch and no
 * dependencies. Give the result to `createSandboxes` from `mayura/sandbox`.
 */
export function e2bSandboxes(options: E2bSandboxOptions): SandboxProvider {
  if (!options || typeof options.apiKey !== 'string' || !/^[!-~]{8,512}$/u.test(options.apiKey)) throw new MayuraError('INVALID_CONFIG', 'e2bSandboxes(): apiKey must be an E2B API key.');
  const apiKey = options.apiKey;
  const template = options.template ?? 'base';
  if (typeof template !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/u.test(template)) throw new MayuraError('INVALID_CONFIG', 'e2bSandboxes(): template must be a template id or alias.');
  const workdir = options.workdir ?? '/home/user';
  if (typeof workdir !== 'string' || !/^\/(?:[A-Za-z0-9._-]+\/)*[A-Za-z0-9._-]+$/u.test(workdir) || workdir.split('/').some(part => part === '.' || part === '..')) {
    throw new MayuraError('INVALID_CONFIG', 'e2bSandboxes(): workdir must be an absolute, normalized path.');
  }
  const maxLifetimeMs = options.maxLifetimeMs ?? 3_600_000;
  if (!Number.isSafeInteger(maxLifetimeMs) || maxLifetimeMs < 1_000 || maxLifetimeMs > 86_400_000) throw new MayuraError('INVALID_CONFIG', 'e2bSandboxes(): maxLifetimeMs is 1 s to 24 hours.');
  const apiUrl = (() => {
    try { const url = new URL(options.apiUrl ?? 'https://api.e2b.app'); if (url.protocol !== 'https:' && url.hostname !== '127.0.0.1' && url.hostname !== 'localhost') throw new Error(); return url.origin; }
    catch { throw new MayuraError('INVALID_CONFIG', 'e2bSandboxes(): apiUrl must be an https URL.'); }
  })();
  const defaultDomain = options.domain ?? 'e2b.app';
  if (typeof defaultDomain !== 'string' || !/^(?:[a-z0-9-]+\.)+[a-z]{2,}$/u.test(defaultDomain)) throw new MayuraError('INVALID_CONFIG', 'e2bSandboxes(): domain must be a domain name.');
  if (options.fetch !== undefined && typeof options.fetch !== 'function') throw new MayuraError('INVALID_CONFIG', 'e2bSandboxes(): fetch must be a function.');
  const fetcher = options.fetch ?? globalThis.fetch;

  const create = async (spec: ProviderSandboxSpec, { signal }: { readonly signal: AbortSignal }): Promise<SandboxBackend> => {
    const chosen = spec.image ?? template;
    if (!/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/u.test(chosen)) throw new MayuraError('INVALID_INPUT', 'image must be an E2B template id or alias.');
    const network = spec.network === 'none' ? { allow_internet_access: false }
      : spec.network === 'all' ? { allow_internet_access: true }
      // Domains are matched on ports 80 and 443 (by Host and SNI); everything else is denied.
      : { allow_internet_access: true, network: { allowOut: spec.network.allow, denyOut: ['0.0.0.0/0'] } };
    const response = await fetcher(`${apiUrl}/v2/sandboxes`, {
      method: 'POST', signal,
      headers: { 'content-type': 'application/json', 'x-api-key': apiKey },
      body: JSON.stringify({
        templateID: chosen, timeout: Math.ceil(spec.lifetimeMs / 1_000), autoPause: false,
        envVars: spec.env, metadata: spec.labels, ...network,
        // Ports a sandbox was asked to serve are public at their URLs; otherwise nothing is.
        ...(spec.ports.length > 0 ? { network: { ...('network' in network ? network.network : {}), allowPublicTraffic: true } } : {}),
      }),
    });
    if (response.status !== 201) throw sandboxResponseFailure(response);
    const created = await response.json().catch(() => undefined) as { sandboxID?: unknown; envdAccessToken?: unknown; domain?: unknown } | undefined;
    const id = created?.sandboxID;
    if (typeof id !== 'string' || !/^[A-Za-z0-9-]{1,128}$/u.test(id)) throw new SandboxError('invalid_response');
    const token = typeof created?.envdAccessToken === 'string' && /^[!-~]{1,1024}$/u.test(created.envdAccessToken) ? created.envdAccessToken : undefined;
    const domain = typeof created?.domain === 'string' && /^(?:[a-z0-9-]+\.)+[a-z]{2,}$/u.test(created.domain) ? created.domain : defaultDomain;
    const envd = domain === 'e2b.app' ? `https://sandbox.${domain}` : `https://${envdPort}-${id}.${domain}`;
    const envdHeaders = (extra: Record<string, string>) => ({ 'e2b-sandbox-id': id, 'e2b-sandbox-port': String(envdPort), ...(token ? { 'x-access-token': token } : {}), ...extra });

    /** A unary Connect call to envd. Resolves with the response JSON, or with the error's Connect code. */
    const unary = async (method: string, body: unknown, callSignal: AbortSignal): Promise<{ ok: true; json: unknown } | { ok: false; code: string; status: number }> => {
      const reply = await fetcher(`${envd}/${method}`, { method: 'POST', signal: callSignal,
        headers: envdHeaders({ 'content-type': 'application/json', 'connect-protocol-version': '1' }), body: JSON.stringify(body) });
      // 502: the sandbox is not there any more.
      if (reply.status === 502) { void reply.body?.cancel().catch(() => undefined); throw new SandboxError('gone', 502); }
      const json = await reply.json().catch(() => undefined) as { code?: unknown } | undefined;
      if (reply.status === 200) return { ok: true, json };
      const code = typeof json?.code === 'string' ? json.code : '';
      if (code === '' ) throw sandboxHttpFailure(reply.status === 404 ? 400 : reply.status);
      return { ok: false, code, status: reply.status };
    };
    const unaryOk = async (method: string, body: unknown, callSignal: AbortSignal): Promise<unknown> => {
      const result = await unary(method, body, callSignal);
      if (!result.ok) throw connectFailure(result.code, result.status);
      return result.json;
    };

    /** Starts a process and reads its event stream: resolves with its pid as soon as it starts, and its end. */
    const start = async (command: readonly string[], env: Readonly<Record<string, string>>, withStdin: boolean, maxOutputBytes: number, callSignal: AbortSignal) => {
      const message = encoder.encode(JSON.stringify({ process: { cmd: command[0], args: command.slice(1), envs: env }, ...(withStdin ? { stdin: true } : {}) }));
      const envelope = new Uint8Array(5 + message.byteLength);
      new DataView(envelope.buffer).setUint32(1, message.byteLength); envelope.set(message, 5);
      const reply = await fetcher(`${envd}/process.Process/Start`, { method: 'POST', signal: callSignal,
        headers: envdHeaders({ 'content-type': 'application/connect+json', 'connect-protocol-version': '1', 'keepalive-ping-interval': '50' }), body: envelope });
      if (reply.status === 502) { void reply.body?.cancel().catch(() => undefined); throw new SandboxError('gone', 502); }
      if (reply.status !== 200 || !reply.body) throw sandboxResponseFailure(reply);
      const stdout = new Collector(maxOutputBytes); const stderr = new Collector(maxOutputBytes);
      let started!: (pid: number) => void; let failed!: (error: unknown) => void;
      const pid = new Promise<number>((resolve, reject) => { started = resolve; failed = reject; });
      pid.catch(() => undefined);
      const reader = reply.body.getReader();
      // Stopping the call stops reading, whether or not the fetch in use ends the body itself.
      const onStop = () => { void reader.cancel().catch(() => undefined); };
      if (callSignal.aborted) onStop(); else callSignal.addEventListener('abort', onStop, { once: true });
      const ended = (async (): Promise<{ exitCode?: number }> => {
        let pending = new Uint8Array(0);
        try {
          for (;;) {
            const { done, value } = await reader.read();
            // A stream that ends before the process did has no exit code, which createSandboxes refuses.
            if (done) return {};
            const joined = new Uint8Array(pending.byteLength + value.byteLength); joined.set(pending); joined.set(value, pending.byteLength);
            let offset = 0;
            while (joined.byteLength - offset >= 5) {
              const flags = joined[offset]!; const size = new DataView(joined.buffer, joined.byteOffset + offset + 1, 4).getUint32(0);
              if (size > 16 * 1_048_576) throw new SandboxError('invalid_response');
              if (joined.byteLength - offset - 5 < size) break;
              let frame: { event?: { start?: { pid?: unknown }; data?: { stdout?: unknown; stderr?: unknown }; end?: { exitCode?: unknown; exited?: unknown; status?: unknown } };
                error?: { code?: unknown } };
              try { frame = JSON.parse(decoder.decode(joined.subarray(offset + 5, offset + 5 + size))); } catch { throw new SandboxError('invalid_response'); }
              offset += 5 + size;
              // Flag 2 ends the stream: an error, or nothing more after the process ended.
              if (flags & 2) { if (frame.error) throw connectFailure(frame.error.code); throw new SandboxError('invalid_response'); }
              const event = frame.event;
              if (event?.start) { if (!Number.isSafeInteger(event.start.pid)) throw new SandboxError('invalid_response'); started(event.start.pid as number); }
              else if (event?.data) {
                if (event.data.stdout !== undefined) stdout.push(fromBase64(event.data.stdout));
                if (event.data.stderr !== undefined) stderr.push(fromBase64(event.data.stderr));
              } else if (event?.end) {
                const end = event.end;
                // Proto3 JSON leaves out an exit code of 0 and an `exited` of false.
                if (end.exited === true) return { exitCode: end.exitCode === undefined ? 0 : Number(end.exitCode) };
                const signal = typeof end.status === 'string' ? /^signal: (.+)$/u.exec(end.status)?.[1] : undefined;
                return { exitCode: signal !== undefined && signals[signal] !== undefined ? 128 + signals[signal]! : -1 };
              }
            }
            pending = joined.slice(offset);
          }
        } catch (error) {
          failed(error); throw error;
        } finally { callSignal.removeEventListener('abort', onStop); void reader.cancel().catch(() => undefined); }
      })();
      return { pid, ended, stdout, stderr };
    };

    const backend: SandboxBackend = {
      id,
      exec: async (command, execOptions): Promise<BackendExecResult> => {
        const tag = randomHex(12);
        const stop = new AbortController();
        const stdin = execOptions.stdin?.byteLength ? execOptions.stdin : undefined;
        const run = await start(['/bin/sh', '-c', execScript, 'mayura', execOptions.cwd, ...command], { ...execOptions.env, [sandboxScripts.tagVariable]: tag },
          stdin !== undefined, execOptions.maxOutputBytes, stop.signal);
        // Ending the call ends the command: SIGKILL to it, and to every process carrying its tag, then the stream closes.
        const onAbort = () => {
          void (async () => {
            // Within the 10 s createSandboxes gives a provider to stop a command.
            const kill = AbortSignal.timeout(8_000);
            const pid = await Promise.race([run.pid, new Promise<undefined>(resolve => setTimeout(resolve, 3_000))]).catch(() => undefined);
            if (pid !== undefined) await unary('process.Process/SendSignal', { process: { pid }, signal: 'SIGNAL_SIGKILL' }, kill).catch(() => undefined);
            const killer = await start(['/bin/sh', '-c', sandboxScripts.kill, 'mayura', tag], {}, false, 4_096, kill).catch(() => undefined);
            await killer?.ended.catch(() => undefined);
          })().finally(() => stop.abort());
        };
        if (execOptions.signal.aborted) onAbort(); else execOptions.signal.addEventListener('abort', onAbort, { once: true });
        try {
          if (stdin) {
            const pid = await run.pid;
            for (let offset = 0; offset < stdin.byteLength; offset += 1_048_576) {
              await unaryOk('process.Process/SendInput', { process: { pid }, input: { stdin: toBase64(stdin.subarray(offset, offset + 1_048_576)) } }, stop.signal);
            }
            await unaryOk('process.Process/CloseStdin', { process: { pid } }, stop.signal);
          }
          const end = await run.ended;
          if (execOptions.signal.aborted) return { stdout: run.stdout.bytes(), stderr: run.stderr.bytes(), truncated: run.stdout.truncated || run.stderr.truncated };
          return { ...end, stdout: run.stdout.bytes(), stderr: run.stderr.bytes(), truncated: run.stdout.truncated || run.stderr.truncated };
        } catch (error) {
          // A command stopped because the call ended has no exit code, and its stream ends early.
          if (execOptions.signal.aborted) return { stdout: run.stdout.bytes(), stderr: run.stderr.bytes(), truncated: run.stdout.truncated || run.stderr.truncated };
          throw error;
        } finally { execOptions.signal.removeEventListener('abort', onAbort); }
      },
      readFile: async (path, { maxBytes, signal: callSignal }) => {
        const reply = await fetcher(`${envd}/files?path=${encodeURIComponent(path)}`, { signal: callSignal, headers: envdHeaders({ 'accept-encoding': 'identity' }) });
        if (reply.status === 404) { void reply.body?.cancel().catch(() => undefined); return undefined; }
        if (reply.status === 400) { void reply.body?.cancel().catch(() => undefined); throw new MayuraError('INVALID_INPUT', 'That path is not a file.'); }
        if (reply.status === 502) { void reply.body?.cancel().catch(() => undefined); throw new SandboxError('gone', 502); }
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
        const reply = await fetcher(`${envd}/files?path=${encodeURIComponent(path)}`, { method: 'POST', signal: callSignal,
          headers: envdHeaders({ 'content-type': 'application/octet-stream' }), body: data as Uint8Array<ArrayBuffer> });
        void reply.body?.cancel().catch(() => undefined);
        if (reply.status === 502) throw new SandboxError('gone', 502);
        if (reply.status === 400) throw new MayuraError('INVALID_INPUT', 'That path cannot be written.');
        if (reply.status === 507) throw new SandboxError('quota', 507);
        if (reply.status !== 200) throw sandboxHttpFailure(reply.status === 404 ? 400 : reply.status);
      },
      listFiles: async (path, { limit, signal: callSignal }) => {
        const result = await unary('filesystem.Filesystem/ListDir', { path, depth: 1 }, callSignal);
        if (!result.ok) {
          if (result.code === 'not_found') return undefined;
          if (result.code === 'invalid_argument') throw new MayuraError('INVALID_INPUT', 'That path is not a directory.');
          throw connectFailure(result.code, result.status);
        }
        const entries = (result.json as { entries?: unknown } | undefined)?.entries ?? [];
        if (!Array.isArray(entries)) throw new SandboxError('invalid_response');
        return entries.slice(0, limit).map((entry: { name?: unknown; type?: unknown; size?: unknown; modifiedTime?: unknown }): SandboxEntry => {
          if (typeof entry?.name !== 'string') throw new SandboxError('invalid_response');
          const type = entry.type === 'FILE_TYPE_FILE' ? 'file' : entry.type === 'FILE_TYPE_DIRECTORY' ? 'directory' : 'other';
          const size = entry.size === undefined ? 0 : Number(entry.size);
          const modified = typeof entry.modifiedTime === 'string' ? Date.parse(entry.modifiedTime) : Number.NaN;
          return { name: entry.name, type, size: type === 'directory' ? 0 : size, ...(Number.isFinite(modified) ? { modified } : {}) };
        });
      },
      removeFile: async (path, { recursive, signal: callSignal }) => {
        if (!recursive) {
          // envd removes directories with everything in them: check first that a directory is empty.
          const stat = await unary('filesystem.Filesystem/Stat', { path }, callSignal);
          if (!stat.ok) { if (stat.code === 'not_found') return; throw connectFailure(stat.code, stat.status); }
          const entry = (stat.json as { entry?: { type?: unknown } } | undefined)?.entry;
          if (entry?.type === 'FILE_TYPE_DIRECTORY') {
            const listed = await unaryOk('filesystem.Filesystem/ListDir', { path, depth: 1 }, callSignal) as { entries?: unknown[] } | undefined;
            if ((listed?.entries ?? []).length > 0) throw new MayuraError('INVALID_INPUT', 'The directory is not empty; remove it with recursive.');
          }
        }
        const removed = await unary('filesystem.Filesystem/Remove', { path }, callSignal);
        if (!removed.ok && removed.code !== 'not_found') throw connectFailure(removed.code, removed.status);
      },
      url: async port => `https://${port}-${id}.${domain}/`,
      release: async ({ signal: callSignal }) => {
        const reply = await fetcher(`${apiUrl}/sandboxes/${encodeURIComponent(id)}`, { method: 'DELETE', signal: callSignal, headers: { 'x-api-key': apiKey } });
        void reply.body?.cancel().catch(() => undefined);
        if (reply.status !== 204 && reply.status !== 200 && reply.status !== 404) throw sandboxHttpFailure(reply.status);
      },
    };
    return backend;
  };

  return Object.freeze({
    id: 'e2b', workdir, maxLifetimeMs,
    features: Object.freeze({ stdin: true, ports: true, desktop: false, network: Object.freeze(['none', 'all', 'allowlist'] as const) }),
    create,
  });
}
