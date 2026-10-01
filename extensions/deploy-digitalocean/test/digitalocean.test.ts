import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { applyDeployFiles, planDeploy, planDeployFiles, runDeployPlan, type DeployRunner, type DeployStep, type DeployTarget } from 'mayura/cli/deploy';
import digitalOceanTarget from '../src/index.js';

const target = digitalOceanTarget as unknown as DeployTarget;
const directories: string[] = [];
afterEach(async () => { for (const path of directories.splice(0)) await rm(path, { recursive: true, force: true }); });
const image = 'registry.digitalocean.com/acme/refunds';
const appId = '9f8c2a1e-4b7d-4c3a-8e2f-1a2b3c4d5e6f';
async function initialized(ocean: object = { appId }, extra: object = {}): Promise<string> {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'mayura-deploy-do-'))); directories.push(root);
  await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'refunds', version: '2.1.0' }));
  await writeFile(join(root, 'mayura.deploy.json'), JSON.stringify({ format: 'mayura.deploy.v1', image, targets: { digitalocean: ocean }, ...extra }));
  await applyDeployFiles(await planDeployFiles(target, root)); return root;
}
const doctl = (script: Record<string, readonly string[]> = {}) => {
  const ran: DeployStep[] = []; const calls = new Map<string, number>();
  const answers: Record<string, readonly string[]> = { 'check-app': [appId], deploy: ['0d1e2f3a-4b5c-4d6e-8f70-8192a3b4c5d6'], 'deploy-wait': ['BUILDING', 'ACTIVE'], ...script };
  const runner: DeployRunner = async step => {
    ran.push(step); const index = calls.get(step.id) ?? 0; calls.set(step.id, index + 1); const list = answers[step.id] ?? [''];
    return { exitCode: 0, ...(step.output ? { output: `${list[Math.min(index, list.length - 1)]}\n` } : {}) };
  };
  return { ran, runner };
};

describe('@mayurajs/deploy-digitalocean', () => {
  it('writes an app spec: server, worker and a pre-deploy migration from the DOCR image tag, with full commands and PostgreSQL', async () => {
    const root = await initialized({ appId, region: 'fra', databaseCluster: 'agents-db' });
    const spec = await readFile(join(root, '.do/app.yaml'), 'utf8');
    for (const line of ['name: refunds', 'region: fra', '      registry_type: DOCR', '      repository: refunds', '      tag: release', '    kind: PRE_DEPLOY',
      '    run_command: node node_modules/mayura/lib/cli/dist/bin.js serve --app dist/src/app.js', '    run_command: node node_modules/mayura/lib/cli/dist/bin.js migrate --app dist/src/app.js',
      '    run_command: node node_modules/mayura/lib/cli/dist/bin.js worker --app dist/src/app.js --probe-host 0.0.0.0 --probe-port 9090', '      http_path: /readyz',
      '        value: ${db.DATABASE_URL}', '    engine: PG', '    production: true', '    cluster_name: agents-db']) expect(spec).toContain(line);
    expect(spec).not.toMatch(/\t/u);
    expect(await readFile(join(root, 'deploy/digitalocean/Dockerfile'), 'utf8')).not.toContain('ENTRYPOINT');
    expect(await readFile(join(await initialized({}), '.do/app.yaml'), 'utf8')).toContain('    production: false');
  });

  it('pushes the release to the app\'s tag, deploys, and waits until the deployment is live', async () => {
    const plan = await planDeploy(target, await initialized(), { tag: 'v2' });
    expect(plan.steps.map(step => [step.id, step.tool, step.args])).toEqual([
      ['check-app', 'doctl', ['apps', 'get', appId, '--format', 'ID', '--no-header']],
      ['build-image', 'docker', ['build', '--file', 'deploy/digitalocean/Dockerfile', '--tag', `${image}:v2`, '--tag', `${image}:release`, '.']],
      ['push-image', 'docker', ['push', `${image}:v2`]], ['push-channel', 'docker', ['push', `${image}:release`]],
      ['deploy', 'doctl', ['apps', 'create-deployment', appId, '--format', 'ID', '--no-header']],
      ['deploy-wait', 'doctl', ['apps', 'get-deployment', appId, '{{deployment}}', '--format', 'Phase', '--no-header']],
    ]);
    const { ran, runner } = doctl();
    expect((await runDeployPlan(plan, { confirmation: plan.digest, runner })).status).toBe('succeeded');
    expect(ran.filter(step => step.id === 'deploy-wait').map(step => step.args[3])).toEqual(['0d1e2f3a-4b5c-4d6e-8f70-8192a3b4c5d6', '0d1e2f3a-4b5c-4d6e-8f70-8192a3b4c5d6']);
  }, 30_000);

  it('fails the release when the deployment errors (a failed migration) or the app is out of reach', async () => {
    const root = await initialized();
    for (const [script, failed] of [[{ 'deploy-wait': ['DEPLOYING', 'ERROR'] }, 'deploy-wait'], [{ 'deploy-wait': ['CANCELED'] }, 'deploy-wait'],
      [{ 'check-app': ['Error: app not found'] }, 'check-app'], [{ deploy: [''] }, 'deploy']] as const) {
      const plan = await planDeploy(target, root, { tag: 'v2' }); const { ran, runner } = doctl(script);
      const result = await runDeployPlan(plan, { confirmation: plan.digest, runner });
      expect(result.steps.find(step => step.status === 'failed')!.id).toBe(failed);
      if (failed === 'check-app') expect(ran.map(step => step.id)).toEqual(['check-app']);
    }
  }, 60_000);

  it('needs the app id and a DOCR image to release, and refuses malformed settings', async () => {
    await expect(planDeploy(target, await initialized({}), { tag: 'v2' })).rejects.toMatchObject({ code: 'INVALID_CONFIG', message: expect.stringContaining('appId') });
    await expect(planDeploy(target, await initialized({ appId }, { image: 'ghcr.io/acme/refunds' }), { tag: 'v2' })).rejects.toMatchObject({ message: expect.stringContaining('DigitalOcean Container Registry') });
    for (const [ocean, message] of [[{ appId: 'my-app' }, /appId/u], [{ channel: 'bad tag' }, /channel/u], [{ region: 'frankfurt' }, /region/u], [{ instanceSize: 'Big One' }, /instanceSize/u],
      [{ serverInstances: 0 }, /serverInstances/u], [{ databaseCluster: 'Agents DB' }, /databaseCluster/u], [{ timeoutSeconds: 5 }, /timeoutSeconds/u], [{ token: 'x' }, /allows only/u]] as const) {
      await expect(initialized(ocean)).rejects.toMatchObject({ code: 'INVALID_CONFIG', message: expect.stringMatching(message) });
    }
  });
});
