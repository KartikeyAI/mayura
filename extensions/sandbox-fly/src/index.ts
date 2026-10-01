import { MayuraError } from 'mayura';
import {
  parseSandboxListing, SandboxError, sandboxHttpFailure, sandboxResponseFailure, sandboxScripts,
  type BackendExecResult, type ProviderSandboxSpec, type SandboxBackend, type SandboxProvider,
} from 'mayura/sandbox';

export interface FlySandboxOptions {
  /** A Fly.io API token for the app (`fly tokens create deploy`). Nothing is read from the environment. */
  readonly token: string;
  /** The Fly app sandboxes are Machines of; create it first (`fly apps create`). */
  readonly app: string;
  /**
   * The image Machines run, such as `docker.io/library/alpine:3.22`. It needs a POSIX shell, `sleep`, `base64`,
   * `setsid` and the usual tools.
   */
  readonly image: string;
  /** The region, such as `iad`; Fly's choice by default. */
  readonly region?: string;
  /** `shared` (the default) or `performance` CPUs. */
  readonly cpuKind?: 'shared' | 'performance';
  /** The working directory, made when the sandbox starts; `/workspace` by default. */
  readonly workdir?: string;
  /** The longest lifetime; 24 hours by default. */
  readonly maxLifetimeMs?: number;
  /** The Machines API; `https://api.machines.dev` by default. */
  readonly apiUrl?: string;
  /** For tests and proxies: the fetch to use. */
  readonly fetch?: typeof fetch;
}

const randomHex = (bytes: number) => Array.from(crypto.getRandomValues(new Uint8Array(bytes)), byte => byte.toString(16).padStart(2, '0')).join('');
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
const environmentScript = (env: Readonly<Record<string, string>>) => Object.entries(env).map(([name, value]) => `export ${name}=${quote(value)}\n`).join('');
const toBase64 = (data: Uint8Array) => { let binary = ''; for (let offset = 0; offset < data.byteLength; offset += 0x8000) binary += String.fromCharCode(...data.subarray(offset, offset + 0x8000)); return btoa(binary); };
function fromBase64(text: string): Uint8Array {
  if (!/^[A-Za-z0-9+/]*={0,2}$/u.test(text)) throw new SandboxError('invalid_response');
  const binary = atob(text); const data = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) data[index] = binary.charCodeAt(index);
  return data;
}
/** Waits `ms`, or fails with `timeout` when `signal` aborts first. */
function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(new SandboxError('timeout')); return; }
    const onAbort = () => { clearTimeout(timer); reject(new SandboxError('timeout')); };
    const timer = setTimeout(() => { signal.removeEventListener('abort', onAbort); resolve(); }, ms);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}
/** Bytes moved per exec call: Fly's exec answers in one JSON response, and runs at most 60 s. */
const chunkBytes = 1_048_576;

/**
 * Starts a command in the background, as Fly's exec runs at most 60 s. $1: the files' base path; $2: the command's
 * tag; $3: `in` when standard input is in `<base>.in`, or `-`; $4: `env` when the command's environment is in
 * `<base>.env`, or `-`; $5: the directory; the command follows. It writes `<base>.out`, `<base>.err` and, when done,
 * `<base>.code`.
 */
const startScript = [
  '_mayura_base=$1; _mayura_tag=$2; _mayura_in=$3; _mayura_env=$4; _mayura_dir=$5; shift 5',
  `export ${sandboxScripts.tagVariable}="$_mayura_tag"`,
  'setsid sh -c \'',
  '  _mayura_base=$1; _mayura_in=$2; _mayura_env=$3; _mayura_dir=$4; shift 4',
  '  {',
  '    if [ "$_mayura_env" != - ]; then _mayura_e=$(cat -- "$_mayura_base.env"); rm -f -- "$_mayura_base.env"; eval "$_mayura_e"; unset _mayura_e; fi',
  '    if cd -- "$_mayura_dir"; then if [ "$_mayura_in" = - ]; then "$@" </dev/null; else "$@" <"$_mayura_base.in"; fi; fi',
  '  } >"$_mayura_base.out" 2>"$_mayura_base.err"',
  '  _mayura_code=$?',
  '  printf "%s\\n" "$_mayura_code" >"$_mayura_base.code"',
  '\' mayura "$_mayura_base" "$_mayura_in" "$_mayura_env" "$_mayura_dir" "$@" </dev/null >/dev/null 2>&1 &',
].join('\n');
/** Prints the size of each file, then the first `$1` bytes of it in base64, a line each. $2...: the files. */
const headScript = [
  '_max=$1; shift',
  'for _file; do',
  '  _size=$(stat -c %s -- "$_file" 2>/dev/null) || _size=0',
  '  printf "%s " "$_size"; head -c "$_max" -- "$_file" 2>/dev/null | base64 | tr -d "\\n"; printf "\\n"',
  'done',
].join('\n');
/** Prints `$3` bytes of the file `$1` from byte `$2`, in base64. Exit 3: there is none; 4: not a regular file. */
const readChunkScript = [
  '[ -e "$1" ] || exit 3',
  '[ -f "$1" ] || exit 4',
  'tail -c "+$(($2 + 1))" -- "$1" | head -c "$3" | base64 | tr -d "\\n"',
].join('\n');
/** Writes standard input, in base64, to `$1`: replacing it with `$2` set to `new`, or adding to it. Exit 4: a directory is there. */
const writeChunkScript = [
  '[ ! -d "$1" ] || exit 4',
  'if [ "$2" = new ]; then mkdir -p -- "$(dirname -- "$1")" || exit; base64 -d > "$1"; else base64 -d >> "$1"; fi',
].join('\n');

/**
 * Fly.io Machines as sandboxes: a Firecracker VM per sandbox in one of your apps, over the Machines API with fetch and
 * no dependencies. Machines reach the internet, so sandboxes are created only with the network `'all'`, allowed in
 * `createSandboxes` and asked for. Give the result to `createSandboxes` from `mayura/sandbox`.
 */
export function flySandboxes(options: FlySandboxOptions): SandboxProvider {
  if (!options || typeof options.token !== 'string' || !/^[!-~ ]{8,8192}$/u.test(options.token)) throw new MayuraError('INVALID_CONFIG', 'flySandboxes(): token must be a Fly.io API token.');
  const token = options.token.startsWith('FlyV1 ') || options.token.startsWith('Bearer ') ? options.token : `Bearer ${options.token}`;
  if (typeof options.app !== 'string' || !/^[a-z0-9][a-z0-9-]{0,62}$/u.test(options.app)) throw new MayuraError('INVALID_CONFIG', 'flySandboxes(): app must be a Fly app name.');
  if (typeof options.image !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._/:@-]{0,511}$/u.test(options.image)) throw new MayuraError('INVALID_CONFIG', 'flySandboxes(): image must be an image reference.');
  if (options.region !== undefined && (typeof options.region !== 'string' || !/^[a-z]{3}$/u.test(options.region))) throw new MayuraError('INVALID_CONFIG', 'flySandboxes(): region must be a Fly region code, such as iad.');
  const cpuKind = options.cpuKind ?? 'shared';
  if (cpuKind !== 'shared' && cpuKind !== 'performance') throw new MayuraError('INVALID_CONFIG', "flySandboxes(): cpuKind is 'shared' or 'performance'.");
  const workdir = options.workdir ?? '/workspace';
  if (typeof workdir !== 'string' || !/^\/(?:[A-Za-z0-9._-]+\/)*[A-Za-z0-9._-]+$/u.test(workdir) || workdir.split('/').some(part => part === '.' || part === '..')) {
    throw new MayuraError('INVALID_CONFIG', 'flySandboxes(): workdir must be an absolute, normalized path.');
  }
  const maxLifetimeMs = options.maxLifetimeMs ?? 86_400_000;
  if (!Number.isSafeInteger(maxLifetimeMs) || maxLifetimeMs < 1_000 || maxLifetimeMs > 2_147_483_647) throw new MayuraError('INVALID_CONFIG', 'flySandboxes(): maxLifetimeMs is 1 s to about 24 days.');
  const apiUrl = (() => {
    try { const url = new URL(options.apiUrl ?? 'https://api.machines.dev'); if (url.protocol !== 'https:') throw new Error(); return url.origin; }
    catch { throw new MayuraError('INVALID_CONFIG', 'flySandboxes(): apiUrl must be an https URL.'); }
  })();
  if (options.fetch !== undefined && typeof options.fetch !== 'function') throw new MayuraError('INVALID_CONFIG', 'flySandboxes(): fetch must be a function.');
  const fetcher = options.fetch ?? globalThis.fetch;
  const app = `${apiUrl}/v1/apps/${options.app}/machines`;
  const headers = (extra: Record<string, string> = {}) => ({ authorization: token, ...extra });

  const create = async (spec: ProviderSandboxSpec, { signal }: { readonly signal: AbortSignal }): Promise<SandboxBackend> => {
    // flySandboxes declares only 'all', so createSandboxes asks for nothing else.
    if (spec.memoryMiB !== undefined && (spec.memoryMiB < 256 || spec.memoryMiB % 256 !== 0)) throw new MayuraError('INVALID_INPUT', 'Fly gives memory in multiples of 256 MiB.');
    if (spec.cpus !== undefined && !Number.isSafeInteger(spec.cpus)) throw new MayuraError('INVALID_INPUT', 'Fly gives whole CPUs.');
    if (spec.image !== undefined && !/^[A-Za-z0-9][A-Za-z0-9._/:@-]{0,511}$/u.test(spec.image)) throw new MayuraError('INVALID_INPUT', 'image must be an image reference.');
    const name = `mayura-${randomHex(12)}`;
    const response = await fetcher(app, { method: 'POST', signal, headers: headers({ 'content-type': 'application/json' }), body: JSON.stringify({
      name, ...(options.region ? { region: options.region } : {}),
      config: {
        image: spec.image ?? options.image, env: spec.env, metadata: spec.labels,
        guest: { cpu_kind: cpuKind, cpus: spec.cpus ?? 1, memory_mb: spec.memoryMiB ?? 1_024 },
        // The Machine's only process sleeps for the lifetime; when it ends, the Machine is destroyed.
        init: { exec: ['sleep', String(Math.ceil(spec.lifetimeMs / 1_000) + 5)] },
        auto_destroy: true, restart: { policy: 'no' },
      },
    }) });
    if (response.status === 404) { void response.body?.cancel().catch(() => undefined); throw new SandboxError('rejected', 404); }
    if (response.status !== 200 && response.status !== 201) throw sandboxResponseFailure(response);
    const machine = await response.json().catch(() => undefined) as { id?: unknown; instance_id?: unknown } | undefined;
    const id = machine?.id;
    if (typeof id !== 'string' || !/^[a-z0-9]{1,64}$/u.test(id)) throw new SandboxError('invalid_response');
    const machineUrl = `${app}/${id}`;
    const release = async (callSignal: AbortSignal) => {
      const reply = await fetcher(`${machineUrl}?force=true`, { method: 'DELETE', signal: callSignal, headers: headers() });
      void reply.body?.cancel().catch(() => undefined);
      if (reply.status !== 200 && reply.status !== 204 && reply.status !== 404) throw sandboxHttpFailure(reply.status);
    };

    /** Runs a short command through Fly's exec (at most 60 s); its output as text. */
    const exec = async (command: readonly string[], callSignal: AbortSignal, stdin?: string) => {
      const reply = await fetcher(`${machineUrl}/exec`, { method: 'POST', signal: callSignal, headers: headers({ 'content-type': 'application/json', accept: 'application/json' }),
        body: JSON.stringify({ command, timeout: 55, ...(stdin === undefined ? {} : { stdin }) }) });
      if (reply.status !== 200) throw sandboxResponseFailure(reply);
      const result = await reply.json().catch(() => undefined) as { exit_code?: unknown; stdout?: unknown; stderr?: unknown } | undefined;
      if (!result || !Number.isSafeInteger(result.exit_code ?? 0)) throw new SandboxError('invalid_response');
      return { exitCode: (result.exit_code ?? 0) as number, stdout: typeof result.stdout === 'string' ? result.stdout : '' };
    };
    const script = (body: string, args: readonly string[]) => ['sh', '-c', body, 'mayura', ...args];
    const writeBytes = async (path: string, data: Uint8Array, callSignal: AbortSignal) => {
      for (let offset = 0; offset === 0 || offset < data.byteLength; offset += chunkBytes) {
        const result = await exec(script(writeChunkScript, [path, offset === 0 ? 'new' : 'add']), callSignal, toBase64(data.subarray(offset, offset + chunkBytes)));
        if (result.exitCode === 4) throw new MayuraError('INVALID_INPUT', 'A directory is at that path.');
        if (result.exitCode !== 0) throw new SandboxError('rejected');
      }
    };
    /** The first bytes of each file, up to `max`, and whether there was more. */
    const heads = async (paths: readonly string[], max: number, callSignal: AbortSignal) => {
      const result = await exec(script(headScript, [String(max), ...paths]), callSignal);
      const lines = result.stdout.split('\n');
      return paths.map((_, index) => {
        const match = /^(\d+) ([A-Za-z0-9+/=]*)$/u.exec(lines[index] ?? '');
        if (!match) throw new SandboxError('invalid_response');
        return { data: fromBase64(match[2]!), more: Number(match[1]) > max };
      });
    };

    try {
      // Fly starts the Machine; wait for it, then make the working directory.
      for (;;) {
        const reply = await fetcher(`${machineUrl}/wait?state=started&timeout=30`, { signal, headers: headers() });
        void reply.body?.cancel().catch(() => undefined);
        if (reply.status === 200) break;
        if (reply.status !== 408) throw sandboxHttpFailure(reply.status);
      }
      const made = await exec(['mkdir', '-p', workdir], signal);
      if (made.exitCode !== 0) throw new SandboxError('rejected');
    } catch (error) {
      await release(AbortSignal.timeout(30_000)).catch(() => undefined);
      throw error;
    }

    return {
      id,
      exec: async (command, execOptions): Promise<BackendExecResult> => {
        const tag = randomHex(12); const base = `/tmp/mayura-${tag}`;
        const stdin = execOptions.stdin?.byteLength ? execOptions.stdin : undefined;
        const hasEnv = Object.keys(execOptions.env).length > 0;
        const output = async (callSignal: AbortSignal) => {
          const [out, err] = await heads([`${base}.out`, `${base}.err`], execOptions.maxOutputBytes, callSignal);
          return { stdout: out!.data, stderr: err!.data, truncated: out!.more || err!.more };
        };
        try {
          if (stdin) await writeBytes(`${base}.in`, stdin, execOptions.signal);
          if (hasEnv) await writeBytes(`${base}.env`, new TextEncoder().encode(environmentScript(execOptions.env)), execOptions.signal);
          const started = await exec(script(startScript, [base, tag, stdin ? 'in' : '-', hasEnv ? 'env' : '-', execOptions.cwd, ...command]), execOptions.signal);
          if (started.exitCode !== 0) throw new SandboxError('rejected');
          let exitCode: number | undefined;
          for (let delay = 200; exitCode === undefined; delay = Math.min(delay * 1.5, 1_000)) {
            await sleep(delay, execOptions.signal);
            const status = await exec(['cat', `${base}.code`], execOptions.signal);
            const match = /^(\d+)\n$/u.exec(status.stdout);
            if (status.exitCode === 0 && match) exitCode = Number(match[1]);
          }
          return { exitCode, ...await output(execOptions.signal) };
        } catch (error) {
          if (!execOptions.signal.aborted) throw error;
          // Ending the call ends the command: every process carrying its tag is killed, then what it wrote is read.
          const kill = AbortSignal.timeout(8_000);
          await exec(script(sandboxScripts.kill, [tag]), kill).catch(() => undefined);
          return output(kill).catch(() => ({ stdout: new Uint8Array(0), stderr: new Uint8Array(0), truncated: false }));
        } finally {
          void exec(['sh', '-c', 'rm -f -- "$1".out "$1".err "$1".in "$1".env "$1".code', 'mayura', base], AbortSignal.timeout(30_000)).catch(() => undefined);
        }
      },
      readFile: async (path, { maxBytes, signal: callSignal }) => {
        const size = await exec(script('[ -e "$1" ] || exit 3; [ -f "$1" ] || exit 4; stat -c %s -- "$1"', [path]), callSignal);
        if (size.exitCode === 3) return undefined;
        if (size.exitCode === 4) throw new MayuraError('INVALID_INPUT', 'That path is not a file.');
        const bytes = /^(\d{1,16})\n?$/u.exec(size.stdout);
        if (size.exitCode !== 0 || !bytes) throw new SandboxError('rejected');
        const total = Number(bytes[1]);
        if (total > maxBytes) throw new MayuraError('LIMIT_EXCEEDED', `The file is larger than ${maxBytes} bytes.`);
        const data = new Uint8Array(total);
        for (let offset = 0; offset < total; offset += chunkBytes) {
          const chunk = await exec(script(readChunkScript, [path, String(offset), String(Math.min(chunkBytes, total - offset))]), callSignal);
          if (chunk.exitCode !== 0) throw new SandboxError('rejected');
          const part = fromBase64(chunk.stdout);
          // The file changed while it was read.
          if (part.byteLength !== Math.min(chunkBytes, total - offset)) throw new SandboxError('rejected');
          data.set(part, offset);
        }
        return data;
      },
      writeFile: (path, data, { signal: callSignal }) => writeBytes(path, data, callSignal),
      listFiles: async (path, { limit, signal: callSignal }) => {
        const result = await exec(script(sandboxScripts.list, [path, String(limit)]), callSignal);
        if (result.exitCode === 3) return undefined;
        if (result.exitCode === 4) throw new MayuraError('INVALID_INPUT', 'That path is not a directory.');
        if (result.exitCode !== 0) throw new SandboxError('rejected');
        return parseSandboxListing(new TextEncoder().encode(result.stdout));
      },
      removeFile: async (path, { recursive, signal: callSignal }) => {
        const result = await exec(script(sandboxScripts.remove, [path, recursive ? '1' : '0']), callSignal);
        if (result.exitCode === 7) throw new MayuraError('INVALID_INPUT', 'The directory is not empty; remove it with recursive.');
        if (result.exitCode !== 0) throw new SandboxError('rejected');
      },
      release: ({ signal: callSignal }) => release(callSignal),
    };
  };

  return Object.freeze({
    id: 'fly', workdir, maxLifetimeMs,
    // Fly Machines reach the internet, and Fly has no way to stop them: 'none' cannot be enforced.
    features: Object.freeze({ stdin: true, ports: false, desktop: false, network: Object.freeze(['all'] as const) }),
    create,
  });
}
