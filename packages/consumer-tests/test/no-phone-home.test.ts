import { execFile } from 'node:child_process';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';

const exec = promisify(execFile);
const workspace = fileURLToPath(new URL('../../..', import.meta.url));
const fixture = fileURLToPath(new URL('./fixtures/no-phone-home.mjs', import.meta.url));
const packages = ['core', 'helpers', 'tools', 'runtime', 'sdk', 'testing', 'workflows', 'workstream', 'storage-contracts', 'context', 'memory',
  'guardrails', 'observability', 'code-mode', 'code-mode-workflows', 'adapter-code-quickjs', 'adapter-code-docker', 'artifacts'];
const forbiddenModule = /(?:from\s*|import\s*\()\s*['"](?:node:)?(?:http|https|net|tls|dgram|dns)['"]|(?:from\s*|import\s*\()\s*['"](?:undici|ws)['"]/u;
const globalTransport = /(^|[^A-Za-z0-9_$.])(?:fetch|WebSocket|EventSource)\s*\(/mu;
const ambientCredential = /\bprocess\s*\.\s*env\s*(?:\.\s*[A-Za-z0-9_]*(?:TOKEN|KEY|SECRET|PASSWORD|CREDENTIAL)[A-Za-z0-9_]*|\[\s*['"][^'"]*(?:TOKEN|KEY|SECRET|PASSWORD|CREDENTIAL)[^'"]*['"]\s*\])/iu;

async function sources(directory: string): Promise<string[]> {
  const result: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) result.push(...await sources(path));
    else if (entry.isFile() && entry.name.endsWith('.ts')) result.push(path);
  }
  return result;
}

describe('no-default-phone-home boundary', () => {
  it('imports default and local-only packages with common network entry points denied', async () => {
    const { stdout } = await exec(process.execPath, [fixture], { cwd: workspace, windowsHide: true, timeout: 10_000, maxBuffer: 64 * 1_024,
      env: Object.freeze({ NODE_NO_WARNINGS: '1' }) });
    expect(JSON.parse(stdout)).toEqual({ status: 'passed', packages: 18, networkAttempts: 0 });
  });

  it('contains no network-module import, global transport call or ambient credential lookup in local-only runtime sources', async () => {
    const violations: string[] = [];
    for (const name of packages) for (const path of await sources(join(workspace, 'packages', name, 'src'))) {
      const source = await readFile(path, 'utf8');
      if (forbiddenModule.test(source)) violations.push(`${name}:network-module`);
      if (globalTransport.test(source)) violations.push(`${name}:global-transport`);
      if (ambientCredential.test(source)) violations.push(`${name}:ambient-credential`);
    }
    expect(violations).toEqual([]);
  });
});
