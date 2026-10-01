import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createSandboxes, type Sandbox, type Sandboxes } from 'mayura/sandbox';
import { sandboxConformance } from 'mayura/sandbox/testing';
import { flySandboxes } from '../src/index.js';

// The provider's shell scripts, run for real: a stand-in for the Machines API whose Machines are local Docker
// containers and whose exec is `docker exec`, answering as Fly does. Needs an image already on the machine, such as
// alpine:3.22; never pulls one.
const image = process.env['MAYURA_TEST_DOCKER_SANDBOX_IMAGE'];
const run = promisify(execFile);

/** `docker exec` as Fly's exec answers it: JSON with the exit code and the output as text. */
function dockerExec(container: string, command: readonly string[], stdin?: string): Promise<{ exit_code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn('docker', ['exec', ...(stdin === undefined ? [] : ['-i']), container, ...command], { windowsHide: true });
    const out: Buffer[] = []; const err: Buffer[] = [];
    child.stdout.on('data', chunk => out.push(chunk)); child.stderr.on('data', chunk => err.push(chunk));
    child.on('error', reject);
    child.on('close', code => resolve({ exit_code: code ?? -1, stdout: Buffer.concat(out).toString('utf8'), stderr: Buffer.concat(err).toString('utf8') }));
    if (stdin !== undefined) child.stdin.end(stdin);
  });
}
function localFly() {
  const containers = new Map<string, string>();
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init); const url = new URL(request.url);
    const json = request.headers.get('content-type') === 'application/json' ? await request.json() as Record<string, unknown> : undefined;
    if (url.pathname === '/v1/apps/local/machines' && request.method === 'POST') {
      const config = json!['config'] as { image: string; env: Record<string, string>; init: { exec: string[] } };
      const id = `m${Math.random().toString(16).slice(2, 12)}`;
      const name = `mayura-fly-test-${id}`;
      await run('docker', ['run', '-d', '--rm', '--pull', 'never', '--network', 'none', '--name', name, '--label', 'mayura.sandbox=fly-test',
        ...Object.entries(config.env).flatMap(([key, value]) => ['-e', `${key}=${value}`]), config.image, ...config.init.exec], { windowsHide: true });
      containers.set(id, name);
      return Response.json({ id, state: 'created' });
    }
    const id = url.pathname.split('/')[5]!; const container = containers.get(id);
    if (!container) return Response.json({ error: 'not found' }, { status: 404 });
    if (url.pathname.endsWith('/wait')) return new Response(null, { status: 200 });
    if (url.pathname.endsWith('/exec')) {
      const body = json as { command: string[]; stdin?: string; timeout: number };
      expect(body.timeout).toBeLessThanOrEqual(60);
      return Response.json(await dockerExec(container, body.command, body.stdin));
    }
    if (request.method === 'DELETE') { await run('docker', ['rm', '-f', container], { windowsHide: true }).catch(() => undefined); containers.delete(id); return Response.json({ ok: true }); }
    return Response.json({});
  }) as typeof globalThis.fetch;
}

describe.skipIf(image === undefined)('Fly Machines sandboxes, their scripts run in a local container', { timeout: 120_000 }, () => {
  let sandboxes: Sandboxes; let sandbox: Sandbox;
  beforeAll(async () => {
    sandboxes = createSandboxes(flySandboxes({ token: 'fly_test_token_value', app: 'local', image: image!, fetch: localFly() }),
      { maxSandboxes: 2, maxLifetimeMs: 600_000, network: ['all'] });
    sandbox = await sandboxes.create({ lifetimeMs: 300_000, network: 'all', env: { SANDBOX_VALUE: 'from-the-sandbox' } });
  }, 120_000);
  afterAll(async () => { await sandboxes?.close(); });

  for (const test of sandboxConformance) it(test.name, async () => { expect(await test.run({ sandbox })).toBe('passed'); });

  it('runs commands longer than one exec allows, in the background', async () => {
    const result = await sandbox.exec(['sh', '-c', 'sleep 3; echo done; echo "$SANDBOX_VALUE"'], { timeoutMs: 30_000 });
    expect(result).toMatchObject({ exitCode: 0, stdout: 'done\nfrom-the-sandbox\n' });
  });

  it('runs each command in a session of its own, so it outlives the exec that started it', async () => {
    // The session leader of the command's processes is the background shell setsid started.
    const result = await sandbox.exec(['sh', '-c', 'set -- $(cat /proc/self/stat); tr "\\000" " " < "/proc/$6/cmdline"']);
    expect(result.stdout).toContain('_mayura_in=$2');
  });

  it('reads back only as much output as is kept, whatever the command wrote', async () => {
    const provider = flySandboxes({ token: 'fly_test_token_value', app: 'local', image: image!, fetch: localFly() });
    const backend = await provider.create({ lifetimeMs: 120_000, network: 'all', env: {}, ports: [], labels: {} }, { signal: AbortSignal.timeout(60_000) });
    try {
      const result = await backend.exec(['head', '-c', '200000', '/dev/zero'], { cwd: '/', env: {}, maxOutputBytes: 64, signal: AbortSignal.timeout(60_000) });
      expect(result.stdout.byteLength).toBe(64); expect(result.truncated).toBe(true);
    } finally { await backend.release({ signal: AbortSignal.timeout(30_000) }); }
  });

  it('cleans up the files a command used', async () => {
    await sandbox.exec(['cat'], { stdin: 'input', env: { CALL: 'x' } });
    await new Promise(resolve => setTimeout(resolve, 1_000));
    // Listed without running a command, which would have files of its own.
    expect((await sandbox.listFiles('/tmp'))!.filter(entry => entry.name.startsWith('mayura-'))).toEqual([]);
  });
});
