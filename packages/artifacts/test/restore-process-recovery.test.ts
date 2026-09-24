import { fork, type ChildProcess } from 'node:child_process';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { createLocalArtifactStore, type ArtifactReference } from '../src/index.js';

const prefix = 'mayura-artifact-crash-'; const roots: string[] = [];
const scope = Object.freeze({ tenantId: 'crash', projectId: 'restore' });
async function root(): Promise<string> { const value = await mkdtemp(join(tmpdir(), prefix)); roots.push(value); return value; }
async function bounded<T>(promise: Promise<T>, label: string, milliseconds = 10_000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([promise, new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error(`${label} timed out.`)), milliseconds); })]); }
  finally { if (timer) clearTimeout(timer); }
}
async function objectCount(directory: string): Promise<number> {
  try { return (await readdir(join(directory, 'objects'), { recursive: true, withFileTypes: true })).filter((entry) => entry.isFile()).length; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 0; throw error; }
}
function waitForMessage(child: ChildProcess, kind: string): Promise<unknown> {
  return bounded(new Promise((done, reject) => {
    const message = (value: unknown): void => { if ((value as { kind?: unknown })?.kind === kind) { cleanup(); done(value); } };
    const exit = (): void => { cleanup(); reject(new Error(`Restore child exited before ${kind}.`)); };
    const error = (cause: Error): void => { cleanup(); reject(cause); };
    const cleanup = (): void => { child.off('message', message); child.off('exit', exit); child.off('error', error); };
    child.on('message', message); child.once('exit', exit); child.once('error', error);
  }), `restore child ${kind}`);
}

afterEach(async () => {
  for (const directory of roots.splice(0)) {
    const actual = resolve(directory); const parent = resolve(tmpdir());
    if (dirname(actual) !== parent || !basename(actual).startsWith(prefix)) throw new Error('Refusing cleanup outside the artifact crash fixture.');
    await rm(actual, { recursive: true, force: true });
  }
});

describe('artifact restore process recovery', () => {
  it('resumes an exact partial restore after the restoring process is killed', async () => {
    const workspace = await root(); const sourceDirectory = await root(); const destinationDirectory = await root();
    const source = createLocalArtifactStore({ rootDirectory: sourceDirectory, maxArtifactBytes: 1_048_576 });
    const references: ArtifactReference[] = [];
    for (let index = 0; index < 32; index++) {
      const content = new Uint8Array(1_048_576); content.fill(index);
      references.push(await source.commit(await source.stage({ scope, content, mediaType: 'application/octet-stream',
        classification: 'internal', filename: `${index}.bin` })));
    }
    const archive = await source.backup({ scope, references, authoritativeSetComplete: true, maxTotalBytes: 32 * 1_024 * 1_024 });
    const archivePath = join(workspace, 'restore.backup'); await writeFile(archivePath, archive);
    const destination = createLocalArtifactStore({ rootDirectory: destinationDirectory, maxArtifactBytes: 1_048_576 });
    await destination.planReconciliation({ scope, retainedReferences: [], authoritativeSetComplete: true,
      olderThan: Date.now(), maxExamined: 1, maxDeletes: 1 });
    const fixture = fileURLToPath(new URL('./fixtures/restore-child.mjs', import.meta.url));
    const child = fork(fixture, [destinationDirectory, archivePath], { execArgv: [], stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
    const exited = new Promise<void>((done, reject) => { child.once('error', reject); child.once('exit', () => done()); });
    try {
      await waitForMessage(child, 'started');
      const published = await bounded((async () => {
        while (child.exitCode === null) {
          const count = await objectCount(destinationDirectory); if (count > 0) return count;
          await new Promise((resolveDelay) => setTimeout(resolveDelay, 1));
        }
        throw new Error('Restore completed before a kill boundary was observed.');
      })(), 'first restored object');
      expect(published).toBeLessThan(references.length);
      if (child.pid !== undefined) process.kill(child.pid, 'SIGKILL'); await bounded(exited, 'restore child exit');
      const retained = await objectCount(destinationDirectory);
      expect(retained).toBeGreaterThan(0); expect(retained).toBeLessThan(references.length);
      await expect(destination.restore(archive, scope, {
        maxArchiveBytes: 48 * 1_024 * 1_024, maxTotalBytes: 32 * 1_024 * 1_024, maxArtifacts: 32,
      })).resolves.toEqual({ artifacts: 32, restored: 32 - retained, existing: retained, contentBytes: 32 * 1_024 * 1_024 });
      const audit = await destination.audit(references, scope, { maxTotalBytes: 32 * 1_024 * 1_024 });
      expect(audit.observations.every((entry) => entry.status === 'ok')).toBe(true);
      await destination.reconcileStaging({ olderThan: Date.now(), maxDeletes: 32 });
      expect(await readdir(join(destinationDirectory, 'staging'))).toEqual([]);
    } finally {
      if (child.exitCode === null && child.pid !== undefined) process.kill(child.pid, 'SIGKILL'); await bounded(exited, 'restore child cleanup').catch(() => undefined);
    }
  }, 30_000);
});
