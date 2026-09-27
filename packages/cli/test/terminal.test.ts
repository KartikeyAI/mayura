import { mkdtemp, readFile, readdir, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { PassThrough, Writable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { initWizard } from '../src/interactive.js';
import { colourEnabled, help, paint, render, renderError, renderLifecycle } from '../src/output.js';
import { starters } from '../src/index.js';

const plain = paint(false);
const bin = fileURLToPath(new URL('../dist/bin.js', import.meta.url));
const runBin = (args: string[]) => new Promise<{ code: number | null; stdout: string; stderr: string }>(resolve => {
  const child = spawn(process.execPath, [bin, ...args], { stdio: ['ignore', 'pipe', 'pipe'] }); let stdout = ''; let stderr = '';
  child.stdout.on('data', chunk => { stdout += String(chunk); }); child.stderr.on('data', chunk => { stderr += String(chunk); });
  child.on('close', code => resolve({ code, stdout, stderr }));
});

describe('terminal output', () => {
  it('keeps piped output as the exact JSON documents, and --json always prints JSON', async () => {
    const piped = await runBin(['starters']);
    expect(JSON.parse(piped.stdout)).toEqual({ status: 'succeeded', starters: starters() });
    expect(JSON.parse((await runBin(['starters', '--json'])).stdout)).toEqual({ status: 'succeeded', starters: starters() });
    const usage = await runBin(['init', '--starter', 'research-team']);
    expect(usage.code).toBe(1);
    // The CLI's own usage problems say what is wrong instead of a generic failure.
    expect(JSON.parse(usage.stderr)).toEqual({ status: 'failed', error: { code: 'INVALID_INPUT', message: expect.stringContaining('--directory') } });
    const unknown = await runBin(['sk-not-a-command-0123456789']);
    expect(unknown.stderr).toContain('Unknown command'); expect(unknown.stderr).not.toContain('sk-not-a-command');
    expect((await runBin(['--help'])).stdout).toContain('mayura <command> [options]');
  });

  it('colours only a terminal that has not opted out', () => {
    expect(colourEnabled({ isTTY: true }, {})).toBe(true);
    expect(colourEnabled({ isTTY: false }, {})).toBe(false);
    expect(colourEnabled({ isTTY: true }, { NO_COLOR: '1' })).toBe(false);
    expect(colourEnabled({ isTTY: true }, { TERM: 'dumb' })).toBe(false);
    expect(colourEnabled({ isTTY: false }, { FORCE_COLOR: '1' })).toBe(true);
    expect(paint(true).red('x')).toBe('\u001b[31mx\u001b[39m'); expect(plain.red('x')).toBe('x');
  });

  it('renders catalogs, plans, workflows, errors and lifecycle events for people', () => {
    const catalog = render('starters', { status: 'succeeded', starters: starters() }, plain);
    for (const item of starters()) expect(catalog).toContain(item.name);
    expect(catalog).toContain('mayura init');

    const change = (path: string, operation: string) => ({ path, operation, afterDigest: 'a'.repeat(64) });
    const planned = { status: 'planned', plan: { format: 'mayura.init-plan.v1', starter: 'research-team', directory: '/work/app', digest: 'd'.repeat(64),
      changes: [change('package.json', 'create'), change('README.md', 'replace'), change('src/app.ts', 'unchanged')] } };
    const planText = render('init', planned, plain);
    expect(planText).toContain('+ create  package.json'); expect(planText).toContain('~ replace README.md');
    expect(planText).toContain(`--confirm ${'d'.repeat(64)}`); expect(planText).not.toContain('src/app.ts');
    const applied = render('init', { ...planned, status: 'succeeded' }, plain);
    expect(applied).toContain('Next steps'); expect(applied).toContain('npm run dev');

    const runId = 'b'.repeat(64);
    const listed = render('workflow-list', { status: 'succeeded', page: { items: [{ format: 5, definitionId: 'research.run', definitionVersion: '1', runId,
      revision: 3, status: 'outcome_unknown', settledAtMs: 0 }], next: 'cursor-2' } }, plain);
    expect(listed).toContain('✖ outcome unknown'); expect(listed).toContain(runId); expect(listed).toContain('1970-01-01 00:00:00 UTC');
    expect(listed).toContain('--after cursor-2');
    const view = render('workflow-get', { status: 'succeeded', workflow: { format: 5, definitionId: 'refund', definitionVersion: '2', runId, revision: 4,
      status: 'waiting', nodes: [], steps: [{ id: 'pay', kind: 'tool', status: 'waiting', approval: { digest: 'c'.repeat(64), expiresAtMs: 1 } }] } }, plain);
    expect(view).toContain('refund@2'); expect(view).toContain(`--node pay --digest ${'c'.repeat(64)}`);

    expect(renderError({ code: 'INVALID_INPUT', message: 'Missing --url.' }, plain)).toBe('✖ Missing --url. (INVALID_INPUT)');
    expect(renderLifecycle({ event: 'serving' }, plain)).toContain('Serving');
    expect(render('unknown-shape', { any: 1 }, plain)).toContain('"any": 1');
    expect(help(plain)).toContain('workflow-list [--settled]');
  });
});

describe('interactive init', () => {
  const roots: string[] = [];
  afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
  /** Type `keys` into the wizard one at a time, as a person would, and capture what it draws. */
  const drive = async (keys: string[]) => {
    const input = new PassThrough(); let screen = '';
    const output = Object.assign(new Writable({ write(chunk, _encoding, done) { screen += String(chunk); done(); } }), { columns: 100, rows: 40 });
    const typing = (async () => { for (const key of keys) { await new Promise(resolve => setTimeout(resolve, 15)); input.write(key); } })();
    const result = await initWizard(plain, { input, output }); await typing;
    return { result, screen: screen.replace(/\u001b\[[0-9;?]*[A-Za-z]/gu, '') };
  };
  const down = '\u001b[B'; const enter = '\r';

  it('creates a starter chosen with the arrow keys, then shows the next steps', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mayura-wizard-')); roots.push(root); const target = join(root, 'my-app');
    const { result, screen } = await drive([enter, down, down, enter, ...target, enter, enter]);
    expect(result).toMatchObject({ status: 'succeeded', plan: { starter: 'research-team' } });
    expect(JSON.parse(await readFile(join(target, 'package.json'), 'utf8'))).toMatchObject({ name: 'my-app' });
    expect(screen).toContain('Next steps'); expect(screen).toContain('npm run dev');
  });

  it('runs an extra step after writing, and leaves npm install out of the next steps when that step installs', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mayura-wizard-')); roots.push(root); const target = join(root, 'local-app'); const seen: string[] = [];
    const input = new PassThrough(); let screen = '';
    const output = Object.assign(new Writable({ write(chunk, _encoding, done) { screen += String(chunk); done(); } }), { columns: 100, rows: 40 });
    const typing = (async () => { for (const key of [enter, enter, ...target, enter, enter]) { await new Promise(resolve => setTimeout(resolve, 15)); input.write(key); } })();
    const result = await initWizard(plain, { input, output }, { label: 'Installing', installs: true, run: async directory => { seen.push(directory); return 'Installed 3 packages'; } });
    await typing;
    expect(result.status).toBe('succeeded'); expect(seen).toEqual([target]);
    expect(screen).toContain('Installed 3 packages'); expect(screen).toContain('npm run dev'); expect(screen).not.toContain('npm install');
  });

  it('writes nothing when cancelled', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mayura-wizard-')); roots.push(root);
    const { result, screen } = await drive([enter, '\u0003']);
    expect(result).toEqual({ status: 'cancelled' }); expect(screen).toContain('Nothing was created.');
    expect(await readdir(root)).toEqual([]);
  });

  it('lists files it would replace and defaults to not replacing them', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mayura-wizard-')); roots.push(root); const target = join(root, 'existing');
    await mkdir(target); await writeFile(join(target, 'README.md'), 'mine\n');
    // Template "basic-agent" is the second template; Enter at the confirmation takes the default, which is No.
    const { result, screen } = await drive([down, enter, down, enter, ...target, enter, enter]);
    expect(result).toEqual({ status: 'cancelled' });
    expect(screen).toContain('These existing files would be replaced'); expect(screen).toContain('~ README.md');
    expect(await readFile(join(target, 'README.md'), 'utf8')).toBe('mine\n');
  });
});
