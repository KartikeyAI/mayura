import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import type { RailwaySandboxLike } from '../src/index.js';

const docker = promisify(execFile);
/** As Railway's SDK names it, so the provider recognizes a missing file. */
export class SandboxFileNotFoundError extends Error {}
export class RailwayAuthError extends Error {}
export class RailwayGraphQLError extends Error { constructor(readonly status: number) { super('secret detail from railway'); } }

function run(container: string, command: readonly string[], stdin?: Uint8Array): Promise<{ code: number; stdout: Buffer }> {
  return new Promise((resolve, reject) => {
    const child = spawn('docker', ['exec', ...(stdin ? ['-i'] : []), container, ...command], { windowsHide: true });
    const out: Buffer[] = []; child.stdout.on('data', chunk => out.push(chunk)); child.stderr.resume();
    child.on('error', reject); child.on('close', code => resolve({ code: code ?? -1, stdout: Buffer.concat(out) }));
    if (stdin) child.stdin.end(stdin);
  });
}

/** A Railway sandbox as the SDK's, running in a local container. */
export function dockerRailwaySandbox(container: string, kills: string[] = []): RailwaySandboxLike {
  const stat = async (path: string) => {
    const result = await run(container, ['sh', '-c', '[ -e "$1" ] || exit 3; stat -c "%s %F" -- "$1"', 'x', path]);
    if (result.code === 3) throw new SandboxFileNotFoundError(path);
    const [size, ...type] = result.stdout.toString().trim().split(' ');
    return { size: Number(size), isDir: type.join(' ') === 'directory' };
  };
  return {
    id: 'sbx-docker', domains: [],
    exec: (command, options = {}) => {
      const env = Object.entries(options.env ?? {}).flatMap(([key, value]) => ['-e', `${key}=${value}`]);
      const child = spawn('docker', ['exec', ...env, container, 'sh', '-c', command], { windowsHide: true });
      child.stdout.resume(); child.stderr.resume();
      const done = new Promise<{ exitCode: number | null }>(resolve => child.on('close', code => resolve({ exitCode: code ?? -1 })));
      return Object.assign(done, { kill: async (signal?: string) => { kills.push(signal ?? 'TERM'); return true; } });
    },
    files: {
      read: async (path, options) => (await run(container, ['head', '-c', String(options.length ?? 1_000_000_000), '--', path])).stdout,
      write: async (path, data) => { await run(container, ['sh', '-c', 'mkdir -p -- "$(dirname -- "$1")" && cat > "$1"', 'x', path], typeof data === 'string' ? Buffer.from(data) : data); },
      list: async path => {
        const result = await run(container, ['sh', '-c', 'cd -- "$1" && for f in .* *; do case $f in .|..) continue;; esac; [ -e "$f" ] || continue; stat -c "%s|%F|%Y|%n" -- "$f"; done', 'x', path]);
        return result.stdout.toString().split('\n').filter(Boolean).map(line => {
          const [size, type, mtime, ...name] = line.split('|');
          return { name: name.join('|'), size: Number(size), isDir: type === 'directory', modTime: new Date(Number(mtime) * 1_000).toISOString() };
        });
      },
      stat,
      remove: async path => {
        const result = await run(container, ['sh', '-c', 'if [ -d "$1" ]; then rmdir -- "$1"; else rm -- "$1"; fi', 'x', path]);
        if (result.code !== 0) throw new Error('remove failed');
      },
    },
    destroy: async () => undefined,
  };
}

export async function startContainer(image: string): Promise<{ name: string; stop: () => Promise<void> }> {
  const name = `mayura-railway-test-${Math.random().toString(16).slice(2, 10)}`;
  await docker('docker', ['run', '-d', '--rm', '--pull', 'never', '--network', 'none', '--name', name, '--label', 'mayura.sandbox=railway-test', image, 'sleep', '600'], { windowsHide: true });
  return { name, stop: async () => { await docker('docker', ['rm', '-f', name], { windowsHide: true }).catch(() => undefined); } };
}
