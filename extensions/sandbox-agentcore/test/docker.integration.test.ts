import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createSandboxes, type Sandbox, type Sandboxes } from 'mayura/sandbox';
import { agentCoreSandboxes } from '../src/index.js';
import { fakeAgentCore } from './fake.js';

// The provider through the AWS SDK and AgentCore's event stream, with each executeCommand line run for real by sh in
// a local container. Needs an image already on the machine, such as alpine:3.22; never pulls one.
const image = process.env['MAYURA_TEST_DOCKER_SANDBOX_IMAGE'];
const docker = promisify(execFile);
const credentials = { accessKeyId: 'AKIDTESTEXAMPLE', secretAccessKey: 'test-secret-not-real' };

describe.skipIf(image === undefined)('AgentCore sandboxes, their commands run in a local container', { timeout: 120_000 }, () => {
  let sandboxes: Sandboxes; let sandbox: Sandbox; let container = '';
  beforeAll(async () => {
    container = `mayura-agentcore-test-${Math.random().toString(16).slice(2, 10)}`;
    await docker('docker', ['run', '-d', '--rm', '--pull', 'never', '--network', 'none', '--name', container, '--label', 'mayura.sandbox=agentcore-test', image!, 'sleep', '600'], { windowsHide: true });
    // executeCommand takes a shell command line: run it with sh, as AgentCore does.
    const fake = fakeAgentCore(command => new Promise(resolve => {
      const child = spawn('docker', ['exec', container, 'sh', '-c', command], { windowsHide: true });
      const out: Buffer[] = []; child.stdout.on('data', chunk => out.push(chunk)); child.stderr.resume();
      child.on('close', code => resolve({ exitCode: code ?? -1, stdout: Buffer.concat(out).toString('utf8') }));
    }));
    sandboxes = createSandboxes(agentCoreSandboxes({ region: 'us-east-1', credentials, fetch: fake.fetch, maxCommandBytes: 16_384 }), { maxSandboxes: 1, maxLifetimeMs: 600_000 });
    sandbox = await sandboxes.create({ lifetimeMs: 300_000, env: { SANDBOX_VALUE: "it's the sandbox's" } });
  }, 120_000);
  afterAll(async () => { await sandboxes?.close(); await docker('docker', ['rm', '-f', container], { windowsHide: true }).catch(() => undefined); });

  it('runs commands with arguments exactly, in their directory, with the sandbox\'s and their own environment', async () => {
    const args = ["it's", '$HOME', '"q"', 'a b', ';rm -rf /', '\\n'];
    expect((await sandbox.exec(['printf', '%s|', ...args])).stdout).toBe(`${args.join('|')}|`);
    const result = await sandbox.exec(['sh', '-c', 'pwd; printf "%s/%s" "$SANDBOX_VALUE" "$CALL"'], { env: { CALL: 'call' } });
    expect(result).toMatchObject({ exitCode: 0, stdout: "/tmp/workspace\nit's the sandbox's/call" });
  });

  it('gives standard input, writes and reads files in pieces, lists and removes', async () => {
    expect((await sandbox.exec(['tr', 'a-z', 'A-Z'], { stdin: 'piped\n' })).stdout).toBe('PIPED\n');
    const data = new Uint8Array(60_000).map((_, index) => (index * 13 + 5) % 256);
    await sandbox.writeFile('dir/data.bin', data);
    const back = await sandbox.readFile('dir/data.bin');
    expect(back!.every((byte, index) => byte === data[index]) && back!.byteLength === data.byteLength).toBe(true);
    expect((await sandbox.listFiles('dir'))!.map(entry => [entry.name, entry.size])).toEqual([['data.bin', 60_000]]);
    expect(await sandbox.removeFile('dir').catch(caught => caught)).toMatchObject({ code: 'INVALID_INPUT' });
    await sandbox.removeFile('dir', { recursive: true });
    expect(await sandbox.listFiles('dir')).toBeUndefined();
  });

  it('stops a command at its timeout, and everything it started', async () => {
    const result = await sandbox.exec(['sh', '-c', 'sleep 61 & sleep 62; wait'], { timeoutMs: 2_000 });
    expect(result.timedOut).toBe(true);
    await new Promise(resolve => setTimeout(resolve, 1_000));
    expect((await sandbox.exec(['sh', '-c', 'for p in /proc/[0-9]*; do tr "\\000" " " < $p/cmdline 2>/dev/null; echo; done'])).stdout).not.toMatch(/sleep 6[12]/u);
  });
});
