import { request, type IncomingMessage } from 'node:http';
import type { Socket } from 'node:net';
import { MayuraError } from '@mayura/core';
import { SandboxError, sandboxHttpFailure } from '../contracts.js';
import { Collector, type DockerEngine, type EngineExecOptions, type EngineExecResult, type RunConfig } from './engine.js';

/**
 * The local socket of a Docker host: `unix:///var/run/docker.sock` or `npipe:////./pipe/docker_engine`. Remote
 * (`tcp://`, `ssh://`) hosts are refused: the Engine API has no authentication of its own.
 */
export function dockerSocketPath(host: string): string {
  if (typeof host !== 'string') throw new MayuraError('INVALID_CONFIG', 'The Docker host must be a string.');
  if (host.startsWith('unix://')) { const path = host.slice('unix://'.length); if (path.startsWith('/')) return path; }
  if (host.startsWith('npipe://')) {
    const pipe = host.slice('npipe://'.length).replaceAll('/', '\\');
    if (/^\\\\\.\\pipe\\[A-Za-z0-9_.-]{1,128}$/u.test(pipe)) return pipe;
  }
  throw new MayuraError('INVALID_CONFIG', 'The Docker host must be a local socket: unix:///path or npipe:////./pipe/name.');
}

const maxJsonBytes = 4 * 1_048_576;

function readBody(response: IncomingMessage, max: number): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const collected = new Collector(max);
    response.on('data', (chunk: Uint8Array) => { collected.push(chunk); if (collected.truncated) { response.destroy(); reject(new SandboxError('invalid_response')); } });
    response.on('end', () => resolve(collected.bytes()));
    response.on('error', () => reject(new SandboxError('unavailable')));
  });
}

/**
 * The Docker Engine API on a local socket as a sandbox engine. With several sockets (the platform's defaults), the
 * first that answers is used from then on.
 */
export function dockerApi(socketPaths: readonly string[]): DockerEngine {
  let socketPath: string | undefined = socketPaths.length === 1 ? socketPaths[0] : undefined;
  let finding: Promise<string> | undefined;
  const socket = (signal: AbortSignal): Promise<string> => {
    if (socketPath !== undefined) return Promise.resolve(socketPath);
    finding ??= (async () => {
      for (const candidate of socketPaths) {
        const answered = await send(candidate, 'GET', '/_ping', signal).then(() => true, () => false);
        if (answered) { socketPath = candidate; return candidate; }
      }
      finding = undefined;
      throw new SandboxError('unavailable');
    })();
    return finding;
  };
  const call = async (method: string, path: string, signal: AbortSignal, body?: unknown) => send(await socket(signal), method, path, signal, body);
  const send = (through: string, method: string, path: string, signal: AbortSignal, body?: unknown): Promise<{ status: number; json: unknown }> => new Promise((resolve, reject) => {
    const data = body === undefined ? undefined : new TextEncoder().encode(JSON.stringify(body));
    const req = request({ socketPath: through, method, path, signal, headers: { host: 'docker', ...(data ? { 'content-type': 'application/json', 'content-length': String(data.byteLength) } : {}) } }, response => {
      readBody(response, maxJsonBytes).then(bytes => {
        const textBody = new TextDecoder().decode(bytes);
        let json: unknown;
        try { json = textBody === '' ? undefined : JSON.parse(textBody); } catch { json = undefined; }
        resolve({ status: response.statusCode ?? 0, json });
      }, reject);
    });
    req.on('error', () => reject(signal.aborted ? new SandboxError('timeout') : new SandboxError('unavailable')));
    req.end(data);
  });
  const expect = async (method: string, path: string, signal: AbortSignal, ok: readonly number[], body?: unknown) => {
    const result = await call(method, path, signal, body);
    if (!ok.includes(result.status)) throw sandboxHttpFailure(result.status >= 100 && result.status <= 599 ? result.status : 502);
    return result.json;
  };

  /** Starts an exec with its streams attached, and settles when they end, or with what came when `signal` aborts. */
  const attach = (execId: string, options: EngineExecOptions): Promise<{ stdout: Collector; stderr: Collector; stopped: boolean }> => new Promise((resolve, reject) => {
    const stdout = new Collector(options.maxOutputBytes); const stderr = new Collector(options.maxOutputBytes);
    const body = new TextEncoder().encode(JSON.stringify({ Detach: false, Tty: false }));
    let pending = new Uint8Array(0); let done = false; let socket: Socket | IncomingMessage | undefined;
    const finish = (stopped: boolean) => { if (done) return; done = true; options.signal.removeEventListener('abort', onAbort); resolve({ stdout, stderr, stopped }); };
    const onAbort = () => { socket?.destroy(); req.destroy(); finish(true); };
    // The stream is framed: one byte of stream (1 stdout, 2 stderr), three of zero, four of length, then the bytes.
    const onData = (chunk: Uint8Array) => {
      const joined = new Uint8Array(pending.byteLength + chunk.byteLength); joined.set(pending); joined.set(chunk, pending.byteLength);
      let offset = 0;
      while (joined.byteLength - offset >= 8) {
        const kind = joined[offset]!; const size = new DataView(joined.buffer, joined.byteOffset + offset + 4, 4).getUint32(0);
        if (joined.byteLength - offset - 8 < size) break;
        const payload = joined.subarray(offset + 8, offset + 8 + size);
        if (kind === 2) stderr.push(payload); else if (kind === 1 || kind === 0) stdout.push(payload);
        offset += 8 + size;
      }
      pending = joined.slice(offset);
    };
    const req = request({ socketPath: socketPath!, method: 'POST', path: `/exec/${execId}/start`,
      headers: { host: 'docker', 'content-type': 'application/json', 'content-length': String(body.byteLength), connection: 'Upgrade', upgrade: 'tcp' } });
    options.signal.addEventListener('abort', onAbort, { once: true });
    req.on('upgrade', (_response, upgraded, head) => {
      socket = upgraded;
      if (head.byteLength) onData(head);
      upgraded.on('data', onData);
      upgraded.on('end', () => finish(false)); upgraded.on('close', () => finish(false)); upgraded.on('error', () => finish(false));
      // Input is written whole and never closed: the command reads exactly its length (see the exec script), since a
      // Windows named pipe cannot close one direction of the connection.
      if (options.stdin) upgraded.write(options.stdin);
    });
    req.on('response', response => {
      if (response.statusCode !== 200) { response.resume(); if (!done) { done = true; options.signal.removeEventListener('abort', onAbort); reject(sandboxHttpFailure(response.statusCode ?? 502)); } return; }
      socket = response;
      response.on('data', onData); response.on('end', () => finish(false)); response.on('error', () => finish(false));
    });
    req.on('error', () => { if (!done) { done = true; options.signal.removeEventListener('abort', onAbort); reject(options.signal.aborted ? new SandboxError('timeout') : new SandboxError('unavailable')); } });
    req.end(body);
  });

  return {
    hasImage: async (image, signal) => {
      // The image reference was checked to be letters, digits and . _ / : @ -, which the path takes as they are.
      const result = await call('GET', `/images/${image}/json`, signal);
      if (result.status === 200) return true;
      if (result.status === 404) return false;
      throw sandboxHttpFailure(result.status || 502);
    },
    run: async (config: RunConfig, signal) => {
      const ports = Object.fromEntries(config.ports.map(port => [`${port}/tcp`, {}]));
      const created = await expect('POST', `/containers/create?name=${encodeURIComponent(config.name)}`, signal, [201], {
        Image: config.image, Cmd: config.command, User: config.user, WorkingDir: config.workdir,
        Env: Object.entries(config.env).map(([name, value]) => `${name}=${value}`), Labels: config.labels, ExposedPorts: ports,
        HostConfig: {
          AutoRemove: true, Init: true, NetworkMode: config.network, CapDrop: ['ALL'], SecurityOpt: ['no-new-privileges'], ReadonlyRootfs: config.readOnlyRoot,
          Tmpfs: config.tmpfs, PidsLimit: config.pids, Memory: config.memoryMiB * 1_048_576, MemorySwap: config.memoryMiB * 1_048_576, NanoCpus: Math.round(config.cpus * 1e9),
          PortBindings: Object.fromEntries(config.ports.map(port => [`${port}/tcp`, [{ HostIp: '127.0.0.1', HostPort: '' }]])),
        },
      }) as { Id?: unknown } | undefined;
      const id = created?.Id;
      if (typeof id !== 'string' || !/^[a-f0-9]{64}$/u.test(id)) throw new SandboxError('invalid_response');
      try { await expect('POST', `/containers/${id}/start`, signal, [204, 304]); } catch (error) {
        await call('DELETE', `/containers/${id}?force=true`, AbortSignal.timeout(30_000)).catch(() => undefined);
        throw error;
      }
      return id;
    },
    exec: async (container, command, options): Promise<EngineExecResult> => {
      const created = await call('POST', `/containers/${container}/exec`, options.signal, {
        AttachStdin: options.stdin !== undefined, AttachStdout: true, AttachStderr: true, Tty: false, Cmd: command,
        Env: Object.entries(options.env).map(([name, value]) => `${name}=${value}`),
      }).catch(error => { if (options.signal.aborted) return undefined; throw error; });
      if (!created) return { stdout: new Uint8Array(0), stderr: new Uint8Array(0), truncated: false };
      // 409: the container is not running.
      if (created.status === 404 || created.status === 409) throw new SandboxError('gone');
      if (created.status !== 201) throw sandboxHttpFailure(created.status || 502);
      const execId = (created.json as { Id?: unknown } | undefined)?.Id;
      if (typeof execId !== 'string' || !/^[a-f0-9]{64}$/u.test(execId)) throw new SandboxError('invalid_response');
      const streams = await attach(execId, options);
      const output = { stdout: streams.stdout.bytes(), stderr: streams.stderr.bytes(), truncated: streams.stdout.truncated || streams.stderr.truncated };
      if (streams.stopped) return output;
      // The exit code is recorded as the streams end; ask again briefly if it is not there yet.
      for (let attempt = 0; attempt < 20; attempt++) {
        const inspected = await expect('GET', `/exec/${execId}/json`, AbortSignal.timeout(30_000), [200]) as { Running?: unknown; ExitCode?: unknown } | undefined;
        if (inspected?.Running === false && Number.isSafeInteger(inspected.ExitCode)) return { ...output, exitCode: inspected.ExitCode as number };
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      throw new SandboxError('invalid_response');
    },
    hostPort: async (container, port, signal) => {
      const inspected = await expect('GET', `/containers/${container}/json`, signal, [200]) as { NetworkSettings?: { Ports?: Record<string, { HostIp?: string; HostPort?: string }[] | null> } } | undefined;
      const binding = inspected?.NetworkSettings?.Ports?.[`${port}/tcp`]?.find(item => item.HostIp === '127.0.0.1');
      return binding?.HostPort && /^\d{1,5}$/u.test(binding.HostPort) ? Number(binding.HostPort) : undefined;
    },
    remove: async (container, signal) => {
      const result = await call('DELETE', `/containers/${container}?force=true`, signal);
      // 404: already gone; 409: already being removed.
      if (![204, 404, 409].includes(result.status)) throw sandboxHttpFailure(result.status || 502);
    },
  };
}
