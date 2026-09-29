// Qualifies Mayura the way a serverless platform runs it: every invocation is a fresh process that handles one call,
// answers, and is stopped at once, so nothing it started may continue afterwards. State is shared only through
// storage (SQLite here, standing in for the database every function instance connects to).
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';

const fixture = fileURLToPath(new URL('./fixtures/function.mjs', import.meta.url));
const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
async function directory(): Promise<string> { const path = await mkdtemp(join(tmpdir(), 'mayura-serverless-')); directories.push(path); return path; }

interface Invocation<T> { readonly result: Promise<T>; kill(): void }
/** Start one invocation: a fresh process for one call. */
function start<T = Record<string, unknown>>(root: string, args: readonly string[], clockOffsetMs = 0): Invocation<T> {
  const child = spawn(process.execPath, [fixture, root, ...args], { env: { ...process.env, CLOCK_OFFSET_MS: String(clockOffsetMs) },
    stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  let stdout = ''; let stderr = '';
  child.stdout.setEncoding('utf8').on('data', chunk => { stdout += chunk; }); child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk; });
  const result = new Promise<T>((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', code => {
      const line = stdout.trim().split('\n').at(-1);
      if (code === 0 && line) resolve(JSON.parse(line) as T); else reject(new Error(`Invocation exited with ${code}: ${stderr.slice(-2_000)}`));
    });
  });
  return { result, kill: () => child.kill('SIGKILL') };
}
const invoke = <T = Record<string, unknown>>(root: string, args: readonly string[], clockOffsetMs = 0): Promise<T> => start<T>(root, args, clockOffsetMs).result;
const ledger = (root: string): unknown[] => existsSync(join(root, 'effects.ndjson'))
  ? readFileSync(join(root, 'effects.ndjson'), 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line) as unknown) : [];

interface HttpResult { readonly http: number; readonly body: { readonly id?: string; readonly status?: string; readonly outcome?: Record<string, unknown> } }
interface WorkerResult { readonly report: { readonly leader: boolean; readonly completedSweep: boolean; readonly failures: readonly string[] } }
interface RunsResult { readonly runs: readonly { readonly id: string; readonly status: string; readonly step: string }[] }

describe('serverless functions: every invocation stops as soon as it answers', () => {
  it('finishes a request-bound run before answering, so the next invocation reads its result', async () => {
    const root = await directory();
    const submitted = await invoke<HttpResult>(root, ['submit', 'request']);
    expect(submitted.http).toBe(202);
    const read = await invoke<HttpResult>(root, ['read', submitted.body.id!]);
    expect(read).toMatchObject({ http: 200, body: { status: 'succeeded', outcome: { status: 'succeeded', output: { answer: 42 } } } });
  }, 60_000);

  it('shows why: in background mode the stopped invocation cuts its run off, which ends as outcome_unknown, never lost', async () => {
    const root = await directory();
    const submitted = await invoke<HttpResult>(root, ['submit', 'background']);
    expect(submitted.http).toBe(202);
    await vi.waitFor(async () => {
      expect(await invoke<HttpResult>(root, ['read', submitted.body.id!])).toMatchObject({ http: 200, body: { status: 'outcome_unknown' } });
    }, { timeout: 30_000, interval: 500 });
  }, 60_000);

  it('advances workflows only through scheduled one-shot invocations, running each effect once', async () => {
    const root = await directory();
    const { ids } = await invoke<{ ids: string[] }>(root, ['workflow-submit', '6']);
    for (let invocation = 0; invocation < 10; invocation++) {
      const { report } = await invoke<WorkerResult>(root, ['worker-once', '1000']);
      expect(report.failures).toEqual([]);
      if (report.completedSweep) break;
    }
    const { runs } = await invoke<RunsResult>(root, ['workflow-read', ids.join(',')]);
    expect(runs.map(run => run.status)).toEqual(ids.map(() => 'succeeded'));
    expect(ledger(root)).toHaveLength(6);
  }, 120_000);

  it('recovers a step whose invocation was killed mid-effect, without running the effect again', async () => {
    const root = await directory();
    const { ids } = await invoke<{ ids: string[] }>(root, ['workflow-submit', '1']);
    const killed = start(root, ['worker-once', '10000', 'hang']);
    await vi.waitFor(() => expect(existsSync(join(root, 'hanging'))).toBe(true), { timeout: 20_000, interval: 50 });
    killed.kill(); await killed.result.catch(() => {});
    // Right away, the step may still be running somewhere: it is left alone (and the killed invocation's lease still holds).
    await invoke<WorkerResult>(root, ['worker-once', '1000']);
    expect((await invoke<RunsResult>(root, ['workflow-read', ids[0]!])).runs[0]).toMatchObject({ status: 'running', step: 'dispatching' });
    // Once the tool's timeout, the margin and the lease have passed, the next invocation settles it as unknown.
    const later = 5_000 + 60_000 + 16_000;
    expect((await invoke<WorkerResult>(root, ['worker-once', '1000'], later)).report).toMatchObject({ leader: true, failures: [] });
    expect((await invoke<RunsResult>(root, ['workflow-read', ids[0]!], later)).runs[0]).toMatchObject({ status: 'outcome_unknown', step: 'unknown' });
    expect(ledger(root)).toHaveLength(1);
  }, 120_000);
});
