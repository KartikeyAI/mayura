import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { applyDeployFiles, planDeploy, planDeployFiles, runDeployPlan, type DeployRunner, type DeployTarget } from 'mayura/cli/deploy';
import railwayTarget from '../src/index.js';

const target = railwayTarget as unknown as DeployTarget;
const directories: string[] = [];
afterEach(async () => { for (const path of directories.splice(0)) await rm(path, { recursive: true, force: true }); });
async function project(deploy: object = {}): Promise<string> {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'mayura-deploy-railway-'))); directories.push(root);
  await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'refunds', version: '2.1.0' }));
  await writeFile(join(root, 'mayura.deploy.json'), JSON.stringify({ format: 'mayura.deploy.v1', ...deploy }));
  return root;
}
async function initialized(deploy: object = {}): Promise<string> { const root = await project(deploy); await applyDeployFiles(await planDeployFiles(target, root)); return root; }
const mayura = 'node node_modules/mayura/lib/cli/dist/bin.js';

describe('@mayurajs/deploy-railway', () => {
  it('writes one config-as-code file per service: full start commands, the migration before each goes live, the server\'s health check', async () => {
    const root = await initialized();
    const server = JSON.parse(await readFile(join(root, 'deploy/railway/server.json'), 'utf8'));
    const worker = JSON.parse(await readFile(join(root, 'deploy/railway/worker.json'), 'utf8'));
    expect(server).toEqual({ $schema: 'https://railway.com/railway.schema.json', build: { builder: 'DOCKERFILE', dockerfilePath: 'Dockerfile' },
      deploy: { startCommand: `${mayura} serve --app dist/src/app.js`, preDeployCommand: [`${mayura} migrate --app dist/src/app.js`],
        healthcheckPath: '/readyz', healthcheckTimeout: 300, restartPolicyType: 'ON_FAILURE', restartPolicyMaxRetries: 10 } });
    expect(worker.deploy).toEqual({ startCommand: `${mayura} worker --app dist/src/app.js --probe-host 0.0.0.0 --probe-port 9090`,
      preDeployCommand: [`${mayura} migrate --app dist/src/app.js`], restartPolicyType: 'ON_FAILURE', restartPolicyMaxRetries: 10 });
    expect(await readFile(join(root, 'Dockerfile'), 'utf8')).toContain('FROM node:24');
  });

  it('releases the server, then the worker, each with railway up --ci, after checking the linked project', async () => {
    const plan = await planDeploy(target, await initialized(), { tag: 'v2.1.0' });
    expect(plan.steps.map(step => [step.id, step.tool, step.args])).toEqual([
      ['check-project', 'railway', ['status']],
      ['deploy-server', 'railway', ['up', '--ci', '--service', 'refunds-server', '--message', 'mayura deploy v2.1.0']],
      ['deploy-worker', 'railway', ['up', '--ci', '--service', 'refunds-worker', '--message', 'mayura deploy v2.1.0']],
    ]);
    const named = await planDeploy(target, await initialized({ targets: { railway: { serverService: 'web', workerService: 'jobs', environment: 'staging' } } }), { tag: 'v3' });
    expect(named.steps[2]!.args).toEqual(['up', '--ci', '--service', 'jobs', '--environment', 'staging', '--message', 'mayura deploy v3']);
  });

  it.each([
    [{ serverService: '' }, /serverService/u], [{ workerService: 'bad\nname' }, /workerService/u], [{ serverService: 'one', workerService: 'one' }, /two Railway services/u],
    [{ environment: 7 }, /environment/u], [{ token: 'x' }, /allows only/u],
  ])('refuses malformed settings (%#)', async (railway, message) => {
    await expect(planDeployFiles(target, await project({ targets: { railway } }))).rejects.toMatchObject({ code: 'INVALID_CONFIG', message: expect.stringMatching(message) });
  });

  it('refuses a release before deploy init, and never releases the worker when the server failed', async () => {
    await expect(planDeploy(target, await project(), { tag: 'v1' })).rejects.toMatchObject({ code: 'NOT_FOUND', message: expect.stringContaining('deploy init --target railway') });
    const plan = await planDeploy(target, await initialized(), { tag: 'v1' }); const ran: string[] = [];
    const runner: DeployRunner = async step => { ran.push(step.id); return { exitCode: step.id === 'deploy-server' ? 1 : 0 }; };
    const result = await runDeployPlan(plan, { confirmation: plan.digest, runner });
    expect(result.status).toBe('failed'); expect(ran).toEqual(['check-project', 'deploy-server']);
  });
});
