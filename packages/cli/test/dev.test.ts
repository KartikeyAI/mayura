import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { dotEnv, runDev } from '../src/dev.js';
import { paint } from '../src/output.js';

// A tiny project: `build` copies src/entry.js to dist/src/dev.js (and fails when the source says so); the entry
// appends one line per start to started.log, including one value from .env, and stays up until it is stopped.
async function project(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'mayura-dev-'));
  await mkdir(join(directory, 'src'));
  await writeFile(join(directory, 'build.js'), `const fs = require('node:fs');
const source = fs.readFileSync('src/entry.js', 'utf8');
if (source.includes('BROKEN')) { console.error('src/entry.js: syntax error'); process.exit(1); }
fs.mkdirSync('dist/src', { recursive: true }); fs.writeFileSync('dist/src/dev.js', source);\n`);
  await writeFile(join(directory, 'package.json'), JSON.stringify({ name: 'dev-fixture', private: true, scripts: { build: 'node build.js' } }));
  await writeFile(join(directory, 'src', 'entry.js'), `require('node:fs').appendFileSync('started.log', 'v1 ' + (process.env.GREETING ?? '-') + '\\n');
setInterval(() => {}, 1000);\n`);
  await writeFile(join(directory, '.env'), 'GREETING=hello\n');
  return directory;
}
const until = async (check: () => Promise<boolean>, timeoutMs = 20_000): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (!(await check())) { if (Date.now() > deadline) throw new Error('Timed out waiting for mayura dev.'); await new Promise(resolve => setTimeout(resolve, 100)); }
};
const lines = async (directory: string): Promise<string[]> => (await readFile(join(directory, 'started.log'), 'utf8').catch(() => '')).split('\n').filter(Boolean);

describe('mayura dev', () => {
  const directories: string[] = [];
  afterEach(async () => { for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true }); });

  it('builds, runs with .env loaded, restarts on an edit and keeps the running version when a build fails', async () => {
    const directory = await project(); directories.push(directory);
    const printed: string[] = []; const controller = new AbortController();
    const running = runDev({ directory, bin: 'unused', watch: true, signal: controller.signal, p: paint(false), print: line => { printed.push(line); } });
    try {
      await until(async () => (await lines(directory)).length === 1);
      expect(await lines(directory)).toEqual(['v1 hello']);
      expect(printed.join('\n')).toContain('loaded .env: GREETING'); expect(printed.join('\n')).not.toContain('hello');

      await writeFile(join(directory, 'src', 'entry.js'), (await readFile(join(directory, 'src', 'entry.js'), 'utf8')).replace("'v1 '", "'v2 '"));
      await until(async () => (await lines(directory)).length === 2);
      expect((await lines(directory))[1]).toBe('v2 hello');

      await writeFile(join(directory, 'src', 'entry.js'), '// BROKEN\n');
      await until(async () => printed.some(line => line.includes('build failed')));
      expect(printed.join('\n')).toContain('src/entry.js: syntax error');
      await new Promise(resolve => setTimeout(resolve, 500));
      expect(await lines(directory)).toHaveLength(2);
    } finally { controller.abort(); }
    await expect(running).resolves.toEqual({ status: 'stopped' });
  }, 60_000);

  it('runs a template project\'s dist/index.js when there is no dev entry or application', async () => {
    const directory = await project(); directories.push(directory);
    // The program a template builds: it records that it ran.
    const program = "require('node:fs').appendFileSync('started.log', 'template' + String.fromCharCode(10));";
    await writeFile(join(directory, 'build.js'), `const fs = require('node:fs'); fs.mkdirSync('dist', { recursive: true }); fs.writeFileSync('dist/index.js', ${JSON.stringify(program)});`);
    const printed: string[] = [];
    await runDev({ directory, bin: 'unused', watch: false, signal: new AbortController().signal, p: paint(false), print: line => { printed.push(line); } });
    await until(async () => (await lines(directory)).length === 1);
    expect(await lines(directory)).toEqual(['template']); expect(printed.some(line => line.includes('running dist/index.js'))).toBe(true);
  }, 30_000);

  it('reads .env names for display and refuses to run outside a project', async () => {
    const directory = await project(); directories.push(directory);
    expect(dotEnv(directory)).toEqual({ values: { GREETING: 'hello' }, names: ['GREETING'] });
    const empty = await mkdtemp(join(tmpdir(), 'mayura-dev-empty-')); directories.push(empty);
    await expect(runDev({ directory: empty, bin: 'unused', watch: false, signal: new AbortController().signal, p: paint(false), print: () => {} }))
      .rejects.toMatchObject({ code: 'INVALID_CONFIG' });
  });
});
