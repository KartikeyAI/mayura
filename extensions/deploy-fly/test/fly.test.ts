import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { applyDeployFiles, planDeploy, planDeployFiles, runDeployPlan, type DeployRunner, type DeployStep, type DeployTarget } from 'mayura/cli/deploy';
import flyTarget from '../src/index.js';

const target = flyTarget as unknown as DeployTarget;
const directories: string[] = [];
afterEach(async () => { for (const path of directories.splice(0)) await rm(path, { recursive: true, force: true }); });
async function project(deploy: object = {}): Promise<string> {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'mayura-deploy-fly-'))); directories.push(root);
  await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'refunds', version: '2.1.0' }));
  await writeFile(join(root, 'mayura.deploy.json'), JSON.stringify({ format: 'mayura.deploy.v1', image: 'registry.example.com/acme/refunds', ...deploy }));
  return root;
}
async function initialized(deploy: object = {}): Promise<string> { const root = await project(deploy); await applyDeployFiles(await planDeployFiles(target, root)); return root; }

describe('@mayurajs/deploy-fly', () => {
  it('writes fly.toml: server and worker processes, the migration as the release command, health checks, machines kept running', async () => {
    const root = await initialized({ targets: { fly: { app: 'acme-refunds', region: 'fra', memory: '1gb' } } });
    const toml = await readFile(join(root, 'fly.toml'), 'utf8');
    for (const line of ['app = "acme-refunds"', 'primary_region = "fra"', 'release_command = "migrate --app dist/src/app.js"', 'app = "serve --app dist/src/app.js"',
      'worker = "worker --app dist/src/app.js --probe-host 0.0.0.0 --probe-port 9090"', 'internal_port = 8080', 'auto_stop_machines = "off"', 'min_machines_running = 1',
      'processes = ["app"]', 'path = "/readyz"', 'port = 9090', 'processes = ["worker"]', 'memory = "1gb"', 'kill_timeout = "45s"']) expect(toml).toContain(line);
    expect(await readFile(join(root, 'Dockerfile'), 'utf8')).toContain('ENTRYPOINT ["node", "node_modules/mayura/lib/cli/dist/bin.js"]');
  });

  it('releases with Fly\'s remote builder by default, labelled with the release tag, after checking the app', async () => {
    const plan = await planDeploy(target, await initialized(), { tag: 'v2.1.0_build.7' });
    expect(plan.steps.map(step => [step.id, step.tool, step.args])).toEqual([
      ['check-app', 'flyctl', ['status', '--app', 'refunds']],
      ['deploy', 'flyctl', ['deploy', '--app', 'refunds', '--config', 'fly.toml', '--strategy', 'rolling', '--wait-timeout', '600s', '--remote-only', '--image-label', 'v2.1.0_build.7']],
    ]);
  });

  it('builds locally, or pushes to your registry and deploys that image', async () => {
    const local = await planDeploy(target, await initialized({ targets: { fly: { build: 'local', waitSeconds: 120 } } }), { tag: 'v3' });
    expect(local.steps[1]!.args).toEqual(['deploy', '--app', 'refunds', '--config', 'fly.toml', '--strategy', 'rolling', '--wait-timeout', '120s', '--local-only', '--image-label', 'v3']);
    const image = await planDeploy(target, await initialized({ targets: { fly: { build: 'image' } } }), { tag: 'v3' });
    expect(image.steps.map(step => step.id)).toEqual(['check-app', 'build-image', 'push-image', 'deploy']);
    expect(image.steps[3]!.args.slice(-2)).toEqual(['--image', 'registry.example.com/acme/refunds:v3']);
    const noImage = await project({ image: undefined, targets: { fly: { build: 'image' } } });
    await applyDeployFiles(await planDeployFiles(target, noImage));
    await expect(planDeploy(target, noImage, { tag: 'v3' })).rejects.toMatchObject({ code: 'INVALID_CONFIG', message: expect.stringContaining('image') });
  });

  it.each([
    [{ app: 'Acme' }, /app/u], [{ region: 'frankfurt' }, /region/u], [{ build: 'cloud' }, /build/u], [{ vmSize: 'huge cpu' }, /vmSize/u],
    [{ memory: '1tb' }, /memory/u], [{ waitSeconds: 5 }, /waitSeconds/u], [{ secrets: 'x' }, /allows only/u],
  ])('refuses malformed settings (%#)', async (fly, message) => {
    await expect(planDeployFiles(target, await project({ targets: { fly } }))).rejects.toMatchObject({ code: 'INVALID_CONFIG', message: expect.stringMatching(message) });
  });

  it('refuses a release when fly.toml is missing or names another app', async () => {
    await expect(planDeploy(target, await project(), { tag: 'v1' })).rejects.toMatchObject({ code: 'NOT_FOUND', message: expect.stringContaining('deploy init --target fly') });
    const root = await initialized();
    await writeFile(join(root, 'fly.toml'), (await readFile(join(root, 'fly.toml'), 'utf8')).replace('app = "refunds"', 'app = "someone-else"'));
    await expect(planDeploy(target, root, { tag: 'v1' })).rejects.toMatchObject({ code: 'INVALID_CONFIG', message: expect.stringContaining('another app') });
  });

  it('never deploys when the app check fails, for example when flyctl is not logged in', async () => {
    const plan = await planDeploy(target, await initialized(), { tag: 'v1' }); const ran: DeployStep[] = [];
    const runner: DeployRunner = async step => { ran.push(step); return { exitCode: step.id === 'check-app' ? 1 : 0 }; };
    const result = await runDeployPlan(plan, { confirmation: plan.digest, runner });
    expect(result.steps.map(step => step.status)).toEqual(['failed', 'skipped']); expect(ran.map(step => step.id)).toEqual(['check-app']);
  });

  it('is found as the fly target when the package is installed in a project', async () => {
    const root = await initialized(); const installed = join(root, 'node_modules', '@mayurajs', 'deploy-fly');
    await mkdir(installed, { recursive: true });
    await writeFile(join(installed, 'package.json'), JSON.stringify({ name: '@mayurajs/deploy-fly', type: 'module', exports: { '.': { import: './index.js' } } }));
    await writeFile(join(installed, 'index.js'), `export { default } from ${JSON.stringify(new URL('../dist/index.js', import.meta.url).href)};\n`);
    const { builtInDeployTargets, resolveDeployTarget } = await import('mayura/cli/deploy');
    expect((await resolveDeployTarget('fly', root, builtInDeployTargets)).tools).toEqual(['flyctl', 'docker']);
  });
});
