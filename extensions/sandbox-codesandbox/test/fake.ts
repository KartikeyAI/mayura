import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import type { CodeSandboxClientLike, CodeSandboxSdkLike } from '../src/index.js';

const docker = promisify(execFile);
/** As the SDK throws for a command that exits non-zero. */
export class CommandError extends Error { constructor(readonly exitCode: number, readonly output = '') { super(`Command failed with exit code ${exitCode}`); } }
export class ApiError extends Error { constructor(readonly status: number) { super('secret detail from codesandbox'); } }

function run(container: string, argv: readonly string[], options: { readonly env?: Record<string, string>; readonly stdin?: Uint8Array } = {}): { done: Promise<{ code: number; stdout: Buffer }>; kill: () => void } {
  const env = Object.entries(options.env ?? {}).flatMap(([key, value]) => ['-e', `${key}=${value}`]);
  const child = spawn('docker', ['exec', ...(options.stdin ? ['-i'] : []), ...env, container, ...argv], { windowsHide: true });
  const out: Buffer[] = []; child.stdout.on('data', chunk => out.push(chunk)); child.stderr.resume();
  if (options.stdin) child.stdin.end(options.stdin);
  return { done: new Promise(resolve => child.on('close', code => resolve({ code: code ?? -1, stdout: Buffer.concat(out) }))), kill: () => child.kill() };
}
const finished = async (done: Promise<{ code: number; stdout: Buffer }>) => {
  const result = await done;
  if (result.code !== 0) throw new CommandError(result.code, result.stdout.toString());
  return result.stdout.toString();
};

/** A connected CodeSandbox client whose commands run as a shell line, and whose file system is, in a local container. */
export function dockerClient(container: string, record: { lines: string[]; kills: number } = { lines: [], kills: 0 }): CodeSandboxClientLike {
  const notFound = () => Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
  return {
    commands: {
      run: async (line, options) => { record.lines.push(line); return finished(run(container, ['sh', '-c', line], options).done); },
      runBackground: async (line, options) => {
        record.lines.push(line);
        const started = run(container, ['sh', '-c', line], options);
        return { waitUntilComplete: () => finished(started.done), kill: async () => { record.kills++; started.kill(); } };
      },
    },
    fs: {
      readFile: async path => { const result = await run(container, ['cat', '--', path]).done; if (result.code !== 0) throw notFound(); return new Uint8Array(result.stdout); },
      writeFile: async (path, content) => { const result = await run(container, ['sh', '-c', 'cat > "$1"', 'x', path], { stdin: content }).done; if (result.code !== 0) throw new Error('write failed'); },
      mkdir: async path => { await run(container, ['mkdir', '-p', '--', path]).done; },
      readdir: async path => (await run(container, ['ls', '-A', '--', path]).done).stdout.toString().split('\n').filter(Boolean).map(name => ({ name })),
      stat: async path => {
        const result = await run(container, ['stat', '-c', '%s %F', '--', path]).done;
        if (result.code !== 0) throw notFound();
        const [size, ...type] = result.stdout.toString().trim().split(' ');
        return { size: Number(size), type: type.join(' ') === 'directory' ? 'directory' as const : 'file' as const };
      },
      remove: async (path, recursive) => { await run(container, recursive ? ['rm', '-rf', '--', path] : ['sh', '-c', 'rmdir -- "$1" 2>/dev/null || rm -f -- "$1"', 'x', path]).done; },
    },
    dispose: () => undefined,
  };
}

/** The SDK, its sandboxes made by `client`, recording what is asked of it. */
export function fakeSdk(client: () => CodeSandboxClientLike, options: { readonly create?: () => Promise<void> } = {}) {
  const created: Record<string, unknown>[] = []; const deleted: string[] = []; const tokens: unknown[] = [];
  const sdk: CodeSandboxSdkLike = {
    sandboxes: {
      create: async request => { await options.create?.(); created.push(request); return { id: 'csb-1', connect: async () => client() }; },
      delete: async id => { deleted.push(id); },
    },
    hosts: {
      createToken: async (sandboxId, request) => { tokens.push(request); return { sandboxId, token: 'host-token' }; },
      getUrl: (token, port) => `https://${token.sandboxId}-${port}.csb.app?preview_token=${token.token}`,
    },
  };
  return { sdk, created, deleted, tokens };
}

export async function startContainer(image: string): Promise<{ name: string; stop: () => Promise<void> }> {
  const name = `mayura-csb-test-${Math.random().toString(16).slice(2, 10)}`;
  await docker('docker', ['run', '-d', '--rm', '--pull', 'never', '--network', 'none', '--name', name, '--label', 'mayura.sandbox=csb-test', image, 'sleep', '600'], { windowsHide: true });
  return { name, stop: async () => { await docker('docker', ['rm', '-f', name], { windowsHide: true }).catch(() => undefined); } };
}
