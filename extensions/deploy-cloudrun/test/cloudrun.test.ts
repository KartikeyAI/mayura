import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { applyDeployFiles, planDeploy, planDeployFiles, runDeployPlan, type DeployRunner, type DeployTarget } from 'mayura/cli/deploy';
import cloudRunTarget from '../src/index.js';

const target = cloudRunTarget as unknown as DeployTarget;
const directories: string[] = [];
afterEach(async () => { for (const path of directories.splice(0)) await rm(path, { recursive: true, force: true }); });
const image = 'us-central1-docker.pkg.dev/acme-prod/apps/refunds';
async function initialized(cloudrun: object = { project: 'acme-prod' }, extra: object = {}): Promise<string> {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'mayura-deploy-cloudrun-'))); directories.push(root);
  await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'refunds', version: '2.1.0' }));
  await writeFile(join(root, 'mayura.deploy.json'), JSON.stringify({ format: 'mayura.deploy.v1', image, env: ['OPENAI_API_KEY'], targets: { cloudrun }, ...extra }));
  await applyDeployFiles(await planDeployFiles(target, root)); return root;
}
const where = ['--project', 'acme-prod', '--region', 'us-central1'];
const shared = [`--image=${image}:v2`, '--set-secrets=DATABASE_URL=DATABASE_URL:latest,OPENAI_API_KEY=OPENAI_API_KEY:latest'];

describe('@mayurajs/deploy-cloudrun', () => {
  it('builds with Cloud Build, migrates with a job it waits for, then deploys the server and an always-on internal worker', async () => {
    const plan = await planDeploy(target, await initialized(), { tag: 'v2' });
    expect(plan.steps.map(step => [step.id, step.tool, step.args])).toEqual([
      ['check-project', 'gcloud', ['projects', 'describe', 'acme-prod', '--format=none']],
      ['build-image', 'gcloud', ['builds', 'submit', '--project', 'acme-prod', `--tag=${image}:v2`, '--quiet', '.']],
      ['migrate', 'gcloud', ['run', 'jobs', 'deploy', 'refunds-migrate', ...where, ...shared, '--args=migrate,--app,dist/src/app.js', '--max-retries=0', '--task-timeout=1800s', '--execute-now', '--wait', '--quiet']],
      ['deploy-server', 'gcloud', ['run', 'deploy', 'refunds-server', ...where, ...shared, '--args=serve,--app,dist/src/app.js', '--port=8080', '--no-cpu-throttling', '--min-instances=1',
        '--timeout=3600s', '--startup-probe=httpGet.path=/readyz,httpGet.port=8080,periodSeconds=5,failureThreshold=24', '--allow-unauthenticated', '--quiet']],
      ['deploy-worker', 'gcloud', ['run', 'deploy', 'refunds-worker', ...where, ...shared, '--args=worker,--app,dist/src/app.js,--probe-host,0.0.0.0,--probe-port,9090', '--port=9090',
        '--no-cpu-throttling', '--min-instances=1', '--max-instances=1', '--ingress=internal', '--no-allow-unauthenticated',
        '--startup-probe=httpGet.path=/readyz,httpGet.port=9090,periodSeconds=5,failureThreshold=24', '--quiet']],
    ]);
    // gcloud is a .cmd script on Windows: every argument must pass through cmd.exe unchanged.
    expect(plan.steps.flatMap(step => step.args).filter(arg => /["%!^&|<>()\r\n]|\\$/u.test(arg))).toEqual([]);
  });

  it('builds locally, maps secrets, connects Cloud SQL, runs as a service account, and keeps the server private on request', async () => {
    const plan = await planDeploy(target, await initialized({ project: 'acme-prod', region: 'europe-west1', build: 'local', secrets: { OPENAI_API_KEY: 'openai-key:3' },
      cloudSqlInstance: 'acme-prod:europe-west1:main', serviceAccount: 'refunds-run@acme-prod.iam.gserviceaccount.com', public: false, serverMinInstances: 2, workerInstances: 2 }), { tag: 'v2' });
    expect(plan.steps.map(step => step.id)).toEqual(['check-project', 'build-image', 'push-image', 'migrate', 'deploy-server', 'deploy-worker']);
    const server = plan.steps[4]!.args;
    for (const flag of ['--region', 'europe-west1', '--set-secrets=DATABASE_URL=DATABASE_URL:latest,OPENAI_API_KEY=openai-key:3', '--set-cloudsql-instances=acme-prod:europe-west1:main',
      '--service-account=refunds-run@acme-prod.iam.gserviceaccount.com', '--min-instances=2', '--no-allow-unauthenticated']) expect(server).toContain(flag);
    expect(plan.steps[5]!.args).toEqual(expect.arrayContaining(['--min-instances=2', '--max-instances=2']));
    expect(plan.steps[3]!.args).toContain('--set-cloudsql-instances=acme-prod:europe-west1:main');
  });

  it('writes its files without a project id, but needs one, and an image, to release', async () => {
    const root = await initialized({});
    await expect(planDeploy(target, root, { tag: 'v2' })).rejects.toMatchObject({ code: 'INVALID_CONFIG', message: expect.stringContaining('targets.cloudrun.project') });
    const noImage = await initialized({ project: 'acme-prod' }, { image: undefined });
    await expect(planDeploy(target, noImage, { tag: 'v2' })).rejects.toMatchObject({ code: 'INVALID_CONFIG', message: expect.stringContaining('Artifact Registry') });
  });

  it.each([
    [{ project: 'Acme' }, /project/u], [{ region: 'mars' }, /region/u], [{ build: 'kaniko' }, /build/u], [{ secrets: { openai: 'x:latest' } }, /secrets/u],
    [{ secrets: { OPENAI_API_KEY: 'key with space:latest' } }, /secrets/u], [{ cloudSqlInstance: 'main' }, /cloudSqlInstance/u], [{ serviceAccount: 'me@gmail.com' }, /serviceAccount/u],
    [{ public: 'yes' }, /public/u], [{ workerInstances: 0 }, /workerInstances/u], [{ token: 'x' }, /allows only/u],
  ])('refuses malformed settings (%#)', async (cloudrun, message) => {
    await expect(initialized(cloudrun)).rejects.toMatchObject({ code: 'INVALID_CONFIG', message: expect.stringMatching(message) });
  });

  it('never deploys the server or worker when the migration fails', async () => {
    const plan = await planDeploy(target, await initialized(), { tag: 'v2' }); const ran: string[] = [];
    const runner: DeployRunner = async step => { ran.push(step.id); return { exitCode: step.id === 'migrate' ? 1 : 0 }; };
    expect((await runDeployPlan(plan, { confirmation: plan.digest, runner })).status).toBe('failed');
    expect(ran).toEqual(['check-project', 'build-image', 'migrate']);
  });
});
