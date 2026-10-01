import { MayuraError } from '@mayura/core';

/** The part of a `Sandbox` the cases use; a sandbox from `createSandboxes` is one. */
export interface ConformanceSandbox {
  readonly workdir: string;
  readonly features: { readonly stdin: boolean };
  exec(command: readonly string[], options?: { readonly cwd?: string; readonly env?: Readonly<Record<string, string>>; readonly stdin?: Uint8Array | string;
    readonly timeoutMs?: number; readonly signal?: AbortSignal }): Promise<{ readonly exitCode?: number; readonly timedOut: boolean; readonly stdout: string; readonly stderr: string }>;
  readFile(path: string, options?: { readonly maxBytes?: number }): Promise<Uint8Array | undefined>;
  writeFile(path: string, data: Uint8Array | string): Promise<void>;
  listFiles(path?: string): Promise<readonly { readonly name: string; readonly type: 'file' | 'directory' | 'other'; readonly size: number }[] | undefined>;
  removeFile(path: string, options?: { readonly recursive?: boolean }): Promise<void>;
}
type Sandbox = ConformanceSandbox;

/** What the sandbox cases run against: one sandbox they may run commands and write files in. */
export interface SandboxHarness {
  /** A sandbox to test, with no network needed. Each case works in its own new directory under the workdir. */
  readonly sandbox: Sandbox;
  /** Cases this provider cannot run, with the reason; they are reported as skipped. */
  readonly skip?: Readonly<Record<string, string>>;
}
export interface SandboxConformanceCase {
  readonly name: string;
  /** Runs the case; throws an `Error` describing the first broken expectation. */
  run(harness: SandboxHarness): Promise<'passed' | 'skipped'>;
}

function check(condition: unknown, message: string): asserts condition { if (!condition) throw new Error(message); }
async function failure(run: () => Promise<unknown>): Promise<unknown> { try { await run(); } catch (error) { return error; } throw new Error('The call must fail.'); }
const text = (data: Uint8Array | undefined) => data === undefined ? undefined : new TextDecoder().decode(data);
const same = (left: Uint8Array, right: Uint8Array) => left.byteLength === right.byteLength && left.every((byte, index) => byte === right[index]);
/** The command lines of every process in the sandbox. */
async function processes(sandbox: Sandbox): Promise<string> {
  const listed = await sandbox.exec(['sh', '-c', 'for p in /proc/[0-9]*; do tr "\\000" " " < "$p/cmdline" 2>/dev/null; echo; done']);
  return listed.stdout;
}
let sequence = 0;

const cases: readonly (readonly [string, (sandbox: Sandbox, directory: string) => Promise<void>, 'stdin'?])[] = [
  ['runs a command and reports its exit code, stdout and stderr apart', async sandbox => {
    const result = await sandbox.exec(['sh', '-c', 'echo out; echo err >&2; exit 3']);
    check(result.exitCode === 3 && !result.timedOut, `The exit code must be 3, not ${result.exitCode}.`);
    check(result.stdout === 'out\n' && result.stderr === 'err\n', 'stdout and stderr must come back apart, exactly.');
    check((await sandbox.exec(['true'])).exitCode === 0, 'A command that succeeds exits 0.');
  }],
  ['passes arguments exactly as given, with no shell in between', async sandbox => {
    const args = ['a b', '$HOME', "'quoted'", '"double"', '*', '; rm -rf /', '\\n', 'ü'];
    const result = await sandbox.exec(['printf', '%s|', ...args]);
    check(result.stdout === `${args.join('|')}|`, 'Every argument must reach the program unchanged.');
  }],
  ['runs in the directory given, with the environment given', async (sandbox, directory) => {
    const value = 'it\'s "quoted" $HOME `cmd`\nsecond line';
    const result = await sandbox.exec(['sh', '-c', 'pwd; printf %s "$GREETING"'], { cwd: directory, env: { GREETING: value } });
    check(result.exitCode === 0 && result.stdout === `${directory}\n${value}`, 'The command must run in cwd and see the variable exactly.');
    const relative = await sandbox.exec(['pwd'], { cwd: directory.slice(sandbox.workdir.length + 1) });
    check(relative.stdout === `${directory}\n`, 'A relative cwd starts at the workdir.');
    check((await sandbox.exec(['pwd'])).stdout === `${sandbox.workdir}\n`, 'Commands run in the workdir by default.');
  }],
  ['reports a program that does not exist as a failed command, not an error', async sandbox => {
    const result = await sandbox.exec(['mayura-no-such-program']);
    check(result.exitCode !== undefined && result.exitCode !== 0, 'A missing program must exit with a non-zero code.');
  }],
  ['gives a command its standard input, and lets it stop reading early', async sandbox => {
    const result = await sandbox.exec(['sh', '-c', 'tr a-z A-Z'], { stdin: 'line one\nline two\n' });
    check(result.exitCode === 0 && result.stdout === 'LINE ONE\nLINE TWO\n', 'The command must read its input exactly.');
    const ignored = await sandbox.exec(['true'], { stdin: new Uint8Array(1_048_576), timeoutMs: 30_000 });
    check(ignored.exitCode === 0, 'A command that ignores its input must still finish.');
  }, 'stdin'],
  ['stops a command and everything it started at the timeout', async sandbox => {
    const result = await sandbox.exec(['sh', '-c', 'sleep 61 & sleep 62 & echo started; wait'], { timeoutMs: 3_000 });
    check(result.timedOut && result.exitCode === undefined, 'A command past its timeout must be reported as timed out, without an exit code.');
    let running = '';
    for (let attempt = 0; attempt < 20; attempt++) {
      running = await processes(sandbox);
      if (!/sleep 6[12]/u.test(running)) break;
      await new Promise(resolve => setTimeout(resolve, 250));
    }
    check(!/sleep 6[12]/u.test(running), 'The command\'s background processes must be stopped too.');
  }],
  ['stops a command when the caller cancels', async sandbox => {
    const controller = new AbortController();
    const pending = sandbox.exec(['sh', '-c', 'sleep 63'], { signal: controller.signal });
    setTimeout(() => controller.abort(), 1_000);
    const error = await failure(() => pending);
    check(error instanceof MayuraError && error.code === 'CANCELLED', 'A cancelled command must fail with CANCELLED.');
    let running = '';
    for (let attempt = 0; attempt < 20; attempt++) {
      running = await processes(sandbox);
      if (!/sleep 63/u.test(running)) break;
      await new Promise(resolve => setTimeout(resolve, 250));
    }
    check(!/sleep 63/u.test(running), 'A cancelled command must be stopped.');
  }],
  ['writes and reads back every byte value, and large files intact', async (sandbox, directory) => {
    const all = new Uint8Array(256).map((_, index) => index);
    await sandbox.writeFile(`${directory}/bytes.bin`, all);
    const back = await sandbox.readFile(`${directory}/bytes.bin`);
    check(back !== undefined && same(back, all), 'Reading must return exactly the bytes written.');
    const large = new Uint8Array(3 * 1_048_576 + 7).map((_, index) => (index * 31 + 7) % 251);
    await sandbox.writeFile(`${directory}/large.bin`, large);
    const largeBack = await sandbox.readFile(`${directory}/large.bin`);
    check(largeBack !== undefined && same(largeBack, large), 'A file of several MiB must come back intact.');
    await sandbox.writeFile(`${directory}/empty.txt`, '');
    check((await sandbox.readFile(`${directory}/empty.txt`))?.byteLength === 0, 'An empty file must read back empty.');
    await sandbox.writeFile(`${directory}/bytes.bin`, 'replaced');
    check(text(await sandbox.readFile(`${directory}/bytes.bin`)) === 'replaced', 'Writing again must replace the file.');
  }],
  ['writes files that commands can use, and reads files commands made', async (sandbox, directory) => {
    await sandbox.writeFile(`${directory}/script.sh`, 'echo from-script\n');
    check((await sandbox.exec(['sh', `${directory}/script.sh`])).stdout === 'from-script\n', 'A written file must be there for commands.');
    await sandbox.exec(['sh', '-c', 'printf made > made.txt'], { cwd: directory });
    check(text(await sandbox.readFile(`${directory}/made.txt`)) === 'made', 'A file a command made must be readable.');
  }],
  ['reports missing files and directories as undefined', async (sandbox, directory) => {
    check(await sandbox.readFile(`${directory}/none.txt`) === undefined, 'A missing file reads as undefined.');
    check(await sandbox.listFiles(`${directory}/none`) === undefined, 'A missing directory lists as undefined.');
  }],
  ['creates directories when writing, and lists entries with their types and sizes', async (sandbox, directory) => {
    await sandbox.writeFile(`${directory}/sub/deeper/a.txt`, 'xyz');
    await sandbox.writeFile(`${directory}/.hidden`, 'h');
    await sandbox.writeFile(`${directory}/with space.txt`, '12345');
    const entries = await sandbox.listFiles(directory);
    check(entries !== undefined, 'The directory must be listed.');
    const byName = Object.fromEntries(entries.map(entry => [entry.name, entry]));
    check(entries.length === 3 && byName['sub']?.type === 'directory' && byName['.hidden']?.size === 1 && byName['with space.txt']?.size === 5, 'Entries must have their names, types and sizes, hidden ones included.');
    check((await sandbox.listFiles(`${directory}/sub/deeper`))?.[0]?.name === 'a.txt', 'Nested directories must be created.');
    const error = await failure(() => sandbox.listFiles(`${directory}/.hidden`));
    check(error instanceof MayuraError, 'Listing a file must fail.');
  }],
  ['removes files, and directories with what is in them only when recursive', async (sandbox, directory) => {
    await sandbox.writeFile(`${directory}/dir/file.txt`, 'x');
    const refused = await failure(() => sandbox.removeFile(`${directory}/dir`));
    check(refused instanceof MayuraError && refused.code === 'INVALID_INPUT', 'Removing a directory that is not empty must need recursive.');
    await sandbox.removeFile(`${directory}/dir/file.txt`);
    check(await sandbox.readFile(`${directory}/dir/file.txt`) === undefined, 'The file must be gone.');
    await sandbox.writeFile(`${directory}/dir/again.txt`, 'x');
    await sandbox.removeFile(`${directory}/dir`, { recursive: true });
    check(await sandbox.listFiles(`${directory}/dir`) === undefined, 'The directory must be gone.');
    await sandbox.removeFile(`${directory}/never-there`);
  }],
  ['refuses to read a file larger than asked', async (sandbox, directory) => {
    await sandbox.writeFile(`${directory}/hundred.txt`, 'x'.repeat(100));
    const error = await failure(() => sandbox.readFile(`${directory}/hundred.txt`, { maxBytes: 10 }));
    check(error instanceof MayuraError && error.code === 'LIMIT_EXCEEDED', 'A file over maxBytes must fail with LIMIT_EXCEEDED.');
  }],
];

/**
 * The sandbox contract as test cases: exit codes and output, exact arguments, cwd and environment, standard input,
 * timeouts and cancellation that stop every process, byte-exact files, listing and removal. A provider package runs
 * them against a real sandbox: `for (const test of sandboxConformance) it(test.name, async () => expect(await
 * test.run({ sandbox })).toBe('passed'))`. Cases the sandbox's features rule out report `skipped`.
 */
export const sandboxConformance: readonly SandboxConformanceCase[] = cases.map(([name, body, needs]) => Object.freeze({
  name,
  run: async (harness: SandboxHarness): Promise<'passed' | 'skipped'> => {
    if (harness.skip?.[name] !== undefined) return 'skipped';
    if (needs === 'stdin' && !harness.sandbox.features.stdin) return 'skipped';
    const directory = `${harness.sandbox.workdir === '/' ? '' : harness.sandbox.workdir}/conformance-${Date.now().toString(36)}-${(++sequence).toString(36)}`;
    const made = await harness.sandbox.exec(['mkdir', '-p', directory]);
    check(made.exitCode === 0, 'The case directory must be created.');
    await body(harness.sandbox, directory);
    return 'passed';
  },
}));
