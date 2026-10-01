import { execFile, spawn } from 'node:child_process';
import { Readable } from 'node:stream';
import { promisify } from 'node:util';
import { expect } from 'vitest';

const docker = promisify(execFile);
export interface Created { readonly app: string; readonly image: string; readonly params: Record<string, unknown> }
export interface FakeModal {
  readonly client: never;
  readonly created: Created[];
  readonly execs: { readonly command: string[]; readonly params: Record<string, unknown> }[];
  readonly terminated: string[];
}
type Run = (command: string[], params: Record<string, unknown>, stdin: Uint8Array) => Promise<{ stdout?: string; stderr?: string; exitCode: number } | 'hang'>;

/**
 * A ModalClient as the provider uses it. Commands run by `run`, or for real in a local container (`docker exec`) when
 * `container` is given.
 */
export function fakeModal(options: { readonly run?: Run; readonly container?: string; readonly create?: () => Promise<void>; readonly terminate?: () => Promise<void> } = {}): FakeModal {
  const created: Created[] = []; const execs: FakeModal['execs'] = []; const terminated: string[] = [];
  const exec = async (command: string[], params: Record<string, unknown>) => {
    execs.push({ command, params });
    if (options.container) {
      const env = Object.entries((params['env'] ?? {}) as Record<string, string>).flatMap(([key, value]) => ['-e', `${key}=${value}`]);
      const child = spawn('docker', ['exec', '-i', ...env, options.container, ...command], { windowsHide: true });
      const exit = new Promise<number>(resolve => child.on('close', code => resolve(code ?? -1)));
      return {
        stdout: Readable.toWeb(child.stdout), stderr: Readable.toWeb(child.stderr),
        stdin: { writeBytes: (bytes: Uint8Array) => new Promise<void>((resolve, reject) => child.stdin.write(bytes, error => (error ? reject(error) : resolve()))) },
        closeStdin: async () => { child.stdin.end(); }, wait: () => exit,
      };
    }
    const chunks: Uint8Array[] = []; let closed!: () => void; const stdinClosed = new Promise<void>(resolve => { closed = resolve; });
    const answer = (async () => { await stdinClosed; return options.run ? options.run(command, params, new Uint8Array(Buffer.concat(chunks))) : { exitCode: 0 } as { stdout?: string; stderr?: string; exitCode: number }; })();
    let out!: (text?: string) => void; let err!: (text?: string) => void;
    const stdout = new ReadableStream<Uint8Array>({ start(controller) { out = text => { if (text) controller.enqueue(new TextEncoder().encode(text)); controller.close(); }; } });
    const stderr = new ReadableStream<Uint8Array>({ start(controller) { err = text => { if (text) controller.enqueue(new TextEncoder().encode(text)); controller.close(); }; } });
    const exit = answer.then(result => {
      if (result === 'hang') return new Promise<number>(() => undefined);
      out(result.stdout); err(result.stderr); return result.exitCode;
    });
    return { stdout, stderr, stdin: { writeBytes: async (bytes: Uint8Array) => { chunks.push(bytes); } }, closeStdin: async () => { closed(); }, wait: () => exit };
  };
  const client = {
    apps: { fromName: async (name: string, params: Record<string, unknown>) => { expect(params['createIfMissing']).toBe(true); return { appId: 'ap-1', name }; } },
    images: { fromRegistry: (tag: string) => ({ tag }) },
    sandboxes: {
      create: async (app: { name: string }, image: { tag: string }, params: Record<string, unknown>) => {
        await options.create?.();
        created.push({ app: app.name, image: image.tag, params });
        return {
          sandboxId: 'sb-1', exec,
          terminate: async () => { await options.terminate?.(); terminated.push('sb-1'); },
          tunnels: async () => ({ 3000: { url: 'https://abc-3000.modal.host' } }),
        };
      },
    },
  };
  return { client: client as never, created, execs, terminated };
}

/** A local container for the fake's commands; never pulls the image. */
export async function startContainer(image: string): Promise<{ name: string; stop: () => Promise<void> }> {
  const name = `mayura-modal-test-${Math.random().toString(16).slice(2, 10)}`;
  await docker('docker', ['run', '-d', '--rm', '--pull', 'never', '--network', 'none', '--name', name, '--label', 'mayura.sandbox=modal-test', image, 'sleep', '600'], { windowsHide: true });
  return { name, stop: async () => { await docker('docker', ['rm', '-f', name], { windowsHide: true }).catch(() => undefined); } };
}

