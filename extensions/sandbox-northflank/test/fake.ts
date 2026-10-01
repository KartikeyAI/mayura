import { execFile, spawn } from 'node:child_process';
import { PassThrough } from 'node:stream';
import { promisify } from 'node:util';
import type { NorthflankClientLike, NorthflankExecLike } from '../src/index.js';

const docker = promisify(execFile);
export class NorthflankApiCallError extends Error { constructor(readonly status: number) { super('secret detail from northflank'); } }
type Answer = { stdout?: string; exitCode: number } | 'hang' | 'unavailable';

export interface FakeNorthflank {
  readonly client: NorthflankClientLike;
  readonly created: { parameters: Record<string, string>; data: Record<string, unknown> }[];
  readonly commands: string[][];
  readonly deleted: Record<string, string>[];
}
/** Northflank's client, running commands by `run`, or for real in a local container when `container` is given. */
export function fakeNorthflank(options: { readonly run?: (command: string[], stdin: Uint8Array) => Answer; readonly container?: string; readonly create?: () => Promise<void>; readonly delete?: () => Promise<void> } = {}): FakeNorthflank {
  const created: FakeNorthflank['created'] = []; const commands: string[][] = []; const deleted: Record<string, string>[] = [];
  const execServiceSession = async (_parameters: Record<string, string>, data: { command: string[] }): Promise<NorthflankExecLike> => {
    commands.push(data.command);
    if (options.container) {
      const child = spawn('docker', ['exec', '-i', options.container, ...data.command], { windowsHide: true });
      const exit = new Promise<{ exitCode: number }>(resolve => child.on('close', code => resolve({ exitCode: code ?? -1 })));
      return { stdOut: child.stdout, stdErr: child.stderr, stdIn: child.stdin, waitForCommandResult: () => exit };
    }
    const stdOut = new PassThrough(); const stdErr = new PassThrough(); const stdIn = new PassThrough(); const input: Buffer[] = [];
    stdIn.on('data', chunk => input.push(chunk));
    const result = new Promise<{ exitCode: number }>((resolve, reject) => stdIn.on('end', () => {
      const answer = options.run?.(data.command, new Uint8Array(Buffer.concat(input))) ?? { exitCode: 0 };
      if (answer === 'hang') return;
      if (answer === 'unavailable') { reject(new NorthflankApiCallError(503)); return; }
      stdOut.end(answer.stdout ?? ''); stdErr.end(); resolve({ exitCode: answer.exitCode });
    }));
    stdIn.resume();
    return { stdOut, stdErr, stdIn, waitForCommandResult: () => result };
  };
  const client: NorthflankClientLike = {
    create: { service: { deployment: async request => { await options.create?.(); created.push(request); return { data: { id: 'mayura-svc-1' } }; } } },
    delete: { service: async request => { await options.delete?.(); deleted.push(request.parameters); return {}; } },
    exec: { execServiceSession },
  };
  return { client, created, commands, deleted };
}

export async function startContainer(image: string): Promise<{ name: string; stop: () => Promise<void> }> {
  const name = `mayura-northflank-test-${Math.random().toString(16).slice(2, 10)}`;
  await docker('docker', ['run', '-d', '--rm', '--pull', 'never', '--network', 'none', '--name', name, '--label', 'mayura.sandbox=northflank-test', image, 'sleep', '600'], { windowsHide: true });
  return { name, stop: async () => { await docker('docker', ['rm', '-f', name], { windowsHide: true }).catch(() => undefined); } };
}
