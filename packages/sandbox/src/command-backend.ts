import { MayuraError } from '@mayura/core';
import { SandboxError, type BackendExecResult, type SandboxBackend } from './contracts.js';
import { parseSandboxListing, sandboxScripts } from './scripts.js';

/** How a provider runs one short command, for `commandSandboxBackend`. */
export interface CommandTransport {
  /**
   * Runs a command to its end and answers with its exit code and its stdout as text. Commands run here are short: a
   * few seconds, with output of at most `chunkBytes` in base64.
   */
  run(command: readonly string[], options: { readonly stdin?: string; readonly signal: AbortSignal }): Promise<{ readonly exitCode: number; readonly stdout: string }>;
  /** Whether `run` passes `stdin`. Without it, files are written in pieces inside the command line. */
  readonly stdin: boolean;
  /** The most bytes of a command line `run` takes, used to size pieces of files without `stdin`; 64 KiB by default. */
  readonly maxCommandBytes?: number;
  /** The most bytes moved by one `run`, as output read back or a piece of a file; 1 MiB by default. */
  readonly chunkBytes?: number;
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
function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(new SandboxError('timeout')); return; }
    const onAbort = () => { clearTimeout(timer); reject(new SandboxError('timeout')); };
    const timer = setTimeout(() => { signal.removeEventListener('abort', onAbort); resolve(); }, ms);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * Starts a command in the background, so it may run longer than one `run`. $1: the files' base path; $2: the
 * command's tag; $3: `in` when standard input is in `<base>.in`, or `-`; $4: `env` when the command's environment is
 * in `<base>.env`, or `-`; $5: the directory; the command follows. It writes `<base>.out`, `<base>.err` and, when done,
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
/**
 * Writes base64 (from standard input, or `$3` when given) to `$1`: replacing it with `$2` set to `new`, or adding to
 * it. Exit 4: a directory is there.
 */
const writeChunkScript = [
  '[ ! -d "$1" ] || exit 4',
  'if [ "$#" -ge 3 ]; then _mayura_b64=$3; _write() { printf "%s" "$_mayura_b64" | base64 -d; }; else _write() { base64 -d; }; fi',
  'if [ "$2" = new ]; then mkdir -p -- "$(dirname -- "$1")" || exit; _write > "$1"; else _write >> "$1"; fi',
].join('\n');

/**
 * A sandbox backend over a provider's way to run short commands: commands start in the background and are polled to
 * their end, their output and files move as base64 in chunks, and a timeout or cancellation stops every process a
 * command started. The sandbox's image needs a POSIX shell, `setsid`, `base64`, `stat`, `head` and `tail`. Add
 * what the provider does natively (ports, a desktop) by spreading the result.
 */
export function commandSandboxBackend(id: string, transport: CommandTransport, release: (signal: AbortSignal) => Promise<void>): SandboxBackend {
  if (typeof id !== 'string' || id === '' || !transport || typeof transport.run !== 'function' || typeof transport.stdin !== 'boolean' || typeof release !== 'function') {
    throw new MayuraError('INVALID_CONFIG', 'commandSandboxBackend() needs an id, a transport and a release function.');
  }
  const chunkBytes = transport.chunkBytes ?? 1_048_576;
  const maxCommandBytes = transport.maxCommandBytes ?? 65_536;
  if (!Number.isSafeInteger(chunkBytes) || chunkBytes < 4_096 || chunkBytes > 64 * 1_048_576) throw new MayuraError('INVALID_CONFIG', 'commandSandboxBackend(): chunkBytes is 4 KiB to 64 MiB.');
  if (!Number.isSafeInteger(maxCommandBytes) || maxCommandBytes < 4_096) throw new MayuraError('INVALID_CONFIG', 'commandSandboxBackend(): maxCommandBytes is at least 4 KiB.');
  // Without stdin, a piece of a file rides in the command line as base64, beside the script and the path.
  const writeBytes = transport.stdin ? chunkBytes : Math.max(1_024, Math.floor((maxCommandBytes - 1_024 - writeChunkScript.length - 4_096) * 3 / 4 / 3) * 3);

  const run = async (command: readonly string[], signal: AbortSignal, stdin?: string) => {
    const result = await transport.run(command, { signal, ...(stdin === undefined ? {} : { stdin }) });
    if (!result || !Number.isSafeInteger(result.exitCode) || typeof result.stdout !== 'string') throw new SandboxError('invalid_response');
    return result;
  };
  const script = (body: string, args: readonly string[]) => ['sh', '-c', body, 'mayura', ...args];
  const write = async (path: string, data: Uint8Array, signal: AbortSignal) => {
    for (let offset = 0; offset === 0 || offset < data.byteLength; offset += writeBytes) {
      const piece = toBase64(data.subarray(offset, offset + writeBytes)); const mode = offset === 0 ? 'new' : 'add';
      const result = transport.stdin ? await run(script(writeChunkScript, [path, mode]), signal, piece) : await run(script(writeChunkScript, [path, mode, piece]), signal);
      if (result.exitCode === 4) throw new MayuraError('INVALID_INPUT', 'A directory is at that path.');
      if (result.exitCode !== 0) throw new SandboxError('rejected');
    }
  };
  /** The first bytes of each file, up to `max`, and whether there was more. */
  const heads = async (paths: readonly string[], max: number, signal: AbortSignal) => {
    const result = await run(script(headScript, [String(max), ...paths]), signal);
    const lines = result.stdout.split('\n');
    return paths.map((_, index) => {
      const match = /^(\d+) ([A-Za-z0-9+/=]*)$/u.exec(lines[index] ?? '');
      if (!match) throw new SandboxError('invalid_response');
      return { data: fromBase64(match[2]!), more: Number(match[1]) > max };
    });
  };

  return {
    id,
    exec: async (command, execOptions): Promise<BackendExecResult> => {
      const tag = randomHex(12); const base = `/tmp/mayura-${tag}`;
      const stdin = execOptions.stdin?.byteLength ? execOptions.stdin : undefined;
      const hasEnv = Object.keys(execOptions.env).length > 0;
      // At most one chunk of each stream is read back.
      const keep = Math.min(execOptions.maxOutputBytes, chunkBytes);
      const output = async (signal: AbortSignal) => {
        const [out, err] = await heads([`${base}.out`, `${base}.err`], keep, signal);
        return { stdout: out!.data, stderr: err!.data, truncated: out!.more || err!.more };
      };
      try {
        if (stdin) await write(`${base}.in`, stdin, execOptions.signal);
        if (hasEnv) await write(`${base}.env`, new TextEncoder().encode(environmentScript(execOptions.env)), execOptions.signal);
        const started = await run(script(startScript, [base, tag, stdin ? 'in' : '-', hasEnv ? 'env' : '-', execOptions.cwd, ...command]), execOptions.signal);
        if (started.exitCode !== 0) throw new SandboxError('rejected');
        let exitCode: number | undefined;
        for (let delay = 200; exitCode === undefined; delay = Math.min(delay * 1.5, 1_000)) {
          await sleep(delay, execOptions.signal);
          const status = await run(['cat', `${base}.code`], execOptions.signal);
          const match = /^(\d+)\n$/u.exec(status.stdout);
          if (status.exitCode === 0 && match) exitCode = Number(match[1]);
        }
        return { exitCode, ...await output(execOptions.signal) };
      } catch (error) {
        if (!execOptions.signal.aborted) throw error;
        // Ending the call ends the command: every process carrying its tag is killed, then what it wrote is read.
        const kill = AbortSignal.timeout(8_000);
        await run(script(sandboxScripts.kill, [tag]), kill).catch(() => undefined);
        return output(kill).catch(() => ({ stdout: new Uint8Array(0), stderr: new Uint8Array(0), truncated: false }));
      } finally {
        void run(['sh', '-c', 'rm -f -- "$1".out "$1".err "$1".in "$1".env "$1".code', 'mayura', base], AbortSignal.timeout(30_000)).catch(() => undefined);
      }
    },
    readFile: async (path, { maxBytes, signal }) => {
      const size = await run(script('[ -e "$1" ] || exit 3; [ -f "$1" ] || exit 4; stat -c %s -- "$1"', [path]), signal);
      if (size.exitCode === 3) return undefined;
      if (size.exitCode === 4) throw new MayuraError('INVALID_INPUT', 'That path is not a file.');
      const bytes = /^(\d{1,16})\n?$/u.exec(size.stdout);
      if (size.exitCode !== 0 || !bytes) throw new SandboxError('rejected');
      const total = Number(bytes[1]);
      if (total > maxBytes) throw new MayuraError('LIMIT_EXCEEDED', `The file is larger than ${maxBytes} bytes.`);
      const data = new Uint8Array(total);
      for (let offset = 0; offset < total; offset += chunkBytes) {
        const length = Math.min(chunkBytes, total - offset);
        const chunk = await run(script(readChunkScript, [path, String(offset), String(length)]), signal);
        if (chunk.exitCode !== 0) throw new SandboxError('rejected');
        const part = fromBase64(chunk.stdout);
        // The file changed while it was read.
        if (part.byteLength !== length) throw new SandboxError('rejected');
        data.set(part, offset);
      }
      return data;
    },
    writeFile: (path, data, { signal }) => write(path, data, signal),
    listFiles: async (path, { limit, signal }) => {
      const result = await run(script(sandboxScripts.list, [path, String(limit)]), signal);
      if (result.exitCode === 3) return undefined;
      if (result.exitCode === 4) throw new MayuraError('INVALID_INPUT', 'That path is not a directory.');
      if (result.exitCode !== 0) throw new SandboxError('rejected');
      return parseSandboxListing(new TextEncoder().encode(result.stdout));
    },
    removeFile: async (path, { recursive, signal }) => {
      const result = await run(script(sandboxScripts.remove, [path, recursive ? '1' : '0']), signal);
      if (result.exitCode === 7) throw new MayuraError('INVALID_INPUT', 'The directory is not empty; remove it with recursive.');
      if (result.exitCode !== 0) throw new SandboxError('rejected');
    },
    release: ({ signal }) => release(signal),
  };
}
