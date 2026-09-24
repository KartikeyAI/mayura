import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { applyProjectPlan, planProject, readProject, TEMPLATE_NAMES } from '../packages/cli/dist/index.js';

const exec = promisify(execFile); const workspace = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const artifactRoot = join(workspace, '.artifacts'); await mkdir(artifactRoot, { recursive: true });
const output = await mkdtemp(join(artifactRoot, 'template-check-')); const compiler = join(workspace, 'node_modules', 'typescript', 'bin', 'tsc');
const reports = [];
for (const template of TEMPLATE_NAMES) {
  const directory = join(output, template); const plan = await planProject(template, directory);
  assert(plan.changes.every(change => change.operation === 'create')); await applyProjectPlan(plan);
  const project = await readProject(join(directory, 'mayura.project.json')); assert.equal(project.template, template);
  const typecheck = await exec(process.execPath, [compiler, '--project', join(directory, 'tsconfig.json'), '--pretty', 'false'],
    { cwd: workspace, timeout: 30_000, windowsHide: true, maxBuffer: 4 * 1024 * 1024 });
  assert.equal(typecheck.stderr, '');
  const execution = await exec(process.execPath, [join(directory, 'dist', 'index.js')],
    { cwd: directory, timeout: 30_000, windowsHide: true, maxBuffer: 4 * 1024 * 1024,
      env: { PATH: process.env.PATH ?? '', SYSTEMROOT: process.env.SYSTEMROOT ?? '', WINDIR: process.env.WINDIR ?? '', TEMP: process.env.TEMP ?? '', TMP: process.env.TMP ?? '' } });
  const line = execution.stdout.trim().split(/\r?\n/u).at(-1); assert(line, `${template} emitted no result.`);
  JSON.parse(line); reports.push({ template, files: plan.changes.length, outputBytes: Buffer.byteLength(execution.stdout) });
}
const report = { status: 'passed', qualification: 'workspace-linked', templates: reports, output };
await writeFile(join(output, 'report.json'), `${JSON.stringify(report, null, 2)}\n`); console.log(JSON.stringify(report));
