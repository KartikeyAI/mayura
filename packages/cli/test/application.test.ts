import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { get } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { listenProbe } from '../../server-node/src/index.js';
import { defineMayuraApplication, loadApplication, migrateApplication, runWorkerApplication, serveApplication, type MayuraLifecycleEvent } from '../src/index.js';

const fixture = fileURLToPath(new URL('./fixtures/application.mjs', import.meta.url));
const directories: string[] = [];
afterEach(async () => { delete process.env['MAYURA_FIXTURE_DIRECTORY']; await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
async function directory(): Promise<string> { const value = await mkdtemp(join(tmpdir(), 'mayura-cli-app-')); directories.push(value); return value; }
function probe(port: number, path: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => { get({ hostname: '127.0.0.1', port, path }, response => { let body = '';
    response.setEncoding('utf8').on('data', chunk => { body += chunk; }).on('end', () => resolve({ status: response.statusCode ?? 0, body })); }).on('error', reject); });
}

describe('mayura application lifecycle', () => {
  it('loads only an explicit regular JavaScript module with the application contract', async () => {
    const root = await directory(); await mkdir(join(root, 'folder.mjs'));
    await writeFile(join(root, 'notes.txt'), 'export default {}'); await writeFile(join(root, 'bad.mjs'), 'export default { server: 1 };');
    for (const path of [join(root, 'missing.mjs'), join(root, 'folder.mjs'), join(root, 'notes.txt'), join(root, 'bad.mjs')]) {
      await expect(loadApplication(path)).rejects.toMatchObject({ code: 'INVALID_CONFIG' });
    }
    expect(() => defineMayuraApplication({ extra: async () => {} } as never)).toThrow(expect.objectContaining({ code: 'INVALID_CONFIG' }));
  });

  it('drives a real worker with probes, then drains and shuts down on abort', async () => {
    process.env['MAYURA_FIXTURE_DIRECTORY'] = await directory(); const application = await loadApplication(fixture);
    const events: MayuraLifecycleEvent[] = []; const controller = new AbortController();
    const running = runWorkerApplication({ application, signal: controller.signal, probe: { hostname: '127.0.0.1', port: 0 }, drainTimeoutMs: 5_000, listenProbe,
      log: event => { events.push(event); } });
    await vi.waitFor(() => expect(events[0]).toMatchObject({ event: 'worker-started' }), { timeout: 5_000 });
    const port = (events[0] as { probe: { port: number } }).probe.port;
    expect(await probe(port, '/livez')).toEqual({ status: 200, body: '{"status":"ok"}' });
    await vi.waitFor(async () => expect((await probe(port, '/readyz')).status).toBe(200), { timeout: 5_000 });
    // The leader's host drove the due timer to completion through real storage.
    const fixtureState = globalThis as { mayuraFixtureRuntime?: { inspect(id: string): Promise<{ status: string }> }; mayuraFixtureRunId?: string };
    await vi.waitFor(async () => expect((await fixtureState.mayuraFixtureRuntime!.inspect(fixtureState.mayuraFixtureRunId!)).status).toBe('succeeded'), { timeout: 5_000 });
    expect((await probe(port, '/nothing')).status).toBe(404);
    controller.abort();
    expect(await running).toEqual({ status: 'stopped', drained: true, interrupted: 0 });
    expect(events.map(event => event.event)).toEqual(['worker-started', 'stopping', 'stopped']);
    expect((globalThis as { mayuraFixtureShutdown?: boolean }).mayuraFixtureShutdown).toBe(true);
    await expect(probe(port, '/livez')).rejects.toBeDefined();
  });

  it('migrates through the application contract and shuts down afterwards', async () => {
    process.env['MAYURA_FIXTURE_DIRECTORY'] = await directory(); (globalThis as { mayuraFixtureShutdown?: boolean }).mayuraFixtureShutdown = false;
    expect(await migrateApplication(await loadApplication(fixture))).toEqual({ status: 'migrated', report: { schemaVersion: 1 } });
    expect((globalThis as { mayuraFixtureShutdown?: boolean }).mayuraFixtureShutdown).toBe(true);
    await expect(migrateApplication(defineMayuraApplication({ shutdown: async () => {} }))).rejects.toMatchObject({ code: 'INVALID_CONFIG' });
  });

  it('serves until abort and closes the server before shutdown', async () => {
    const order: string[] = [];
    const application = defineMayuraApplication({ server: async () => ({ isAccepting: () => true, close: async () => { order.push('close'); } }),
      shutdown: async () => { order.push('shutdown'); } });
    const controller = new AbortController(); const events: string[] = [];
    const serving = serveApplication({ application, signal: controller.signal, log: event => { events.push(event.event); } });
    await vi.waitFor(() => expect(events).toEqual(['serving'])); controller.abort();
    expect(await serving).toEqual({ status: 'stopped' }); expect(order).toEqual(['close', 'shutdown']); expect(events).toEqual(['serving', 'stopping', 'stopped']);
    await expect(serveApplication({ application: defineMayuraApplication({ shutdown: async () => {} }), signal: controller.signal }))
      .rejects.toMatchObject({ code: 'INVALID_CONFIG' });
  });

  it('starts the executable worker with a live readiness probe', async () => {
    const root = await directory();
    const child = spawn(process.execPath, [fileURLToPath(new URL('../dist/bin.js', import.meta.url)), 'worker', '--app', fixture, '--probe-port', '0'],
      { env: { ...process.env, MAYURA_FIXTURE_DIRECTORY: root }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    try {
      let stdout = ''; child.stdout.setEncoding('utf8').on('data', chunk => { stdout += chunk; });
      await vi.waitFor(() => expect(stdout).toContain('worker-started'), { timeout: 10_000 });
      const started = JSON.parse(stdout.split('\n').find(line => line.includes('worker-started'))!) as { probe: { port: number } };
      await vi.waitFor(async () => expect((await probe(started.probe.port, '/readyz')).status).toBe(200), { timeout: 10_000 });
    } finally { child.kill(); await new Promise(resolve => child.once('exit', resolve)); }
  });
});
