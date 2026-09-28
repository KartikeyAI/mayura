// Option validation and the exact container flags. Internal: not part of the package's exports.
import { isAbsolute } from 'node:path';
import type { CodeLimits } from '@mayura/code-mode';
import { MayuraError, type ErrorCode } from '@mayura/core';
import type { DockerQuickJsAdapterOptions } from './index.js';

export const imageId = /^sha256:[a-f0-9]{64}$/;
export const provenanceDigest = /^sha256:[a-f0-9]{64}$/;
const daemonHost = /^(?:unix:\/\/\/[^\s,]{1,4096}|npipe:\/\/\/\/\.\/pipe\/[A-Za-z0-9._-]{1,256})$/;
const runtimeName = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
export function fail(code: ErrorCode, message: string): never { throw new MayuraError(code, message); }

const optionKeys = ['dockerPath', 'image', 'provenance', 'host', 'runtime'];

export function config(value: unknown, extra: readonly string[] = []): DockerQuickJsAdapterOptions {
  if (!value || typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype) fail('INVALID_CONFIG', 'Docker adapter options must be a plain object.');
  const fields = Object.getOwnPropertyDescriptors(value);
  const unknown = Reflect.ownKeys(fields).find(key => typeof key !== 'string' || ![...optionKeys, ...extra].includes(key));
  if (unknown !== undefined) fail('INVALID_CONFIG', typeof unknown === 'string' && unknown.length <= 64 ? `Unknown Docker adapter option "${unknown}".` : 'Docker adapter options contain an unknown key.');
  if (Object.values(fields).some(field => !('value' in field))) fail('INVALID_CONFIG', 'Docker adapter options must be plain data properties.');
  const read = (key: string): unknown => fields[key]?.value;
  const dockerPath = read('dockerPath'); const image = read('image'); const provenance = read('provenance');
  const host = read('host'); const runtime = read('runtime');
  if (typeof dockerPath !== 'string' || !isAbsolute(dockerPath)) fail('INVALID_CONFIG', 'dockerPath must be the absolute path of a trusted Docker CLI; PATH lookup is not supported.');
  if (typeof image !== 'string' || !imageId.test(image)) fail('INVALID_CONFIG', 'image must be an exact local image id such as "sha256:<64 hex>", from docker image inspect --format {{.Id}}.');
  if (typeof provenance !== 'string' || !provenanceDigest.test(provenance)) fail('INVALID_CONFIG', 'provenance must be the "sha256:<64 hex>" digest of the image\'s SPDX document.');
  if (host !== undefined && (typeof host !== 'string' || !daemonHost.test(host))) fail('INVALID_CONFIG', 'host must be "unix:///absolute/path.sock" or "npipe:////./pipe/<name>".');
  if (runtime !== undefined && (typeof runtime !== 'string' || !runtimeName.test(runtime))) fail('INVALID_CONFIG', 'runtime must be an OCI runtime name such as "runsc".');
  return Object.freeze({ dockerPath: dockerPath as string, image: image as string, provenance: provenance as string,
    ...(host === undefined ? {} : { host: host as string }), ...(runtime === undefined ? {} : { runtime: runtime as string }) });
}

function bytes(value: number): string { return `${value}b`; }

/**
 * The exact `docker` arguments for one sandbox run. Every run gets: no network, a read-only root, a private IPC
 * namespace, no Linux capabilities, no-new-privileges, Docker's default seccomp profile, an unprivileged user, at
 * most 16 processes and 64 open files, one CPU, memory without extra swap, a small noexec tmpfs, and no log driver,
 * so tool data on the protocol streams is never written to daemon logs.
 */
export function dockerRunArguments(options: DockerQuickJsAdapterOptions, name: string, limits: CodeLimits): string[] {
  const selected = config(options);
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(name)) fail('INVALID_CONFIG', 'The container name must be a Docker container name.');
  const memory = Math.min(2_415_919_104, limits.memoryBytes + 268_435_456);
  return [...(selected.host ? ['--host', selected.host] : []), 'run', '--rm', '--interactive', '--pull=never', '--name', name,
    '--network=none', '--read-only', '--cap-drop=ALL', '--security-opt=no-new-privileges=true', '--security-opt=seccomp=builtin',
    '--pids-limit=16', '--ulimit=nofile=64:64', '--cpus=1', '--memory', bytes(memory), '--memory-swap', bytes(memory),
    '--user=65532:65532', '--ipc=none', '--log-driver=none', '--tmpfs', `/tmp:rw,noexec,nosuid,nodev,size=${limits.scratchBytes}`,
    ...(selected.runtime ? [`--runtime=${selected.runtime}`] : []), selected.image];
}

