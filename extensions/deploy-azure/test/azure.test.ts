import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { applyDeployFiles, planDeploy, planDeployFiles, runDeployPlan, type DeployRunner, type DeployStep, type DeployTarget } from 'mayura/cli/deploy';
import azureTarget from '../src/index.js';

const target = azureTarget as unknown as DeployTarget;
const directories: string[] = [];
afterEach(async () => { for (const path of directories.splice(0)) await rm(path, { recursive: true, force: true }); });
const image = 'acmeregistry.azurecr.io/refunds';
async function initialized(azure: object = { resourceGroup: 'agents-prod' }, extra: object = {}): Promise<string> {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'mayura-deploy-azure-'))); directories.push(root);
  await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'refunds', version: '2.1.0' }));
  await writeFile(join(root, 'mayura.deploy.json'), JSON.stringify({ format: 'mayura.deploy.v1', image, targets: { azure }, ...extra }));
  await applyDeployFiles(await planDeployFiles(target, root)); return root;
}
/** A fake az: answers each step from a script, one answer per call, the last one repeated. */
const az = (script: Record<string, readonly string[]> = {}) => {
  const ran: DeployStep[] = []; const calls = new Map<string, number>();
  const answers: Record<string, readonly string[]> = { 'check-account': ['3f2504e0-4f89-11d3-9a0c-0305e82c3301'], 'migrate-image': ['refunds-migrate'], migrate: ['refunds-migrate-k2x9q1'],
    'migrate-wait': ['Running', 'Succeeded'], 'update-server': ['refunds-server--0000007'], 'server-ready': ['Activating', 'Running'], 'update-worker': ['refunds-worker--0000007'],
    'worker-ready': ['Running'], ...script };
  const runner: DeployRunner = async step => {
    ran.push(step); const index = calls.get(step.id) ?? 0; calls.set(step.id, index + 1);
    const list = answers[step.id] ?? ['']; return { exitCode: 0, ...(step.output ? { output: `${list[Math.min(index, list.length - 1)]}\n` } : {}) };
  };
  return { ran, runner };
};

describe('@mayurajs/deploy-azure', () => {
  it('builds in ACR, runs the migration job to success, then updates the server and worker and waits for each new revision', async () => {
    const plan = await planDeploy(target, await initialized(), { tag: 'v2' });
    expect(plan.steps.map(step => step.id)).toEqual(['check-account', 'build-image', 'migrate-image', 'migrate', 'migrate-wait', 'update-server', 'server-ready', 'update-worker', 'worker-ready']);
    expect(plan.steps[1]!.args).toEqual(['acr', 'build', '--registry', 'acmeregistry', '--image', 'refunds:v2', '.']);
    // Polls wait 5 s between attempts; the scripted answers settle within two.
    const { ran, runner } = az();
    const result = await runDeployPlan(plan, { confirmation: plan.digest, runner });
    expect(result.status).toBe('succeeded');
    expect(ran.filter(step => step.id === 'migrate-wait')[0]!.args).toEqual(['containerapp', 'job', 'execution', 'show', '--name', 'refunds-migrate', '--resource-group', 'agents-prod',
      '--job-execution-name', 'refunds-migrate-k2x9q1', '--query', 'properties.status', '--output', 'tsv']);
    expect(ran.filter(step => step.id === 'server-ready').map(step => step.args[step.args.indexOf('--revision') + 1])).toEqual(['refunds-server--0000007', 'refunds-server--0000007']);
    expect(ran.find(step => step.id === 'update-worker')!.args).toEqual(['containerapp', 'update', '--name', 'refunds-worker', '--resource-group', 'agents-prod', '--image', `${image}:v2`,
      '--query', 'properties.latestRevisionName', '--output', 'tsv']);
    // az is a .cmd script on Windows: every argument must pass through cmd.exe unchanged.
    expect(ran.flatMap(step => step.args).filter(arg => /["%!^&|<>()\r\n]|\\$/u.test(arg))).toEqual([]);
  }, 30_000);

  it('never updates the apps when the migration fails, and stops when a new revision fails', async () => {
    const root = await initialized();
    for (const [script, failed] of [[{ 'migrate-wait': ['Running', 'Failed'] }, 'migrate-wait'], [{ migrate: ['ERROR: not found'] }, 'migrate'],
      [{ 'server-ready': ['Activating', 'Failed'] }, 'server-ready'], [{ 'check-account': [''] }, 'check-account']] as const) {
      const plan = await planDeploy(target, root, { tag: 'v2' }); const { ran, runner } = az(script);
      const result = await runDeployPlan(plan, { confirmation: plan.digest, runner });
      expect(result.steps.find(step => step.status === 'failed')!.id).toBe(failed);
      if (failed !== 'server-ready') expect(ran.map(step => step.id)).not.toContain('update-server');
      expect(ran.map(step => step.id)).not.toContain('update-worker');
    }
  }, 60_000);

  it('builds locally, uses a subscription, and waits as long as configured', async () => {
    const plan = await planDeploy(target, await initialized({ resourceGroup: 'agents-prod', build: 'local', subscription: '3f2504e0-4f89-11d3-9a0c-0305e82c3301',
      migrationTimeoutSeconds: 120, revisionTimeoutSeconds: 60 }), { tag: 'v2' });
    expect(plan.steps.map(step => step.id).slice(1, 3)).toEqual(['build-image', 'push-image']);
    expect(plan.steps[0]!.args).toEqual(['account', 'show', '--subscription', '3f2504e0-4f89-11d3-9a0c-0305e82c3301', '--query', 'id', '--output', 'tsv']);
    expect(plan.steps.find(step => step.id === 'migrate-wait')!.output!.retry).toEqual({ while: 'Running|Processing|Pending', attempts: 24, intervalSeconds: 5 });
    expect(plan.steps.find(step => step.id === 'server-ready')!.output!.retry).toEqual({ while: 'Activating|Processing|Provisioning', attempts: 12, intervalSeconds: 5 });
  });

  it('needs a resource group and an image, and a registry for ACR builds; refuses malformed settings', async () => {
    await expect(planDeploy(target, await initialized({}), { tag: 'v2' })).rejects.toMatchObject({ code: 'INVALID_CONFIG', message: expect.stringContaining('resourceGroup') });
    await expect(planDeploy(target, await initialized({ resourceGroup: 'g' }, { image: undefined }), { tag: 'v2' })).rejects.toMatchObject({ message: expect.stringContaining('image') });
    await expect(planDeploy(target, await initialized({ resourceGroup: 'g' }, { image: 'ghcr.io/acme/refunds' }), { tag: 'v2' })).rejects.toMatchObject({ message: expect.stringContaining('registry') });
    expect((await planDeploy(target, await initialized({ resourceGroup: 'g', registry: 'acmeregistry' }, { image: 'ghcr.io/acme/refunds' }), { tag: 'v2' })).steps[1]!.args)
      .toEqual(['acr', 'build', '--registry', 'acmeregistry', '--image', 'acme/refunds:v2', '.']);
    for (const [azure, message] of [[{ resourceGroup: 'agents (prod)' }, /resourceGroup/u], [{ subscription: 'mine' }, /subscription/u], [{ build: 'buildpack' }, /build/u],
      [{ registry: 'acme.azurecr.io' }, /registry/u], [{ migrationTimeoutSeconds: 10 }, /migrationTimeoutSeconds/u], [{ revisionTimeoutSeconds: 7_200 }, /revisionTimeoutSeconds/u], [{ token: 'x' }, /allows only/u]] as const) {
      await expect(initialized(azure)).rejects.toMatchObject({ code: 'INVALID_CONFIG', message: expect.stringMatching(message) });
    }
  });
});
