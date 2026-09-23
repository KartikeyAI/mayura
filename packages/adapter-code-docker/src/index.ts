import { execFile, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { isAbsolute } from 'node:path';
import { promisify } from 'node:util';
import { createQuickJsProtocolAdapter, type QuickJsChildProcess, type QuickJsWorkerProcess } from '@mayura/adapter-code-quickjs';
import type { SandboxAdapter, SandboxExecutionRequest } from '@mayura/code-mode';

const executeFile = promisify(execFile);
const imageId = /^sha256:[a-f0-9]{64}$/;

export interface DockerQuickJsAdapterOptions {
  /** Absolute trusted Docker CLI path. PATH lookup is deliberately unsupported. */
  readonly dockerPath: string;
  /** Exact locally present content ID returned by `docker image inspect --format {{.Id}}`. */
  readonly image: string;
}

function config(value: DockerQuickJsAdapterOptions): DockerQuickJsAdapterOptions {
  if (!value || Object.getPrototypeOf(value) !== Object.prototype) throw new TypeError('Docker adapter configuration must be plain data.');
  const fields = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(fields).length !== 2 || !fields['dockerPath'] || !('value' in fields['dockerPath'])
    || !fields['image'] || !('value' in fields['image']) || typeof fields['dockerPath'].value !== 'string'
    || !isAbsolute(fields['dockerPath'].value) || typeof fields['image'].value !== 'string' || !imageId.test(fields['image'].value)) {
    throw new TypeError('Docker adapter requires an absolute CLI path and exact sha256 image ID.');
  }
  return Object.freeze({ dockerPath: fields['dockerPath'].value, image: fields['image'].value });
}

function bytes(value: number): string { return `${value}b`; }

/** Creates the hardened local Docker profile; qualification remains test-only until the full V15 matrix passes. */
export function createDockerQuickJsSandboxAdapter(options: DockerQuickJsAdapterOptions): SandboxAdapter {
  const selected = config(options);
  return createQuickJsProtocolAdapter({
    id: 'mayura.quickjs-docker',
    version: '0.1.0',
    isAvailable: async () => {
      try {
        const result = await executeFile(selected.dockerPath, ['image', 'inspect', '--format', '{{.Id}}', selected.image], {
          windowsHide: true, timeout: 10_000, maxBuffer: 4_096, env: Object.freeze({}),
        });
        return result.stdout.trim() === selected.image;
      } catch { return false; }
    },
    launch: (request: SandboxExecutionRequest): QuickJsWorkerProcess => {
      const name = `mayura-code-${randomUUID()}`;
      const memory = Math.min(2_415_919_104, request.manifest.limits.memoryBytes + 268_435_456);
      const args = ['run', '--rm', '--interactive', '--pull=never', '--name', name,
        '--network=none', '--read-only', '--cap-drop=ALL', '--security-opt=no-new-privileges=true', '--security-opt=seccomp=builtin',
        '--pids-limit=16', '--ulimit=nofile=64:64', '--cpus=1', '--memory', bytes(memory), '--memory-swap', bytes(memory),
        '--user=65532:65532', '--ipc=none', '--tmpfs', `/tmp:rw,noexec,nosuid,nodev,size=${request.manifest.limits.scratchBytes}`,
        selected.image];
      const child = spawn(selected.dockerPath, args, {
        windowsHide: true,
        env: Object.freeze({}),
        stdio: ['pipe', 'pipe', 'pipe'],
      }) as unknown as QuickJsChildProcess;
      const terminate = (): void => {
        child.stdin.destroy(); child.stdout.destroy(); child.stderr.destroy(); child.kill('SIGKILL');
        const remover = execFile(selected.dockerPath, ['rm', '--force', name], { windowsHide: true, env: Object.freeze({}), timeout: 10_000 }, () => undefined);
        remover.unref();
      };
      return Object.freeze({ child, terminate });
    },
  });
}
