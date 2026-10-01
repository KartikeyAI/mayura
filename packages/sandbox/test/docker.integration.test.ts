import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MayuraError } from '@mayura/core';
import { createSandboxes, type Sandbox, type Sandboxes } from '../src/index.js';
import { dockerSandboxes } from '../src/docker/index.js';
import { sandboxConformance } from '../src/testing.js';

// Runs against a real Docker with an image already on the machine, such as alpine:3.22; never pulls one.
const image = process.env['MAYURA_TEST_DOCKER_SANDBOX_IMAGE'];
// For the Engine API: the local socket, when it is not the platform's default (Docker Desktop on Windows:
// npipe:////./pipe/dockerDesktopLinuxEngine).
const host = process.env['MAYURA_TEST_DOCKER_HOST'];
const run = promisify(execFile);
const docker = async (...args: string[]) => (await run('docker', args, { windowsHide: true, timeout: 30_000 })).stdout.trim();

for (const engine of ['cli', 'api'] as const) {
  describe.skipIf(image === undefined)(`Docker sandboxes through the ${engine === 'cli' ? 'docker CLI' : 'Engine API'}`, { timeout: 120_000 }, () => {
    let sandboxes: Sandboxes; let sandbox: Sandbox;
    beforeAll(async () => {
      sandboxes = createSandboxes(dockerSandboxes({ image: image!, engine, ...(engine === 'api' && host ? { host } : {}), memoryMiB: 512, workspaceMiB: 64 }),
        { maxSandboxes: 3, maxLifetimeMs: 600_000, network: ['none', 'all'] });
      sandbox = await sandboxes.create({ lifetimeMs: 300_000, env: { SANDBOX_SECRET: 'sandbox-secret-value' } });
    }, 120_000);
    afterAll(async () => { await sandboxes?.close(); });

    for (const test of sandboxConformance) it(test.name, async () => { expect(await test.run({ sandbox })).toBe('passed'); });

    it('locks the container down: no network, no capabilities, no privilege escalation, a non-root user, a read-only image, bounded resources', async () => {
      const shell = async (script: string) => (await sandbox.exec(['sh', '-c', script])).stdout.trim();
      expect(await shell('id -u; id -g')).toBe('1000\n1000');
      expect(await shell('ls /sys/class/net')).toBe('lo');
      // A non-root user has no effective capabilities anyway; the bounding set is empty only when all were dropped.
      expect(await shell('grep -E "^Cap(Prm|Eff|Bnd):" /proc/self/status')).toMatch(/^CapPrm:\s+0+\nCapEff:\s+0+\nCapBnd:\s+0+$/u);
      expect(await shell('grep ^NoNewPrivs /proc/self/status')).toMatch(/^NoNewPrivs:\s+1$/u);
      const readOnly = await sandbox.exec(['sh', '-c', 'touch /etc/mayura-test']);
      expect(readOnly.exitCode).not.toBe(0); expect(readOnly.stderr).toMatch(/Read-only/iu);
      expect(await shell('cat /sys/fs/cgroup/pids.max')).toBe('256');
      expect(await shell('cat /sys/fs/cgroup/memory.max')).toBe(String(512 * 1_048_576));
      expect(await shell('cat /sys/fs/cgroup/memory.swap.max 2>/dev/null || echo 0')).toBe('0');
      const writable = await shell(`df -k ${sandbox.workdir} | tail -1`);
      expect(writable).toMatch(/^tmpfs\s+65536\s/u);
    });

    it('gives commands the sandbox\'s environment without it reaching the container\'s configuration or the host\'s command lines', async () => {
      expect((await sandbox.exec(['sh', '-c', 'printf %s "$SANDBOX_SECRET"'])).stdout).toBe('sandbox-secret-value');
      const result = await sandbox.exec(['sh', '-c', 'printf %s "$CALL_SECRET"'], { env: { CALL_SECRET: 'call-secret-value' } });
      expect(result.stdout).toBe('call-secret-value');
      const inspected = await docker('inspect', sandbox.id);
      expect(inspected).not.toContain('sandbox-secret-value');
      expect(inspected).toContain('"mayura.sandbox": "true"');
      // The command's environment file is removed before the command starts.
      expect((await sandbox.exec(['sh', '-c', 'ls -a /tmp/.mayura'])).stdout.split('\n').filter(name => name.startsWith('exec-'))).toEqual([]);
    });

    it('serves a port at a URL on this machine only, with the network allowed', async () => {
      const served = await sandboxes.create({ lifetimeMs: 120_000, network: 'all', ports: [8_080] });
      try {
        const body = 'hello from the sandbox';
        await served.writeFile('site/serve.sh', `printf 'HTTP/1.0 200 OK\r\nContent-Length: ${body.length}\r\nConnection: close\r\n\r\n${body}'
`);
        const started = await served.exec(['sh', '-c', `nc -lk -p 8080 -e sh ${served.workdir}/site/serve.sh >/dev/null 2>&1 & echo up`]);
        expect(started.stdout).toBe('up\n');
        const url = await served.url(8_080);
        expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/$/u);
        let received = '';
        for (let attempt = 0; attempt < 40 && received === ''; attempt++) {
          received = await fetch(url).then(response => response.text(), () => '');
          if (received === '') await new Promise(resolve => setTimeout(resolve, 250));
        }
        expect(received).toBe(body);
      } finally { await served.release(); }
    });

    it('refuses an image that is not on this machine instead of pulling it', async () => {
      const error = await sandboxes.create({ lifetimeMs: 60_000, image: 'mayura-test/not-pulled:never' }).catch(caught => caught);
      expect(error).toBeInstanceOf(MayuraError);
      expect(error).toMatchObject({ code: 'INVALID_CONFIG', message: expect.stringContaining('not on this machine') });
      expect(await docker('images', '--quiet', 'mayura-test/not-pulled')).toBe('');
    });

    it('removes the container on release; later calls fail as gone', async () => {
      const short = await sandboxes.create({ lifetimeMs: 60_000 });
      expect(await docker('ps', '--all', '--quiet', '--filter', `name=^${short.id}$`)).not.toBe('');
      await short.release();
      expect(await docker('ps', '--all', '--quiet', '--filter', `name=^${short.id}$`)).toBe('');
      await expect(short.exec(['true'])).rejects.toMatchObject({ reason: 'gone' });
    });

    it('reports a container removed behind its back as gone', async () => {
      const victim = await sandboxes.create({ lifetimeMs: 60_000 });
      await docker('rm', '--force', victim.id);
      await expect(victim.exec(['true'])).rejects.toMatchObject({ reason: 'gone' });
      await victim.release();
    });
  });
}
