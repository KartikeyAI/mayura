import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const compilerRoot = dirname(require.resolve('typescript/package.json'));
const compilerPath = join(compilerRoot, 'bin', 'tsc');
const compilerRequire = createRequire(join(compilerRoot, 'package.json'));
const platformRoot = dirname(compilerRequire.resolve(`@typescript/typescript-${process.platform}-${process.arch}/package.json`));
const library = join(platformRoot, 'lib', 'lib.es5.d.ts');
const helper = new URL('../../../scripts/consumer-type-isolation.mjs', import.meta.url).href;

describe('packed consumer declaration isolation', () => {
  let directory: string; let application: string; let entry: string; let outsider: string;
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'mayura-type-isolation-'));
    application = join(directory, 'consumer'); await mkdir(application);
    entry = join(application, 'consumer.ts'); await writeFile(entry, 'export {};');
    outsider = join(directory, 'workspace-types.d.ts'); await writeFile(outsider, 'export type Leaked = string;');
  });
  afterEach(async () => {
    const target = resolve(directory);
    if (!target.startsWith(`${resolve(tmpdir())}${sep}mayura-type-isolation-`)) throw new Error('Unexpected test fixture directory.');
    await rm(target, { recursive: true, force: true });
  });
  const check = (files: string[]): boolean => {
    try {
      execFileSync(process.execPath, ['--input-type=module', '-e',
        'const { assertConsumerTypeFiles } = await import(process.argv[1]); assertConsumerTypeFiles(JSON.parse(process.argv[2]));',
        helper,
        JSON.stringify({ output: files.join('\n'), application, compilerPath })], { stdio: 'pipe', windowsHide: true });
      return true;
    } catch { return false; }
  };
  it('accepts only the consumer and the compiler standard library', () => { expect(check([library, entry])).toBe(true); });
  it('rejects parent workspace declarations even when the compiler resolved them successfully', () => { expect(check([library, outsider, entry])).toBe(false); });
  it('rejects a consumer-looking junction to outside declaration files', async () => {
    const outside = join(directory, 'outside'); await mkdir(outside); await writeFile(join(outside, 'leaked.d.ts'), 'export {};');
    const linked = join(application, 'linked'); await symlink(outside, linked, process.platform === 'win32' ? 'junction' : 'dir');
    expect(check([library, join(linked, 'leaked.d.ts'), entry])).toBe(false);
  });
  it('does not count an arbitrary compiler implementation file as a standard library', () => { expect(check([library, compilerPath, entry])).toBe(false); });
  it('rejects a list missing the consumer source', () => { expect(check([library])).toBe(false); });
  it('rejects a list missing standard-library evidence', () => { expect(check([entry])).toBe(false); });
});
