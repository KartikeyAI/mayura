import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { applyDeployFiles, planDeploy, planDeployFiles, runDeployPlan, type DeployRunner, type DeployTarget } from 'mayura/cli/deploy';
import renderTarget from '../src/index.js';

const target = renderTarget as unknown as DeployTarget;
const directories: string[] = [];
afterEach(async () => { for (const path of directories.splice(0)) await rm(path, { recursive: true, force: true }); });
async function project(deploy: object = {}): Promise<string> {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'mayura-deploy-render-'))); directories.push(root);
  await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'refunds', version: '2.1.0' }));
  await writeFile(join(root, 'mayura.deploy.json'), JSON.stringify({ format: 'mayura.deploy.v1', env: ['OPENAI_API_KEY', 'MAYURA_OPERATOR_TOKEN_SHA256'], ...deploy }));
  return root;
}
async function initialized(deploy: object = {}): Promise<string> { const root = await project(deploy); await applyDeployFiles(await planDeployFiles(target, root)); return root; }
const ids = { serverServiceId: 'srv-d1abcdefgh2345678901', workerServiceId: 'srv-d9zyxwvut8765432109' };
const cli = 'node node_modules/mayura/lib/cli/dist/bin.js';

describe('@mayurajs/deploy-render', () => {
  it('writes a Blueprint: web service and worker from an image without an entry point, both migrating first, PostgreSQL, secrets without values', async () => {
    const root = await initialized({ targets: { render: { region: 'frankfurt', autoDeploy: 'commit' } } });
    const yaml = await readFile(join(root, 'render.yaml'), 'utf8');
    for (const line of ['  - type: web', '    name: refunds-server', '  - type: worker', '    name: refunds-worker', '    runtime: docker', '    region: frankfurt',
      '    dockerfilePath: ./deploy/render/Dockerfile', `    dockerCommand: ${cli} serve --app dist/src/app.js`,
      `    dockerCommand: ${cli} worker --app dist/src/app.js --probe-host 0.0.0.0 --probe-port 9090`, '    healthCheckPath: /readyz', '    autoDeployTrigger: "commit"',
      '          name: refunds-db', '          property: connectionString', '      - key: OPENAI_API_KEY', '        sync: false', '  - name: refunds-db', '    plan: basic-256mb']) {
      expect(yaml).toContain(line);
    }
    expect(yaml.match(new RegExp(`preDeployCommand: ${cli} migrate --app dist/src/app.js`, 'gu'))).toHaveLength(2);
    expect(yaml.match(/key: MAYURA_OPERATOR_TOKEN_SHA256/gu)).toHaveLength(2);
    expect(yaml).not.toMatch(/\t/u);
    const docker = await readFile(join(root, 'deploy/render/Dockerfile'), 'utf8');
    expect(docker).not.toContain('ENTRYPOINT'); expect(docker).toContain(`CMD ["node", "node_modules/mayura/lib/cli/dist/bin.js", "serve", "--app", "dist/src/app.js"]`);
  });

  it('releases by validating the Blueprint, then deploying the server and the worker and waiting for each', async () => {
    const plan = await planDeploy(target, await initialized({ targets: { render: ids } }), { tag: 'v2' });
    expect(plan.steps.map(step => [step.id, step.tool, step.args])).toEqual([
      ['validate', 'render', ['blueprints', 'validate', 'render.yaml']],
      ['deploy-server', 'render', ['deploys', 'create', ids.serverServiceId, '--wait', '--confirm', '--output', 'text']],
      ['deploy-worker', 'render', ['deploys', 'create', ids.workerServiceId, '--wait', '--confirm', '--output', 'text']],
    ]);
  });

  it('needs the services\' ids to release, and refuses malformed settings', async () => {
    await expect(planDeploy(target, await initialized(), { tag: 'v2' })).rejects.toMatchObject({ code: 'INVALID_CONFIG', message: expect.stringContaining('serverServiceId') });
    await expect(planDeploy(target, await project({ targets: { render: ids } }), { tag: 'v2' })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    for (const [render, message] of [[{ region: 'Frankfurt!' }, /region/u], [{ plan: '' }, /plan/u], [{ databasePlan: 'x y' }, /databasePlan/u], [{ autoDeploy: 'always' }, /autoDeploy/u],
      [{ serverServiceId: 'svc-123' }, /serverServiceId/u], [{ serverServiceId: ids.serverServiceId, workerServiceId: ids.serverServiceId }, /two ids/u], [{ apiKey: 'x' }, /allows only/u]] as const) {
      await expect(planDeployFiles(target, await project({ targets: { render } }))).rejects.toMatchObject({ code: 'INVALID_CONFIG', message: expect.stringMatching(message) });
    }
  });

  it('never deploys the worker when the server deploy fails', async () => {
    const plan = await planDeploy(target, await initialized({ targets: { render: ids } }), { tag: 'v2' }); const ran: string[] = [];
    const runner: DeployRunner = async step => { ran.push(step.id); return { exitCode: step.id === 'deploy-server' ? 1 : 0 }; };
    expect((await runDeployPlan(plan, { confirmation: plan.digest, runner })).status).toBe('failed');
    expect(ran).toEqual(['validate', 'deploy-server']);
  });
});
