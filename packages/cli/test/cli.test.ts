import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { MayuraError } from '@mayura/core';
import { applyProjectPlan, planProject, readProject, templates, validateProject } from '../src/index.js';

const directories: string[] = [];
async function directory(): Promise<string> { const value = await mkdtemp(join(tmpdir(), 'mayura-cli-test-')); directories.push(value); return value; }
afterEach(async () => { for (const path of directories.splice(0)) await rm(path, { recursive: true, force: true }); });

describe('@mayura/cli initialization', () => {
  it('publishes exactly the eight required bounded templates', () => {
    expect(templates().map(template => template.name)).toEqual(['typed-tool-runner', 'basic-agent', 'durable-approval', 'parallel-research',
      'native-memory', 'guarded-streaming-app', 'code-mode-workflow', 'capability-policy']);
    expect(Object.isFrozen(templates())).toBe(true);
  });

  it('plans without writing and applies a genuine fresh create-only plan', async () => {
    const target = join(await directory(), 'agent'); const plan = await planProject('basic-agent', target);
    expect(plan.changes.every(change => change.operation === 'create')).toBe(true);
    await expect(readFile(join(target, 'package.json'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    await applyProjectPlan(plan); const project = await readProject(join(target, 'mayura.project.json'));
    expect(project).toMatchObject({ format: 'mayura.project.v1', template: 'basic-agent' });
    expect(JSON.parse(await readFile(join(target, 'package.json'), 'utf8')).dependencies).toEqual({
      '@mayura/sdk': '0.1.0-dev.0', '@mayura/testing': '0.1.0-dev.0', zod: '4.6.5',
    });
  });

  it('shows a bounded diff and requires exact confirmation before replacement', async () => {
    const target = join(await directory(), 'agent'); const initial = await planProject('basic-agent', target); await applyProjectPlan(initial);
    await writeFile(join(target, 'README.md'), '# local change\n');
    const plan = await planProject('basic-agent', target); const replacement = plan.changes.find(change => change.path === 'README.md');
    expect(replacement).toMatchObject({ operation: 'replace', diff: expect.stringContaining('-# local change') });
    await expect(applyProjectPlan(plan)).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
    expect(await readFile(join(target, 'README.md'), 'utf8')).toBe('# local change\n');
    const confirmed = await planProject('basic-agent', target); await applyProjectPlan(confirmed, { confirmation: confirmed.digest });
    expect(await readFile(join(target, 'README.md'), 'utf8')).toContain('Credential-free structured agent');
  });

  it('rejects a stale plan before any file changes', async () => {
    const target = join(await directory(), 'agent'); const plan = await planProject('basic-agent', target);
    await writeFile(join(target, 'package.json'), '{"external":true}\n', { flag: 'wx' }).catch(async error => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        const bootstrap = await planProject('basic-agent', target); await applyProjectPlan(bootstrap); await writeFile(join(target, 'package.json'), '{"external":true}\n');
      } else throw error;
    });
    await expect(applyProjectPlan(plan)).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(await readFile(join(target, 'package.json'), 'utf8')).toBe('{"external":true}\n');
  });
});

describe('@mayura/cli catalog validation', () => {
  it('returns immutable inspected records and rejects duplicate identities', () => {
    const base = { format: 'mayura.project.v1', name: 'agent', template: 'basic-agent', tools: [],
      definitions: [{ kind: 'agent', id: 'agent', version: '1', source: 'src/index.ts' }] };
    const project = validateProject(base); expect(Object.isFrozen(project)).toBe(true); expect(Object.isFrozen(project.definitions)).toBe(true);
    expect(() => validateProject({ ...base, definitions: [...base.definitions, ...base.definitions] })).toThrow(MayuraError);
  });

  it('rejects accessor-backed and path-escaping catalogs without invoking source code', () => {
    let reads = 0; const hostile = Object.defineProperty({}, 'format', { enumerable: true, get: () => { reads++; return 'mayura.project.v1'; } });
    expect(() => validateProject(hostile)).toThrow(MayuraError); expect(reads).toBe(0);
    expect(() => validateProject({ format: 'mayura.project.v1', name: 'agent', template: 'basic-agent', tools: [],
      definitions: [{ kind: 'agent', id: 'agent', version: '1', source: 'src/../secret.ts' }] })).toThrow(MayuraError);
  });
});
