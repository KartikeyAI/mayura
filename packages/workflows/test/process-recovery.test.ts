import { fork, type ChildProcess } from 'node:child_process';
import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { WorkflowSnapshot } from '@mayura/workflows';

type Scenario = 'approval' | 'dispatch' | 'receipt';
interface Marker {
  readonly kind: 'waiting' | 'dispatched' | 'receipt_pending' | 'completed' | 'fixture_error';
  readonly runId?: string;
  readonly digest?: string;
  readonly code?: string;
  readonly before?: WorkflowSnapshot;
  readonly snapshot?: WorkflowSnapshot;
  readonly repeated?: WorkflowSnapshot;
  readonly events?: readonly { readonly sequence: number; readonly type: string; readonly data: Readonly<Record<string, unknown>> }[];
}

const fixturePath = fileURLToPath(new URL('./fixtures/process-recovery.mjs', import.meta.url));
const tempPrefix = 'mayura-process-recovery-';

/** Timer-bounded synchronization prevents a failed crash fixture from hanging the suite. */
async function within<T>(promise: Promise<T>, label: string, timeoutMs = 8_000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([promise, new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error(`Timed out waiting for ${label}.`)), timeoutMs);
    })]);
  } finally { if (timer !== undefined) clearTimeout(timer); }
}

/** Owns one child PID and its IPC history; never signals a discovered or unrelated process. */
class FixtureProcess {
  private readonly child: ChildProcess;
  private readonly messages: Marker[] = [];
  private readonly listeners = new Set<() => void>();
  private readonly exited: Promise<{ readonly code: number | null; readonly signal: NodeJS.Signals | null }>;
  private exitObserved = false;
  private failure: Error | undefined;
  private stderr = '';

  constructor(args: readonly string[]) {
    this.child = fork(fixturePath, [...args], { execArgv: [], stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
    this.child.stderr?.on('data', (chunk: Buffer) => { this.stderr = `${this.stderr}${chunk.toString()}`.slice(-4_096); });
    this.child.on('message', (message: Marker) => {
      this.messages.push(message);
      if (message.kind === 'fixture_error') this.failure = new Error(`Child fixture failed (${message.code ?? 'unknown'}). ${this.stderr}`);
      for (const listener of this.listeners) listener();
    });
    this.exited = new Promise((resolveExit, rejectExit) => {
      this.child.once('error', (error) => { this.failure = error; this.exitObserved = true; rejectExit(error); for (const listener of this.listeners) listener(); });
      this.child.once('exit', (code, signal) => {
        this.exitObserved = true;
        resolveExit({ code, signal });
        for (const listener of this.listeners) listener();
      });
    });
    // A spawn failure may occur before a test begins awaiting a marker; retain it without an unhandled rejection.
    void this.exited.catch(() => {});
  }

  async marker(kind: Marker['kind']): Promise<Marker> {
    let listener: (() => void) | undefined;
    try {
      return await within(new Promise<Marker>((resolveMarker, reject) => {
        listener = (): void => {
          const found = this.messages.find((message) => message.kind === kind);
          if (found) resolveMarker(found);
          else if (this.failure) reject(this.failure);
          else if (this.exitObserved) reject(new Error(`Child exited before ${kind}. ${this.stderr}`));
        };
        this.listeners.add(listener);
        listener();
      }), `child marker ${kind}`);
    } finally { if (listener) this.listeners.delete(listener); }
  }

  async successfulExit(): Promise<void> {
    const exit = await within(this.exited, 'successful child exit');
    expect(exit).toEqual({ code: 0, signal: null });
  }

  async kill(): Promise<void> {
    // The PID originates only from this object's fork, and paused fixtures cannot naturally finish.
    const pid = this.child.pid;
    if (!this.exitObserved && pid !== undefined) process.kill(pid, 'SIGKILL');
    await within(this.exited, 'owned child termination').catch((error: unknown) => {
      if (!this.failure) throw error;
    });
  }
}

describe('real process termination and SQLite workflow recovery', () => {
  let directory: string;
  let children: FixtureProcess[];
  beforeEach(async () => { directory = await mkdtemp(join(tmpdir(), tempPrefix)); children = []; });
  afterEach(async () => {
    await Promise.all(children.map((child) => child.kill()));
    // Resolve before recursive cleanup; never delete an environment variable or an unverified computed target.
    const actual = await realpath(directory);
    const temporaryRoot = await realpath(tmpdir());
    if (dirname(actual) !== temporaryRoot || !basename(actual).startsWith(tempPrefix) || resolve(directory) !== resolve(actual)) {
      throw new Error('Refusing cleanup outside the verified test-owned temporary directory.');
    }
    await rm(actual, { recursive: true, force: true });
  });

  function spawn(scenario: Scenario, action: 'start' | 'recover', runId?: string, digest?: string): FixtureProcess {
    const child = new FixtureProcess([scenario, action, directory, ...(runId ? [runId] : []), ...(digest ? [digest] : [])]);
    children.push(child); return child;
  }

  async function effects(): Promise<readonly { readonly runId: string; readonly callId: string }[]> {
    try {
      const contents = await readFile(join(directory, 'effects.ndjson'), 'utf8');
      return contents.trim().split('\n').filter(Boolean).map((line) => JSON.parse(line) as { runId: string; callId: string });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
  }

  it('survives termination while awaiting exact human approval, then executes once after restart', async () => {
    const first = spawn('approval', 'start'); const waiting = await first.marker('waiting');
    expect(waiting.snapshot?.status).toBe('waiting');
    expect(waiting.digest).toBeTypeOf('string'); expect(waiting.runId).toBeTypeOf('string');
    expect(await effects()).toEqual([]);
    await first.kill();

    const second = spawn('approval', 'recover', waiting.runId!, waiting.digest!);
    const completed = await second.marker('completed'); await second.successfulExit();
    expect(completed.before?.steps['write']?.approval?.digest).toBe(waiting.digest);
    expect(completed.snapshot?.status).toBe('succeeded');
    expect(completed.snapshot?.output).toEqual({ value: 7 });
    expect(completed.snapshot?.steps['write']?.approval?.humanId).toBe('verified-reviewer');
    expect(completed.snapshot?.steps['write']?.receipt).toMatchObject({ execution: 'succeeded', disclosure: 'released' });
    expect(completed.repeated).toEqual(completed.snapshot);
    expect(await effects()).toEqual([{ runId: waiting.runId, callId: `${waiting.runId}/step:write` }]);
    expect(completed.events?.filter((event) => event.type === 'step.dispatching')).toHaveLength(1);
    expect(completed.events?.map((event) => event.sequence)).toEqual(completed.events?.map((_event, index) => index + 1));
  }, 25_000);

  it('marks a killed in-flight external effect unknown and never redispatches it', async () => {
    const first = spawn('dispatch', 'start'); const dispatched = await first.marker('dispatched');
    expect(await effects()).toHaveLength(1); await first.kill();

    const second = spawn('dispatch', 'recover', dispatched.runId!);
    const recovered = await second.marker('completed'); await second.successfulExit();
    expect(recovered.before?.steps['write']?.status).toBe('dispatching');
    expect(recovered.before?.steps['write']?.receipt).toBeNull();
    expect(recovered.snapshot?.status).toBe('outcome_unknown');
    expect(recovered.snapshot?.steps['write']?.status).toBe('unknown');
    expect(recovered.snapshot?.budget).toEqual({ spentMicros: 0, reservedMicros: 1, maxCostMicros: 10 });
    expect(recovered.repeated).toEqual(recovered.snapshot);
    expect(await effects()).toHaveLength(1);
    expect(recovered.events?.filter((event) => event.type === 'step.dispatching')).toHaveLength(1);
  }, 25_000);

  it('preserves a persisted success receipt after a guard-stage crash without reconstructing output by reexecution', async () => {
    const first = spawn('receipt', 'start'); const receipt = await first.marker('receipt_pending');
    expect(await effects()).toHaveLength(1); await first.kill();

    const second = spawn('receipt', 'recover', receipt.runId!);
    const recovered = await second.marker('completed'); await second.successfulExit();
    expect(recovered.before?.steps['write']?.status).toBe('dispatching');
    expect(recovered.before?.steps['write']?.receipt).toMatchObject({ execution: 'succeeded', disclosure: 'withheld' });
    expect(recovered.snapshot?.status).toBe('blocked');
    expect(recovered.snapshot?.steps['write']?.status).toBe('blocked');
    expect(recovered.snapshot?.steps['write']?.receipt).toMatchObject({ execution: 'succeeded', disclosure: 'withheld' });
    expect(recovered.snapshot?.steps['write']?.output).toBeNull();
    expect(recovered.snapshot?.output).toBeNull();
    expect(recovered.snapshot?.budget).toEqual({ spentMicros: 1, reservedMicros: 0, maxCostMicros: 10 });
    expect(recovered.repeated).toEqual(recovered.snapshot);
    expect(await effects()).toHaveLength(1);
    expect(recovered.events?.filter((event) => event.type === 'effect.receipt' && event.data['execution'] === 'succeeded')).toHaveLength(1);
    expect(recovered.events?.filter((event) => event.type === 'step.dispatching')).toHaveLength(1);
  }, 25_000);
});
