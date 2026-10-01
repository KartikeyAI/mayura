import { spawn } from 'node:child_process';
import { MayuraError } from '@mayura/core';
import { SandboxError } from '../contracts.js';
import { Collector, type DockerEngine, type EngineExecOptions, type EngineExecResult, type RunConfig } from './engine.js';

interface Spawned { readonly exitCode?: number; readonly stdout: Uint8Array; readonly stderr: Uint8Array; readonly truncated: boolean }

/** Runs the docker CLI without a shell. Aborting `signal` kills it and settles with what it printed, without an exit code. */
function docker(path: string, args: readonly string[], options: { readonly stdin?: Uint8Array; readonly maxOutputBytes: number; readonly signal: AbortSignal }): Promise<Spawned> {
  return new Promise((resolve, reject) => {
    if (options.signal.aborted) { resolve({ stdout: new Uint8Array(0), stderr: new Uint8Array(0), truncated: false }); return; }
    let child;
    try {
      child = spawn(path, args, { stdio: [options.stdin ? 'pipe' : 'ignore', 'pipe', 'pipe'], windowsHide: true, shell: false });
    } catch { reject(new SandboxError('unavailable')); return; }
    const stdout = new Collector(options.maxOutputBytes); const stderr = new Collector(options.maxOutputBytes);
    let stopped = false; let settled = false;
    const onAbort = () => { stopped = true; child.kill('SIGKILL'); };
    options.signal.addEventListener('abort', onAbort, { once: true });
    child.stdout!.on('data', (chunk: Uint8Array) => stdout.push(chunk));
    child.stderr!.on('data', (chunk: Uint8Array) => stderr.push(chunk));
    child.on('error', error => {
      if (settled) return; settled = true; options.signal.removeEventListener('abort', onAbort);
      reject((error as NodeJS.ErrnoException).code === 'ENOENT' ? new MayuraError('INVALID_CONFIG', `The docker CLI was not found at ${path}.`) : new SandboxError('unavailable'));
    });
    child.on('close', code => {
      if (settled) return; settled = true; options.signal.removeEventListener('abort', onAbort);
      resolve({ ...(stopped || code === null ? {} : { exitCode: code }), stdout: stdout.bytes(), stderr: stderr.bytes(), truncated: stdout.truncated || stderr.truncated });
    });
    if (options.stdin) {
      // A command that exits without reading all of its input closes the pipe; that is not a failure.
      child.stdin!.on('error', () => undefined);
      child.stdin!.end(options.stdin);
    }
  });
}

const text = (data: Uint8Array) => new TextDecoder().decode(data);
const containerGone = (container: string) => new RegExp(`^Error response from daemon: (?:No such container: ${container}|container ${container} is not running)\\s*$`, 'u');
/** The docker CLI's own failure: nothing it printed reaches the error. */
function failed(result: Spawned): never {
  if (result.exitCode === undefined) throw new SandboxError('timeout');
  const message = text(result.stderr);
  if (/No such container/iu.test(message)) throw new SandboxError('gone');
  if (/Cannot connect to the Docker daemon|error during connect|daemon is not running/iu.test(message)) throw new SandboxError('unavailable');
  throw new SandboxError('rejected');
}

/** The docker CLI at `path` as a sandbox engine. */
export function dockerCli(path: string): DockerEngine {
  const call = async (args: readonly string[], signal: AbortSignal, maxOutputBytes = 65_536) => {
    const result = await docker(path, args, { maxOutputBytes, signal });
    if (result.exitCode !== 0) failed(result);
    return text(result.stdout).trim();
  };
  return {
    hasImage: async (image, signal) => {
      const result = await docker(path, ['image', 'inspect', '--format', '{{.Id}}', image], { maxOutputBytes: 65_536, signal });
      if (result.exitCode === 0) return true;
      if (/No such image/iu.test(text(result.stderr))) return false;
      return failed(result);
    },
    run: async (config: RunConfig, signal) => {
      const args = ['run', '--detach', '--rm', '--init', '--pull', 'never', '--name', config.name, '--user', config.user, '--workdir', config.workdir,
        '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--pids-limit', String(config.pids),
        '--memory', `${config.memoryMiB}m`, '--memory-swap', `${config.memoryMiB}m`, '--cpus', String(config.cpus), '--network', config.network];
      if (config.readOnlyRoot) args.push('--read-only');
      for (const [mount, options] of Object.entries(config.tmpfs)) args.push('--tmpfs', `${mount}:${options}`);
      for (const port of config.ports) args.push('--publish', `127.0.0.1::${port}`);
      for (const [name, value] of Object.entries(config.env)) args.push('--env', `${name}=${value}`);
      for (const [name, value] of Object.entries(config.labels)) args.push('--label', `${name}=${value}`);
      args.push(config.image, ...config.command);
      const id = await call(args, signal);
      if (!/^[a-f0-9]{64}$/u.test(id)) throw new SandboxError('invalid_response');
      return id;
    },
    exec: async (container, command, options: EngineExecOptions): Promise<EngineExecResult> => {
      const args = ['exec', ...(options.stdin ? ['--interactive'] : [])];
      for (const [name, value] of Object.entries(options.env)) args.push('--env', `${name}=${value}`);
      args.push(container, ...command);
      const result = await docker(path, args, { maxOutputBytes: options.maxOutputBytes, signal: options.signal, ...(options.stdin ? { stdin: options.stdin } : {}) });
      // docker's own refusal names this container exactly; a command's output cannot be mistaken for it unless it
      // prints that same line and nothing else.
      if (result.exitCode !== undefined && result.exitCode !== 0 && containerGone(container).test(text(result.stderr))) throw new SandboxError('gone');
      return { ...(result.exitCode === undefined ? {} : { exitCode: result.exitCode }), stdout: result.stdout, stderr: result.stderr, truncated: result.truncated };
    },
    hostPort: async (container, port, signal) => {
      const result = await docker(path, ['port', container, `${port}/tcp`], { maxOutputBytes: 4_096, signal });
      if (result.exitCode !== 0) { if (/No public port|no such|not published/iu.test(text(result.stderr))) return undefined; failed(result); }
      const match = /^127\.0\.0\.1:(\d{1,5})$/mu.exec(text(result.stdout));
      return match ? Number(match[1]) : undefined;
    },
    remove: async (container, signal) => {
      const result = await docker(path, ['rm', '--force', container], { maxOutputBytes: 4_096, signal });
      if (result.exitCode !== 0 && !/No such container|removal of container .* is already in progress/iu.test(text(result.stderr))) failed(result);
    },
  };
}
