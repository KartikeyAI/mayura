import { execFile } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';

const exec = promisify(execFile);
const script = fileURLToPath(new URL('../../../scripts/consumer-check.mjs', import.meta.url));

describe('packed developer installation', () => {
  it('installs offline archives, checks strict consumer types, and executes a public-API agent', async () => {
    // A caller's unrelated working directory must not change package or artifact resolution.
    const { stdout } = await exec(process.execPath, [script], { cwd: tmpdir(), timeout: 55_000, windowsHide: true, maxBuffer: 8 * 1024 * 1024 });
    const report: unknown = JSON.parse(stdout);
    expect(report).toMatchObject({ status: 'passed', installedPackageCount: 6 });
    expect(report).toHaveProperty('checks', expect.arrayContaining(['strict-public-types', 'esm-agent-execution', 'no-native-or-provider-dependencies', 'declaration-map-targets', 'debugger-map-source-integrity', 'node-source-mapped-stack']));
  }, 60_000);

  it('rejects an invalid explicit package-manager path instead of silently using another installation', async () => {
    await expect(exec(process.execPath, [script], {
      env: { ...process.env, MAYURA_NPM_CLI: join(tmpdir(), 'mayura-deliberately-missing-npm-cli.js') },
      timeout: 5_000,
      windowsHide: true,
    })).rejects.toMatchObject({ stderr: expect.stringContaining('MAYURA_NPM_CLI must identify') });
  });
});
